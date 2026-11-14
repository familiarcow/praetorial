#!/usr/bin/env bash
# MAINPREP1: build a MAINNET OutLayer CLI home for a BOT-held account from its key file (no transaction, nothing printed).
# Homes live outside the repo: $OLHOMES/<role> (default $PRAETORIAL_CACHE_DIR/mainnet-night/olhome-<role>).
# Usage: 05-olhome.sh ops|attest|bets|aikey
#   KEYS2 (D-KEYS2a): bets. (escrow contract: outcome report-pubkey + verifier E4) and aikey. (OutLayer secrets owner, GATE-09)
#   are BOT-held too. Delete $OLHOMES/olhome-bets together with the bets key file once bets.'s key is deleted on chain (RUNBOOK).
set -euo pipefail
ROLE=${1:?usage: 05-olhome.sh ops|attest|bets|aikey}
case "$ROLE" in ops|attest|bets|aikey) ;; *) echo "only bot-held roles (ops, attest, bets, aikey)" >&2; exit 2;; esac
KEYS=${KEYS:-${PRAETORIAL_SECRETS_DIR:?set PRAETORIAL_SECRETS_DIR to the operator secrets dir}/praetorial-mainnet-keys}
H=${OLHOMES:-${PRAETORIAL_CACHE_DIR:?set PRAETORIAL_CACHE_DIR to the operator cache dir}/mainnet-night}/olhome-$ROLE
F=$(ls "$KEYS/$ROLE"/*.json | head -1)
mkdir -p "$H/mainnet"; chmod 700 "$H" "$H/mainnet"
python3 -I - "$F" "$ROLE.praetorial.near" "$H/mainnet/credentials.json" <<'PY'
import json, os, sys
k = json.load(open(sys.argv[1]))
out = {"account_id": sys.argv[2], "public_key": k["public_key"], "private_key": k["private_key"], "contract_id": "outlayer.near", "auth_type": "near_key"}
fd = os.open(sys.argv[3], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f: json.dump(out, f)
PY
printf mainnet > "$H/default-network"
OUTLAYER_HOME="$H" "${OL:-$HOME/.local/bin/outlayer}" whoami 2>&1 | grep -E "Account|Network|Contract"
echo "OUTLAYER_HOME=$H"
