#!/usr/bin/env bash
# MAINPREP1: deploy the eight MAINNET Workers (F1 added funding) (Workers Free). No --route flags here: DOM1's custom domains
# (<svc>.praetorial.com) come from each wrangler.toml [env.mainnet] routes; workers.dev stays on too. Mirrors deploy-testnet.sh (GIT_SHA injected as a --var).
# Gated: real runs need PRAETORIAL_MAINNET_GO=GO (familiarcow's GATE-11 go). DRY_RUN=1 prints every command and runs none of them
# (the readiness checks still run). Order: service-binding targets first, keeper (cron + bindings) after its targets.
# Usage: cd services/workers && [DRY_RUN=1] PRAETORIAL_MAINNET_GO=GO scripts/deploy-mainnet.sh [svc ...]
# Credentials: source $PRAETORIAL_SECRETS_DIR/praetorial-cloudflare.env first (never read or printed here).
# Env: WRANGLER (default "npx wrangler"), MAINNET_RPC (default https://free.rpc.fastnear.com), ESCROW (default bets.praetorial.near),
#      EXPECT_CODE_HASH_B58 (default the frozen escrow caf134a4 = EfCgMFheGBZpoFNrhDDozkGK43KL31W12dHUc2QWjQ7Q), SKIP_CHAIN_CHECK=1 (dry runs only).
set -euo pipefail
cd "$(dirname "$0")/.."
WRANGLER=${WRANGLER:-npx wrangler}
DRY=${DRY_RUN:-0}
ORDER=(indexer notifier monitor relayer registry sourcecheck funding keeper)
SERVICES=("$@"); [ ${#SERVICES[@]} -gt 0 ] || SERVICES=("${ORDER[@]}")
ESCROW=${ESCROW:-bets.praetorial.near}
EXPECT=${EXPECT_CODE_HASH_B58:-EfCgMFheGBZpoFNrhDDozkGK43KL31W12dHUc2QWjQ7Q}
RPC=${MAINNET_RPC:-https://free.rpc.fastnear.com}

if [ "$DRY" != "1" ] && [ "${PRAETORIAL_MAINNET_GO:-}" != "GO" ]; then
  echo "refusing: mainnet deploy needs PRAETORIAL_MAINNET_GO=GO (familiarcow's GATE-11 go) or DRY_RUN=1" >&2; exit 3
fi
if [ "$DRY" != "1" ] && [ "${SKIP_CHAIN_CHECK:-0}" = "1" ]; then echo "refusing: SKIP_CHAIN_CHECK is for dry runs only" >&2; exit 3; fi
for s in "${SERVICES[@]}"; do case " ${ORDER[*]} " in *" $s "*) ;; *) echo "unknown service: $s" >&2; exit 2;; esac; done

(cd .. && node --import tsx workers/scripts/check-mainnet-ready.mjs) || { echo "mainnet config NOT ready: refusing to deploy" >&2; exit 1; }
node scripts/check-config-drift.mjs || { echo "config drift: refusing to deploy" >&2; exit 1; }

# The Workers must point at a deployed, frozen escrow: code hash on chain == the frozen build.
if [ "${SKIP_CHAIN_CHECK:-0}" != "1" ]; then
  got=$(curl -s -m 15 "$RPC" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$ESCROW\"}}" \
    | sed -n 's/.*"code_hash":"\([^"]*\)".*/\1/p')
  [ "$got" = "$EXPECT" ] || { echo "escrow $ESCROW code hash is '${got:-none}', expected $EXPECT: deploy the escrow first" >&2; exit 1; }
  echo "escrow $ESCROW code hash OK ($got)"
fi

SHA="$(git rev-parse --short=12 HEAD)"
if [ -n "$(git status --porcelain -- . ../common 2>/dev/null)" ]; then
  [ "$DRY" = "1" ] || { echo "refusing: uncommitted changes under services/workers or services/common (deploy a clean commit)" >&2; exit 1; }
  SHA="${SHA}-dirty"
fi
run() { if [ "$DRY" = "1" ]; then echo "DRY: $*"; else "$@"; fi; }
echo "deploying MAINNET git_sha=${SHA} services=${SERVICES[*]}"
for s in "${SERVICES[@]}"; do
  echo "== $s"
  case "$s" in
    indexer)  run bash -c "cd $s && $WRANGLER d1 migrations apply praetorial-indexer-mainnet --env mainnet --remote" ;;
    registry) run bash -c "cd $s && $WRANGLER d1 migrations apply praetorial-registry-mainnet --env mainnet --remote" ;;
  esac
  run bash -c "cd $s && $WRANGLER deploy --env mainnet --var GIT_SHA:${SHA}"
done
echo "next: scripts/set-mainnet-secrets.sh, then: cd services && node --import tsx workers/scripts/check-deployed-stack.mjs --network mainnet --release ../release/mainnet-night/release-mainnet.json"
