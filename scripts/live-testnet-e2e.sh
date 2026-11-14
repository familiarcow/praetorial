#!/usr/bin/env bash
# LIVE1: the LIVE end-to-end gate against the DEPLOYED testnet stack (site + Workers + testnet contracts).
# Not part of ./test.sh (needs network, a Privy test login and testnet NEAR). Usage from the repo root:
#   scripts/live-testnet-e2e.sh            # health + drift guard + driver flow + @live Playwright suite
#   SKIP_UI=1 scripts/live-testnet-e2e.sh  # everything except the browser suite
# Secrets: $PRAETORIAL_SECRETS_DIR/praetorial-privy.env (PRIVY_TEST_EMAIL, PRIVY_TEST_OTP) is sourced, never printed.
# Testnet keys created by the driver live in ~/.near-credentials/testnet/live1/ (outside the repo).
# Every tx hash is printed and written to $OUT (JSON lines).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SITE="${DEPLOYED_URL:-https://praetorial-web-testnet.familiarcow.workers.dev}"
OUT="${OUT:-$ROOT/spikes/live1/live-e2e-$(date +%Y%m%d-%H%M%S).jsonl}"
mkdir -p "$(dirname "$OUT")"
echo "live e2e against $SITE -> $OUT"

echo "== 1. Worker health (public ones; notifier + monitor are binding-only by design: workers_dev = false)"
for s in relayer indexer registry sourcecheck keeper; do
  body="$(curl -fsS --max-time 15 "https://praetorial-$s-testnet.familiarcow.workers.dev/health")" || { echo "FAIL $s /health"; exit 1; }
  echo "$s: $body"
  printf '{"step":"health","service":"%s","body":%s}\n' "$s" "$body" >> "$OUT"
done

echo "== 2. config drift guard (web lib/network.ts vs every Worker's wrangler.toml)"
node "$ROOT/services/workers/scripts/check-config-drift.mjs"

echo "== 3a. fresh UNFUNDED implicit account claims a username on the deployed registry"
(cd "$ROOT/apps/web" && npx tsx tests/live/claimFresh.ts | tee -a "$OUT")

echo "== 3b. AI-judge path: real sourcecheck attestation + open of a Coinbase BTC-USD touch bet (testnet sourcecheck allows 60 checks/IP/hour since LIVE2)"
(cd "$ROOT/apps/web" && npx tsx tests/live/aiProof.ts | tee -a "$OUT")

echo "== 3b2. FUND2: deposit-only user (betting balance, no NEAR account yet) -> relayer /activate -> open a USDC bet"
(cd "$ROOT/apps/web" && npx tsx tests/live/unfundedOpenProbe.ts | tee -a "$OUT" | grep -q '"pass":true') || { echo "FAIL FUND2 deposit-only open"; exit 1; }

echo "== 3c. driver flow (fresh accounts; sign-up/username for an unfunded implicit account, move NEAR, NEAR + USDC bets, take, referee rules, payout, withdraw to wallet via the relayer, AI source check)"
BLOCKED_LOG="$(mktemp)"
(cd "$ROOT/apps/web" && LIVE_OUT="$OUT" npx tsx tests/live/fullFlow.ts) 2> >(tee "$BLOCKED_LOG" >&2)
sleep 1 # let the stderr tee flush

if [ -z "${SKIP_UI:-}" ]; then
  echo "== 4. @live browser suite on the deployed site (real Privy login + signing)"
  set -a; . "${PRAETORIAL_SECRETS_DIR:?set PRAETORIAL_SECRETS_DIR to the operator secrets dir}/praetorial-privy.env"; set +a
  (cd "$ROOT/apps/web" && DEPLOYED_URL="$SITE" LIVE_OUT="$OUT" npx playwright test -c playwright.deployed.config.ts --grep @live)
fi
# LIVE2: a BLOCKED step (e.g. USDC withdraw while the testnet intents mock holds no real usdc.testnet) is never a plain PASS.
if grep -q "WITHDRAW BLOCKED" "$BLOCKED_LOG"; then
  echo "LIVE E2E PASS WITH BLOCKED ITEMS ($OUT):"; grep "WITHDRAW BLOCKED" "$BLOCKED_LOG"
else
  echo "LIVE E2E PASS ($OUT)"
fi
