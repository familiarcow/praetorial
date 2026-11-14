#!/usr/bin/env bash
# ALRT1a / D-CF1E3a: page on any exceededCpu outcome. A Worker cannot observe other Workers' outcomes from inside, so this
# operator script tails each praetorial-*-testnet Worker ONE AT A TIME (`wrangler tail --format json`, a window of
# TAIL_SECONDS, default 120), counts outcomes, prints one JSON summary line per Worker and exits non-zero if ANY
# event had outcome exceededCpu. Other non-ok outcomes (exception, canceled, ...) are counted, not paged on here.
#
#   ./tail_cpu_alert.sh [worker ...]    live (export your Cloudflare API token in your shell first; never put it in a file)
#   ./tail_cpu_alert.sh --from-file recorded_tail.jsonl            offline: summarise recorded tail JSON (used by the test)
# Proves: CPU-limit kills seen inside the tail window. Does NOT prove continuous paging (see monitor/README.md).
set -u
WORKERS_DEFAULT="praetorial-indexer-testnet praetorial-keeper-testnet praetorial-monitor-testnet praetorial-notifier-testnet praetorial-registry-testnet praetorial-relayer-testnet"
TAIL_SECONDS="${TAIL_SECONDS:-120}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WRANGLER_DIR="${WRANGLER_DIR:-$HERE/../../workers/monitor}"

summarise() { # $1 = worker label; stdin = tail JSON lines
  node -e '
    const label = process.argv[1]; let events = 0; const outcomes = {};
    for (const l of require("fs").readFileSync(0, "utf8").split("\n")) {
      const t = l.trim(); if (!t || t[0] !== "{") continue;
      let j; try { j = JSON.parse(t); } catch { continue; }
      if (typeof j.outcome !== "string") continue;
      events++; outcomes[j.outcome] = (outcomes[j.outcome] || 0) + 1;
    }
    const non_ok = Object.entries(outcomes).filter(([k]) => k !== "ok").reduce((a, [, v]) => a + v, 0);
    const exceeded_cpu = outcomes.exceededCpu || 0;
    console.log(JSON.stringify({ worker: label, events, non_ok, exceeded_cpu, outcomes }));
    if (exceeded_cpu) console.error(`ALERT: ${exceeded_cpu} exceededCpu outcome(s) on ${label}`);
    process.exit(exceeded_cpu ? 3 : 0);
  ' "$1"
}

if [ "${1:-}" = "--from-file" ]; then
  [ -r "${2:-}" ] || { echo "usage: $0 --from-file <tail.jsonl>" >&2; exit 2; }
  summarise "${2}" < "$2"; exit $?
fi

rc=0
for w in ${@:-$WORKERS_DEFAULT}; do
  out="$(mktemp "${TMPDIR:-/tmp}/tailcpu.XXXXXX")"
  # single-worker tail (running tails for several Workers at once skews the CPU measurement)
  ( cd "$WRANGLER_DIR" && npx wrangler tail "$w" --format json >"$out" 2>/dev/null & p=$!; sleep "$TAIL_SECONDS"; kill "$p" 2>/dev/null; wait "$p" 2>/dev/null )
  summarise "$w" < "$out" || rc=3
  rm -f "$out"
done
exit $rc
