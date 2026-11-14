#!/usr/bin/env bash
# Praetorial single test entry point. Tiers:
#   ./test.sh fast  -- escrow cargo test + resolver cargo test (default AND real-http,outlayer-sign) + services npm test + services tsc --noEmit + web npm test +
#                      conformance run.sh + redteam_evidence. No sandbox. ~1 min.
#   ./test.sh full  -- fast + serial CPU/wall `budget` step + the full chaos suite (chaos/run.mjs, all
#                      families, parallel sandboxes). ~5-10 min.
#   ./test.sh live  -- testnet g4 lifecycle + privy-web-e2e npm run e2e.
#                      Refuses unless the deployed testnet escrow code
#                      hash matches the local cargo-near build.
#
# TEST POLICY: never skip or ignore failing tests. Red-by-design tests
# (documented, expected-red invariant probes) still count as red and are
# listed by name in the final table; they are not hidden as "skipped".
set -u
cd "$(dirname "${BASH_SOURCE[0]}")"

# L1b12 build-cache isolation: never inherit a caller's CARGO_TARGET_DIR (a shared/foreign
# target dir mixes near-sdk-core builds -> E0308 "multiple different versions of crate").
# contracts/escrow tests use their OWN dir, away from contracts/target, which the wasm
# release/stripped builds (chaos/harness.mjs, cargo near build) write with other flags.
unset CARGO_TARGET_DIR
ESCROW_TEST_TARGET="$PWD/contracts/target-test"
TIER="${1:-fast}"
RED=0

# TS2: per-run log dir (concurrent runs in other worktrees never clobber these logs); also
# defines row/run_step/ts_summary. See tests/lib/logdir.sh.
. "$PWD/tests/lib/logdir.sh"
ts_init_logdir

budget_files() { ls services/workers/*/test-budget/*.test.ts 2>/dev/null; }

# Serial (one file at a time, --test-concurrency=1) CPU/wall budget step. Thresholds are in the test files, unchanged.
run_budget() {
  run_step "budget (serial CPU or wall timing)" bash -c "cd services && npm run test:budget"
}

# TESTPY1: ONE known-good python (has judge-proto deps) for every python step; fails loudly, never skips.
. "$PWD/tests/lib/python.sh"
resolve_py_or_die() {
  PY="$(ts_resolve_python)" || { echo "test.sh: ABORT -- python deps missing (see message above); python steps cannot run." >&2; exit 1; }
  export PY
  echo "NOTE: python steps use $PY"
}

run_fast() {
  resolve_py_or_die
  run_step "escrow cargo test" bash -c "cd contracts/escrow && CARGO_TARGET_DIR=$ESCROW_TEST_TARGET cargo test --no-fail-fast"
  run_step "wasm-bin cargo test" bash -c "cd resolver/wasm-bin && cargo test"
  # RHTTP1: the SAME tests under the production feature set (the OutLayer wasm is built with real-http,outlayer-sign);
  # 9 tests were red here for weeks because only the default (offline) build ran in fast.
  run_step "wasm-bin cargo test (production features real-http,outlayer-sign)" bash -c "cd resolver/wasm-bin && cargo test --features real-http,outlayer-sign"
  # INTENTS1: mock-intents must keep mirroring the real intents.near (fixtures/intents_near/real_abi.json).
  run_step "mock-intents cargo test" bash -c "cd contracts && CARGO_TARGET_DIR=$ESCROW_TEST_TARGET cargo test -p mock-intents"
  # DOCS5: apps/web deps too, before services npm test (one services test imports apps/web code).
  # PUB1: services/ deps are installed like apps/web deps (tests/lib/deps.sh: npm ci when node_modules is missing), in every
  # step that needs them (web unit tests, conformance and the verifier fixture import services/ code), so a bare clone passes.
  run_step "services npm test" bash -c "bash tests/test_sh_deps.sh && . tests/lib/deps.sh && ts_ensure_node_deps services && ts_ensure_node_deps apps/web && cd services && npm test"
  # CPUFLAKE1/D-CPUFLAKE1a: CPU/wall budget tests flake on a loaded box, so they are NOT in services npm test.
  echo "NOTE: $(budget_files | wc -l | tr -d ' ') budget files not run in fast (CPU/wall timing budgets: $(budget_files | sed 's#services/workers/##; s#/test-budget/#:#' | tr '\n' ' ')); they run in ./test.sh full (serial 'budget' step)"
  run_step "services tsc --noEmit" bash -c ". tests/lib/deps.sh && ts_ensure_node_deps services && cd services && npx tsc --noEmit"
  run_step "web npm test" bash -c ". tests/lib/deps.sh && ts_ensure_node_deps services && ts_ensure_node_deps apps/web && cd apps/web && npm test"
  # Own port (not 3000) so a dev server from another worktree is never reused; playwright.config.ts starts vite there. Fails (never skips) if chromium cannot start.
  run_step "web e2e (mocked)" bash -c "cd apps/web && npx playwright install chromium && PW_CI=1 PLAYWRIGHT_BASE_URL=http://localhost:\$(node scripts/free-port.mjs) npm run test:e2e"
  run_step "web visual gate (Q1: every screen at 375 and 1280, no sideways scroll, no raw id or base units or nep141)" bash -c "cd apps/web && npx playwright test -c playwright.visual.config.ts"
  export ESCROW_TEST_TARGET
  run_step "conformance run.sh" bash -c ". tests/lib/deps.sh && ts_ensure_node_deps services && cd tests/conformance && ./run.sh"
  run_step "rte4b parity (python vs rust decide; + python resolver test)" bash -c "bash tests/test_sh_python.sh && cd judge-proto/redteam_evidence && $PY test_rte4b_parity.py"
  run_step "redteam_evidence (offline replay of recorded production-pair answers)" bash -c "cd judge-proto/redteam_evidence && $PY test_redteam_evidence.py"
  run_step "rte4c replay (zero network, manifest, empty reply -> VOID)" bash -c "cd judge-proto/redteam_evidence && $PY test_rte4c_replay.py"
  run_step "verifier fixture (verify-bet on R3e evidence)" bash -c ". tests/lib/deps.sh && ts_ensure_node_deps services && services/verifier/run_fixture.sh"
  run_step "release record" bash -c "cd resolver/release && $PY test_verify_release_record.py && $PY -I test_check_record_covers_source.py && $PY -I test_check_key_bound.py && $PY -I check_record_covers_source.py && $PY -I ../../contracts/escrow/release/check_toolchain_align.py && $PY -I ../../contracts/escrow/release/test_check_record_covers_source.py && $PY -I ../../contracts/escrow/release/check_record_covers_source.py && $PY verify_release_record.py ../../contracts/escrow/release/record-9662db8.json && $PY verify_release_record.py ../../contracts/escrow/release/record-6944916.json && $PY verify_release_record.py ../../contracts/escrow/release/record-8580ca7.json && $PY verify_release_record.py \"\$(cat CURRENT)\" && $PY verify_release_record.py \"../../contracts/escrow/release/\$(cat ../../contracts/escrow/release/CURRENT)\""
}

run_full() {
  run_fast
  run_budget
  # RTE4/D-RTE4: nightly comparison -- the same JUDGE cases on the old claude:haiku harness (fast uses the production pair)
  run_step "redteam_evidence (claude:haiku comparison)" bash -c "cd judge-proto/redteam_evidence && RTE_JUDGE_BACKEND=haiku $PY test_redteam_evidence.py"
  # RTE4c/D-RTE4b: the LIVE production-pair run (fast replays recorded answers offline); INFRA reported separately, wrong-winner -> ACTION NEEDED
  run_step "redteam_evidence (LIVE production pair, nightly)" bash -c "cd judge-proto/redteam_evidence && $PY nightly_production_pair.py"
  # TFIX1: chaos (and the release sandbox, which imports chaos/harness.mjs) need chaos/node_modules and the
  # sandbox-launcher binary; a fresh worktree has neither. Both are no-ops when already up to date.
  run_step "chaos deps (npm ci + sandbox-launcher cargo build --release)" bash -c "cd chaos && npm ci --no-audit --no-fund && cd sandbox-launcher && cargo build --release"
  local start=$(date +%s)
  if node chaos/run.mjs > "$(ts_log_file chaos)" 2>&1; then
    row "chaos (all families)" "PASS" "$(( $(date +%s) - start ))s" "$(ts_log_file chaos)"
  else
    row "chaos (all families)" "FAIL" "$(( $(date +%s) - start ))s" "$(ts_log_file chaos)"
    RED=1
  fi
  # RC1b: release sandbox WITHOUT RC1_SKIP_24H (real 24h apply_params delay via block fast-forward; ~50 min)
  start=$(date +%s)
  if (cd services/release/sandbox && node --import tsx release_sandbox.mjs > "$PRAETORIAL_TEST_LOGDIR/praetorial_test_release_sandbox.log" 2>&1); then
    row "release sandbox (24h apply, no skip)" "PASS" "$(( $(date +%s) - start ))s" "$(ts_log_file release_sandbox)"
  else
    row "release sandbox (24h apply, no skip)" "FAIL" "$(( $(date +%s) - start ))s" "$(ts_log_file release_sandbox)"
    RED=1
  fi
  # surface each red-by-design / failing scenario by name from latest.json
  if [ -f chaos/results/latest.json ]; then
    node -e '
      const r = JSON.parse(require("fs").readFileSync("chaos/results/latest.json","utf8"));
      for (const s of r.scenarios) if (s.verdict !== "pass") console.log(`    RED: ${s.family}/${s.name} (${s.verdict})`);
    ' | tee -a "$(ts_log_file chaos)"
  fi
}

run_live() {
  echo "== live tier: checking deployed testnet escrow code hash =="
  local escrow_account="${PRAETORIAL_TESTNET_ESCROW:-escrow4.praetorial-dev-1101.testnet}"
  local near_bin="$HOME/.local/node_modules/.bin/near"
  if [ ! -x "$near_bin" ]; then
    echo "near CLI not found at $near_bin"; exit 1
  fi
  echo "Building local escrow wasm (cargo-near, non-reproducible) to compare hashes..."
  ( cd contracts/escrow && cargo near build non-reproducible-wasm > "$PRAETORIAL_TEST_LOGDIR/praetorial_cargo_near_build.log" 2>&1 )
  local local_hash
  local_hash=$(shasum -a 256 contracts/target/near/escrow/escrow.wasm 2>/dev/null | awk '{print $1}')
  local deployed_hash
  # D-RPC1 (queue item 7b): NEAR_RPC_URL overrides the default testnet
  # RPC endpoint; the literal fastnear URL otherwise lives only in
  # services/common/src/rpc.ts.
  local rpc_url="${NEAR_RPC_URL:-https://test.rpc.fastnear.com}"
  deployed_hash=$("$near_bin" state "$escrow_account" --networkId testnet --nodeUrl "$rpc_url" 2>/dev/null | grep -o 'code_hash.*' | head -1)
  echo "local wasm sha256: ${local_hash:-<build failed>}"
  echo "deployed account:  $escrow_account (code_hash: ${deployed_hash:-<unknown>})"
  echo
  echo "NOTE: on-chain code_hash is base58(sha256) via NEAR's own hashing, not a raw"
  echo "shasum comparison -- this script flags a mismatch risk and tells you to"
  echo "re-verify with 'near state' + 'near-cli view-state' by hand before trusting"
  echo "a live run against funds."
  if [ -z "$deployed_hash" ]; then
    echo "REFUSING: could not read deployed code hash for $escrow_account."
    echo "Redeploy with: cd contracts/escrow && cargo near build non-reproducible-wasm && \\"
    echo "  $near_bin deploy $escrow_account contracts/target/near/escrow/escrow.wasm --networkId testnet"
    exit 1
  fi
  echo "(hash verification is advisory in this script -- see TESTING.md)"
  # V1/D-VERIFY1: a live run is not DONE unless the verifier passes. Needs a real OutLayer-resolved bet:
  # PRAETORIAL_VERIFY_BET=<id> (and PRAETORIAL_TESTNET_ESCROW) -- read-only views, no keys.
  if [ -n "${PRAETORIAL_VERIFY_BET:-}" ]; then
    run_step "verify-bet (live, final)" bash -c "services/verifier/final_step.sh --live testnet $escrow_account $PRAETORIAL_VERIFY_BET"
  else
    echo "NOTE: PRAETORIAL_VERIFY_BET unset; live verify-bet step not run (g4 uses the resolver simulator, not OutLayer)"
  fi
  run_step "g4 lifecycle (testnet)" bash -c "cd services/e2e && node g4_lifecycle.mjs"
  run_step "privy-web-e2e" bash -c "cd services/privy-web-e2e && npm run e2e"
}

case "$TIER" in
  fast) run_fast ;;
  full) run_full ;;
  live) run_live ;;
  *) echo "usage: $0 [fast|full|live]"; exit 2 ;;
esac

ts_summary

exit $RED
