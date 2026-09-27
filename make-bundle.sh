#!/usr/bin/env bash
# Build the bootstrap bundle: one image tar each for the registry, dashboard and agent,
# packed into a single file you copy to every node.
#
# Needs internet, skopeo, and ONE image builder: docker or buildah (podman is not used).
#   RHEL / Rocky / Alma:  dnf install -y skopeo buildah
#   Ubuntu / Debian:      apt-get install -y skopeo buildah
#
#   ./scripts/make-bundle.sh                     # linux/amd64
#   PLATFORM=linux/arm64 ./scripts/make-bundle.sh
#   BUILDER=buildah ./scripts/make-bundle.sh     # force a builder
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${VERSION:-1.2.0}"
PLATFORM="${PLATFORM:-linux/amd64}"
ARCH="${PLATFORM#*/}"
REGISTRY_IMAGE="${REGISTRY_IMAGE:-docker.io/library/registry:2.8.3}"
DASHBOARD="docker.io/k8s-image-loader/dashboard:${VERSION}"
AGENT="docker.io/k8s-image-loader/agent:${VERSION}"
NAME="k8s-image-loader-bundle-${VERSION}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

say() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v skopeo >/dev/null || die "skopeo is required (dnf install -y skopeo)"
if [ -z "${BUILDER:-}" ]; then
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then BUILDER=docker
  elif command -v buildah >/dev/null; then BUILDER=buildah
  else die "an image builder is required: install buildah (dnf install -y buildah) or docker"
  fi
fi
case "$BUILDER" in docker|buildah) ;; *) die "BUILDER must be docker or buildah" ;; esac
say "Builder: $BUILDER, platform: $PLATFORM"
mkdir -p "$WORK/$NAME"

# 1. Registry image: skopeo straight from Docker Hub into a docker-archive tar
say "Pulling $REGISTRY_IMAGE with skopeo"
skopeo copy --override-os linux --override-arch "$ARCH" \
  "docker://$REGISTRY_IMAGE" "docker-archive:$WORK/$NAME/registry.tar:$REGISTRY_IMAGE"

# 2. Dashboard and agent: build, then export to a docker-archive tar
#
# `docker save` output is not always readable by skopeo/ctr. Docker 25+ writes an
# OCI-style layout, and the containerd image store (default in Docker 29) keeps
# references to blobs it never downloaded (other platforms of the base image), so
# save and push fail with "content digest ... not found". Every export is fully
# verified, and the last method does not use the image store at all.

verify() {   # <tar>: read the whole image (manifest, config, every layer)
  local d; d="$(mktemp -d -p "$WORK")"
  if skopeo copy --quiet "docker-archive:$1" "dir:$d" >/dev/null 2>&1; then rm -rf "$d"; return 0; fi
  rm -rf "$d"; return 1
}

# Build an image tar from the container filesystem + the image's settings.
# docker export reads the real filesystem, so nothing can be "not found".
flatten_export() {   # <image> <output tar>
  local image=$1 out=$2 cid rootfs="$WORK/rootfs.tar" cfg="$WORK/imgcfg.json"
  command -v python3 >/dev/null || die "python3 is needed to assemble the image tar"
  cid=$(docker create "$image")
  docker export -o "$rootfs" "$cid"
  docker rm -f "$cid" >/dev/null
  docker image inspect --format '{"os":{{json .Os}},"architecture":{{json .Architecture}},"config":{{json .Config}}}' "$image" > "$cfg"
  python3 - "$rootfs" "$cfg" "$out" "$image" <<'PY'
import hashlib, io, json, sys, tarfile, datetime
rootfs, cfgfile, out, image = sys.argv[1:]
meta = json.load(open(cfgfile))
# Drop files that only exist because of `docker create` (the runtime recreates them)
SKIP = {".dockerenv", "etc/hostname", "etc/hosts", "etc/resolv.conf"}
layer = out + ".layer"
with tarfile.open(rootfs) as src, tarfile.open(layer, "w", format=tarfile.PAX_FORMAT) as dst:
    for m in src:
        name = m.name[2:] if m.name.startswith("./") else m.name   # not lstrip: it would eat ".dockerenv"
        if name.lstrip("/") in SKIP:
            continue
        dst.addfile(m, src.extractfile(m) if m.isreg() else None)
h = hashlib.sha256()
with open(layer, "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
        h.update(chunk)
diff_id = h.hexdigest()
c = meta.get("config") or {}
keep = ("User", "ExposedPorts", "Env", "Entrypoint", "Cmd", "Volumes", "WorkingDir", "Labels", "StopSignal")
config = {
    "architecture": meta.get("architecture") or "amd64",
    "os": meta.get("os") or "linux",
    "created": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "config": {k: c[k] for k in keep if c.get(k) not in (None, "", [], {})},
    "rootfs": {"type": "layers", "diff_ids": ["sha256:" + diff_id]},
    "history": [{"created_by": "k8s-image-loader make-bundle (flattened from " + image + ")"}],
}
cfg_bytes = json.dumps(config, separators=(",", ":")).encode()
cfg_id = hashlib.sha256(cfg_bytes).hexdigest()
manifest = json.dumps([{"Config": cfg_id + ".json", "RepoTags": [image], "Layers": [diff_id + "/layer.tar"]}]).encode()
with tarfile.open(out, "w") as t:
    for name, data in ((cfg_id + ".json", cfg_bytes), ("manifest.json", manifest)):
        ti = tarfile.TarInfo(name); ti.size = len(data); t.addfile(ti, io.BytesIO(data))
    t.add(layer, diff_id + "/layer.tar")
import os; os.remove(layer)
PY
  rm -f "$rootfs" "$cfg"
}

export_docker() {   # <image> <output tar>
  local image=$1 out=$2 raw="$WORK/raw-$(basename "$2")"
  # Method 1: docker save
  if docker save -o "$raw" "$image" 2>/dev/null; then
    cp "$raw" "$out"
    if verify "$out"; then say "  exported with docker save"; rm -f "$raw"; return 0; fi
    # Method 2: the same tar read as an OCI archive (Docker 25+ format)
    rm -f "$out"
    if skopeo copy --quiet "oci-archive:$raw" "docker-archive:$out:$image" >/dev/null 2>&1 && verify "$out"; then
      say "  docker save output was OCI format; converted"; rm -f "$raw"; return 0
    fi
  fi
  rm -f "$out" "$raw"
  # Method 3: save only this platform (Docker versions that support --platform)
  if docker save --platform "$PLATFORM" -o "$raw" "$image" 2>/dev/null; then
    if skopeo copy --quiet "docker-archive:$raw" "docker-archive:$out:$image" >/dev/null 2>&1 && verify "$out"; then
      say "  exported with docker save --platform $PLATFORM"; rm -f "$raw"; return 0
    fi
    rm -f "$out"
    if skopeo copy --quiet "oci-archive:$raw" "docker-archive:$out:$image" >/dev/null 2>&1 && verify "$out"; then
      say "  exported with docker save --platform $PLATFORM (OCI format, converted)"; rm -f "$raw"; return 0
    fi
  fi
  rm -f "$out" "$raw"
  # Method 4: flatten the container filesystem (independent of Docker's image store)
  say "  docker's image store is incomplete (containerd store); flattening with docker export"
  flatten_export "$image" "$out"
  verify "$out" || die "could not export $image in a readable format"
  say "  exported as a flattened image"
}

build_and_export() {   # <context dir> <image name> <output tar>
  local ctx=$1 image=$2 out=$3
  say "Building $image"
  if [ "$BUILDER" = docker ]; then
    docker build --platform "$PLATFORM" -t "$image" "$ctx"
    export_docker "$image" "$out"
  else
    buildah bud --platform "$PLATFORM" --layers -t "$image" "$ctx"
    buildah push "$image" "docker-archive:$out:$image"
    verify "$out" || die "buildah export of $image is not readable"
  fi
}

verify "$WORK/$NAME/registry.tar" || die "registry.tar from skopeo failed verification"
build_and_export dashboard "$DASHBOARD" "$WORK/$NAME/dashboard.tar"
build_and_export agent     "$AGENT"     "$WORK/$NAME/agent.tar"

# 3. Pack everything, including the node import script, into one file
cp scripts/node-import.sh "$WORK/$NAME/"
( cd "$WORK/$NAME" && sha256sum ./*.tar > SHA256SUMS )
tar -C "$WORK" -cf "$NAME.tar" "$NAME"

say "Bundle: $NAME.tar ($(du -h "$NAME.tar" | cut -f1))"
for t in registry dashboard agent; do
  skopeo inspect --format "    {{.Architecture}}  $t.tar" "docker-archive:$WORK/$NAME/$t.tar" 2>/dev/null \
    || echo "    $t.tar"
done
cat <<EOF

Next, on EVERY node (as root):
  tar -xf $NAME.tar && cd $NAME
  ./node-import.sh . localhost:30500
CRI-O nodes need skopeo; containerd, k3s and RKE2 nodes use ctr, which they already have.
EOF
