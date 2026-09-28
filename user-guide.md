# User guide

How to use each part of the dashboard. What you see depends on your **role**: buttons for work your role can't do are hidden, and the server refuses such requests anyway. See [Users](#users).

- [Signing in](#signing-in)
- [Workloads](#workloads): deploy images, restart, manage, autoscale, delete
- [Images](#images): local registry, images on nodes, cleanup
- [Apply YAML](#apply-yaml)
- [Config maps and secrets](#config-maps-and-secrets)
- [Storage](#storage)
- [Nodes and activity](#nodes-and-activity)
- [Users](#users)

## Signing in

Open the dashboard address (for example `http://<node-ip>:30080`) and paste your **access token**. An admin gives you one; the built-in admin token comes from `make token`. The header shows who you are, for example `ravi · deployer · shop`: name, role, namespaces.

The namespace selector at the top filters most screens. You only ever see namespaces your user may access.

## Workloads

![Workloads](images/workloads.png)

Every Deployment you may see, with its status, pods ready, containers and images. The page refreshes every 10 seconds.

### Update image

**Update image** changes the image of one container. Choose where the image comes from:

![Update image](images/update-image.png)

| Source | What happens | Use it when |
|---|---|---|
| **From the local registry** | Pick a repository and tag. The container you choose is pre-selected. | Promoting or rolling back a version that is already in the registry |
| **Upload a tar file, to the local registry** | The tar is pushed to the registry, then deployed | A new build (recommended: every node, even a new one, can pull it) |
| **Upload a tar file, onto each node** | The node agents import the tar into CRI-O or containerd on every node. No registry involved | The registry is off, or you don't use one. Nodes added later won't have the image |

Tar files come from `docker save`, `skopeo copy … docker-archive:…` or `ctr export`, and gzipped tars work too.

- **Image name**: leave it empty to use the name inside the tar, or enter one such as `team/api:1.4.2`.
- **Add a unique timestamp tag** (on by default) turns `myapp:latest` into `myapp:build-20260927101500`. Every node then runs exactly this build, and rollback is unambiguous.
- **Pull policy**: `IfNotPresent` uses the copy on the node, and fits unique tags. Use `Always` only for tags you overwrite. `Never` fails instead of pulling if a node lacks the image.

After you start, the sheet follows the job live, stage by stage: *Inspect archive*, *Push to registry* or *Load on nodes*, *Update deployment*, *Roll out pods*. It also reports pod problems such as `ErrImagePull` or `CrashLoopBackOff`. If the image could not be loaded on every node, **the deployment is not changed**. When a rollout fails, **Roll back** restores the previous image.

### YAML

**YAML** opens the Deployment's current definition, cleaned of status and server fields, in [Apply YAML](#apply-yaml). Edit it and apply. This also works for Deployments created with `kubectl`.

### Manage

**Manage** opens everything about one Deployment:

| Section | What you can do |
|---|---|
| **Replicas** | Set the number of pods. **Restart pods** replaces them one by one, for example to pick up changed configuration |
| **Autoscaling** | See below |
| **Containers** | Each container's image (with **Update image**), and environment loaded from config maps or secrets (`envFrom`) |
| **Storage** | Add or remove volumes: a persistent volume claim, a node directory (hostPath, optionally pinning the Deployment to that node), scratch space (emptyDir), or a config map or secret as files |
| **Pods** | Every pod, its node, restarts and current problem |
| **Delete deployment** | See below |

Changes use optimistic locking. If someone else changed the Deployment in the meantime, your save is refused with a clear message instead of overwriting their change.

### Autoscaling

![Autoscaling](images/manage-autoscaling.png)

Set **Minimum pods**, **Maximum pods** and a **CPU target** (and optionally a memory target), then choose **Turn on autoscaling**. This creates a standard Kubernetes HorizontalPodAutoscaler (`autoscaling/v2`). While it is on:

- the section shows current pods and CPU;
- manual scaling is replaced by a note, because the autoscaler would override it;
- **Save autoscaling** changes the limits, and **Turn off** removes the autoscaler and keeps the current pods.

The dashboard checks the two things an autoscaler needs:

- **metrics-server** must be installed ([how](installation.md#9-optional-metrics-server-for-autoscaling)); without it, you see a warning.
- **A CPU request** on each container, because the target is a percentage of it. If one is missing, the dashboard offers to set it (100m by default).

### Delete deployment

![Delete deployment](images/delete-deployment.png)

At the bottom of Manage, for **editors and admins**. **Delete deployment…** first shows what goes with it:

- all its pods, and its **autoscaler**;
- its **Services**, if you tick the option, but only those no other Deployment uses (a shared Service is kept, and the preview names who still uses it);
- **storage claims are never deleted**, so their data is safe.

Confirm by typing the Deployment's name.

## Images

### Local registry

![Local registry](images/images-registry.png)

- **The switch** (admins with all-namespace scope): **Switch off** stops the registry pod. Its images stay on its volume and come back with **Switch on**. While it is off, registry options disappear from the forms. Running pods keep running, but new pods on nodes without a copy of their image can't start. A registry you run elsewhere shows as **External** and has no switch.
- **Push image tar** stores images without deploying them. A tar with several images pushes all of them. You may give a single image a name, such as `team/billing:2.3.0`.
- **Show tags** lists each tag with its build time, size, platform and who uses it. **Deploy** puts it into a Deployment, **Copy name** copies the full name, and **Delete** removes it (refused while in use, unless you confirm).
- **Set up nodes** lets every node's runtime pull from the registry over plain HTTP. It reports per node whether a manual step is left (for example `config_path` on containerd 1.x).

Deleting tags frees space only after the registry's garbage collection. Run it when nobody is pushing:

```bash
kubectl -n k8s-image-loader exec deploy/image-registry -- \
  registry garbage-collect --delete-untagged /etc/docker/registry/config.yml
```

### On nodes

![Images on nodes](images/images-on-nodes.png)

Every image on each node's runtime, read with `crictl` exactly as the kubelet sees it. Kubernetes can start these without pulling. For each image: size, nodes, and who uses it.

- **Filters**: *Used by Kubernetes (CRI-O / containerd)*, *Docker only*, or *All*; one node or all; *Only images nothing uses*.
- **Docker's images** are listed separately, marked *not used by Kubernetes*. Pods can't start from them; load them with Update image or `node-import.sh` first.
- **Deploy** puts an on-node image into a Deployment, and warns when the image is only on some nodes.
- **Remove** (admins with all-namespace scope) deletes an image from the nodes. It asks for confirmation if something uses it, and the runtime refuses while a container runs from it.

### Clean up

![Clean up](images/cleanup-images.png)

**Clean up…** frees disk space. Choose:

- **Dangling images**: untagged leftovers of older versions and imports;
- **Dangling and unused images**: also tagged images that nothing in the cluster uses;
- optionally **Docker's dangling images** (`docker image prune`).

Choose **Preview** to see exactly which images would go and how much space that frees; nothing is removed yet. Then choose **Remove**.

**Always protected**: images of any pod (including system pods such as `kube-apiserver` or `etcd`) and of every workload template (Deployments, StatefulSets, DaemonSets, Jobs and CronJobs), **including workloads scaled to zero**, such as a switched-off registry. Also protected: images the runtime pins as system images, and anything the runtime reports as in use. If the dashboard can't check all of these, it removes nothing.

In an air-gapped cluster, keep this in mind: an image removed as *unused* must be loaded again (from its tar or the registry) before it can be deployed again.

## Apply YAML

![Apply YAML](images/apply-yaml.png)

Works like `kubectl apply`, from the browser:

1. Drop `.yaml` files, paste YAML, or choose **New deployment template**.
2. Choose **Check**. The API server validates everything in a **dry run**, and the plan shows what would be **created** or **updated**. Nothing changes yet.
3. For **each container**, choose the image: **Keep** the one in the YAML, a tag from the **local registry**, or **Upload a tar file** (to the registry, or onto each node).
4. Choose **Apply**. Tars are loaded first, then the YAML is applied with the chosen images.

- **All or nothing**: if the API server would reject any object, nothing is changed.
- **Strict checks**: a misspelled or misplaced field (for example a config map key not indented under `data:`) is an error, not silently dropped. Invalid YAML is reported with its line number.
- **Always use full names** (on by default) turns `nginx:1.27` into `docker.io/library/nginx:1.27`, so CRI-O never guesses a registry.
- **Supported kinds**: Deployment, StatefulSet, Service, Ingress, ConfigMap, Secret, PersistentVolumeClaim, ServiceAccount, HorizontalPodAutoscaler. Each needs the matching role: Deployer for workloads and Services, Editor for config maps and claims, Admin for secrets.

## Config maps and secrets

Lists with a **Used by** column, so you see which Deployments depend on each one.

- **New** / **Edit**: add keys by typing, or with **Add key from file** for config files and certificates. A key's value is the *content* of one setting or file. If you load a whole Kubernetes manifest into a key, the dashboard offers to open it in Apply YAML instead.
- **After saving**, keep **Restart the deployments that use it** ticked. Environment variables and `subPath` mounts only change when pods restart.
- **Secret types**: generic, **Docker registry login** (built from server, username and password), **TLS certificate**, basic auth and SSH key. Required keys are checked before saving.
- **Secret values** stay hidden until you choose **Show**, and each view is recorded in the change log. Binary values are kept unchanged when you edit other keys.
- **Delete** asks you to type the name, and warns first if something still uses it.

## Storage

- **Storage classes**: the default class and which classes allow resizing. **Add local disk class** creates a `kubernetes.io/no-provisioner` class with `WaitForFirstConsumer`, the standard setup for node disks.
- **Persistent volumes** (admins with all-namespace scope): register a **local disk** (pinned to its node; the node agent can create its directory under `/mnt/disks` or `/var/lib/k8s-volumes`), a **node directory**, or an **NFS share**. **Make available** returns a Released volume to the pool with its data intact.
- **Claims**: create one from a class or bound to a specific volume, **Resize** it when the class allows expansion, and delete it once nothing mounts it.

**Typical local-disk setup**:
1. Add the local disk class.
2. Create a volume per disk (node, path, size).
3. Create a claim with that class.
4. In Manage, then Storage, add the claim to a Deployment.

Kubernetes binds the claim to a disk on the node where the pod runs.

## Nodes and activity

![Nodes and activity](images/nodes-activity.png)

- **Nodes**: each node's state, runtime, whether its agent is ready, and whether it pulls from the local registry.
- **Recent image jobs**: uploads, pushes, loads and rollouts. Open one to see its stages and log again.
- **Change log**: every change made through the dashboard, with **who** made it and when. Admins see everyone's changes; other users see their own. The same entries go to the dashboard's log with the prefix `AUDIT`, for your log collector.

## Users

![Users](images/users.png)

Admins with all-namespace scope manage users on the **Users** tab.

| Role | What they can do |
|---|---|
| **Viewer** | See everything in their namespaces. Change nothing |
| **Deployer** | Deploy images and tar files, apply workload YAML, restart, scale, autoscale, roll back, push images |
| **Editor** | Deployer, plus config maps, volumes and environment of workloads, storage claims, deleting Deployments |
| **Admin** | Everything in their namespaces, including secrets. With **All namespaces**, also nodes, persistent volumes, storage classes, the registry switch, image cleanup and users |

**Scope** is either **All namespaces (whole cluster)** or a list of namespaces.

![Add user](images/add-user.png)

- **Add user**: choose a name, role and scope. The token is shown **once**. Send it with the dashboard address through a private channel.
- **Edit** changes role or scope, **New token** replaces the token (the old one stops working immediately), and **Disable** and **Delete** lock someone out. All of these take effect at the user's next click.
- **The built-in admin** is the token in the `dashboard-auth` secret. It always works, so you can't lock yourself out. Keep it for emergencies, and use a personal admin user day to day.

These are **dashboard** users. They don't get `kubectl` access to the cluster; for that, use Kubernetes RBAC (Roles and RoleBindings).
