"""Deployment editing: replicas, storage (volumes + mounts), env from ConfigMap/Secret, node pinning."""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from kubernetes.client.rest import ApiException
from pydantic import BaseModel, Field

import common as c

router = APIRouter(dependencies=[Depends(c.require_auth)])

HOSTNAME_LABEL = "kubernetes.io/hostname"
HOST_PATH_TYPES = {"DirectoryOrCreate", "Directory", "FileOrCreate", "File", ""}
VOLUME_TYPES = ("persistentVolumeClaim", "hostPath", "emptyDir", "configMap", "secret", "projected",
                "nfs", "csi", "downwardAPI", "ephemeral", "local")


# --------------------------------------------------------------------------- serializers
def summarize_volume(v: dict) -> dict:
    vtype = next((t for t in VOLUME_TYPES if t in v), next((k for k in v if k != "name"), "unknown"))
    src = v.get(vtype) or {}
    source = {
        "persistentVolumeClaim": lambda: f"claim {src.get('claimName')}" + (" (read-only)" if src.get("readOnly") else ""),
        "hostPath": lambda: f"{src.get('path')} on the node" + (f" ({src['type']})" if src.get("type") else ""),
        "emptyDir": lambda: ("memory" if src.get("medium") == "Memory" else "node disk")
                            + (f", limit {src['sizeLimit']}" if src.get("sizeLimit") else "") + ", deleted with the pod",
        "configMap": lambda: f"config map {src.get('name')}",
        "secret": lambda: f"secret {src.get('secretName')}",
        "nfs": lambda: f"{src.get('server')}:{src.get('path')}",
        "csi": lambda: f"CSI {src.get('driver')}",
        "projected": lambda: "projected: " + ", ".join(
            next(iter(k for k in s), "?") for s in src.get("sources", [])),
    }.get(vtype, lambda: vtype)()
    return {"name": v.get("name"), "type": vtype, "source": source}


def pod_summary(p) -> dict:
    statuses = p.status.container_statuses or []
    reason = None
    for cs in statuses:
        if cs.state and cs.state.waiting and cs.state.waiting.reason:
            reason = cs.state.waiting.reason
        elif cs.state and cs.state.terminated and cs.state.terminated.reason:
            reason = cs.state.terminated.reason
    if p.metadata.deletion_timestamp:
        reason = "Terminating"
    return {
        "name": p.metadata.name,
        "node": p.spec.node_name,
        "phase": p.status.phase,
        "ready": sum(1 for cs in statuses if cs.ready),
        "containers": len(p.spec.containers),
        "restarts": sum(cs.restart_count or 0 for cs in statuses),
        "reason": reason,
        "age_seconds": c.age_seconds(p.metadata.creation_timestamp),
    }


# --------------------------------------------------------------------------- detail
@router.get("/api/deployments/{namespace}/{name}")
async def deployment_detail(namespace: str, name: str):
    d = await c.k8s(c.apps_api.read_namespaced_deployment, name, namespace)
    spec = c.to_dict(d.spec.template.spec)
    selector = ",".join(f"{k}={v}" for k, v in (d.spec.selector.match_labels or {}).items())
    pods = await c.k8s(c.core_api.list_namespaced_pod, namespace, label_selector=selector) if selector else None

    hpa = None
    try:
        hpas = await c.k8s(c.autoscaling_api.list_namespaced_horizontal_pod_autoscaler, namespace)
        for h in hpas.items:
            ref = h.spec.scale_target_ref
            if ref.kind == "Deployment" and ref.name == name:
                hpa = {"name": h.metadata.name, "min": h.spec.min_replicas, "max": h.spec.max_replicas}
    except ApiException:
        pass  # autoscaling access not granted; not fatal

    return {
        "namespace": namespace,
        "name": name,
        "status": c.deployment_status(d),
        "replicas": d.spec.replicas if d.spec.replicas is not None else 1,
        "ready": d.status.ready_replicas or 0,
        "strategy": d.spec.strategy.type if d.spec.strategy else None,
        "protected": namespace in c.PROTECTED_NAMESPACES or c.READ_ONLY,
        "hpa": hpa,
        "node_selector": spec.get("nodeSelector") or {},
        "pinned_node": (spec.get("nodeSelector") or {}).get(HOSTNAME_LABEL),
        "volumes": [summarize_volume(v) for v in spec.get("volumes") or []],
        "containers": [{
            "name": ct["name"],
            "image": ct.get("image"),
            "mounts": [{"volume": m["name"], "path": m["mountPath"], "sub_path": m.get("subPath"),
                        "read_only": bool(m.get("readOnly"))} for m in ct.get("volumeMounts") or []],
            "env_from": [{"kind": "configMap" if "configMapRef" in ef else "secret",
                          "name": (ef.get("configMapRef") or ef.get("secretRef") or {}).get("name"),
                          "prefix": ef.get("prefix")} for ef in ct.get("envFrom") or []],
            "env_count": len(ct.get("env") or []),
        } for ct in spec.get("containers") or []],
        "pods": [pod_summary(p) for p in (pods.items if pods else [])],
    }


# --------------------------------------------------------------------------- replicas
class ReplicasIn(BaseModel):
    replicas: int = Field(ge=0, le=500)


@router.put("/api/deployments/{namespace}/{name}/replicas")
async def scale(namespace: str, name: str, body: ReplicasIn):
    c.require_write(namespace)
    await c.k8s(c.apps_api.patch_namespaced_deployment_scale, name, namespace, {"spec": {"replicas": body.replicas}})
    c.audit("scale", f"deployment/{namespace}/{name}", f"replicas → {body.replicas}")
    return {"ok": True, "replicas": body.replicas}


# --------------------------------------------------------------------------- volumes
class MountIn(BaseModel):
    container: str
    mount_path: str
    sub_path: str = ""
    read_only: bool = False


class VolumeIn(BaseModel):
    name: str
    type: Literal["persistentVolumeClaim", "hostPath", "emptyDir", "configMap", "secret"]
    claim_name: str = ""
    path: str = ""
    host_path_type: str = "DirectoryOrCreate"
    medium: Literal["", "Memory"] = ""
    size_limit: str = ""
    source_name: str = ""
    pin_node: str = ""
    mounts: list[MountIn] = Field(min_length=1)


def build_volume(body: VolumeIn) -> dict:
    v: dict = {"name": body.name}
    if body.type == "persistentVolumeClaim":
        v["persistentVolumeClaim"] = {"claimName": c.check_name(body.claim_name, "Claim name")}
    elif body.type == "hostPath":
        if body.host_path_type not in HOST_PATH_TYPES:
            raise HTTPException(400, f"Unknown host path type '{body.host_path_type}'.")
        v["hostPath"] = {"path": c.check_abs_path(body.path, "Node path")}
        if body.host_path_type:
            v["hostPath"]["type"] = body.host_path_type
    elif body.type == "emptyDir":
        v["emptyDir"] = {}
        if body.medium:
            v["emptyDir"]["medium"] = body.medium
        if body.size_limit:
            c.parse_quantity(body.size_limit)
            v["emptyDir"]["sizeLimit"] = body.size_limit
    elif body.type == "configMap":
        v["configMap"] = {"name": c.check_name(body.source_name, "Config map")}
    elif body.type == "secret":
        v["secret"] = {"secretName": c.check_name(body.source_name, "Secret")}
    return v


@router.post("/api/deployments/{namespace}/{name}/volumes")
async def add_volume(namespace: str, name: str, body: VolumeIn):
    c.require_write(namespace)
    c.check_name(body.name, "Volume name", label=True)
    volume = build_volume(body)
    warnings: list[str] = []

    if body.type == "persistentVolumeClaim":
        pvc = await c.k8s(c.core_api.read_namespaced_persistent_volume_claim, body.claim_name, namespace)
        d = await c.k8s(c.apps_api.read_namespaced_deployment, name, namespace)
        modes = pvc.spec.access_modes or []
        if (d.spec.replicas or 1) > 1 and "ReadWriteMany" not in modes and "ReadOnlyMany" not in modes:
            warnings.append("This claim is ReadWriteOnce: all pods must run on the same node, and pods on "
                            "other nodes will stay Pending. Use 1 replica or a ReadWriteMany claim.")
    if body.type == "hostPath" and not body.pin_node:
        warnings.append("Data on a node path stays on that node. Without pinning, a pod moved to another "
                        "node sees an empty directory.")

    def mutate(spec: dict):
        if any(v["name"] == body.name for v in spec.get("volumes") or []):
            raise HTTPException(409, f"A volume named '{body.name}' already exists.")
        containers = {ct["name"]: ct for ct in spec["containers"]}
        for m in body.mounts:
            ct = containers.get(m.container)
            if not ct:
                raise HTTPException(400, f"Container '{m.container}' not found.")
            path = c.check_abs_path(m.mount_path, "Mount path")
            if any(x["mountPath"] == path for x in ct.get("volumeMounts") or []):
                raise HTTPException(409, f"Container '{m.container}' already has something mounted at {path}.")
            mount = {"name": body.name, "mountPath": path}
            if m.sub_path:
                mount["subPath"] = m.sub_path.strip("/")
            if m.read_only:
                mount["readOnly"] = True
            ct.setdefault("volumeMounts", []).append(mount)
        spec.setdefault("volumes", []).append(volume)
        if body.pin_node:
            spec.setdefault("nodeSelector", {})[HOSTNAME_LABEL] = body.pin_node

    await c.mutate_pod_spec(namespace, name, mutate)
    where = ", ".join(f"{m.container}:{m.mount_path}" for m in body.mounts)
    c.audit("volume-add", f"deployment/{namespace}/{name}", f"{body.name} ({body.type}) at {where}")
    return {"ok": True, "warnings": warnings}


@router.delete("/api/deployments/{namespace}/{name}/volumes/{volume}")
async def remove_volume(namespace: str, name: str, volume: str):
    c.require_write(namespace)

    def mutate(spec: dict):
        before = len(spec.get("volumes") or [])
        spec["volumes"] = [v for v in spec.get("volumes") or [] if v["name"] != volume]
        if len(spec["volumes"]) == before:
            raise HTTPException(404, f"Volume '{volume}' not found.")
        for ct in (spec.get("containers") or []) + (spec.get("initContainers") or []):
            if ct.get("volumeMounts"):
                ct["volumeMounts"] = [m for m in ct["volumeMounts"] if m["name"] != volume]

    await c.mutate_pod_spec(namespace, name, mutate)
    c.audit("volume-remove", f"deployment/{namespace}/{name}", volume)
    return {"ok": True}


@router.delete("/api/deployments/{namespace}/{name}/node-pin")
async def unpin_node(namespace: str, name: str):
    c.require_write(namespace)

    def mutate(spec: dict):
        (spec.get("nodeSelector") or {}).pop(HOSTNAME_LABEL, None)

    await c.mutate_pod_spec(namespace, name, mutate)
    c.audit("unpin", f"deployment/{namespace}/{name}")
    return {"ok": True}


# --------------------------------------------------------------------------- env from
class EnvFromIn(BaseModel):
    container: str
    kind: Literal["configMap", "secret"]
    name: str
    prefix: str = ""


def _env_key(kind: str) -> str:
    return "configMapRef" if kind == "configMap" else "secretRef"


@router.post("/api/deployments/{namespace}/{name}/env-from")
async def add_env_from(namespace: str, name: str, body: EnvFromIn):
    c.require_write(namespace)
    c.check_name(body.name)

    def mutate(spec: dict):
        ct = next((x for x in spec["containers"] if x["name"] == body.container), None)
        if not ct:
            raise HTTPException(400, f"Container '{body.container}' not found.")
        key = _env_key(body.kind)
        if any((ef.get(key) or {}).get("name") == body.name for ef in ct.get("envFrom") or []):
            raise HTTPException(409, f"{body.container} already loads environment from {body.name}.")
        entry = {key: {"name": body.name}}
        if body.prefix:
            entry["prefix"] = body.prefix
        ct.setdefault("envFrom", []).append(entry)

    await c.mutate_pod_spec(namespace, name, mutate)
    c.audit("env-add", f"deployment/{namespace}/{name}", f"{body.container} ← {body.kind} {body.name}")
    return {"ok": True}


@router.delete("/api/deployments/{namespace}/{name}/env-from")
async def remove_env_from(namespace: str, name: str, container: str, kind: Literal["configMap", "secret"], source: str):
    c.require_write(namespace)

    def mutate(spec: dict):
        ct = next((x for x in spec["containers"] if x["name"] == container), None)
        if not ct:
            raise HTTPException(400, f"Container '{container}' not found.")
        key = _env_key(kind)
        ct["envFrom"] = [ef for ef in ct.get("envFrom") or [] if (ef.get(key) or {}).get("name") != source]

    await c.mutate_pod_spec(namespace, name, mutate)
    c.audit("env-remove", f"deployment/{namespace}/{name}", f"{container} ← {kind} {source}")
    return {"ok": True}
