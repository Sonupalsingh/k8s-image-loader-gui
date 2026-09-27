"""Storage: StorageClasses, PersistentVolumes (local disk, hostPath, NFS) and PersistentVolumeClaims."""
from __future__ import annotations

from typing import Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import common as c

router = APIRouter(dependencies=[Depends(c.require_auth)])

DEFAULT_CLASS_ANNOTATIONS = ("storageclass.kubernetes.io/is-default-class",
                             "storageclass.beta.kubernetes.io/is-default-class")
NO_PROVISIONER = "kubernetes.io/no-provisioner"
AccessMode = Literal["ReadWriteOnce", "ReadOnlyMany", "ReadWriteMany", "ReadWriteOncePod"]


# =========================================================================== StorageClasses
@router.get("/api/storage/classes")
async def list_classes():
    res = await c.k8s(c.storage_api.list_storage_class)
    return sorted([{
        "name": sc.metadata.name,
        "provisioner": sc.provisioner,
        "reclaim_policy": sc.reclaim_policy,
        "binding_mode": sc.volume_binding_mode,
        "allow_expansion": bool(sc.allow_volume_expansion),
        "default": any((sc.metadata.annotations or {}).get(a) == "true" for a in DEFAULT_CLASS_ANNOTATIONS),
        "local": sc.provisioner == NO_PROVISIONER,
    } for sc in res.items], key=lambda x: (not x["default"], x["name"]))


class LocalClassIn(BaseModel):
    name: str = "local-storage"
    make_default: bool = False


@router.post("/api/storage/classes/local")
async def create_local_class(body: LocalClassIn):
    c.require_write()
    name = c.check_name(body.name)
    annotations = {DEFAULT_CLASS_ANNOTATIONS[0]: "true"} if body.make_default else {}
    await c.k8s(c.storage_api.create_storage_class, {
        "metadata": {"name": name, "annotations": annotations},
        "provisioner": NO_PROVISIONER,
        "volumeBindingMode": "WaitForFirstConsumer",   # bind when the pod is scheduled, on the right node
        "reclaimPolicy": "Retain",
    })
    c.audit("create", f"storageclass/{name}", "local disks (no provisioner)")
    return {"ok": True}


# =========================================================================== PersistentVolumes
def _pv_source(pv) -> dict:
    s = pv.spec
    node = None
    if s.node_affinity and s.node_affinity.required:
        for term in s.node_affinity.required.node_selector_terms or []:
            for e in term.match_expressions or []:
                if e.key == "kubernetes.io/hostname" and e.values:
                    node = ", ".join(e.values)
    if s.local:
        return {"type": "local", "detail": s.local.path, "node": node}
    if s.host_path:
        return {"type": "hostPath", "detail": s.host_path.path, "node": node}
    if s.nfs:
        return {"type": "nfs", "detail": f"{s.nfs.server}:{s.nfs.path}", "node": None}
    if s.csi:
        return {"type": "csi", "detail": f"{s.csi.driver} ({s.csi.volume_handle[:40]})", "node": node}
    return {"type": "other", "detail": "", "node": node}


@router.get("/api/storage/pvs")
async def list_pvs():
    res = await c.k8s(c.core_api.list_persistent_volume)
    out = []
    for pv in res.items:
        claim = pv.spec.claim_ref
        out.append({
            "name": pv.metadata.name,
            "capacity": (pv.spec.capacity or {}).get("storage"),
            "access_modes": pv.spec.access_modes or [],
            "reclaim_policy": pv.spec.persistent_volume_reclaim_policy,
            "storage_class": pv.spec.storage_class_name or "",
            "status": pv.status.phase,
            "claim": f"{claim.namespace}/{claim.name}" if claim else None,
            "source": _pv_source(pv),
            "age_seconds": c.age_seconds(pv.metadata.creation_timestamp),
        })
    return sorted(out, key=lambda x: x["name"])


class PVIn(BaseModel):
    name: str
    type: Literal["local", "hostPath", "nfs"]
    capacity: str
    path: str
    node: str = ""
    nfs_server: str = ""
    storage_class: str = ""
    access_mode: AccessMode = "ReadWriteOnce"
    reclaim_policy: Literal["Retain", "Delete"] = "Retain"
    create_dir: bool = False              # ask the node agent to create the path first
    dir_mode: str = "0775"


async def _create_dir_on_node(node: str, path: str, mode: str) -> bool:
    url = await c.agent_url(node)
    async with httpx.AsyncClient(timeout=15) as http:
        r = await http.post(f"{url}/mkdir", json={"path": path, "mode": mode},
                            headers={"x-agent-token": c.AGENT_TOKEN})
    if r.status_code != 200:
        detail = r.json().get("detail", r.text) if r.headers.get("content-type", "").startswith("application/json") else r.text
        raise HTTPException(r.status_code if 400 <= r.status_code < 500 else 502, f"{node}: {detail}")
    return bool(r.json().get("created"))


@router.post("/api/storage/pvs")
async def create_pv(body: PVIn):
    c.require_write()
    name = c.check_name(body.name)
    c.parse_quantity(body.capacity)
    path = c.check_abs_path(body.path, "Path")
    spec: dict = {
        "capacity": {"storage": body.capacity},
        "accessModes": [body.access_mode],
        "persistentVolumeReclaimPolicy": body.reclaim_policy,
        "storageClassName": body.storage_class,
        "volumeMode": "Filesystem",
    }
    if body.type == "local":
        if not body.node:
            raise HTTPException(400, "A local disk volume must name the node the disk is on.")
        spec["local"] = {"path": path}
    elif body.type == "hostPath":
        spec["hostPath"] = {"path": path, "type": "DirectoryOrCreate"}
    else:
        if not body.nfs_server:
            raise HTTPException(400, "Enter the NFS server address.")
        spec["nfs"] = {"server": body.nfs_server.strip(), "path": path}

    if body.node and body.type in ("local", "hostPath"):
        spec["nodeAffinity"] = {"required": {"nodeSelectorTerms": [{"matchExpressions": [
            {"key": "kubernetes.io/hostname", "operator": "In", "values": [body.node]}]}]}}

    created_dir = None
    if body.create_dir and body.type == "local":
        created_dir = await _create_dir_on_node(body.node, path, body.dir_mode)

    await c.k8s(c.core_api.create_persistent_volume, {"metadata": {"name": name}, "spec": spec})
    where = f"{body.nfs_server}:{path}" if body.type == "nfs" else f"{path} on {body.node or 'any node'}"
    c.audit("create", f"pv/{name}", f"{body.type} {body.capacity} {where}"
            + (" (directory created)" if created_dir else ""))
    return {"ok": True, "created_dir": created_dir}


@router.post("/api/storage/pvs/{name}/release")
async def release_pv(name: str):
    """Make a Released volume Available again (its data is kept)."""
    c.require_write()
    pv = await c.k8s(c.core_api.read_persistent_volume, name)
    if pv.status.phase != "Released":
        raise HTTPException(409, f"Only Released volumes can be made available (this one is {pv.status.phase}).")
    await c.k8s(c.core_api.patch_persistent_volume, name, [{"op": "remove", "path": "/spec/claimRef"}])
    c.audit("release", f"pv/{name}", "claimRef cleared, data kept")
    return {"ok": True}


@router.delete("/api/storage/pvs/{name}")
async def delete_pv(name: str, force: bool = False):
    c.require_write()
    pv = await c.k8s(c.core_api.read_persistent_volume, name)
    if pv.status.phase == "Bound" and not force:
        claim = pv.spec.claim_ref
        raise HTTPException(409, f"Bound to claim {claim.namespace}/{claim.name}. Delete the claim first.")
    await c.k8s(c.core_api.delete_persistent_volume, name)
    c.audit("delete", f"pv/{name}")
    return {"ok": True}


# =========================================================================== PersistentVolumeClaims
@router.get("/api/storage/pvcs")
async def list_pvcs(namespace: str = ""):
    res = await c.k8s(c.core_api.list_namespaced_persistent_volume_claim, namespace) if namespace \
        else await c.k8s(c.core_api.list_persistent_volume_claim_for_all_namespaces)
    classes = {sc["name"]: sc for sc in await list_classes()}
    default_class = next((n for n, sc in classes.items() if sc["default"]), None)
    usage = await c.usage_map(namespace)
    out = []
    for pvc in res.items:
        ns, name = pvc.metadata.namespace, pvc.metadata.name
        if not c.visible(ns):
            continue
        sc_name = pvc.spec.storage_class_name if pvc.spec.storage_class_name is not None else default_class
        out.append({
            "namespace": ns, "name": name,
            "status": pvc.status.phase,
            "requested": (pvc.spec.resources.requests or {}).get("storage") if pvc.spec.resources else None,
            "capacity": (pvc.status.capacity or {}).get("storage"),
            "access_modes": pvc.spec.access_modes or [],
            "storage_class": sc_name or "",
            "volume": pvc.spec.volume_name,
            "expandable": bool(classes.get(sc_name or "", {}).get("allow_expansion")),
            "used_by": usage.get((ns, "pvc", name), []),
            "protected": ns in c.PROTECTED_NAMESPACES or c.READ_ONLY,
            "age_seconds": c.age_seconds(pvc.metadata.creation_timestamp),
        })
    return sorted(out, key=lambda x: (x["namespace"], x["name"]))


class PVCIn(BaseModel):
    name: str
    size: str
    storage_class: str | None = None      # None = cluster default, "" = no class (static PVs only)
    access_mode: AccessMode = "ReadWriteOnce"
    volume_name: str = ""                 # bind to a specific PV


@router.post("/api/storage/pvcs/{namespace}")
async def create_pvc(namespace: str, body: PVCIn):
    c.require_write(namespace)
    name = c.check_name(body.name)
    c.parse_quantity(body.size)
    spec: dict = {"accessModes": [body.access_mode], "resources": {"requests": {"storage": body.size}}}
    if body.storage_class is not None:
        spec["storageClassName"] = body.storage_class
    if body.volume_name:
        spec["volumeName"] = c.check_name(body.volume_name, "Volume")
    await c.k8s(c.core_api.create_namespaced_persistent_volume_claim, namespace,
                {"metadata": {"name": name, "namespace": namespace}, "spec": spec})
    c.audit("create", f"pvc/{namespace}/{name}",
            f"{body.size} {body.access_mode} class={body.storage_class if body.storage_class is not None else 'default'}")
    return {"ok": True}


class ResizeIn(BaseModel):
    size: str


@router.put("/api/storage/pvcs/{namespace}/{name}/size")
async def resize_pvc(namespace: str, name: str, body: ResizeIn):
    c.require_write(namespace)
    pvc = await c.k8s(c.core_api.read_namespaced_persistent_volume_claim, name, namespace)
    current = (pvc.spec.resources.requests or {}).get("storage", "0")
    if c.parse_quantity(body.size) <= c.parse_quantity(current):
        raise HTTPException(400, f"The new size must be larger than {current}. Kubernetes cannot shrink volumes.")
    if pvc.spec.storage_class_name:
        sc = await c.k8s(c.storage_api.read_storage_class, pvc.spec.storage_class_name)
        if not sc.allow_volume_expansion:
            raise HTTPException(409, f"Storage class '{sc.metadata.name}' does not allow resizing "
                                     f"(allowVolumeExpansion is false).")
    await c.k8s(c.core_api.patch_namespaced_persistent_volume_claim, name, namespace,
                {"spec": {"resources": {"requests": {"storage": body.size}}}})
    c.audit("resize", f"pvc/{namespace}/{name}", f"{current} → {body.size}")
    return {"ok": True}


@router.delete("/api/storage/pvcs/{namespace}/{name}")
async def delete_pvc(namespace: str, name: str, force: bool = False):
    c.require_write(namespace)
    users = (await c.usage_map(namespace)).get((namespace, "pvc", name), [])
    if users and not force:
        raise HTTPException(409, f"Mounted by {', '.join(users)}. Remove it from those deployments first.")
    await c.k8s(c.core_api.delete_namespaced_persistent_volume_claim, name, namespace)
    c.audit("delete", f"pvc/{namespace}/{name}")
    return {"ok": True}
