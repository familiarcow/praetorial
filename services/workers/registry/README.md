# registry Worker (CF1f, D-REGW1)

The node registry (`services/registry`) on Cloudflare Workers + D1. Routes: `POST /claim`, `GET /search`, `GET /lookup/account/:id`, `GET /lookup/username/:name`, `GET /health`; CORS and status codes as the node server.

- One shared host-neutral core (`registry/src/core.ts`, `nep413Core.ts`): claim/search/lookup/rate rules, NEP-413 digest, full-access-key check. The node server (`server.ts`) and this Worker (`src/index.ts`) only add their host (node: tweetnacl + JSON/memory store; Worker: WebCrypto ed25519 + D1).
- D1 schema (`migrations/0001_init.sql`): `users` (UNIQUE folded username, UNIQUE account_id), `nonces` (PK = replay guard), `rate` (per-IP token bucket). Claim is one atomic `batch`, so a failed claim never burns a nonce.
- Parity: `test/parity.test.ts` runs the unchanged node suites (`registry/test/*.test.ts`) against this Worker (`REGISTRY_BACKEND=worker`, harness in `registry/test/helpers.ts` + `test/workerBackend.ts`). `test/worker.miniflare.test.ts` runs the real bundle in workerd with a persisted D1.
- Deploy (testnet only, free plan): `wrangler d1 migrations apply praetorial-registry-testnet --remote && wrangler deploy`. No secrets, no cron.
- CPU (D-CF1F1): local `test-budget/cpuBudget.test.ts` p99 <= 7 ms (measured ~0.09 ms p99 in-process); deployed gate in `test-budget/cpuDeployed.test.ts` over `e2e/live-CF1f/tail_registry.json`.
- Deployed 2026-11-09: version a0d5c43f-dfb6-49ee-a19c-f9f5c4d0e0de, https://praetorial-registry-testnet.familiarcow.workers.dev. Live: 1 real claim + search/lookup/health, 116 tail events, 0 exceededCpu, 0 non-ok, cpu p50 0 ms / max 6 ms (`e2e/live-CF1f/`).
