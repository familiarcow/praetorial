#!/bin/bash
# Bind the NEAR AI key as an OutLayer secret under the SECRETS-OWNER account's home (outlayer_config.secrets_account_id),
# profile = outlayer_config.secrets_profile, accessor = the escrow's pinned resolver wasm hash, whitelisted to the escrow via --via.
# Never prints the key.
# Usage: bind_secret.sh [ESCROW] [WASM_HASH_64]     (env overrides: ESC, HASH, PROFILE, OUTLAYER_HOME, OL)
# Defaults = the OLD escrow praetorial-e2e-2611052236 + hash 3dd936d8... (unchanged behaviour).
# frz2: bind_secret.sh praetorial-frz2-2611091914.praetorial-dev-1101.testnet 6517a422f55639d5d452ba2abcea93cc261c33729025be2afd5efcfa42d3b1c3
#   (OUTLAYER_HOME=~/.outlayer holds praetorial-dev-1101.testnet = frz2's secrets_account_id)
set -u
OL=${OL:-$HOME/.local/bin/outlayer}
[ -x "$OL" ] || OL=${PRAETORIAL_CACHE_DIR:?set PRAETORIAL_CACHE_DIR to the operator cache dir}/scratch/olbin/outlayer
ESC=${1:-${ESC:-praetorial-e2e-2611052236.praetorial-dev-1101.testnet}}
HASH=${2:-${HASH:-3dd936d8deee90bb452d8e4f242062d8ef6a1f05e4cd62a548941e380fe4ad49}}
PROFILE=${PROFILE:-praetorial-resolver}
if ! printf '%s' "$HASH" | grep -Eq '^[0-9a-f]{64}$'; then echo "HASH must be the full 64-char hex resolver hash" >&2; exit 2; fi
export OUTLAYER_HOME=${OUTLAYER_HOME:-${PRAETORIAL_CACHE_DIR:?set PRAETORIAL_CACHE_DIR to the operator cache dir}/scratch/olhome}
set -a; . ${PRAETORIAL_SECRETS_DIR:?set PRAETORIAL_SECRETS_DIR to the operator secrets dir}/praetorial-nearai.env; set +a
J="{\"NEAR_AI_API_KEY\":\"$NEAR_AI_API_KEY\"}"
unset NEAR_AI_REFRESH_TOKEN NEAR_AI_RESOLVER_KEY
timeout 250 "$OL" secrets set "$J" --profile "$PROFILE" --wasm-hash "$HASH" --via "$ESC" 2>&1 | sed -E 's/[A-Za-z0-9_-]{30,}/<r>/g'
unset J NEAR_AI_API_KEY
"$OL" secrets list -v 2>&1 | grep -i "$PROFILE" | grep -F "${HASH:0:8}" | sed -E 's/[A-Za-z0-9_-]{50,}/<r>/g'
