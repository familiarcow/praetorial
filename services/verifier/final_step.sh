#!/bin/sh
# FINAL STEP of every live run: a live run is NOT DONE unless this passes.
# usage: final_step.sh <run-evidence-dir> [expect-escrow-hash]   (offline, on the run's recorded files; layout of services/e2e/live-runR3e)
#        final_step.sh --live <network> <escrow> <bet>           (public views only; B2/B3/B5 SKIP without recorded evidence)
d="$(cd "$(dirname "$0")" && pwd)"
if [ "$1" = "--live" ]; then exec "$d/verify-bet" --network "$2" --escrow "$3" --bet "$4"; fi
if [ -n "$2" ]; then exec "$d/verify-bet" --evidence-dir "$1" --expect-escrow-hash "$2"; fi
exec "$d/verify-bet" --evidence-dir "$1"
