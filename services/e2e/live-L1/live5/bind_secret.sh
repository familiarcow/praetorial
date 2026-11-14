#!/bin/bash
# Bind the NEAR AI key as an OutLayer secret (owner dev account, profile praetorial-resolver, wasm-hash accessor),
# Predecessor-whitelisted to the escrow via --via, exactly as 11b. Never prints the key.
set -u
OL=${PRAETORIAL_CACHE_DIR:?set PRAETORIAL_CACHE_DIR to the operator cache dir}/scratch/olbin/outlayer
ESC=praetorial-l1b20-11080132.praetorial-dev-1101.testnet
HASH=4b9d937286061cf2ab685bc5c0bc54dde6d5d8ef8d8a01f36b9752718157aa50
export OUTLAYER_HOME=${PRAETORIAL_CACHE_DIR:?set PRAETORIAL_CACHE_DIR to the operator cache dir}/scratch/olhome
set -a; . ${PRAETORIAL_SECRETS_DIR:?set PRAETORIAL_SECRETS_DIR to the operator secrets dir}/praetorial-nearai.env; set +a
J="{\"NEAR_AI_API_KEY\":\"$NEAR_AI_API_KEY\"}"
unset NEAR_AI_REFRESH_TOKEN NEAR_AI_RESOLVER_KEY
timeout 250 "$OL" secrets set "$J" --profile praetorial-resolver --wasm-hash "$HASH" --via "$ESC" 2>&1 | sed -E 's/[A-Za-z0-9_-]{30,}/<r>/g'
unset J NEAR_AI_API_KEY
"$OL" secrets list -v 2>&1 | grep -i "praetorial-resolver" | sed -E 's/[A-Za-z0-9_-]{50,}/<r>/g'
