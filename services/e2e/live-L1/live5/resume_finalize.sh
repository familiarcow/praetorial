#!/bin/sh
# L1b20 live5 finalize-only follow-up. Run from this dir NOT BEFORE 2026-11-08T02:39:16Z (bet 1 settlement window ends 02:39:15.102Z).
set -e
export NEAR_RPC_URL=${NEAR_RPC_URL:-https://test.rpc.fastnear.com}
ESC=$(cat escrow_name.txt); H=ba96b2ae35796c1f28b309e25b8a9961d9f20a10aa5f1b98ca14531e79c6e148
node finish.mjs finalize jason_bitstamp_only_no; ../../../verifier/verify-bet --network testnet --escrow "$ESC" --bet 1 --expect-escrow-hash "$H" | tee verify_final_bet1.txt
