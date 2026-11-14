#!/bin/sh
# L1b11 live3 resume steps. Run from this dir; needs funded testnet keys in ~/.near-credentials (never printed).
# Escrow praetorial-l1b11-11072031.praetorial-dev-1101.testnet; bets: 1=jason_bitstamp_only_no, 2=close_above_future (T=2026-11-07T21:39:00Z).
# Steps: early1 (only in [21:39,21:44)Z: expect signed NO, bet back to Taken) | late1 (only >= 21:44Z: expect Proposed YES) | finalize_a | finalize_b
# Each resolve step also submits the outcome (if delivered) and runs the V1 verifier.
set -e
export NEAR_RPC_URL=${NEAR_RPC_URL:-https://test.rpc.fastnear.com}
ESC=$(cat escrow_name.txt); H=a240f3632e956d5eac45c2965b8fdc85b5b2aa17656d00b37bd2eb3e68afbf97
verify() { ../../../verifier/verify-bet --network testnet --escrow "$ESC" --bet "$1" --expect-escrow-hash "$H" | tee "$2"; }
case "$1" in
  early1)  cp results_close_above_future.json results_close_above_future.before_early.json
           node resolve.mjs close_above_future; cp raw_resolution_close_above_future.txt raw_resolution_close_above_future.early.txt
           node view_bet.mjs 2 | tee after_early_bet2.txt ;;
  late1)   node resolve.mjs close_above_future && node finish.mjs submit close_above_future && verify 2 verify_pre_finalize_bet2.txt
           echo "finalizable ~1h after submit_outcome (settle_ready_ns in results_close_above_future.json)" ;;
  finalize_a) node finish.mjs finalize jason_bitstamp_only_no; verify 1 verify_final_bet1.txt ;;
  finalize_b) node finish.mjs finalize close_above_future; verify 2 verify_final_bet2.txt ;;
  *) echo "unknown step"; exit 1 ;;
esac
