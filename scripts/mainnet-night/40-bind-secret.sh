#!/usr/bin/env bash
# MAINPREP1 step (c) GATE-09: bind the CAPPED NEAR AI resolver key as the OutLayer secret the mainnet resolver reads.
# Same proven shape as testnet (services/e2e/live-run16r/bind_secret.sh, NOKEY1b check_key_bound OK): secret name NEAR_AI_API_KEY,
# profile praetorial-resolver, accessor = the pinned resolver wasm hash, calls admitted only via the escrow (--via).
# Source of the value: NEAR_AI_RESOLVER_KEY in $PRAETORIAL_SECRETS_DIR/praetorial-nearai.env (familiarcow: the spend-capped key, GATE-09).
# NEVER the general NEAR_AI_API_KEY. The value is never printed. MAINNET TX (storage ~0.0074 NEAR from the secrets owner).
# Usage: OUTLAYER_HOME=<home logged in as aikey.praetorial.near on mainnet> PRAETORIAL_MAINNET_GO=GO 40-bind-secret.sh
set -uo pipefail
[ "${PRAETORIAL_MAINNET_GO:-}" = "GO" ] || { echo "refusing: needs PRAETORIAL_MAINNET_GO=GO" >&2; exit 3; }
: "${OUTLAYER_HOME:?set OUTLAYER_HOME to the secrets-owner home (mainnet)}"
OL=${OL:-$HOME/.local/bin/outlayer}
ESC=${ESC:-bets.praetorial.near}
HASH=${HASH:-8791413ff7943f5e5b99df4c5cafc50cb9baf5696cf32837e1a8afd31baa2473}
OWNER=${OWNER:-aikey.praetorial.near}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
who=$("$OL" whoami 2>&1)
printf '%s\n' "$who" | grep -q "Account:  $OWNER" || { echo "refusing: OUTLAYER_HOME is not logged in as $OWNER" >&2; exit 1; }
printf '%s\n' "$who" | grep -q "Network:  mainnet" || { echo "refusing: OUTLAYER_HOME is not on mainnet" >&2; exit 1; }
set -a; . "${PRAETORIAL_SECRETS_DIR:?set PRAETORIAL_SECRETS_DIR to the operator secrets dir}/praetorial-nearai.env"; set +a
[ -n "${NEAR_AI_RESOLVER_KEY:-}" ] || { echo "refusing: NEAR_AI_RESOLVER_KEY (the capped key) is not set; GATE-09 is familiarcow's" >&2; exit 1; }
[ "${NEAR_AI_RESOLVER_KEY}" != "${NEAR_AI_API_KEY:-}" ] || { echo "refusing: NEAR_AI_RESOLVER_KEY equals the general NEAR_AI_API_KEY (must be the separate capped key)" >&2; exit 1; }
J="{\"NEAR_AI_API_KEY\":\"$NEAR_AI_RESOLVER_KEY\"}"
unset NEAR_AI_API_KEY NEAR_AI_REFRESH_TOKEN NEAR_AI_RESOLVER_KEY
timeout 250 "$OL" secrets set "$J" --profile praetorial-resolver --wasm-hash "$HASH" --via "$ESC" 2>&1 | sed -E 's/[A-Za-z0-9_-]{30,}/<r>/g'
unset J
python3 -I "$REPO/resolver/release/check_key_bound.py" --escrow "$ESC" --hash "$HASH"
