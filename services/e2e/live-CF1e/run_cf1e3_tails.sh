#!/bin/sh
# CF1e3: five concurrent SINGLE-worker wrangler tails (one process per worker), 340 s each.
set -a; . ${PRAETORIAL_SECRETS_DIR:?set PRAETORIAL_SECRETS_DIR to the operator secrets dir}/praetorial-cloudflare.env; set +a
cd "$(dirname "$0")"
node collect_cf1e3.mjs indexer 340 https://praetorial-indexer-testnet.familiarcow.workers.dev/health &
node collect_cf1e3.mjs keeper 340 &
node collect_cf1e3.mjs monitor 340 &
node collect_cf1e3.mjs notifier 340 &
node collect_cf1e3.mjs relayer 340 https://praetorial-relayer-testnet.familiarcow.workers.dev/budget/global &
wait
