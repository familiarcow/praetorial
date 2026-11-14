# Keeper Worker (CF1a, D-HOST3)

Cloudflare Worker port of `services/keeper`. Reuses the host-agnostic planner
(`keeper/src/policy.ts`, `liveness.ts`); everything host-specific is replaced:

| node keeper | Worker |
|---|---|
| near-api-js signer | WebCrypto Ed25519 + hand-written borsh (`workers/common/src/nearWebClient.ts`), byte-identical to near-api-js (tested) |
| JSON state file | SQLite-backed Durable Object `KeeperDO` (also serialises ticks) |
| 15 s poll loop | one Cron Trigger, **bounded batch per tick** |
| log file / webhook | `console` + Telegram Bot API via `fetch` (heartbeat + deduped alerts) |
| env vars | Worker bindings/secrets, all named in `ops/src/serviceEnv.ts` (keeper row) |

Not ported in CF1a: archive job and resolver-sim (stay on the node host).

## Layout for CF1b-d
`workers/common/src` holds shared pieces (`nearWebClient`, `dispatcher`, `telegram`, `bytes`).
Each service gets `workers/<name>/{src,test,wrangler.toml,README.md}`.

## One cron, shared dispatcher
The account limit is 5 cron triggers. There is exactly one: `* * * * *`. `scheduled()` calls
`runDispatcher(JOBS, env, now)`; a job declares `everyMinutes` (1 = every tick, N = when
`minute-of-epoch % N == 0`). CF1b-d register their job in `JOBS` (one entry Worker or a combined
one) and never add a cron. A failing job does not stop the others; the first error is rethrown.

## Bounded batch and CPU budget
Per tick: at most `KEEPER_MAX_VIEWS_PER_TICK` (8) `get_bet` reads, `KEEPER_MAX_ACTIONS_PER_TICK` (1)
actions plus up to `KEEPER_MAX_DRAINS_PER_TICK` (4) `drain_payouts` calls, plus up to `KEEPER_MAX_RELAYS_PER_TICK` (2) KEEPSUBMIT1 `submit_outcome` relays of the resolver's stored signed output (own budget so refund/payout lines never queue behind resolution actions or each other; KEEPDRAIN1), a 44-subrequest hard cap in the client. The payout scan resumes from a persisted all-done floor (`payoutFloor`). A rotating cursor and least-recently-attempted
ordering drain backlogs; bets seen terminal are never re-read. Cron's floor is 1 minute (the node
keeper polled every 15 s), so liveness latency is up to ~60 s + batch draining.

The 5 ms CPU/invocation target (Workers Free) is tested in `test/worker.miniflare.test.ts`.
**Limitation:** workerd exposes no per-invocation CPU time locally, so the test measures
*wall time* of `scheduled()` through miniflare against instant mocks. That is an upper bound on
CPU plus miniflare IPC overhead, not Cloudflare's billed CPU number; confirm with
`wrangler tail` / the dashboard CPU-time metric after the first testnet deploy.

## Deploy to testnet (needs a Cloudflare API token; none is committed or on CI)
Never commit the token or the key. Put the token in the shell env only:

```sh
cd services/workers/keeper
export CLOUDFLARE_API_TOKEN=...      # Workers Scripts:Edit + Durable Objects; from your password manager
export CLOUDFLARE_ACCOUNT_ID=...
# 1. fill the three REPLACE_* values in wrangler.toml [vars] (public account ids only)
# 2. secrets (prompted on stdin, never in a file):
npx wrangler secret put KEEPER_PRIVATE_KEY        # ed25519:<base58 64-byte key>, function-call-scoped access key (D-AUDIT5)
npx wrangler secret put TELEGRAM_BOT_TOKEN        # optional; ops alerts + heartbeat
npx wrangler secret put KEEPER_ALERT_TELEGRAM_CHAT_ID
# 3. deploy (creates the DO migration v1 and the cron)
npx wrangler deploy
npx wrangler tail                                  # watch a tick; heartbeat arrives in Telegram
```
Mainnet is a separate decision: set `NEAR_NETWORK_ID=mainnet` only through that process.

> CPUFLAKE1: CPU-budget numbers are the min over 5 independent batches of per-batch p99 (per-call thread-CPU deltas); wall guards use the median of batch p99s. Thresholds unchanged. See ../README.md.
