#!/usr/bin/env bash
# Reproducible resolver wasm build in OutLayer's pinned amd64 compiler image.
# Mirrors OutLayer scripts/build_github_wasm.sh (wasm32-wasip2 recipe: cargo build
# --release --locked, then wasm-tools strip) but with our cargo features, which that
# script cannot pass. Source = `git archive <commit> resolver` (nothing else).
#
# Usage: build_reproducible.sh <commit> <route> <outdir>
#   route=run : docker run, source bind-mounted read-only
#   route=cp  : docker create + docker cp in/out, no bind mounts (fresh container)
# Prints the sha256 of <outdir>/module.wasm on stdout (logs on stderr).
set -euo pipefail
COMMIT="${1:?commit}"; ROUTE="${2:?run|cp}"; OUT="${3:?outdir}"
IMAGE="${OUTLAYER_COMPILER_IMAGE:-outlayer/wasmedge-compiler@sha256:d9eb7bd9bab6c46b77f309ec33e94ca112883268a848dd1929289fade799cd27}"
FEATURES="${FEATURES:-real-http,outlayer-sign}"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
[ "$(docker image inspect "$IMAGE" --format '{{.Architecture}}')" = amd64 ] || { echo "image is not amd64" >&2; exit 1; }
# The source dir must live under $HOME: colima only shares $HOME into its VM, so a
# bind mount from /var/folders arrives empty.
SRC="$(mktemp -d "${RB_TMP:-$HOME/.cache}/rbsrc.XXXXXX" 2>/dev/null || { mkdir -p "$HOME/.cache"; mktemp -d "$HOME/.cache/rbsrc.XXXXXX"; })"; mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
CID=""
cleanup() { [ -z "$CID" ] || docker rm -f "$CID" >/dev/null 2>&1 || true; rm -r -f "$SRC"; }
trap cleanup EXIT
git -C "$ROOT" archive "$COMMIT" resolver | tar -x -C "$SRC"
chmod -R a+rX "$SRC"
RECIPE='set -eu
. /usr/local/cargo/env
rustup target add wasm32-wasip2 >/dev/null 2>&1
mkdir -p /workspace /outlayer/out
cp -a /outlayer/src /workspace/repo
cd /workspace/repo/resolver
cargo build --release --target wasm32-wasip2 --locked -p praetorial-resolver --features "$FEATURES" >&2
W=target/wasm32-wasip2/release/praetorial-resolver.wasm
sha256sum $W | sed "s/^/unstripped /" >&2
wasm-tools strip --delete "^(\.debug_.*|producers|target_features|linking|reloc\..*|sourceMappingURL|external_debug_info|component-name)\$" $W -o /tmp/m.wasm
cp /tmp/m.wasm /outlayer/out/module.wasm
rustc -V >&2; wasm-tools --version >&2
sha256sum /tmp/m.wasm | cut -d" " -f1'
case "$ROUTE" in
  run)
    docker run --rm --platform linux/amd64 -e FEATURES="$FEATURES" -v "$SRC:/outlayer/src:ro" -v "$OUT:/outlayer/out" "$IMAGE" sh -c "$RECIPE" ;;
  cp)
    CID=$(docker create --platform linux/amd64 -e FEATURES="$FEATURES" "$IMAGE" sh -c "mkdir -p /outlayer && mv /outlayer-stage /outlayer/src && $RECIPE")
    docker cp "$SRC" "$CID:/outlayer-stage"
    docker start -a "$CID"
    docker cp "$CID:/outlayer/out/module.wasm" "$OUT/module.wasm" ;;
  *) echo "route must be run|cp" >&2; exit 2 ;;
esac
