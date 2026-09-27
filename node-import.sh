#!/usr/bin/env bash
# Import image tars into THIS node's container runtime, and optionally let the runtime
# pull from the local registry over plain HTTP.
#
#   containerd / k3s / RKE2  ->  ctr -n k8s.io images import
#   CRI-O                    ->  skopeo copy docker-archive: containers-storage:
#
# Usage (as root):
#   ./node-import.sh <bundle.tar | bundle-dir | image.tar ...> [registry-host:port]
#   ./node-import.sh k8s-image-loader-bundle-1.2.0.tar localhost:30500
#   ./node-import.sh . localhost:30500            # inside the unpacked bundle folder
#   ./node-import.sh myapp.tar                    # any docker save / skopeo tar
set -euo pipefail

# Paths can be overridden (useful for testing or unusual layouts)
CONTAINERD_SOCK="${CONTAINERD_SOCK:-/run/containerd/containerd.sock}"
K3S_SOCK="${K3S_SOCK:-/run/k3s/containerd/containerd.sock}"
CRIO_SOCKS="${CRIO_SOCKS:-/run/crio/crio.sock /var/run/crio/crio.sock}"
ETC="${ETC:-/etc}"
RKE2_CTR="${RKE2_CTR:-/var/lib/rancher/rke2/bin/ctr}"

say() { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ $# -ge 1 ] || die "usage: $0 <bundle.tar | dir | image.tar ...> [registry-host:port]"
[ "$(id -u)" -eq 0 ] || [ -n "${ALLOW_NON_ROOT:-}" ] || die "run as root"

# Last argument is the registry if it looks like host:port and is not a file
REG=""
last="${!#}"
if [ $# -ge 2 ] && [ ! -e "$last" ] && [[ "$last" =~ ^[A-Za-z0-9.-]+(:[0-9]+)?$ ]]; then
  REG="$last"; set -- "${@:1:$#-1}"
fi

# ---------------------------------------------------------------- detect the runtime
CRIO_SOCK=""
for s in $CRIO_SOCKS; do [ -S "$s" ] && CRIO_SOCK="$s" && break; done
if [ -S "$K3S_SOCK" ] && command -v k3s >/dev/null; then
  RT=k3s;  CTR=(k3s ctr -n k8s.io)
elif [ -S "$K3S_SOCK" ] && [ -x "$RKE2_CTR" ]; then
  RT=rke2; CTR=("$RKE2_CTR" --address "$K3S_SOCK" -n k8s.io)
elif [ -S "$CONTAINERD_SOCK" ]; then
  RT=containerd; command -v ctr >/dev/null || die "ctr not found (it ships with containerd)"
  CTR=(ctr --address "$CONTAINERD_SOCK" -n k8s.io)
elif [ -n "$CRIO_SOCK" ]; then
  RT=crio; command -v skopeo >/dev/null || die "CRI-O nodes need skopeo: dnf install -y skopeo
   (offline: on a connected machine run 'dnf download --resolve skopeo', copy the RPMs, 'dnf install ./*.rpm')"
else
  die "no containerd or CRI-O socket found on this node"
fi
say "Runtime: $RT"

# ---------------------------------------------------------------- collect image tars
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
TARS=()
# Read the whole listing (no grep -q): an early-exiting grep kills tar with SIGPIPE,
# which pipefail turns into a random "not an image" result.
is_image_tar() {
  local n
  n=$(tar -tf "$1" 2>/dev/null | grep -cE '^(\./)?(manifest\.json|index\.json)$' || true)
  [ "${n:-0}" -gt 0 ]
}
add_dir() {
  local f
  if [ -f "$1/SHA256SUMS" ]; then
    ( cd "$1" && sha256sum -c --quiet SHA256SUMS ) || die "checksum mismatch in $1 (copy the bundle again)"
    say "Checksums OK ($1)"
  fi
  for f in "$1"/*.tar; do
    [ -f "$f" ] || continue
    if is_image_tar "$f"; then TARS+=("$f"); else warn "$(basename "$f") is not an image archive; skipped"; fi
  done
  return 0
}
for arg in "$@"; do
  if [ -d "$arg" ]; then add_dir "$arg"
  elif [ -f "$arg" ] && is_image_tar "$arg"; then TARS+=("$arg")
  elif [ -f "$arg" ]; then                      # a bundle: a tar holding image tars
    tar -xf "$arg" -C "$TMP"
    while IFS= read -r d; do add_dir "$d"; done < <(find "$TMP" -type d)
  else die "$arg not found"
  fi
done
[ ${#TARS[@]} -gt 0 ] || die "no image tars found in: $*"

# Image names inside a docker-archive tar, without needing python
# (tolerates both compact and pretty JSON; never fails, prints nothing if there are no names)
repo_tags() {
  { tar -xOf "$1" manifest.json 2>/dev/null || tar -xOf "$1" ./manifest.json 2>/dev/null; } \
    | tr -d '\n' | grep -oE '"RepoTags"[[:space:]]*:[[:space:]]*\[[^]]*\]' \
    | sed -E 's/"RepoTags"[[:space:]]*:[[:space:]]*//' | grep -oE '"[^"]+"' | tr -d '"' || true
}

# ---------------------------------------------------------------- import
IMPORTED=()
for t in "${TARS[@]}"; do
  tags=$(repo_tags "$t")
  if [ "$RT" = crio ]; then
    if [ -z "$tags" ]; then
      warn "$(basename "$t"): no image name inside (OCI archive?); skipped. Push it through the dashboard instead."
      continue
    fi
    for ref in $tags; do
      say "skopeo: $ref  ($(basename "$t"))"
      skopeo copy --quiet "docker-archive:$t:$ref" "containers-storage:$ref"
      IMPORTED+=("$ref")
    done
  else
    say "ctr: $(basename "$t")"
    "${CTR[@]}" images import "$t"
    for ref in $tags; do IMPORTED+=("$ref"); done
  fi
done

# Full name as the runtime stores it: nginx:1 -> docker.io/library/nginx:1
normalize() {
  local r=$1 first=${1%%/*}
  if [[ "$r" != */* ]]; then r="docker.io/library/$r"
  elif [[ "$first" != *.* && "$first" != *:* && "$first" != localhost ]]; then r="docker.io/$r"; fi
  [[ "${r##*/}" == *:* || "$r" == *@* ]] || r="$r:latest"
  printf '%s' "$r"
}

# Read every image back from the runtime; never report success without proof
say "Verifying ${#IMPORTED[@]} image(s) in $RT:"
[ "$RT" != crio ] && STORED="$("${CTR[@]}" images ls -q 2>/dev/null || true)"
MISSING=0
for ref in "${IMPORTED[@]}"; do
  full=$(normalize "$ref")
  if [ "$RT" = crio ]; then
    skopeo inspect --format x "containers-storage:$full" >/dev/null 2>&1 && found=1 || found=0
  else
    grep -qxF "$full" <<<"$STORED" && found=1 || found=0
  fi
  if [ $found = 1 ]; then printf '      OK       %s\n' "$full"; else printf '      MISSING  %s\n' "$full"; MISSING=$((MISSING+1)); fi
done
[ $MISSING -eq 0 ] || die "$MISSING image(s) are not in $RT after import; see above"

# ---------------------------------------------------------------- registry trust
[ -n "$REG" ] || { say "Done"; exit 0; }
say "Allowing pulls from http://$REG"
case "$RT" in
  containerd)
    mkdir -p "$ETC/containerd/certs.d/$REG"
    cat > "$ETC/containerd/certs.d/$REG/hosts.toml" <<TOML
# Managed by k8s-image-loader
server = "http://$REG"

[host."http://$REG"]
  capabilities = ["pull", "resolve"]
  skip_verify = true
TOML
    say "Wrote $ETC/containerd/certs.d/$REG/hosts.toml"
    if ! grep -qE '^\s*config_path\s*=' "$ETC/containerd/config.toml" 2>/dev/null \
       && ! [[ "$(containerd --version 2>/dev/null)" =~ \ v?2\. ]]; then
      warn "containerd 1.x reads that file only with config_path set. Add under"
      warn "  [plugins.\"io.containerd.grpc.v1.cri\".registry]   in $ETC/containerd/config.toml:"
      warn "  config_path = \"/etc/containerd/certs.d\""
      warn "then run: systemctl restart containerd"
    fi ;;
  k3s|rke2)
    f="$ETC/rancher/$RT/registries.yaml"
    if grep -q "\"$REG\"" "$f" 2>/dev/null; then say "$f already lists $REG"
    elif [ -s "$f" ] && grep -q '^mirrors:' "$f"; then
      warn "$f already has mirrors; add \"$REG\" with endpoint http://$REG by hand"
    else
      mkdir -p "$(dirname "$f")"
      printf 'mirrors:\n  "%s":\n    endpoint:\n      - "http://%s"\n' "$REG" "$REG" >> "$f"
      warn "Updated $f; restart to apply: systemctl restart $RT-server (or $RT-agent)"
    fi ;;
  crio)
    mkdir -p "$ETC/containers/registries.conf.d"
    printf '# Managed by k8s-image-loader\n[[registry]]\nlocation = "%s"\ninsecure = true\n' "$REG" \
      > "$ETC/containers/registries.conf.d/50-k8s-image-loader.conf"
    say "Wrote $ETC/containers/registries.conf.d/50-k8s-image-loader.conf"
    systemctl reload crio 2>/dev/null && say "Reloaded CRI-O" || warn "Reload CRI-O to apply: systemctl reload crio" ;;
esac
say "Done"
