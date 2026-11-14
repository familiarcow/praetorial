#!/usr/bin/env bash
# MAINPREP1 step (c): turn the three OutLayer outputs into release/mainnet-night/input.mainnet.json (no network, no keys).
# Logs (saved by the RUNBOOK commands): $LOGS/upload.log, $LOGS/report_pubkey_outcome.log (run AS bets.praetorial.near),
# $LOGS/report_pubkey_attest.log (run AS attest.praetorial.near). Refuses a wrong predecessor or a wasm hash mismatch.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../.." && pwd); NIGHT=$REPO/release/mainnet-night; LOGS=${LOGS:-$NIGHT/logs}
cd "$REPO/services"
node --import tsx release/src/nightCli.ts fill --input "$REPO/release/draft-input.mainnet.json" \
  --outcome-log "$LOGS/report_pubkey_outcome.log" --attest-log "$LOGS/report_pubkey_attest.log" --upload-log "$LOGS/upload.log" \
  --escrow "${ESCROW:-bets.praetorial.near}" --attest-account "${ATTEST:-attest.praetorial.near}" --out "$NIGHT/input.mainnet.json"
