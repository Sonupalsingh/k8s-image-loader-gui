# Getting started: a step-by-step guide for beginners

This guide takes you from nothing to a working dashboard, one small step at a time. Every command is explained, and after each step you'll see what you should expect. There are separate instructions for **Ubuntu** and **RHEL** (RHEL, Rocky Linux and AlmaLinux work the same way).

Plan about **45 minutes** the first time.

**Contents**

1. [What you are going to install](#1-what-you-are-going-to-install)
2. [A few words you need to know](#2-a-few-words-you-need-to-know)
3. [Check your setup before you start](#3-check-your-setup-before-you-start)
4. [Prepare the build machine](#4-prepare-the-build-machine)
5. [Download the project](#5-download-the-project)
6. [Build the bundle](#6-build-the-bundle)
7. [Put the bundle on every node](#7-put-the-bundle-on-every-node)
8. [Install the local registry](#8-install-the-local-registry)
9. [Install the dashboard](#9-install-the-dashboard)
10. [Open the dashboard in your browser](#10-open-the-dashboard-in-your-browser)
11. [Your first deployment](#11-your-first-deployment)
12. [If something goes wrong](#12-if-something-goes-wrong)
13. [Command cheat sheet](#13-command-cheat-sheet)

---

## 1. What you are going to install

Three small programs, all running **inside your Kubernetes cluster**:

| Program | What it does | Where it runs |
|---|---|---|
| **Dashboard** | The website you use in your browser | 1 copy, anywhere in the cluster |
| **Node agent** | A helper that puts images onto a server (a "node") | 1 copy **on every node** |
| **Local registry** | A storage place for your images, inside the cluster | 1 copy |

Your cluster doesn't need internet access. Only **one** computer needs internet, and only once, to download and build these programs. We call that computer the **build machine**.

## 2. A few words you need to know

| Word | Meaning |
|---|---|
| **Node** | One server (physical or virtual) that is part of your Kubernetes cluster |
| **kubectl** | The command-line tool that talks to Kubernetes. If `kubectl get nodes` works, you're ready |
| **Image** | A packaged application. Kubernetes starts containers from images |
| **Tar file** | An image saved as one file (`something.tar`), so you can copy it to a computer without internet |
| **Container runtime** | The program on each node that runs containers. Yours is **CRI-O** or **containerd** |
| **Registry** | A server that stores images, so all nodes can fetch them |
| **Namespace** | A folder inside Kubernetes. This tool lives in the namespace `k8s-image-loader` |
| **Token** | Your password for the dashboard |
| **`sudo`** | Runs a command as the administrator (root). Some steps need it |

## 3. Check your setup before you start

Run these commands on a computer where `kubectl` works (often the Kubernetes master node).

**a) Can you reach the cluster?**

```bash
kubectl get nodes -o wide
```

You should see a list of your nodes with `STATUS Ready`. Look at two columns and write them down:

- **INTERNAL-IP**: the address of each node, for example `192.168.200.151`. You'll need it to open the dashboard.
- **CONTAINER-RUNTIME**: `cri-o://…` means your nodes use **CRI-O**, and `containerd://…` means **containerd**. You'll need this in [step 7](#7-put-the-bundle-on-every-node).

Example:

```
NAME           STATUS   ...   INTERNAL-IP       OS-IMAGE                      CONTAINER-RUNTIME
ram.test.com   Ready    ...   192.168.200.151   Red Hat Enterprise Linux 9.4  cri-o://1.29.1
```

> If `kubectl get nodes` gives an error, fix that first. This tool needs a working cluster and admin access (`kubectl` with cluster-admin rights).

**b) Which operating system is your build machine?**

```bash
cat /etc/os-release | head -3
```

It says `Ubuntu` or `Red Hat Enterprise Linux` (or Rocky / AlmaLinux). Follow the matching instructions below. For Ubuntu, use **22.04 or newer**: older versions don't have the `skopeo` package.

**c) Does the build machine have internet?**

```bash
curl -sI https://registry-1.docker.io/v2/ | head -1
```

If this prints a line starting with `HTTP`, you have internet. If it prints nothing, use another computer with internet as the build machine. You'll copy one file from it later.

## 4. Prepare the build machine

The build machine needs these tools:

| Tool | Why |
|---|---|
| `git` | To download the project |
| `make` | To run the build with one short command |
| `skopeo` | To download and save images |
| `buildah` (or `docker`) | To build the dashboard and agent images |
| `python3` | Used by the build script in some cases |

### If your build machine runs Ubuntu

```bash
sudo apt-get update
sudo apt-get install -y git make skopeo buildah python3
```

### If your build machine runs RHEL, Rocky or AlmaLinux

```bash
sudo dnf install -y git make skopeo buildah python3 tar
```

> **RHEL error `Cannot download repomd.xml` or `not registered`?** Your server installs packages from the RHEL installation DVD, and it isn't mounted. Mount it and try again:
>
> ```bash
> sudo mount /dev/sr0 /mnt          # if the DVD is attached to the VM
> ls /mnt                           # you should see BaseOS and AppStream
> ```
>
> The message "not registered with an entitlement server" is only a warning; you can ignore it.

**Check:** every tool prints a version:

```bash
git --version && make --version | head -1 && skopeo --version && buildah --version
```

> Already have Docker? That works too. The build script uses `docker` if it runs, otherwise `buildah`.

## 5. Download the project

```bash
cd ~
git clone https://github.com/Sonupalsingh/k8s-image-loader-gui.git
cd k8s-image-loader-gui
ls
```

**You should see:** `Makefile  README.md  agent  dashboard  deploy  docs  scripts`

> **Important:** run all following `make` commands **inside this folder**. The error `No rule to make target` means you are in the wrong folder.

## 6. Build the bundle

The **bundle** is one file that contains the three programs (dashboard, agent, registry). Build it:

```bash
sudo make bundle
```

What this does:
1. It downloads the registry program.
2. It builds the dashboard and the agent.
3. It checks each image.
4. It packs everything into one file.

The first time takes **5 to 15 minutes**, depending on your internet speed.

**You should see at the end:**

```
==> Bundle: k8s-image-loader-bundle-1.6.0.tar (406M)
    amd64  registry.tar
    amd64  dashboard.tar
    amd64  agent.tar
```

**Check** that the file exists:

```bash
ls -lh k8s-image-loader-bundle-*.tar
```

> A message like `docker's image store is incomplete … flattening with docker export` is normal. The script handles it.
>
> Your nodes are ARM (for example a Raspberry Pi)? Use `sudo PLATFORM=linux/arm64 make bundle`.

## 7. Put the bundle on every node

**Every node** needs the bundle, because the node agent runs on every node. Do the following for **each node**.

**a) Copy the bundle to the node.** Replace `NODE-IP` with the node's address from step 3:

```bash
scp k8s-image-loader-bundle-1.6.0.tar root@NODE-IP:/root/
```

> Is the build machine itself a node? Then skip the copy for that node.

**b) Log in to the node and unpack:**

```bash
ssh root@NODE-IP
cd /root
tar -xf k8s-image-loader-bundle-1.6.0.tar
cd k8s-image-loader-bundle-1.6.0
```

**c) Check the node's runtime tool.** This depends on the runtime you wrote down in step 3:

| Your runtime | What the node needs | Install it (Ubuntu) | Install it (RHEL) |
|---|---|---|---|
| **CRI-O** | `skopeo` | `sudo apt-get install -y skopeo` | `sudo dnf install -y skopeo` |
| **containerd** | `ctr` | already there (comes with containerd) | already there (comes with containerd) |

> **The node has no internet?** On the build machine, download the package and copy it over:
> - **RHEL:** run `dnf download --resolve skopeo`, copy the `.rpm` files to the node, then run `sudo dnf install ./*.rpm` there.
> - **Ubuntu:** run `apt-get download skopeo` plus its dependencies, copy the `.deb` files, then run `sudo apt-get install ./*.deb` there.

**d) Import the bundle:**

```bash
sudo ./node-import.sh . localhost:30500
```

What the two parts mean:
- `.` means "the bundle in this folder".
- `localhost:30500` is the address of the local registry. The script configures the runtime to trust it.

**You should see** (example for CRI-O):

```
==> Runtime: crio  (kubelet endpoint unix:///var/run/crio/crio.sock (from kubelet process))
==> Checksums OK (.)
==> Verifying 3 image(s) in crio:
      OK       docker.io/k8s-image-loader/agent:1.6.0
      OK       docker.io/k8s-image-loader/dashboard:1.6.0
      OK       docker.io/library/registry:2.8.3
==> Done
```

**Check three things:**

1. **The first line** names the runtime from step 3. If it's wrong, run it again with the right one: `sudo RUNTIME=crio ./node-import.sh . localhost:30500` (or `RUNTIME=containerd`).
2. **All three images say `OK`.**
3. **Lines starting with `!!`** are steps you must do by hand. See the next part.

**e) Extra step for containerd 1.x nodes (common on Ubuntu).** If the script printed `!!` lines about `config_path`, do this:

```bash
containerd --version                                            # shows v1.x or v2.x
sudo grep -n 'config_path' /etc/containerd/config.toml
```

If you see a line like `config_path = ""` (empty), change it to point at the right folder, then restart containerd:

```bash
sudo sed -i 's#config_path = ""#config_path = "/etc/containerd/certs.d"#' /etc/containerd/config.toml
sudo grep -n 'config_path' /etc/containerd/config.toml         # now shows /etc/containerd/certs.d
sudo systemctl restart containerd
```

Restarting containerd doesn't stop your running pods.

> **k3s or RKE2?** The script updates `/etc/rancher/k3s/registries.yaml` for you. Afterwards run `sudo systemctl restart k3s` (on worker nodes: `k3s-agent`).

**f) Double-check** that Kubernetes can see the images:

```bash
sudo crictl images | grep -E "k8s-image-loader|registry"
```

You should see `agent`, `dashboard` and `registry`.

**Repeat step 7 for every node.** Then go back to the computer where `kubectl` works.

## 8. Install the local registry

```bash
cd ~/k8s-image-loader-gui
make registry
```

**Check** that the registry is running:

```bash
kubectl -n k8s-image-loader get pods,pvc
```

You should see a pod `image-registry-…` with `STATUS Running`, and `persistentvolumeclaim/registry-data` with `STATUS Bound`.

> **The claim stays `Pending`?** Your cluster has no automatic storage (no "storage class"). Store the registry on a node's disk instead:
>
> ```bash
> kubectl get nodes                                                          # pick a node name
> ssh root@NODE-IP "mkdir -p /mnt/disks/registry"                           # on that node
> sed -i 's/NODE-NAME/<your-node-name>/' deploy/registry/pv-local.example.yaml
> ```
>
> Then open `deploy/registry/kustomization.yaml` in an editor (for example `nano`). Remove the `#` at the start of each line of the `patches:` block, and save. Apply both:
>
> ```bash
> kubectl apply -f deploy/registry/pv-local.example.yaml
> kubectl apply -k deploy/registry
> ```

## 9. Install the dashboard

```bash
make deploy
```

This creates two passwords (tokens) the first time, then installs the dashboard and the node agents. It waits until they are ready.

**Check:**

```bash
kubectl -n k8s-image-loader get pods -o wide
```

**You should see**, all with `STATUS Running`:
- one `image-loader-agent-…` **per node**;
- one `image-loader-dashboard-…`;
- one `image-registry-…`.

**Get your login token** (your admin password) and copy it somewhere safe:

```bash
make token
```

It prints a long line like `df2e74d8fc2fc428a10631a94b37c8dee8d774ff6f7d960a`.

## 10. Open the dashboard in your browser

**a) Make the dashboard reachable** on port **30080** of every node:

```bash
kubectl -n k8s-image-loader patch svc image-loader-dashboard \
  -p '{"spec":{"type":"NodePort","ports":[{"port":80,"targetPort":"http","nodePort":30080}]}}'
```

**b) Open the firewall** on the node you'll use, so your laptop can connect:

On **Ubuntu** (only if the firewall is on; `sudo ufw status` shows `Status: active`):

```bash
sudo ufw allow 30080/tcp
```

On **RHEL**:

```bash
sudo firewall-cmd --permanent --add-port=30080/tcp
sudo firewall-cmd --reload
```

**c) Open the dashboard.** In your browser, go to:

```
http://NODE-IP:30080
```

For example `http://192.168.200.151:30080`. The browser shows "Not secure" because the dashboard uses plain HTTP; that's expected on an internal network.

**d) Sign in.** Paste the token from `make token` and choose **Sign in**.

**You should see:** "Connected to cluster" at the top right, and your deployments in the list.

**e) One-time setup:** open the **Images** tab and choose **Set up nodes**. This makes sure every node can fetch images from the local registry.

## 11. Your first deployment

Let's deploy a small web server (nginx) from a tar file, the same way you will deploy your own applications.

**a) On the build machine, save nginx as a tar file:**

```bash
skopeo copy docker://docker.io/library/nginx:1.27 docker-archive:nginx.tar:docker.io/library/nginx:1.27
ls -lh nginx.tar
```

Copy `nginx.tar` to the computer where you use the browser.

> For your own application, create the tar the same way. From Docker: `docker save myapp:1.0 -o myapp.tar`.

**b) In the dashboard:**

1. Open the **Apply YAML** tab.
2. Choose **New deployment template**. A ready-made example appears.
3. nginx listens on port 80, so in the text change `containerPort: 8080` to `containerPort: 80`, and `targetPort: 8080` to `targetPort: 80`.
4. Choose **Check**. The plan on the right shows **Create** for `my-app` (a Deployment and a Service).
5. Under the container, open the image list and choose **Upload a tar file…**, then choose `nginx.tar`. Keep **To local registry**.
6. Choose **Apply** and confirm.

The dashboard uploads the tar, stores it in the local registry, and creates the deployment.

**c) Check that it runs:**

```bash
kubectl get pods
```

You should see `my-app-…` with `STATUS Running`. In the dashboard, **Workloads** shows `my-app` as **Healthy**.

**d) Try it:**

```bash
kubectl port-forward svc/my-app 8081:80
```

In a second terminal, run `curl http://localhost:8081`. You should see *Welcome to nginx!*

**You did it.** To deploy a new version later, open **Workloads**, choose **Update image** on `my-app`, then **Upload a tar file**. The [user guide](user-guide.md) explains every other screen.

## 12. If something goes wrong

These three commands show what's happening:

```bash
kubectl -n k8s-image-loader get pods -o wide                     # is everything running?
kubectl -n k8s-image-loader logs deploy/image-loader-dashboard   # messages from the dashboard
kubectl describe pod <pod-name>                                  # why a pod doesn't start
```

The most common beginner problems:

| You see | What it means | What to do |
|---|---|---|
| `make: *** No rule to make target 'bundle'` | You're not in the project folder | `cd ~/k8s-image-loader-gui` and try again |
| `make: command not found` | `make` isn't installed | Step 4 (install the tools) |
| `sudo: ./node-import.sh: command not found` | The script isn't executable | `chmod +x node-import.sh`, or run it with `sudo bash node-import.sh …` |
| `tar: This does not look like a tar archive` | You gave node-import.sh the wrong file | Use the **bundle** from step 6, not the project's `.zip` |
| A pod shows `ImagePullBackOff` | The image isn't on that node | Do step 7 on that node; all images must say `OK` |
| `ImagePullBackOff` with `quay.io … unauthorized` | Same: the image isn't on the node, so CRI-O looked on the internet | Step 7 on that node; check that its first line says the right runtime |
| `http: server gave HTTP response to HTTPS client` | The node doesn't trust the local registry yet | **Images**, then **Set up nodes**. On containerd 1.x, do step 7e |
| The browser can't connect to `:30080` | Firewall, or wrong address | Step 10b; use an **INTERNAL-IP** from `kubectl get nodes -o wide` |
| The token is refused | Copy error (a space or line break) | Run `make token` again and copy the whole line |
| `dnf`: `Cannot download repomd.xml` | The RHEL DVD isn't mounted | See the tip in step 4 |

More problems and fixes are in the [troubleshooting guide](troubleshooting.md).

## 13. Command cheat sheet

| What | Command |
|---|---|
| Build the bundle (build machine) | `sudo make bundle` |
| Import on a node (as root) | `sudo ./node-import.sh . localhost:30500` |
| Install the registry | `make registry` |
| Install or update the dashboard | `make deploy` |
| Show the admin token | `make token` |
| See the tool's pods | `make status` |
| Follow the dashboard's log | `make logs` |
| Remove the dashboard (keeps registry and images) | `make undeploy` |

**Updating to a new version later:**

```bash
cd ~/k8s-image-loader-gui && git pull
sudo make bundle
# on every node: copy the new bundle, then
#   tar -xf k8s-image-loader-bundle-<version>.tar && cd k8s-image-loader-bundle-<version>
#   sudo ./node-import.sh . localhost:30500
make deploy
kubectl -n k8s-image-loader delete pod -l app.kubernetes.io/name=k8s-image-loader
```

Your users, tokens and the images in the registry are kept when you update.
