#!/usr/bin/env bash
# Reproducible escrow wasm build in the cargo-near image pinned in contracts/escrow/Cargo.toml
# ([package.metadata.near.reproducible_build]). Does what `cargo near build reproducible-wasm`
# does inside the container (copy the committed tree to /home/near/code, cd to the contract,
# run container_build_command = `cargo near build non-reproducible-wasm --locked`), but from a
# `git archive` export so it works without a git remote / on a local-only repo, and with no host
# target dir. Needs docker (amd64; Apple Silicon runs it under emulation) and network for crates.io.
#
# Usage: build_reproducible.sh <commit> <route> <outdir>
#   route=run : docker run, source bind-mounted read-only
#   route=cp  : docker create + docker cp in/out, no bind mounts (fresh container)
# Prints the sha256 of <outdir>/escrow.wasm on stdout (logs on stderr). Container is removed on exit.
set -euo pipefail
COMMIT="${1:?commit}"; ROUTE="${2:?run|cp}"; OUT="${3:?outdir}"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
TOML="$ROOT/contracts/escrow/Cargo.toml"
IMG_TAG="$(sed -n 's/^image = "\(.*\)"/\1/p' "$TOML")"
DIGEST="$(sed -n 's/^image_digest = "\(.*\)"/\1/p' "$TOML")"
IMAGE="${IMG_TAG%%:*}@${DIGEST}"   # pull and run by digest; the tag is only informative
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" >&2
[ "$(docker image inspect "$IMAGE" --format '{{.Architecture}}')" = amd64 ] || { echo "image is not amd64" >&2; exit 1; }
# Source dir under $HOME (colima shares only $HOME into its VM).
mkdir -p "${RB_TMP:-$HOME/.cache}"
SRC="$(mktemp -d "${RB_TMP:-$HOME/.cache}/esrsrc.XXXXXX")"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
NAME="esr-build-$$-$RANDOM"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; python3 -c 'import shutil,sys; shutil.rmtree(sys.argv[1], ignore_errors=True)' "$SRC"; }
trap cleanup EXIT
git -C "$ROOT" archive "$COMMIT" | tar -x -C "$SRC"   # the whole committed tree, nothing else
chmod -R a+rX "$SRC"
RECIPE='set -eu
mkdir -p /home/near/code
cp -r /src/. /home/near/code/
cd /home/near/code/contracts/escrow
cargo near build non-reproducible-wasm --locked --out-dir /tmp/out >&2
cargo near --version >&2; rustc -V >&2
sha256sum /tmp/out/escrow.wasm | cut -d" " -f1'
case "$ROUTE" in
  run)
    docker run --name "$NAME" --platform linux/amd64 -v "$SRC:/src:ro" "$IMAGE" bash -c "$RECIPE" | tail -1
    docker cp "$NAME:/tmp/out/escrow.wasm" "$OUT/escrow.wasm" ;;
  cp)
    docker create --name "$NAME" --platform linux/amd64 "$IMAGE" bash -c "$RECIPE" >/dev/null
    docker cp "$SRC/." "$NAME:/src"
    docker start -a "$NAME" | tail -1
    docker cp "$NAME:/tmp/out/escrow.wasm" "$OUT/escrow.wasm" ;;
  *) echo "route must be run|cp" >&2; exit 2 ;;
esac
