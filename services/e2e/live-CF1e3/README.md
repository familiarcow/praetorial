# CF1e3 deployed indexer CPU check (D-CF1E3a)
Gate = what Cloudflare enforces: on the deployed testnet worker `praetorial-indexer-testnet` (free plan, 1 cron/min via the keeper dispatcher),
>= 60 consecutive ticks with zero `exceededCpu` and zero non-ok outcomes, while >= 20 bets are open on the watched escrow.
- `open_many.mjs`: opens N (default 20) open bets on the escrow (run from apps/web: `NEAR_RPC_URL=<testnet rpc> tsx ../../services/e2e/live-CF1e3/open_many.mjs`). Results: results.json, open_many.log.
- Tail: `cd services/workers/indexer && wrangler tail praetorial-indexer-testnet --format json > ../../e2e/live-CF1e3/tail_indexer.json` (single worker; kill when done).
- `node count_outcomes.mjs [tail_indexer.json]` prints events / per-outcome counts / exceededCpu / non-ok / cpuTime p50,max; output saved as summary.txt.
- `npm run test:budget` (services/) runs workers/indexer/test-budget/cpuDeployed.test.ts over tail_indexer.json.
