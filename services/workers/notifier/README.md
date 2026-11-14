# Notifier Worker (CF1c2, D-HOST3)

The node notifier (`notifier/src/runner.ts`) as a Cloudflare Worker, testnet only. The notice logic is the **same** code, not a
fork: `notifier/src/notifierCore.ts` (`computeNoticesMulti`; `notifier.ts` re-exports it and keeps the node file I/O),
`notifier/src/confirm.ts` + `common/src/terminalConfirmCore.ts` (D-DSY1 second-RPC terminal confirm; `terminalConfirm.ts` re-exports
it and keeps the NearClient factory), `notifier/src/highStakeRouter.ts`, and `monitor/src/serviceAlerts.ts` (`AlertRaiser`
interface; node uses `ServiceAlertRaiser`, the Worker a Durable-Object-backed raiser).

## How it runs
- **No cron of its own.** The keeper Worker's single `* * * * *` trigger runs the shared **dispatcher**
  (`workers/common/src/dispatcher.ts`); its `notifier-tick` job calls `POST /tick` on this Worker over the `NOTIFIER_SERVICE`
  service binding (declared in `workers/keeper/wrangler.toml`). The account allows 5 cron triggers in total.
- `POST /tick` reaches one SQLite-backed Durable Object (`NotifierDO`). It holds, so a restart changes nothing: seen keys,
  the outbox, the **PII-free notification log** (`bet_id`, `event`, `timestamp` only), the high-stake Telegram queue, per-contract
  sweep cursors, alert cooldowns and the encrypted contacts.
- **Bounded batch per tick:** `NOTIFIER_BATCH_BETS` (default 12, split across contracts) bets are read per tick; <= 44 outbound
  subrequests (Free cap 50) including second-RPC confirms, the version check and Telegram. The sweep covers the whole bet range over
  several ticks; seen keys make each notice fire once. Notice latency is therefore at most one sweep (node polls every bet each 20 s).
- **High-stake Telegram** (>= `NOTIFIER_HIGH_STAKE_USD` per side, `NOTIFIER_ASSET_PRICES`): queued in SQLite as account + message
  (bet id, event, link), at most `NOTIFIER_MAX_SENDS_PER_TICK` (default 10) sent per tick; the chat id is decrypted only at send
  time; failures stay queued (dropped after 10 attempts); opted-out/deleted contacts are dropped. The log and outbox are pruned to `NOTIFIER_LOG_KEEP` rows.
- Terminal outcomes (Settled/Voided) are announced only after a **second RPC** (`NEAR_RPC_FALLBACKS`, first entry) returns the same
  state; with one RPC configured they are never announced and `terminal_single_rpc` is raised. Alerts are returned in the tick result and logged.

## Contacts
`WebContactStore` (WebCrypto AES-256-GCM) uses the node store's schema: table `contacts(account_id, iv, auth_tag, ciphertext,
updated_at_ms)`, plaintext JSON `{kind,value}`, key = `NOTIFIER_CONTACT_KEY` (64 hex chars, AES-256-GCM). Rows written by either
host decrypt on the other (cross-host round-trip tested). The DO exposes `setContact/getContact/deleteContact` as methods only: there
is no public HTTP surface for contacts (how contacts get in is outside CF1c2). Unconfirmed on real workerd: that BLOB bindings of
Uint8Array are accepted by DO SQL (tests use node:sqlite) -- check on the first deploy.

## Deploy to testnet (not done by CI; needs a Cloudflare account)
```sh
export CLOUDFLARE_API_TOKEN=...        # from your shell only; never commit, never put in wrangler.toml
cd services/workers/notifier
# edit [vars] in wrangler.toml (public account ids only; set NEAR_RPC_FALLBACKS for the 2nd RPC)
npx wrangler secret put NOTIFIER_CONTACT_KEY     # 64 hex chars (openssl rand -hex 32), required
npx wrangler secret put TELEGRAM_BOT_TOKEN       # optional: enables the high-stake Telegram channel
npx wrangler deploy                              # deploy the notifier FIRST ...
cd ../keeper && npx wrangler deploy              # ... then the keeper, whose NOTIFIER_SERVICE binding points at it
```
Every var the Worker reads is in `ops/src/serviceEnv.ts` (the `notifier` row); a static test fails on unlisted vars.

## CPU budget
`test/cpuBudget.test.ts` measures p99 main-thread CPU per `NotifierDO` tick in-process (same method as the keeper, relayer and
monitor) and asserts <= 5 ms. It is a proxy for Cloudflare's billed CPU: confirm with `wrangler tail` after the first deploy.

> CPUFLAKE1: CPU-budget numbers are the min over 5 independent batches of per-batch p99 (per-call thread-CPU deltas); wall guards use the median of batch p99s. Thresholds unchanged. See ../README.md.
