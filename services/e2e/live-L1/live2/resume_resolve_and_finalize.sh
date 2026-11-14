#!/bin/sh
# L1b5 follow-up (live2). Run from this dir; needs funded testnet keys in ~/.near-credentials (never printed).
# Escrow praetorial-l1b5-11071226.praetorial-dev-1101.testnet; bets: 1=close_above_future (Taken, T=2026-11-07T18:38:00Z),
# 2=btc_breaks_76140_messy (Proposed YES, finalizable after 2026-11-07T18:53:19Z), 3=jason_bitstamp_only_no (Taken, 2 failed resolution attempts, runs_used 0).
# Usage: sh resume_resolve_and_finalize.sh <step>   steps: finalize2 | resolve1 | resolve3 | finalize1 | finalize3
set -e
export NEAR_RPC_URL=${NEAR_RPC_URL:-https://test.rpc.fastnear.com}
ESC=$(cat escrow_name.txt); H=a240f3632e956d5eac45c2965b8fdc85b5b2aa17656d00b37bd2eb3e68afbf97
verify() { ../../../verifier/verify-bet --network testnet --escrow "$ESC" --bet "$1" --expect-escrow-hash "$H" | tee "$2"; }
case "$1" in
  finalize2)  # at/after 18:53:19Z UTC
    node finish.mjs finalize btc_breaks_76140_messy; verify 2 verify_final_bet2.txt ;;
  resolve1)   # only at/after T=18:38:00Z (+ a minute for the Coinbase candle); expected YES (BTC ~75.7k > 70000)
    node resolve.mjs close_above_future && node finish.mjs submit close_above_future && verify 1 verify_pre_finalize_bet1.txt
    echo "finalizable ~1h after submit_outcome: see results_close_above_future.json after_submit / get_bet settle_ready" ;;
  resolve3)   # one more attempt at the Jason one-venue NO bet (runs_used is 0; failed attempts do not consume a run)
    node resolve.mjs jason_bitstamp_only_no && node finish.mjs submit jason_bitstamp_only_no && verify 3 verify_pre_finalize_bet3.txt ;;
  finalize1)  node finish.mjs finalize close_above_future; verify 1 verify_final_bet1.txt ;;
  finalize3)  node finish.mjs finalize jason_bitstamp_only_no; verify 3 verify_final_bet3.txt ;;
  *) echo "unknown step"; exit 1 ;;
esac
