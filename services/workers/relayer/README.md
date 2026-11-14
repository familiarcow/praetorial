# Relayer Worker (CF1b, D-HOST3)

Cloudflare Worker port of `services/relayer` (NEP-366 meta-tx relayer). The **pure logic is shared, not copied**:

| piece | node relayer | Worker |
|---|---|---|
| relay pipeline (policy, expiry window, rate limit, budget, global cap + bettor reserve, replay, broadcast, settle/release) | `relayer/src/relayerCore.ts` | same file |
| allowlist / caps | `relayer/src/policy.ts` | same file |
| guard SQL | `relayer/src/guardStoreCore.ts` over `node:sqlite` | same file over the Durable Object's SQLite (`guardDriver.ts`) |
| HTTP error/body mapping | `relayer/src/httpMap.ts` | same file |
| delegate decode + ed25519 verify | tweetnacl + node:crypto + borsh | `delegateWeb.ts`: hand-written strict borsh reader + WebCrypto Ed25519 |
| outer tx signing + broadcast | near-api-js | `chain.ts` + `common/nearWebClient.ts`: WebCrypto Ed25519, byte-identical to near-api-js (tested) |
| env | process.env + key file | Worker bindings/secrets, all named in `ops/src/serviceEnv.ts` (relayer row) |

## API (parity with the node relayer)
`POST /relay {signedDelegate}` -> `{ok:true, txHash}`; 400 caller errors (bad sig, policy, expired, rate limit,
per-user budget, replay); 429 global gas cap; 413 body > 64 KiB; 500 `internal relayer error` (details never leak).
`GET /budget/global` -> monitor feed. `POST /heartbeat` -> the dispatcher job (interval-limited Telegram heartbeat).

## State survives restarts
All requests go to one SQLite-backed Durable Object (`RelayerDO`, name `relayer`). Replay nonces, rate-limit
windows, per-user and global budgets are rows in its SQLite file; every check+write is one `transactionSync`.
The nonce is marked seen *before* broadcast, so concurrent identical delegates broadcast once. Tested: a new
runtime on the same persisted storage rejects a replay (`test/worker.miniflare.test.ts`, `test/relayerDo.test.ts`).

## One cron, shared dispatcher
This Worker has **no cron trigger**. The keeper Worker's single `* * * * *` dispatcher registers
`relayer-heartbeat` (every 5 min) in `JOBS` and calls this Worker via the `RELAYER_SERVICE` service binding
(`workers/keeper/wrangler.toml`). `/heartbeat` is idempotent and interval-limited; it exposes nothing.

## Differences from the node relayer (deferred)
- Bettor lookup (CF1b2, node RLY1 parity): `INDEXER_URL` first; if it is unset or errors, a bounded escrow `get_bet`
  scan (`boundedEscrowBettorLookup` in `relayer/src/bettor.ts`, at most `RELAYER_BETTOR_SCAN_MAX_VIEWS` <= 40 views per
  request, so 3 relay calls + 1 indexer + 40 = 44) with progress and the maker/taker set cached in the RelayerDO SQLite
  (`RELAYER_BETTOR_CACHE_TTL_MS`). Any failure => non-bettor, never cached; an incomplete scan fails closed for
  unscanned accounts and finishes over the next requests.
- No heartbeat *file* (MON4 file heartbeat -> Telegram heartbeat, like the keeper Worker).
- A relay holds the HTTP request open while the tx executes (`EXECUTED_OPTIMISTIC`), as the node relayer does.

## CPU budget
Target: p99 <= 5 ms CPU per invocation (Workers Free limit 10 ms). `test/cpuBudget.test.ts` measures the real
handler path in-process on V8 as main-thread CPU (method as in the keeper test; it is a proxy, workerd exposes no
per-invocation CPU locally). `test/worker.miniflare.test.ts` adds a loose wall-time guard through workerd.
Confirm with `wrangler tail` after the first deploy.

## Deploy to testnet (needs a Cloudflare API token; none is committed or on CI)
Never commit the token or the key. Token in the shell env only:

```sh
cd services/workers/relayer
export CLOUDFLARE_API_TOKEN=...      # Workers Scripts:Edit + Durable Objects; from your password manager
export CLOUDFLARE_ACCOUNT_ID=...
# 1. fill the REPLACE_* values in wrangler.toml [vars] (public account ids only)
# 2. secrets (prompted on stdin, never in a file):
npx wrangler secret put RELAYER_PRIVATE_KEY       # ed25519:<base58 64-byte key>, the gas-paying relayer key (never moves user funds)
npx wrangler secret put TELEGRAM_BOT_TOKEN        # optional; heartbeat
npx wrangler secret put RELAYER_ALERT_TELEGRAM_CHAT_ID
# 3. deploy the relayer FIRST (creates the DO migration v1), then the keeper (its service binding RELAYER_SERVICE
#    points at praetorial-relayer-testnet)
npx wrangler deploy
cd ../keeper && npx wrangler deploy
npx wrangler tail praetorial-relayer-testnet
```
Mainnet is a separate decision (familiarcow's go). Deploy itself is CF1e.

> CPUFLAKE1: CPU-budget numbers are the min over 5 independent batches of per-batch p99 (per-call thread-CPU deltas); wall guards use the median of batch p99s. Thresholds unchanged. See ../README.md.

## RLYFIN1 / RLYREF2 live proof (testnet, 2026-11-09)
Worker `praetorial-relayer-testnet` redeployed from main 569e92d, version id `c5081175-64a7-4346-8a0a-43c80272bf40`.
No bet was ready to finalize, so this is a dry policy probe (fresh implicit sender, validly signed delegate with `maxBlockHeight: 1`, so an
accepted call stops at "delegate expired" before any broadcast; no tx hash). Request ids are the Cloudflare `cf-ray` of each POST /relay:
- `finalize {bet_id:1}` -> 400 `delegate expired ...` (passed the allowlist; no longer "not on the allowlist") — a57dcc85b883437e-EWR
- `finalize {bet_id:1,x:1}` -> 400 `finalize args contain unexpected field "x"` — a57dcc88cbb9437e-EWR
- `referee_rule {bet_id:1,outcome:"YES"}` -> 400 `delegate expired ...` (passed the allowlist) — a57dcc89bca3437e-EWR
- `referee_rule outcome:"MAYBE"` -> 400 `outcome must be exactly "YES", "NO" or "VOID"` — a57dcc8c9fb3437e-EWR
- `referee_rule outcome:"yes"` -> 400 same refusal (exact case) — a57dcc8d98b9437e-EWR

## RELAY500 (2026-11-10): intermittent 500 on near_deposit relays
Symptom: `POST /relay` for a wrap.testnet `near_deposit` delegate answered 500 `internal relayer error` for a window (MODAL1d live runs,
06:35-06:50) and then recovered without a deploy; config (escrow frz3 / wNEAR / allowlists) was correct. Fresh probes against the same
Worker (`services/relayer/scripts/relay500_probe.ts`) returned 200 before and after the fix, so the exact failing upstream message was not
captured (the old build's node log omitted it; the Worker already logged it). Most likely cause: the relayer key is shared with other writers
(dev/test runs), the optimistic `view_access_key` lost the nonce race, and `WorkerRelayChain.send` retried InvalidNonce only once
(`src/chain.ts`). Fix: up to 3 attempts, learning `ak_nonce` from the error. Diagnosability: both hosts now log
`describeInternal(err)` (class + redacted message; `relayer/src/httpMap.ts`). Next time, `wrangler tail praetorial-relayer-testnet` shows
`[relayer] 500 <sender> internal error: <Class>: <message>`.
