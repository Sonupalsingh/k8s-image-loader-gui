# k8s-image-loader

A web dashboard for air-gapped Kubernetes clusters. It runs a **local image registry** in the cluster, so you can upload your business applications as `.tar` files, keep them in the registry, and deploy any version to any Deployment with a click. Rollouts are followed until they finish, and one click rolls back.

The same dashboard scales Deployments, attaches storage (PVCs, local disks, node directories), and edits ConfigMaps and Secrets. Everything works on **containerd**, **CRI-O**, k3s and RKE2.

## How it works

```
                 upload .tar
 Browser ───────────────────────▶ Dashboard ──skopeo push──▶ Local registry (in cluster, PVC)
                                     │                          ▲  image-registry.svc:5000
                                     │ patch Deployment         │
                                     ▼                          │ pull  localhost:30500/team/app:1.4
                                 Kubernetes ──schedules pod──▶ Node (containerd / CRI-O)
                                                               ▲
                     Node agent (DaemonSet) ── trusts the registry, or loads tars directly
```

Every image job shows its stages live: inspect archive, push to registry (or load on nodes), update deployment, roll out pods. There are three ways to get an image to a Deployment:

| Source | What happens | Use it when |
|---|---|---|
| **From the local registry** | Picks a repository and tag already in the registry. | Normal case: deploy, promote or roll back versions. |
| **Upload a tar, then push to registry** | Pushes the tar, then deploys it. | A new build of a business app. |
| **Upload a tar, load onto each node** | The node agent imports the tar into each node's runtime, no registry involved. | The registry is down or not installed. Nodes added later won't have the image. |

## Install

You need Kubernetes 1.24+, `kubectl` with cluster-admin, and one machine with `docker` or `podman` and internet access to build the bundle. `make` is optional; each target is plain `kubectl`.

### 1. Build the bootstrap bundle (on the internet-connected machine)

```bash
make bundle                      # or: PLATFORM=linux/arm64 make bundle
```

This produces `k8s-image-loader-bundle-1.2.0.tar`, containing the registry, dashboard and agent images. The registry can't serve its own image before it is running, so this bundle goes onto the nodes directly, **once**.

### 2. Import the bundle on every node

Copy the bundle and `scripts/node-import.sh` to each node, then run:

```bash
sudo ./node-import.sh k8s-image-loader-bundle-1.2.0.tar localhost:30500
```

This imports the images into containerd, k3s, RKE2 or CRI-O, and lets the runtime pull from the local registry at `localhost:30500` over plain HTTP. It prints the one extra step your node needs, if any:
- **containerd 1.x**: add `config_path = "/etc/containerd/certs.d"` and restart containerd.
- **k3s / RKE2**: restart the service after `registries.yaml` is updated.
- **CRI-O**: reload happens automatically.

### 3. Install the local registry

```bash
make registry                    # kubectl apply -k deploy/registry
```

The registry stores images on a 50 GiB PVC from your default storage class. If you have no storage class, follow `deploy/registry/pv-local.example.yaml` to put it on a node's disk first. Check that it's up:

```bash
kubectl -n k8s-image-loader get pods,pvc -l app.kubernetes.io/component=registry
curl http://<any-node-ip>:30500/v2/_catalog            # {"repositories":[]}
```

### 4. Install the dashboard and node agents

```bash
make deploy                      # creates tokens, then kubectl apply -k deploy
make token                       # prints the login token
make port-forward                # http://localhost:8080
```

For access from your network, use `deploy/06-ingress.example.yaml` (it allows large uploads), or run `kubectl -n k8s-image-loader patch svc image-loader-dashboard -p '{"spec":{"type":"NodePort"}}'`.

### 5. Put your images into the registry

In the dashboard, open **Images**, then **Push image tar**, and upload:
- **your business applications**, for example `docker save billing:2.3 invoicing:1.8 -o apps.tar`. One tar can hold many images, and all are pushed.
- **the bundle itself**, so the dashboard and agent images are also kept in the registry.

Then choose **Set up nodes** on the Images tab. The node agents confirm that every node trusts the registry, and the Nodes tab shows each node as *pulls from the local registry*.

## Using it

**Deploy a new build:** on **Workloads**, choose **Update image** on the Deployment, pick the container, choose **Upload a tar file** with **Local registry, then deploy**, and drop the tar. Leave the image name empty to keep the archive's name, or enter one like `team/api:1.4.2`.

**Deploy or roll back to a version already in the registry:** use **Update image**, then **From the local registry**, and pick the repository and tag. Or, on **Images**, open a repository's tags and choose **Deploy** next to a tag.

**Unique tags:** keep **Add a unique timestamp tag** on for uploads. `myapp:latest` becomes `myapp:build-20260927101500`, so every node runs the exact build and rollback is unambiguous. If you do overwrite tags, set the pull policy to **Always**.

**Images tab:** shows every repository with its tags, build time, size, platform, and which Deployments use each tag. **Delete** is refused while a Deployment still uses the tag, unless you confirm. Deleting frees space only after garbage collection:

```bash
kubectl -n k8s-image-loader exec deploy/image-registry -- \
  registry garbage-collect --delete-untagged /etc/docker/registry/config.yml
```

Run it when nobody is pushing, because pushes that run during garbage collection can be corrupted.

## Managing workloads, config and storage

### Deployments: Manage
Choose **Manage** on any Deployment to open its detail view:

- **Replicas**: set the pod count (0 to 500). If a HorizontalPodAutoscaler controls the Deployment, the dashboard warns you, because the autoscaler will override manual changes.
- **Storage**: add or remove volumes and choose where each container mounts them.
  - *Persistent volume claim*: durable storage from a PVC. The dashboard warns when a ReadWriteOnce claim is combined with more than one replica, because those pods can only run on one node.
  - *Node directory (hostPath)*: a folder on the node. You can pin the Deployment to a node so the data stays reachable. Unpin it from the same view.
  - *Scratch space (emptyDir)*: temporary disk or memory, deleted with the pod, with an optional size limit.
  - *Config map / Secret as files*: mounts each key as a file.
- **Environment**: load all keys of a ConfigMap or Secret as environment variables (`envFrom`), with an optional prefix.
- **Pods**: every pod with its node, restarts and current problem (for example `CrashLoopBackOff`).

Edits use optimistic locking. If someone else changed the Deployment while you were editing, the save fails with a clear message instead of overwriting their change.

### ConfigMaps and Secrets
- List, create, edit and delete, with a **Used by** column showing which Deployments depend on each one. Deleting asks you to type the name, and warns first when Deployments still depend on it.
- Add keys by typing or by loading a file (config files, certificates).
- After saving, keep **Restart the deployments that use it** ticked so pods pick up the change. Environment variables and `subPath` mounts only change on restart.
- Secret types: generic (Opaque), **Docker registry login** (built from server, username and password), **TLS certificate**, basic auth and SSH key. Required keys are checked before saving.
- Secret values stay hidden until you choose **Show**. Viewing a secret is recorded in the change log. Binary values are kept unchanged when you edit other keys. Kubernetes-managed secrets (service account tokens, Helm releases) are hidden from editing.

### Storage
- **Storage classes**: see the default class and which ones allow resizing. **Add local disk class** creates a `kubernetes.io/no-provisioner` class with `WaitForFirstConsumer` binding, the standard setup for node disks.
- **Persistent volumes**: register a *local disk* (pinned to its node), a *node directory* (hostPath) or an *NFS share*. For local disks the dashboard can **create the directory on the node** through the node agent, restricted to `/mnt/disks` and `/var/lib/k8s-volumes`. **Make available** returns a Released volume to the pool with its data intact.
- **Claims**: create a claim from a class or bound to a specific volume, expand it when the class allows it, and delete it once no Deployment mounts it.

**Typical local-disk setup:** add the local disk class, then create one volume per disk (node, path, size), then create a claim with that class, then add it to a Deployment under Manage, then Storage. Kubernetes binds the claim to a disk on the node where the pod is scheduled.

### Change log
The **Change log** tab lists every change made through the dashboard (scale, restart, image, volume, config, secret views and edits, storage) with a timestamp. The same entries go to the dashboard's stdout with the prefix `AUDIT`, for your log collector.

## Configuration

Dashboard environment variables (`deploy/04-dashboard.yaml`):

| Variable | Default | Purpose |
|---|---|---|
| `DASHBOARD_TOKEN` | from secret | Login token for the UI and API. Empty disables auth (not recommended). |
| `AGENT_TOKEN` | from secret | Shared secret sent to node agents. |
| `ROLLOUT_TIMEOUT_SECONDS` | `600` | How long to follow a rollout before marking it failed. |
| `AGENT_TIMEOUT_SECONDS` | `1800` | Max time for one node to receive and import an archive. |
| `HIDE_NAMESPACES` | `kube-public,kube-node-lease` | Comma-separated namespaces hidden from all lists. |
| `PROTECTED_NAMESPACES` | `kube-system,…,k8s-image-loader` | Visible but read-only. Changes there are refused. |
| `READ_ONLY` | `false` | `true` turns the whole dashboard into a viewer. |
| `REGISTRY_URL` | `http://image-registry.k8s-image-loader.svc:5000` | Where the dashboard pushes and browses. Remove it to turn registry features off. |
| `REGISTRY_HOST` | `localhost:30500` | The registry address used in image names, as nodes reach it. Must match the agent's `REGISTRY_HOST`. |

Agent environment variables (`deploy/03-agent-daemonset.yaml`):

| Variable | Default | Purpose |
|---|---|---|
| `RUNTIME` | `auto` | Force `containerd` or `crio` if detection picks the wrong one. |
| `CONTAINERD_SOCKET` | auto | Custom socket path relative to host root, e.g. `run/k3s/containerd/containerd.sock`. |
| `CONTAINERD_NAMESPACE` | `k8s.io` | containerd namespace the kubelet uses. |
| `CRIO_STORAGE_DRIVER` | from `storage.conf` | Override the containers-storage driver for CRI-O. |
| `REGISTRY_HOST` | `localhost:30500` | Registry the agent reports trust for, and configures on **Set up nodes**. |
| `LOCAL_STORAGE_ROOTS` | `/mnt/disks:/var/lib/k8s-volumes` | Host directories where the dashboard may create local-volume folders. Each needs a matching hostPath mount under `/host`. |

On CRI-O nodes the agent reads `/etc/containers/storage.conf` to use the same driver, graphroot, runroot and overlay mount options as CRI-O. If your graphroot is not under `/var/lib/containers`, add a matching hostPath mount under `/host`.

**Disk sizing**: the dashboard's `/data` and `/tmp` and each agent's `/work` `emptyDir` must hold your largest archive. The default limit is 20 GiB.

## API

All endpoints except `/healthz` and `/api/config` need `Authorization: Bearer <token>`.

```bash
TOKEN=...; URL=http://localhost:8080; AUTH="Authorization: Bearer $TOKEN"

# Push a tar (one or many images) to the local registry
curl -H "$AUTH" -F file=@apps.tar $URL/api/registry/push                    # → {"job_id": "..."}

# Upload a tar, push it to the registry and roll it out (destination=nodes skips the registry)
curl -H "$AUTH" -F file=@billing.tar -F container=web -F destination=registry \
     -F unique_tag=true -F pull_policy=IfNotPresent $URL/api/deployments/prod/billing/image

# Deploy a version that is already in the registry
curl -H "$AUTH" -H 'Content-Type: application/json' \
     -d '{"container":"web","image":"localhost:30500/team/billing:2.3.0"}' \
     $URL/api/deployments/prod/billing/image-ref

curl -H "$AUTH" $URL/api/registry                                   # repositories and tags
curl -H "$AUTH" "$URL/api/registry/tags?repo=team/billing"          # tag details and usage
curl -H "$AUTH" $URL/api/jobs/<job_id>                              # follow a job
curl -X POST -H "$AUTH" $URL/api/jobs/<job_id>/rollback
```

This makes the tool usable from CI pipelines in air-gapped environments.

## Security model

The node agent is **privileged** and mounts the runtime socket and storage. That is inherent to loading images onto a node, so treat this tool like cluster-admin:

- Tokens are compared in constant time. The agent rejects requests without the agent token.
- `05-networkpolicy.yaml` allows only the dashboard to reach agents (requires a CNI that enforces NetworkPolicy).
- The dashboard runs as non-root with a read-only root filesystem. Its ClusterRole (`02-rbac.yaml`) allows editing Deployments, ConfigMaps, Secrets, PVCs, PVs and StorageClasses. It cannot delete Deployments, namespaces or nodes. **Anyone with the dashboard token can read and change Secrets**, so protect it like cluster-admin credentials.
- To narrow what it can touch, swap the ClusterRole for namespaced Roles, and use `PROTECTED_NAMESPACES` or `READ_ONLY=true`.
- **The registry has no login and uses plain HTTP.** Anyone who can reach port 30500 on a node can pull and push images. Keep node ports off untrusted networks. For stricter setups, put the registry behind TLS and htpasswd auth, and give the dashboard and nodes the credentials.
- The agent only creates directories under `LOCAL_STORAGE_ROOTS`. Paths with `..` or outside those roots are refused.
- Put the dashboard behind your SSO proxy (oauth2-proxy, etc.) for production, and restrict the Ingress to trusted networks.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Node shows "No agent running" | The DaemonSet pod is not on that node. Check taints and `kubectl -n k8s-image-loader get ds`. |
| `no containerd or CRI-O socket found` | Non-standard socket path. Set `CONTAINERD_SOCKET` or `RUNTIME`. |
| Pods show `ErrImageNeverPull` | The image is missing on that node, usually a node without a ready agent. Check the Nodes panel and reload. |
| Pods show `ErrImagePull` with policy `IfNotPresent` | The image name in the Deployment differs from what was loaded (for example `docker.io/library/` prefix). Use a fully qualified target image. |
| `ctr: content digest ... not found` | The archive is multi-platform with missing layers. Re-export for one platform: `docker save` from a single-arch pull. |
| CRI-O: `overlay: mount ... invalid argument` | Driver or mount options differ from CRI-O's. Check `/etc/containers/storage.conf` or set `CRIO_STORAGE_DRIVER`. |
| Pods show `ErrImagePull ... http: server gave HTTP response to HTTPS client` | The node does not trust the registry yet. Choose **Set up nodes** on the Images tab, then complete the step it reports (containerd 1.x needs `config_path`). |
| Pods show `ErrImagePull ... connection refused` on `localhost:30500` | Your kube-proxy mode does not serve NodePorts on localhost (IPVS, nftables, some eBPF CNIs). Set `REGISTRY_HOST` to `<node-ip>:30500` on the dashboard and agent, and re-run **Set up nodes**. |
| Registry pod `Pending` | Its PVC is unbound. Check `kubectl -n k8s-image-loader get pvc registry-data`, and use `pv-local.example.yaml` if you have no storage class. |
| Push fails with `blob upload unknown` or disk errors | The registry volume is full. Delete old tags, run garbage collection, or grow the PVC. |
| Pod stays `Pending` after adding a claim | The claim is unbound (no matching volume or class), or it is ReadWriteOnce and the pods are on different nodes. Check the Storage tab status and the pod list. |
| Saving a Deployment says it changed meanwhile | Someone else (or a controller) edited it. Reload and apply your change again. |
| Config change has no effect | Environment variables and `subPath` mounts are read at start. Save again with the restart option ticked. |
| Resize is refused | The storage class has `allowVolumeExpansion: false`, or the new size is not larger. Kubernetes cannot shrink volumes. |
| Upload stops at 100% for a long time | The dashboard is decompressing or distributing a large archive. Watch the Activity log. |

## Limitations

- The registry is a single replica on one volume. If it is down, running pods keep running, but new pods on nodes without a cached image cannot start. Keep the registry, dashboard and agent images from the bundle on every node for that reason.
- Job history is kept in memory and cleared when the dashboard restarts. The deployment itself carries `image-loader.k8s.io/*` annotations recording the last loaded image.
- Run a single dashboard replica.
- Images are loaded onto every node that has an agent, not only nodes the Deployment can schedule on.
- Garbage collection of old images is left to the kubelet's image GC.

## Project layout

```
dashboard/   FastAPI API + single-page UI
  app.py         image upload, distribution, rollout jobs
  workloads.py   replicas, volumes, env-from, node pinning, pod list
  config_api.py  ConfigMaps and Secrets
  storage.py     StorageClasses, PersistentVolumes, PersistentVolumeClaims
  registry.py    local registry: browse, push (skopeo), delete, node setup
  common.py      Kubernetes clients, auth, write guards, audit log, validation
  static/        index.html, styles.css, app.js
agent/       Node agent (ctr + skopeo image import, local-volume directories)
deploy/      Namespace, RBAC, DaemonSet, Deployment, Service, NetworkPolicy, Ingress example
  registry/    local registry: Deployment, NodePort service, PVC, local-disk PV example
scripts/     make-bundle.sh (bootstrap images), node-import.sh (import + registry trust on a node)
Makefile     bundle, registry, deploy, token, port-forward
```
