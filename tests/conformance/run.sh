#!/usr/bin/env bash
# Praetorial conformance gate: runs every test that backs a claim in
# the conformance matrix (internal design notes) and prints pass/fail counts
# per matrix status, so the matrix can be re-checked every build loop.
#
# Local only. No testnet/mainnet/NEAR AI calls here.
#
# Usage: tests/conformance/run.sh
set -u -o pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
ROOT="$(cd ../.. && pwd)"
# TS2: share test.sh's per-run log dir when run under it; else make our own (no fixed /tmp path).
if [ -z "${PRAETORIAL_TEST_LOGDIR:-}" ]; then PRAETORIAL_TEST_LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/praetorial_test.XXXXXX")"; export PRAETORIAL_TEST_LOGDIR; fi
CONF_LOG="$PRAETORIAL_TEST_LOGDIR/praetorial_conformance_last.log"

pass=0
fail=0
fail_names=()

section() { printf '\n=== %s ===\n' "$1"; }

run_cargo() {
  local name="$1" manifest="$2"
  local dir
  dir="$(dirname "$manifest")"
  section "$name (cargo test)"
  # cd into the crate's own dir first: rustup resolves rust-toolchain.toml
  # from the CURRENT DIRECTORY tree, not from --manifest-path, so running
  # this from tests/conformance/ would silently pick up the wrong (too
  # old) default toolchain for the escrow/resolver crates.
  local status=0
  # --no-fail-fast: a crate with MULTIPLE test binaries (lib suite +
  # `tests/*.rs` integration binaries + doc-tests) must still run every
  # one of them even when an earlier binary has a failing test --
  # otherwise a single red test (e.g. OQ-T11 in escrow's lib suite)
  # would cargo's-default-abort the run before chaos_findings/doc-tests
  # ever execute, silently dropping their real counts from this
  # summary too (the exact same under-count bug this fix targets, one
  # layer up).
  # L1b12: same isolated target as test.sh's escrow step for contracts/escrow; never inherit a
  # caller's CARGO_TARGET_DIR (other crates use their own default <crate>/target).
  local tdir=""
  [ "$manifest" = "$ROOT/contracts/escrow/Cargo.toml" ] && tdir="${ESCROW_TEST_TARGET:-$ROOT/contracts/target-test}"
  (cd "$dir" && if [ -n "$tdir" ]; then export CARGO_TARGET_DIR="$tdir"; else unset CARGO_TARGET_DIR; fi; cargo test --quiet --no-fail-fast) 2>&1 | tee "$CONF_LOG"
  status=${PIPESTATUS[0]}
  # DR-11 FIX: a single `cargo test` invocation prints ONE "test result:"
  # summary line PER test binary it ran (the lib suite, every
  # `tests/*.rs` integration binary, AND the doc-tests binary) -- e.g.
  # the escrow crate alone prints a lib-suite line, a chaos_findings
  # line, and a doc-tests line (always "0 passed"). The old
  # `grep ... | tail -1` kept only the LAST such line in the whole
  # output, which is that always-0 doc-tests line, so every crate with
  # more than one test binary silently lost its real counts (escrow's
  # lib+chaos_findings ~110 tests, every loop). Sum every "test
  # result:" line's passed/failed counts instead -- ok AND FAILED
  # alike, so a crate with one failing binary still gets credit for
  # every other binary's (and that failing binary's own PASSING
  # tests') real totals, nothing silently dropped either direction.
  local counts
  counts=$(awk '
    /^test result: / {
      for (i = 1; i <= NF; i++) {
        if ($i == "passed;") p += $(i - 1)
        if ($i == "failed;") f += $(i - 1)
      }
    }
    END { printf "%d %d", p + 0, f + 0 }
  ' "$CONF_LOG")
  local n_pass n_fail
  n_pass=${counts%% *}
  n_fail=${counts##* }
  pass=$((pass + n_pass))
  if [ "$status" -ne 0 ]; then
    fail=$((fail + 1))
    fail_names+=("$name")
    # Standing test policy (familiarcow, 2026-11-03): name the actual failing
    # test(s), not just the crate/suite -- never hide which assertion
    # is red behind a suite-level "failed" line. `cargo test --quiet`'s
    # own final "failures:\n    <bare::test::path>" block is the one
    # line format that's stable across both --quiet's condensed
    # per-test "<path> --- FAILED" progress lines AND verbose mode's
    # "test <path> ... FAILED" lines, so match that block's bare names
    # instead of either progress-line format.
    while IFS= read -r line; do
      failing_test_names+=("$name :: $line")
    done < <(grep -E '^    [A-Za-z0-9_]+(::[A-Za-z0-9_]+)+$' "$CONF_LOG" | sed -E 's/^    //')
    if [ "$n_fail" -gt 0 ] && [ ${#failing_test_names[@]} -eq 0 ]; then
      failing_test_names+=("$name :: ($n_fail failing test(s), names not found in cargo output -- see "$CONF_LOG")")
    fi
  fi
}

run_node() {
  local name="$1"; shift
  section "$name (node --test)"
  # cd into services/ so Node's ESM resolver can find the `tsx` loader
  # and workspace node_modules (@praetorial/common etc.) the same way
  # `npm test` there already does.
  if (cd "$ROOT/services" && node --import tsx --test "$@") 2>&1 | tee "$CONF_LOG"; then
    local p s
    p=$(grep -oE '^# pass [0-9]+' "$CONF_LOG" | grep -oE '[0-9]+' | tail -1)
    s=$(grep -oE '^# skipped [0-9]+' "$CONF_LOG" | grep -oE '[0-9]+' | tail -1)
    pass=$((pass + ${p:-0}))
    skip=$((skip + ${s:-0}))
  else
    fail=$((fail + 1))
    fail_names+=("$name")
    # Standing test policy (familiarcow, 2026-11-03): surface exactly which
    # claim IDs failed, not just the suite name -- "not ok N - <claim>"
    # TAP lines carry the test's own title, which is the claim ID by
    # convention in this suite.
    while IFS= read -r line; do
      not_enforced_failures+=("$line")
    done < <(grep -oE '^not ok [0-9]+ - .*' "$CONF_LOG" | sed -E 's/^not ok [0-9]+ - //')
  fi
}

skip=0
not_enforced_failures=()
failing_test_names=()

# --- ENFORCED+TESTED / ENFORCED-UNTESTED-now-fixed: escrow contract ---
# NOTE: contracts/escrow/src is OWNED by another agent this loop (D1-D6:
# settlement bound, exhibit timestamps, re-judge bond funding, storage
# charge, keeper key, beta cap/sunset). This loop never edits it. If
# this suite is red, it's their WIP mid-edit (e.g. a changed
# Contract::new signature not yet threaded through every call site),
# not something this script or the escrow_conformance crate caused or
# should paper over.
run_cargo "escrow (existing suite, contracts/escrow/src is frozen this loop)" \
  "$ROOT/contracts/escrow/Cargo.toml"
run_cargo "escrow conformance additions (tests/conformance/escrow_conformance)" \
  "$ROOT/tests/conformance/escrow_conformance/Cargo.toml"

# --- resolver/core conformance additions ---
run_cargo "resolver conformance additions (tests/conformance/resolver_conformance)" \
  "$ROOT/tests/conformance/resolver_conformance/Cargo.toml"
run_cargo "resolver core (existing suite)" \
  "$ROOT/resolver/core/Cargo.toml"

# --- services spec-boundary tests (keeper/notifier/indexer policy claims) ---
run_node "services spec-boundary + invariants + policy tests" \
  "$ROOT/services/keeper/test/spec-boundary.test.ts" \
  "$ROOT/services/keeper/test/policy.test.ts" \
  "$ROOT/services/notifier/test/spec-boundary.test.ts" \
  "$ROOT/services/indexer/test/spec-boundary.test.ts" \
  "$ROOT/services/monitor/test/invariants.test.ts"

# --- NOT ENFORCED claims ---
# Standing test policy (familiarcow, 2026-11-03): a NOT ENFORCED claim is a
# real gap, not something to hide behind node:test's `skip`. This
# suite runs as a NORMAL failing gate -- any claim still open fails
# the whole script (see the `exit 1` below), and each failing claim ID
# is listed by name, not just counted. Closing a claim means either
# fixing it (ENFORCED+TESTED elsewhere, test moves out of this file)
# or recording a decision that it's deliberately out of scope and
# rewriting this test to assert that decided design instead (green).
run_node "NOT ENFORCED claims (real failing gate, not skipped)" \
  "$ROOT/tests/conformance/ts/not_enforced.test.ts"

echo
echo "===================================================================="
echo "Conformance run summary"
echo "  passed tests : $pass"
echo "  skipped (legitimate node:test skips elsewhere, NOT NOT-ENFORCED claims) : $skip"
echo "  failing suites : $fail"
if [ ${#fail_names[@]} -gt 0 ]; then
  printf '    - %s\n' "${fail_names[@]}"
fi
if [ ${#not_enforced_failures[@]} -gt 0 ]; then
  echo
  echo "  OPEN NOT ENFORCED claims (red by policy -- never hidden):"
  printf '    - %s\n' "${not_enforced_failures[@]}"
fi
if [ ${#failing_test_names[@]} -gt 0 ]; then
  echo
  echo "  FAILING cargo tests (named, not just the suite -- never hidden):"
  printf '    - %s\n' "${failing_test_names[@]}"
fi
echo
echo "See the conformance matrix (internal design notes) for the per-claim"
echo "status breakdown (ENFORCED+TESTED / ENFORCED-UNTESTED / NOT ENFORCED"
echo "/ DOC-ONLY / IN PROGRESS) and the NOT ENFORCED blast-radius ranking."
echo "===================================================================="

if [ "$fail" -gt 0 ]; then
  exit 1
fi
exit 0
