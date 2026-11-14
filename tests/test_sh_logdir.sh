#!/usr/bin/env bash
# TS2: test.sh step logs live in a per-run dir, so concurrent runs never clobber each other.
# Standalone: tests/test_sh_logdir.sh  (exercises tests/lib/logdir.sh with fake steps; no real suites)
# Scratch lives in one mktemp dir under ${TMPDIR:-/tmp} (small; left for the OS/TMPDIR pruner).
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ts2_logdir_test.XXXXXX")"
fails=0
check() { if [ "$2" = "$3" ]; then echo "ok   - $1"; else echo "FAIL - $1 (expected '$2' got '$3')"; fails=$((fails+1)); fi; }
has() { case "$3" in *"$2"*) echo "ok   - $1";; *) echo "FAIL - $1 (missing '$2')"; fails=$((fails+1));; esac; }

# one fake "test.sh run": two steps (one slow, one failing) from its own cwd
fake_run() {
  local id="$1" dir="$WORK/wt_$1"; mkdir -p "$dir"; cd "$dir" || exit 9
  unset PRAETORIAL_TEST_LOGDIR
  export TMPDIR="$WORK/tmp_$id"; mkdir -p "$TMPDIR"
  . "$HERE/lib/logdir.sh"
  ts_init_logdir
  run_step "slow step" bash -c "sleep 1; echo content-of-run-$id"
  run_step "bad step" bash -c "echo failing-in-run-$id; exit 1"
  ts_summary > "$WORK/summary_$id.txt"
  echo "$PRAETORIAL_TEST_LOGDIR" > "$WORK/logdir_$id.txt"
  echo "$RED" > "$WORK/red_$id.txt"
}
fake_run A & p1=$!
fake_run B & p2=$!
wait $p1 $p2

for id in A B; do
  d="$(cat "$WORK/logdir_$id.txt")"
  check "run $id logdir under its TMPDIR" "$WORK/tmp_$id" "$(dirname "$d")"
  check "run $id slow step log is its own" "content-of-run-$id" "$(cat "$d/praetorial_test_slow_step.log")"
  check "run $id bad step log is its own" "failing-in-run-$id" "$(cat "$d/praetorial_test_bad_step.log")"
  check "run $id RED=1 on a failing step" "1" "$(cat "$WORK/red_$id.txt")"
  s="$(cat "$WORK/summary_$id.txt")"
  has "run $id summary prints log dir" "$d" "$s"
  has "run $id summary keeps header" "STEP                           RESULT   TIME" "$s"
  has "run $id summary FAIL row" "bad step" "$s"
  has "run $id FAIL shows its log path" "$d/praetorial_test_bad_step.log" "$s"
done
[ "$(cat "$WORK/logdir_A.txt")" != "$(cat "$WORK/logdir_B.txt")" ] && echo "ok   - dirs differ" || { echo "FAIL - dirs equal"; fails=$((fails+1)); }

# an exported dir is reused (so child scripts like conformance/run.sh share the run's dir)
( export PRAETORIAL_TEST_LOGDIR="$WORK/preset"; mkdir -p "$WORK/preset"; . "$HERE/lib/logdir.sh"; ts_init_logdir; echo "$PRAETORIAL_TEST_LOGDIR" > "$WORK/reuse.txt" )
check "preset PRAETORIAL_TEST_LOGDIR reused" "$WORK/preset" "$(cat "$WORK/reuse.txt")"

[ $fails -eq 0 ] && { echo "ALL PASS"; exit 0; } || { echo "$fails FAILED"; exit 1; }
