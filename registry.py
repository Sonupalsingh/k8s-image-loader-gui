"""Local image registry: browse repositories and tags, push archives, delete tags, set up node trust.

Two addresses point at the same registry:
  * REGISTRY_URL  - how the dashboard reaches it inside the cluster (Service DNS), used for push and browse.
  * REGISTRY_HOST - how nodes (containerd / CRI-O) reach it, used in image references, e.g. localhost:30500.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException

import common as c

REGISTRY_URL = os.getenv("REGISTRY_URL", "").rstrip("/")
REGISTRY_HOST = os.getenv("REGISTRY_HOST", "localhost:30500").strip().rstrip("/")
PUSH_TIMEOUT = int(os.getenv("REGISTRY_PUSH_TIMEOUT_SECONDS", "1800"))
ENABLED = bool(REGISTRY_URL)

MANIFEST_TYPES = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
]
INDEX_TYPES = set(MANIFEST_TYPES[:2])
ACCEPT = ", ".join(MANIFEST_TYPES)

router = APIRouter(dependencies=[Depends(c.require_auth)])


# --------------------------------------------------------------------------- naming
def _push_host() -> str:
    return urlparse(REGISTRY_URL).netloc


def repo_and_tag(ref: str) -> tuple[str, str]:
    """'docker.io/library/nginx:1.27' -> ('nginx', '1.27'); 'reg.x:5000/team/api:v1' -> ('team/api', 'v1')."""
    ref = ref.split("@", 1)[0]
    last_slash, colon = ref.rfind("/"), ref.rfind(":")
    repo, tag = (ref[:colon], ref[colon + 1:]) if colon > last_slash else (ref, "latest")
    parts = repo.split("/")
    if len(parts) > 1 and ("." in parts[0] or ":" in parts[0] or parts[0] == "localhost"):
        parts = parts[1:]                       # drop the source registry host
    if len(parts) > 1 and parts[0] == "library":
        parts = parts[1:]
    return "/".join(parts).lower(), tag


def node_ref(ref: str) -> str:
    """Rewrite any image reference to point at the local registry (as nodes see it)."""
    if ref.startswith(REGISTRY_HOST + "/"):
        return ref
    repo, tag = repo_and_tag(ref)
    return f"{REGISTRY_HOST}/{repo}:{tag}"


def is_local(image: str) -> bool:
    return bool(image) and image.startswith(REGISTRY_HOST + "/")


def _require_enabled() -> None:
    if not ENABLED:
        raise HTTPException(409, "The local registry is not configured. Set REGISTRY_URL on the dashboard "
                                 "(see deploy/registry in the README).")


# --------------------------------------------------------------------------- push
async def push(archive: Path, fmt: str, source_ref: str | None, dest_ref: str, multi: bool) -> str:
    """Copy one image from the archive into the registry with skopeo. Returns the manifest digest."""
    _require_enabled()
    repo, tag = repo_and_tag(dest_ref)
    if fmt == "docker":
        src = f"docker-archive:{archive}" + (f":{source_ref}" if source_ref and multi else "")
    else:
        src = f"oci-archive:{archive}" + (f":{source_ref}" if source_ref and multi else "")
    with tempfile.NamedTemporaryFile(prefix="digest-", delete=False) as df:
        digest_file = df.name
    cmd = ["skopeo", "copy", "--quiet", "--retry-times", "2", "--dest-tls-verify=false",
           "--digestfile", digest_file, src, f"docker://{_push_host()}/{repo}:{tag}"]
    c.log.info("push: %s", " ".join(cmd))
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=PUSH_TIMEOUT)
    except asyncio.TimeoutError:
        proc.kill()
        raise RuntimeError(f"push timed out after {PUSH_TIMEOUT}s")
    try:
        if proc.returncode != 0:
            text = out.decode(errors="replace").strip()
            raise RuntimeError(f"push to registry failed: {text[-1500:]}")
        return Path(digest_file).read_text().strip()
    finally:
        Path(digest_file).unlink(missing_ok=True)


# --------------------------------------------------------------------------- registry HTTP API
def _client(timeout: float = 15) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=REGISTRY_URL, timeout=timeout)


def _unreachable(exc: Exception) -> HTTPException:
    return HTTPException(502, f"Cannot reach the registry at {REGISTRY_URL}: {exc}")


async def _manifest(http: httpx.AsyncClient, repo: str, ref: str, method: str = "GET") -> httpx.Response:
    return await http.request(method, f"/v2/{repo}/manifests/{ref}", headers={"Accept": ACCEPT})


async def tag_detail(http: httpx.AsyncClient, repo: str, tag: str, sem: asyncio.Semaphore) -> dict:
    async with sem:
        info = {"tag": tag, "digest": None, "size": None, "created": None, "platforms": []}
        try:
            r = await _manifest(http, repo, tag)
            if r.status_code != 200:
                return {**info, "error": f"manifest HTTP {r.status_code}"}
            info["digest"] = r.headers.get("docker-content-digest")
            m = r.json()
            mtype = m.get("mediaType") or r.headers.get("content-type", "").split(";")[0]
            if mtype in INDEX_TYPES:
                subs = [x for x in m.get("manifests", []) if (x.get("platform") or {}).get("os") != "unknown"]
                info["platforms"] = [f"{x['platform'].get('os')}/{x['platform'].get('architecture')}"
                                     for x in subs if x.get("platform")]
                if not subs:
                    return info
                r = await _manifest(http, repo, subs[0]["digest"])
                m = r.json()
            info["size"] = sum(l.get("size", 0) for l in m.get("layers", [])) + (m.get("config") or {}).get("size", 0)
            cfg_digest = (m.get("config") or {}).get("digest")
            if cfg_digest:
                cr = await http.get(f"/v2/{repo}/blobs/{cfg_digest}", follow_redirects=True)
                if cr.status_code == 200:
                    cfg = cr.json()
                    info["created"] = cfg.get("created")
                    if not info["platforms"] and cfg.get("os"):
                        info["platforms"] = [f"{cfg.get('os')}/{cfg.get('architecture')}"]
        except (httpx.HTTPError, json.JSONDecodeError, KeyError) as exc:
            info["error"] = str(exc)
        return info


async def image_usage() -> dict[str, list[str]]:
    """{image reference: ['ns/deployment:container', ...]} for every Deployment."""
    res = await c.k8s(c.apps_api.list_deployment_for_all_namespaces)
    usage: dict[str, list[str]] = {}
    for d in res.items:
        for ct in d.spec.template.spec.containers:
            usage.setdefault(ct.image, []).append(f"{d.metadata.namespace}/{d.metadata.name}:{ct.name}")
    return usage


# --------------------------------------------------------------------------- routes
@router.get("/api/registry")
async def overview():
    if not ENABLED:
        return {"enabled": False, "host": REGISTRY_HOST, "repositories": []}
    try:
        async with _client() as http:
            r = await http.get("/v2/_catalog", params={"n": 1000})
            if r.status_code != 200:
                raise HTTPException(502, f"Registry catalog returned HTTP {r.status_code}.")
            repos = r.json().get("repositories") or []

            async def tags(repo: str):
                t = await http.get(f"/v2/{repo}/tags/list")
                return sorted((t.json().get("tags") or []) if t.status_code == 200 else [])
            tag_lists = await asyncio.gather(*[tags(x) for x in repos])
    except httpx.HTTPError as exc:
        raise _unreachable(exc) from exc
    usage = await image_usage()
    out = []
    for repo, tl in zip(repos, tag_lists):
        if not tl:
            continue                            # every tag deleted; repository is empty
        in_use = sorted({u for t in tl for u in usage.get(f"{REGISTRY_HOST}/{repo}:{t}", [])})
        out.append({"name": repo, "tags": tl, "used_by": in_use})
    return {"enabled": True, "host": REGISTRY_HOST, "url": REGISTRY_URL, "repositories": out}


@router.get("/api/registry/tags")
async def tags(repo: str):
    _require_enabled()
    if not re.fullmatch(r"[a-z0-9]+(?:[._/-][a-z0-9]+)*", repo):
        raise HTTPException(400, "Invalid repository name.")
    try:
        async with _client() as http:
            r = await http.get(f"/v2/{repo}/tags/list")
            if r.status_code == 404:
                raise HTTPException(404, f"Repository {repo} not found.")
            names = r.json().get("tags") or []
            sem = asyncio.Semaphore(8)
            details = await asyncio.gather(*[tag_detail(http, repo, t, sem) for t in names])
    except httpx.HTTPError as exc:
        raise _unreachable(exc) from exc
    usage = await image_usage()
    for d in details:
        d["image"] = f"{REGISTRY_HOST}/{repo}:{d['tag']}"
        d["used_by"] = usage.get(d["image"], [])
    details.sort(key=lambda d: d.get("created") or "", reverse=True)
    return {"repo": repo, "tags": details}


@router.delete("/api/registry/tags")
async def delete_tag(repo: str, tag: str, force: bool = False):
    c.require_write()
    _require_enabled()
    image = f"{REGISTRY_HOST}/{repo}:{tag}"
    users = (await image_usage()).get(image, [])
    if users and not force:
        raise HTTPException(409, f"{image} is used by {', '.join(users)}. Pods rescheduled onto new nodes "
                                 f"would fail to pull it.")
    try:
        async with _client() as http:
            head = await _manifest(http, repo, tag, "HEAD")
            digest = head.headers.get("docker-content-digest")
            if head.status_code != 200 or not digest:
                raise HTTPException(404, f"{image} not found in the registry.")
            r = await http.delete(f"/v2/{repo}/manifests/{digest}")
    except httpx.HTTPError as exc:
        raise _unreachable(exc) from exc
    if r.status_code == 405:
        raise HTTPException(409, "Deleting is disabled in the registry. Set REGISTRY_STORAGE_DELETE_ENABLED=true.")
    if r.status_code not in (200, 202):
        raise HTTPException(502, f"Registry refused the delete (HTTP {r.status_code}).")
    c.audit("delete", f"image/{repo}:{tag}", f"digest {digest[:19]}; other tags on this digest are removed too")
    return {"ok": True, "digest": digest}


@router.post("/api/registry/configure-nodes")
async def configure_nodes():
    """Ask every node agent to trust the local registry (plain HTTP)."""
    c.require_write()
    _require_enabled()
    pods = await c.k8s(c.core_api.list_namespaced_pod, c.AGENT_NAMESPACE, label_selector=c.AGENT_SELECTOR)
    targets = [(p.spec.node_name, p.status.pod_ip) for p in pods.items
               if p.status.pod_ip and any(x.type == "Ready" and x.status == "True" for x in (p.status.conditions or []))]
    if not targets:
        raise HTTPException(409, "No node agents are ready.")

    async def one(http: httpx.AsyncClient, node: str, ip: str) -> dict:
        try:
            r = await http.post(f"http://{ip}:{c.AGENT_PORT}/registry-config", json={"host": REGISTRY_HOST},
                                headers={"x-agent-token": c.AGENT_TOKEN})
            data = r.json()
            if r.status_code != 200:
                return {"node": node, "state": "failed", "message": data.get("detail", r.text)}
            return data
        except Exception as exc:  # noqa: BLE001
            return {"node": node, "state": "failed", "message": str(exc)}

    async with httpx.AsyncClient(timeout=30) as http:
        results = await asyncio.gather(*[one(http, n, ip) for n, ip in targets])
    summary = ", ".join(f"{r['node']}={r['state']}" for r in results)
    c.audit("registry-nodes", f"registry/{REGISTRY_HOST}", summary)
    return {"host": REGISTRY_HOST, "nodes": sorted(results, key=lambda r: r["node"])}
