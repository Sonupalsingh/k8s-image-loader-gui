# Installation

This guide installs the local registry, the dashboard and the node agents. It is written for **air-gapped clusters**: only one machine needs internet access, once.

- [1. What you need](#1-what-you-need)
- [2. Get the code](#2-get-the-code)
- [3. Build the bundle](#3-build-the-bundle)
- [4. Import the bundle on every node](#4-import-the-bundle-on-every-node)
- [5. Install the local registry](#5-install-the-local-registry)
- [6. Install the dashboard and node agents](#6-install-the-dashboard-and-node-agents)
- [7. Open the dashboard](#7-open-the-dashboard)
- [8. First steps](#8-first-steps)
- [9. Optional: metrics-server for autoscaling](#9-optional-metrics-server-for-autoscaling)
- [Upgrading](#upgrading) · [Uninstalling](#uninstalling)

## 1. What you need

| Where | What |
|---|---|
| **Cluster** | Kubernetes 1.24 or newer, with CRI-O, containerd, k3s or RKE2 on the nodes |
| **Admin machine** | `kubectl` with cluster-admin rights, and `make` (optional: every target is plain `kubectl`) |
| **Build machine** | Internet access, `skopeo`, and **one** image builder: `docker` or `buildah` (podman is not used) |
| **CRI-O nodes** | `skopeo` (imports into CRI-O's storage) |
| **containerd nodes** | nothing extra: `ctr` ships with containerd |

The build machine, admin machine and a node can be the same computer.

Install the build tools:

```bash
# RHEL / Rocky / Alma
sudo dnf install -y make skopeo buildah git
# Ubuntu / Debian
sudo apt-get install -y make skopeo buildah git
```

> **RHEL without a subscription?** `dnf` then uses a local repository, usually the installation DVD mounted at `/mnt`. If `dnf` reports `Cannot download repomd.xml`, mount the DVD first (`sudo mount /dev/sr0 /mnt`). Also make sure both the `BaseOS` and `AppStream` repositories are configured; skopeo and buildah are in AppStream.

**CRI-O node without internet and without skopeo:** on the build machine run `dnf download --resolve skopeo`, copy the `.rpm` files to the node, and install them with `sudo dnf install ./*.rpm`.

## 2. Get the code

```bash
git clone https://github.com/Sonupalsingh/k8s-image-loader-gui.git
cd k8s-image-loader-gui
chmod +x scripts/*.sh
```

Check that you are in the project folder. `ls` must show `Makefile`, `dashboard/`, `agent/`, `deploy/` and `scripts/`.

## 3. Build the bundle

On the build machine:

```bash
make bundle                          # linux/amd64
# or: PLATFORM=linux/arm64 make bundle
# or: BUILDER=buildah make bundle    # force a builder
```

This builds the dashboard and agent images, downloads the registry image, and packs everything into one file with checksums:

```
==> Builder: docker, platform: linux/amd64
==> Pulling docker.io/library/registry:2.8.3 with skopeo
==> Building docker.io/k8s-image-loader/dashboard:1.6.0
...
==> Bundle: k8s-image-loader-bundle-1.6.0.tar (406M)
    amd64  registry.tar
    amd64  dashboard.tar
    amd64  agent.tar
```

A line such as `docker's image store is incomplete (containerd store); flattening with docker export` is normal on newer Docker versions. The script detects that `docker save` output is unusable and exports the image another way. Every exported image is verified before it goes into the bundle.

**Why a bundle?** The registry cannot serve its own image before it is running, and the node agent cannot start before its image is on the node. So these three images are loaded onto the nodes directly, once. Everything after that goes through the dashboard.

## 4. Import the bundle on every node

Copy the bundle to **each** node (every node runs a node agent) and run the import as root:

```bash
scp k8s-image-loader-bundle-1.6.0.tar root@NODE:/root/
ssh root@NODE
cd /root && tar -xf k8s-image-loader-bundle-1.6.0.tar && cd k8s-image-loader-bundle-1.6.0
./node-import.sh . localhost:30500
```

The script finds the runtime **the kubelet uses**: it reads the kubelet's `--container-runtime-endpoint` from the running kubelet, `/var/lib/kubelet/config.yaml`, kubeadm's flags or `/etc/crictl.yaml`. This matters on nodes that also run Docker, because Docker brings its own containerd. Expected output on a CRI-O node:

```
==> Runtime: crio  (kubelet endpoint unix:///var/run/crio/crio.sock (from kubelet process))
==> Checksums OK (.)
==> skopeo: docker.io/k8s-image-loader/agent:1.6.0  (agent.tar)
...
==> Verifying 3 image(s) in crio:
      OK       docker.io/k8s-image-loader/agent:1.6.0
      OK       docker.io/k8s-image-loader/dashboard:1.6.0
      OK       docker.io/library/registry:2.8.3
==> Allowing pulls from http://localhost:30500
==> Wrote /etc/containers/registries.conf.d/50-k8s-image-loader.conf
==> Reloaded CRI-O
==> Done
```

**Every image must say `OK`.** Check the first line too. If it names the wrong runtime, force it: `RUNTIME=crio ./node-import.sh . localhost:30500` (or `RUNTIME=containerd`).

The last lines let the runtime **pull from the local registry over plain HTTP**. Lines starting with `!!` name one more step your node needs:

| Runtime | What the script does | What you may need to do |
|---|---|---|
| **CRI-O** | Writes `/etc/containers/registries.conf.d/50-k8s-image-loader.conf` and reloads CRI-O | nothing |
| **containerd 2.x** | Writes `/etc/containerd/certs.d/localhost:30500/hosts.toml` | nothing |
| **containerd 1.x** | Writes the same file | Add `config_path = "/etc/containerd/certs.d"` under `[plugins."io.containerd.grpc.v1.cri".registry]` in `/etc/containerd/config.toml`, then run `systemctl restart containerd` |
| **k3s / RKE2** | Adds a mirror to `/etc/rancher/k3s/registries.yaml` (or `rke2`) | `systemctl restart k3s` (or `k3s-agent`, `rke2-server`, `rke2-agent`) |

You can also use `node-import.sh` for any image tar: `./node-import.sh myapp.tar`.

## 5. Install the local registry

Where `kubectl` works:

```bash
make registry            # = kubectl apply -k deploy/registry
```

The registry keeps its images on a **50 GiB PersistentVolumeClaim** from your default storage class. Check that it is running:

```bash
kubectl -n k8s-image-loader get pods,pvc -l app.kubernetes.io/component=registry
curl http://<any-node-ip>:30500/v2/_catalog           # {"repositories":[]}
```

**No storage class in your cluster?** Then the claim stays `Pending`. Put the registry on a node's disk instead:

1. On the node, create the directory: `sudo mkdir -p /mnt/disks/registry`
2. In `deploy/registry/pv-local.example.yaml`, replace `NODE-NAME` with the node's name (`kubectl get nodes`).
3. In `deploy/registry/kustomization.yaml`, uncomment the `patches:` block.
4. Apply: `kubectl apply -f deploy/registry/pv-local.example.yaml && kubectl apply -k deploy/registry`

## 6. Install the dashboard and node agents

```bash
make deploy              # creates the access tokens once, then kubectl apply -k deploy
make token               # prints the built-in admin token
```

Without `make`:

```bash
kubectl apply -f deploy/00-namespace.yaml
kubectl -n k8s-image-loader create secret generic dashboard-auth --from-literal=token="$(openssl rand -hex 24)"
kubectl -n k8s-image-loader create secret generic agent-auth --from-literal=token="$(openssl rand -hex 32)"
kubectl apply -k deploy
kubectl -n k8s-image-loader get secret dashboard-auth -o jsonpath='{.data.token}' | base64 -d; echo
```

Check that everything runs. There is one agent per node, plus the dashboard and the registry:

```bash
kubectl -n k8s-image-loader get pods -o wide
```

If a pod shows `ImagePullBackOff`, the bundle is not imported on that node. See [Troubleshooting](troubleshooting.md#pods-of-the-tool-itself-show-imagepullbackoff).

## 7. Open the dashboard

Pick one:

**NodePort (simplest, permanent).** Available on every node's IP, port 30080:

```bash
kubectl -n k8s-image-loader patch svc image-loader-dashboard \
  -p '{"spec":{"type":"NodePort","ports":[{"port":80,"targetPort":"http","nodePort":30080}]}}'
```

Browse to `http://<node-ip>:30080`.

**Port-forward (temporary).** For a quick look:

```bash
kubectl -n k8s-image-loader port-forward --address 0.0.0.0 svc/image-loader-dashboard 8080:80
```

Browse to `http://<this-machine>:8080`.

**Ingress.** Adapt `deploy/06-ingress.example.yaml`. It already allows large uploads (no body-size limit, long timeouts, no request buffering).

Sign in with the token from `make token`. This is the **built-in admin**. For daily work, create personal users on the **Users** tab (see the [user guide](user-guide.md#users)).

## 8. First steps

1. **Nodes and activity**: every node should show *Ready* with its runtime (for example *crio*).
2. **Images**, then **Set up nodes**: confirms that every node trusts the local registry.
3. **Images**, then **Push image tar**: upload your application images, for example `docker save myapp:1.0 -o myapp.tar`.
4. **Workloads**, then **Update image**: deploy one. Or use **Apply YAML** for a new application.

The [user guide](user-guide.md) walks through every screen.

## 9. Optional: metrics-server for autoscaling

Autoscaling (HPA) needs **metrics-server** to measure CPU and memory. Without it, the Autoscaling section warns you and the autoscaler doesn't scale. On the build machine:

```bash
skopeo copy docker://registry.k8s.io/metrics-server/metrics-server:v0.7.2 \
  docker-archive:metrics-server.tar:registry.k8s.io/metrics-server/metrics-server:v0.7.2
curl -LO https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml
```

Import `metrics-server.tar` on every node (`./node-import.sh metrics-server.tar`), then run `kubectl apply -f components.yaml`. On kubeadm test clusters with self-signed kubelet certificates, add `--kubelet-insecure-tls` to the metrics-server container's `args`. Check with `kubectl top nodes`.

## Upgrading

```bash
git pull
make bundle
# on every node:
tar -xf k8s-image-loader-bundle-<version>.tar && cd k8s-image-loader-bundle-<version> && ./node-import.sh . localhost:30500
# then:
kubectl apply -k deploy
kubectl -n k8s-image-loader delete pod -l app.kubernetes.io/name=k8s-image-loader
```

Each version uses new image tags, so a node never keeps running an old copy. The dashboard header shows the running version. Users, tokens and the registry's images are kept across upgrades.

## Uninstalling

```bash
make undeploy                     # dashboard and agents; the registry and its images stay
kubectl delete -k deploy/registry # everything else: the registry, its images, users (deletes the namespace)
```

`deploy/registry` contains the `k8s-image-loader` namespace, so the second command removes it with everything in it: the registry's claim (and so its images), the users and the tokens.

The registry settings on the nodes (`registries.conf.d/50-k8s-image-loader.conf`, or `certs.d/localhost:30500/`) are small files you can delete by hand.
