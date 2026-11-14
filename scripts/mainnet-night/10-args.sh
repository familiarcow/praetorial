#!/usr/bin/env bash
# MAINPREP1 step (b): deploy-day prices (PXF1, Coinbase + Kraken) -> gen-new-args. Never signs or sends anything.
#   10-args.sh preflight   input = release/draft-input.mainnet.json (OutLayer fields still placeholders) -> release/mainnet-night/dryrun/
#                          must exit 0 and print exactly 3 PENDING lines (outcome_pubkey, attest_pubkey, outlayer_config.wasm_base_url)
#   10-args.sh final       input = release/mainnet-night/input.mainnet.json (written by 20-fill-outlayer.sh) -> release/mainnet-night/
#                          args.mainnet.json + limits.md + input.priced.json. Prices are valid 30 min: sign the deploy within 30 min.
set -euo pipefail
MODE=${1:?usage: 10-args.sh preflight|final}
REPO=$(cd "$(dirname "$0")/../.." && pwd); NIGHT=$REPO/release/mainnet-night
case "$MODE" in
  preflight) IN=$REPO/release/draft-input.mainnet.json; OUT=$NIGHT/dryrun; FLAG=--preflight ;;
  final)     IN=$NIGHT/input.mainnet.json; OUT=$NIGHT; FLAG=--final
             [ -f "$IN" ] || { echo "missing $IN: run 20-fill-outlayer.sh first" >&2; exit 1; } ;;
  *) echo "usage: 10-args.sh preflight|final" >&2; exit 2 ;;
esac
mkdir -p "$OUT"; cd "$REPO/services"
node --import tsx release/src/cli.ts prices --input "$IN" --out "$OUT/input.priced.json" --providers coinbase,kraken
node --import tsx release/src/cli.ts gen-new-args $FLAG --input "$OUT/input.priced.json" --network mainnet --out "$OUT/args.mainnet.json" --table "$OUT/limits.md"
shasum -a 256 "$OUT/args.mainnet.json"
