# Monitor Worker (CF1c, D-HOST3)

The node monitor's alert loop (`monitor/src/runner.ts`) as a Cloudflare Worker, testnet only. It runs the **same**
`runAlertTick` (`monitor/src/runnerCore.ts`, with `alertsCore` / `opsAlertsCore` / `storageHeadroom` / `relayerBudget` /
`invariants` / `snapshot`, shared with the node and not forked). Only the data provider differs.

## How it runs
- **No cron of its own.** The keeper Worker's single `* * * * *` trigger runs the shared **dispatcher**
  (`workers/common/src/dispatcher.ts`); its `monitor-tick` job calls `POST /tick` on this Worker over the
  `MONITOR_SERVICE` service binding (declared in `workers/keeper/wrangler.toml`). The account allows 5 cron triggers in total.
- `POST /tick` reaches one Durable Object (`MonitorDO`, SQLite-backed). It holds alert dedupe/cooldowns, stall and
  rpc-error trackers, headroom samples, the ops-recovery set and the sweep cursor, so a restart changes nothing.
- **Bounded batch per tick:** `MONITOR_BATCH_BETS` (default 20) bets are read per tick (<= 44 outbound subrequests; Free plan cap is 50).
  The sweep covers the whole bet range over several ticks; contract-wide I-2 is judged when a sweep completes.
  Alert latency is therefore at most one sweep, not one tick (the node monitor walks every bet each poll).
- Alerts: invariants (I-1/2/4/5/7), stalled actions, paused/shutdown, storage headroom (+trend), relayer budget,
  keeper credit (`CREDIT_WATCH`, MON4/MON4b). One Telegram digest per tick (<= 3 posts) via `fetch`. Unreadable sources raise the
  distinct "cannot check" alerts, never OK.

## Deploy to testnet (not done by CI; needs a Cloudflare account)
```sh
export CLOUDFLARE_API_TOKEN=...        # from your shell only; never commit, never put in wrangler.toml
cd services/workers/monitor
# edit [vars] in wrangler.toml (public account ids only)
npx wrangler secret put ALERT_TELEGRAM_BOT_TOKEN   # optional: operator Telegram alerts (with ALERT_TELEGRAM_CHAT_ID var)
npx wrangler deploy                                  # deploy the monitor FIRST ...
cd ../keeper && npx wrangler deploy                  # ... then the keeper, whose MONITOR_SERVICE binding points at it
```
Tuning vars (all optional): `MONITOR_RPC_PER_SEC`, `MONITOR_MIN_TICK_INTERVAL_MS`, `MONITOR_BATCH_BETS`, `ALERT_*`,
`FEE_ACCOUNT_ID`, `KEEPER_ACCOUNT_ID`, `RELAYER_BUDGET_URL`, `CREDIT_WATCH`. Every var the Worker reads is listed in
`ops/src/serviceEnv.ts` (the `monitor:alerts` row; a static test fails on unlisted vars).

## CPU budget
`test/cpuBudget.test.ts` measures p99 main-thread CPU per `MonitorDO` tick in-process (same method as the keeper and relayer)
and asserts <= 5 ms. It is a proxy for Cloudflare's billed CPU: confirm with `wrangler tail` after the first deploy.

## Not in this Worker (CF1c2)
The notifier (`services/notifier`) is split out as CF1c2; the node notifier is unchanged.

> CPUFLAKE1: CPU-budget numbers are the min over 5 independent batches of per-batch p99 (per-call thread-CPU deltas); wall guards use the median of batch p99s. Thresholds unchanged. See ../README.md.

## Telegram delivery when unconfigured / failing (ALRT1a)
- `ALERT_TELEGRAM_BOT_TOKEN` or `ALERT_TELEGRAM_CHAT_ID` unset: no request to `api.telegram.org`; the tick logs exactly one
  structured `{"msg":"telegram not configured","alert_count":N,"kinds":[...]}` warning (never the token) on every tick that had alerts,
  and the `/tick` JSON carries `telegram_unconfigured: true` (even with zero alerts) so a deployed check can see it. Alerts are still
  logged as `[ALERT:...]` lines.
- Telegram non-ok / network error: one `{"msg":"telegram delivery failed",...}` error log, `telegram_failed: true` in the tick JSON; the
  tick still completes and dedupe state is persisted.
- Offline tests: `test/telegramOffline.test.ts` (mocked fetch). The live half (real bot message) is ALRT1, held on the token.

## exceededCpu alert (ALRT1a, D-CF1E3a)
A Worker cannot see other Workers' outcomes, so this Worker cannot page on them. `services/e2e/ops/tail_cpu_alert.sh` tails each
`praetorial-*-testnet` Worker one at a time (`wrangler tail --format json`, `TAIL_SECONDS` window, default 120), prints a JSON summary
per Worker (`events`, `non_ok`, `exceeded_cpu`, `outcomes`) and **exits non-zero on any `exceededCpu`**. Run it from your shell with
your Cloudflare token exported (never committed); `--from-file <tail.jsonl>` summarises recorded tail output offline (what
`e2e/test/tailCpuAlert.test.ts` and `e2e/ops/fixtures/` exercise).
- **Proves:** CPU-limit kills (`exceededCpu`) observed during the tail window.
- **Does not prove:** continuous paging. Events outside the window are not seen, and nothing runs it on a schedule. Continuous
  paging waits on Workers Logpush / analytics, post-launch.
