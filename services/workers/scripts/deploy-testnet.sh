#!/usr/bin/env bash
# STACK1: deploy the eight TESTNET Workers (F1 added funding, dry-only on testnet) (Workers Free; never mainnet) with the git sha injected as the GIT_SHA wrangler var
# (`wrangler deploy --var GIT_SHA:<sha>`): the sha is never typed into a wrangler.toml, and GET /health reports it.
# Usage: cd services/workers && scripts/deploy-testnet.sh [svc ...]     (default order: service-binding targets first)
# Credentials: source $PRAETORIAL_SECRETS_DIR/praetorial-cloudflare.env first (this script never reads or prints it).
set -euo pipefail
cd "$(dirname "$0")/.."
ORDER=(indexer notifier monitor relayer keeper registry sourcecheck funding)
SERVICES=("$@"); [ ${#SERVICES[@]} -gt 0 ] || SERVICES=("${ORDER[@]}")
SHA="$(git rev-parse --short=12 HEAD)"
if [ -n "$(git status --porcelain -- . ../common 2>/dev/null)" ]; then SHA="${SHA}-dirty"; fi
# LIVE1: abort before deploying anything if apps/web/lib/network.ts and the Workers' wrangler.toml disagree (escrow/intents/registry ids, URLs).
node scripts/check-config-drift.mjs || { echo "config drift: refusing to deploy" >&2; exit 1; }
echo "deploying git_sha=${SHA}"
for s in "${SERVICES[@]}"; do
  case " ${ORDER[*]} " in *" $s "*) ;; *) echo "unknown service: $s" >&2; exit 2;; esac
  echo "== $s"
  (cd "$s" && npx wrangler deploy --var "GIT_SHA:${SHA}" 2>&1)
done
