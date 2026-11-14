# TS2: per-run log directory + run_step/summary helpers, sourced by test.sh (and tests/test_sh_logdir.sh).
# Every step log goes to "$PRAETORIAL_TEST_LOGDIR/praetorial_test_<step_with_underscores>.log" so two
# concurrent runs (different worktrees) never overwrite each other. The dir is exported so child
# scripts (tests/conformance/run.sh) write into the same run dir.
RED=${RED:-0}
declare -a ROWS=()

ts_init_logdir() {
  if [ -z "${PRAETORIAL_TEST_LOGDIR:-}" ]; then
    PRAETORIAL_TEST_LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/praetorial_test.XXXXXX")"
  fi
  mkdir -p "$PRAETORIAL_TEST_LOGDIR"
  export PRAETORIAL_TEST_LOGDIR
}

ts_log_file() { local name="$1"; printf '%s/praetorial_test_%s.log' "$PRAETORIAL_TEST_LOGDIR" "${name// /_}"; }

# row <name> <PASS|FAIL> <time> [logfile]; logfile defaults to the step-name log
row() { ROWS+=("$1|$2|$3|${4:-$(ts_log_file "$1")}"); }

run_step() {
  local name="$1"; shift
  local start=$(date +%s)
  if "$@" > "$(ts_log_file "$name")" 2>&1; then
    row "$name" "PASS" "$(( $(date +%s) - start ))s"
  else
    row "$name" "FAIL" "$(( $(date +%s) - start ))s"
    RED=1
  fi
}

ts_summary() {
  echo
  printf "%-30s %-8s %s\n" "STEP" "RESULT" "TIME"
  local r name result time logf
  for r in "${ROWS[@]+"${ROWS[@]}"}"; do
    IFS='|' read -r name result time logf <<< "$r"
    printf "%-30s %-8s %s\n" "$name" "$result" "$time"
  done
  echo
  echo "Logs: $PRAETORIAL_TEST_LOGDIR"
  for r in "${ROWS[@]+"${ROWS[@]}"}"; do
    IFS='|' read -r name result time logf <<< "$r"
    [ "$result" = "FAIL" ] && echo "FAIL log: $name -> $logf"
  done
  return 0
}
