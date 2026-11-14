#!/bin/sh
# L1b2 resume: run at/after the settlement window end (bets 1 and 3 became final-able 2026-11-07T16:42:25Z / 16:42:31Z).
# Needs funded testnet keys in ~/.near-credentials (never printed). Usage: sh resume_finalize.sh   (from this dir)
set -e
export NEAR_RPC_URL=${NEAR_RPC_URL:-https://test.rpc.fastnear.com}
ESC=$(cat escrow_name.txt); H=$(grep -o '"escrow_wasm_sha256": *"[0-9a-f]*"' results.json | grep -o '[0-9a-f]\{64\}')
for pair in "jason_same_bucket_yes:1" "flips_100k_messy:3"; do
  ex=${pair%%:*}; id=${pair##*:}
  node finish.mjs finalize "$ex"
  ../../../verifier/verify-bet --network testnet --escrow "$ESC" --bet "$id" --expect-escrow-hash "$H" | tee "verify_final_bet$id.txt"
done
