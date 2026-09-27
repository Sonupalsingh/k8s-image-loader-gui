"""ConfigMaps and Secrets: list, view, create, edit, delete, restart dependents."""
from __future__ import annotations

import base64
import json
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import common as c

router = APIRouter(dependencies=[Depends(c.require_auth)])

MAX_BYTES = 1024 * 1024 - 4096          # etcd object limit minus metadata headroom
SYSTEM_CONFIGMAPS = {"kube-root-ca.crt"}
SYSTEM_SECRET_TYPES = {"kubernetes.io/service-account-token", "helm.sh/release.v1",
                       "bootstrap.kubernetes.io/token"}
EDITABLE_SECRET_TYPES = {"Opaque", "kubernetes.io/tls", "kubernetes.io/dockerconfigjson",
                         "kubernetes.io/basic-auth", "kubernetes.io/ssh-auth"}
REQUIRED_KEYS = {"kubernetes.io/tls": {"tls.crt", "tls.key"},
                 "kubernetes.io/dockerconfigjson": {".dockerconfigjson"},
                 "kubernetes.io/ssh-auth": {"ssh-privatekey"}}


def _size(data: dict[str, str]) -> int:
    return sum(len(k) + len(v.encode()) for k, v in data.items())


def _check_data(data: dict[str, str]) -> None:
    c.check_keys(data.keys())
    if _size(data) > MAX_BYTES:
        raise HTTPException(413, "Total data exceeds the 1 MiB Kubernetes limit. Use a volume for large files.")


# =========================================================================== ConfigMaps
class ConfigMapIn(BaseModel):
    name: str = ""
    data: dict[str, str] = Field(default_factory=dict)
    resource_version: str = ""
    restart: bool = False


@router.get("/api/configmaps")
async def list_configmaps(namespace: str = ""):
    res = await c.k8s(c.core_api.list_namespaced_config_map, namespace) if namespace \
        else await c.k8s(c.core_api.list_config_map_for_all_namespaces)
    usage = await c.usage_map(namespace)
    out = []
    for cm in res.items:
        ns, name = cm.metadata.namespace, cm.metadata.name
        if not c.visible(ns):
            continue
        out.append({
            "namespace": ns, "name": name,
            "keys": sorted((cm.data or {}).keys()) + sorted((cm.binary_data or {}).keys()),
            "used_by": usage.get((ns, "configmap", name), []),
            "immutable": bool(cm.immutable),
            "system": name in SYSTEM_CONFIGMAPS or name.endswith(".kube-root-ca.crt"),
            "protected": ns in c.PROTECTED_NAMESPACES or c.READ_ONLY,
            "age_seconds": c.age_seconds(cm.metadata.creation_timestamp),
        })
    return sorted(out, key=lambda x: (x["namespace"], x["name"]))


@router.get("/api/configmaps/{namespace}/{name}")
async def get_configmap(namespace: str, name: str):
    cm = await c.k8s(c.core_api.read_namespaced_config_map, name, namespace)
    usage = await c.usage_map(namespace)
    return {
        "namespace": namespace, "name": name,
        "data": cm.data or {},
        "binary_keys": sorted((cm.binary_data or {}).keys()),
        "immutable": bool(cm.immutable),
        "resource_version": cm.metadata.resource_version,
        "used_by": usage.get((namespace, "configmap", name), []),
        "protected": namespace in c.PROTECTED_NAMESPACES or c.READ_ONLY,
    }


@router.post("/api/configmaps/{namespace}")
async def create_configmap(namespace: str, body: ConfigMapIn):
    c.require_write(namespace)
    name = c.check_name(body.name)
    _check_data(body.data)
    await c.k8s(c.core_api.create_namespaced_config_map, namespace,
                {"metadata": {"name": name, "namespace": namespace}, "data": body.data})
    c.audit("create", f"configmap/{namespace}/{name}", f"{len(body.data)} keys")
    return {"ok": True}


@router.put("/api/configmaps/{namespace}/{name}")
async def update_configmap(namespace: str, name: str, body: ConfigMapIn):
    c.require_write(namespace)
    _check_data(body.data)
    cm = await c.k8s(c.core_api.read_namespaced_config_map, name, namespace)
    if cm.immutable:
        raise HTTPException(409, "This config map is immutable. Create a new one and point the deployment to it.")
    old = cm.data or {}
    cm.data = body.data
    if body.resource_version:
        cm.metadata.resource_version = body.resource_version   # conflict -> 409 if changed meanwhile
    await c.k8s(c.core_api.replace_namespaced_config_map, name, namespace, cm)

    changed = sorted(k for k in set(old) | set(body.data) if old.get(k) != body.data.get(k))
    c.audit("edit", f"configmap/{namespace}/{name}", f"changed keys: {', '.join(changed) or 'none'}")
    restarted = []
    if body.restart and changed:
        users = (await c.usage_map(namespace)).get((namespace, "configmap", name), [])
        restarted = await c.restart_deployments(namespace, users, f"config map {name} changed")
    return {"ok": True, "changed": changed, "restarted": restarted}


@router.delete("/api/configmaps/{namespace}/{name}")
async def delete_configmap(namespace: str, name: str, force: bool = False):
    c.require_write(namespace)
    users = (await c.usage_map(namespace)).get((namespace, "configmap", name), [])
    if users and not force:
        raise HTTPException(409, f"Used by {', '.join(users)}. Their pods fail to start without it.")
    await c.k8s(c.core_api.delete_namespaced_config_map, name, namespace)
    c.audit("delete", f"configmap/{namespace}/{name}")
    return {"ok": True}


# =========================================================================== Secrets
class RegistryAuth(BaseModel):
    registry: str
    username: str
    password: str
    email: str = ""


class SecretIn(BaseModel):
    name: str = ""
    type: str = "Opaque"
    data: dict[str, str] = Field(default_factory=dict)       # plain text values
    keep_binary: list[str] = Field(default_factory=list)     # binary keys to keep unchanged
    registry: RegistryAuth | None = None                     # helper for dockerconfigjson
    resource_version: str = ""
    restart: bool = False


def _encode(data: dict[str, str]) -> dict[str, str]:
    return {k: base64.b64encode(v.encode()).decode() for k, v in data.items()}


def _decode(data: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    text, binary = {}, []
    for k, v in (data or {}).items():
        try:
            text[k] = base64.b64decode(v).decode("utf-8")
        except (UnicodeDecodeError, ValueError):
            binary.append(k)
    return text, sorted(binary)


def _validate_secret(stype: str, data: dict[str, str], binary_keys: list[str]) -> None:
    missing = REQUIRED_KEYS.get(stype, set()) - set(data) - set(binary_keys)
    if missing:
        raise HTTPException(400, f"A {stype} secret needs these keys: {', '.join(sorted(missing))}.")
    if stype == "kubernetes.io/dockerconfigjson" and ".dockerconfigjson" in data:
        try:
            json.loads(data[".dockerconfigjson"])
        except json.JSONDecodeError:
            raise HTTPException(400, ".dockerconfigjson must be valid JSON.")


def _registry_json(r: RegistryAuth) -> str:
    auth = base64.b64encode(f"{r.username}:{r.password}".encode()).decode()
    entry = {"username": r.username, "password": r.password, "auth": auth}
    if r.email:
        entry["email"] = r.email
    return json.dumps({"auths": {r.registry: entry}})


def _is_system(s) -> bool:
    return s.type in SYSTEM_SECRET_TYPES


@router.get("/api/secrets")
async def list_secrets(namespace: str = ""):
    res = await c.k8s(c.core_api.list_namespaced_secret, namespace) if namespace \
        else await c.k8s(c.core_api.list_secret_for_all_namespaces)
    usage = await c.usage_map(namespace)
    out = []
    for s in res.items:
        ns, name = s.metadata.namespace, s.metadata.name
        if not c.visible(ns):
            continue
        out.append({
            "namespace": ns, "name": name, "type": s.type,
            "keys": sorted((s.data or {}).keys()),             # never values in the list view
            "used_by": usage.get((ns, "secret", name), []),
            "system": _is_system(s),
            "editable": s.type in EDITABLE_SECRET_TYPES and not s.immutable,
            "protected": ns in c.PROTECTED_NAMESPACES or c.READ_ONLY,
            "age_seconds": c.age_seconds(s.metadata.creation_timestamp),
        })
    return sorted(out, key=lambda x: (x["namespace"], x["name"]))


@router.get("/api/secrets/{namespace}/{name}")
async def get_secret(namespace: str, name: str):
    s = await c.k8s(c.core_api.read_namespaced_secret, name, namespace)
    if _is_system(s):
        raise HTTPException(403, f"{s.type} secrets are managed by Kubernetes or Helm and are not shown here.")
    text, binary = _decode(s.data)
    usage = await c.usage_map(namespace)
    c.audit("view", f"secret/{namespace}/{name}")
    return {
        "namespace": namespace, "name": name, "type": s.type,
        "data": text, "binary_keys": binary,
        "editable": s.type in EDITABLE_SECRET_TYPES and not s.immutable,
        "resource_version": s.metadata.resource_version,
        "used_by": usage.get((namespace, "secret", name), []),
        "protected": namespace in c.PROTECTED_NAMESPACES or c.READ_ONLY,
    }


@router.post("/api/secrets/{namespace}")
async def create_secret(namespace: str, body: SecretIn):
    c.require_write(namespace)
    name = c.check_name(body.name)
    if body.type not in EDITABLE_SECRET_TYPES:
        raise HTTPException(400, f"Secret type '{body.type}' cannot be created here.")
    data = dict(body.data)
    if body.type == "kubernetes.io/dockerconfigjson" and body.registry:
        data = {".dockerconfigjson": _registry_json(body.registry)}
    _check_data(data)
    _validate_secret(body.type, data, [])
    await c.k8s(c.core_api.create_namespaced_secret, namespace,
                {"metadata": {"name": name, "namespace": namespace}, "type": body.type, "data": _encode(data)})
    c.audit("create", f"secret/{namespace}/{name}", f"{body.type}, keys: {', '.join(sorted(data))}")
    return {"ok": True}


@router.put("/api/secrets/{namespace}/{name}")
async def update_secret(namespace: str, name: str, body: SecretIn):
    c.require_write(namespace)
    s = await c.k8s(c.core_api.read_namespaced_secret, name, namespace)
    if s.type not in EDITABLE_SECRET_TYPES or s.immutable:
        raise HTTPException(409, f"This secret ({s.type}{', immutable' if s.immutable else ''}) cannot be edited here.")
    if s.type == "kubernetes.io/dockerconfigjson" and body.registry:
        body.data = {".dockerconfigjson": _registry_json(body.registry)}
        body.keep_binary = []
    _check_data(body.data)
    old_raw = s.data or {}
    kept = {k: old_raw[k] for k in body.keep_binary if k in old_raw}
    _validate_secret(s.type, body.data, list(kept))

    new_raw = {**kept, **_encode(body.data)}
    s.data = new_raw
    s.string_data = None
    if body.resource_version:
        s.metadata.resource_version = body.resource_version
    await c.k8s(c.core_api.replace_namespaced_secret, name, namespace, s)

    changed = sorted(k for k in set(old_raw) | set(new_raw) if old_raw.get(k) != new_raw.get(k))
    c.audit("edit", f"secret/{namespace}/{name}", f"changed keys: {', '.join(changed) or 'none'}")
    restarted = []
    if body.restart and changed:
        users = (await c.usage_map(namespace)).get((namespace, "secret", name), [])
        restarted = await c.restart_deployments(namespace, users, f"secret {name} changed")
    return {"ok": True, "changed": changed, "restarted": restarted}


@router.delete("/api/secrets/{namespace}/{name}")
async def delete_secret(namespace: str, name: str, force: bool = False):
    c.require_write(namespace)
    s = await c.k8s(c.core_api.read_namespaced_secret, name, namespace)
    if _is_system(s):
        raise HTTPException(403, "System secrets cannot be deleted here.")
    users = (await c.usage_map(namespace)).get((namespace, "secret", name), [])
    if users and not force:
        raise HTTPException(409, f"Used by {', '.join(users)}. Their pods fail to start without it.")
    await c.k8s(c.core_api.delete_namespaced_secret, name, namespace)
    c.audit("delete", f"secret/{namespace}/{name}")
    return {"ok": True}

