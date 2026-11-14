# services/workers

## Timing / CPU-budget tests (CPUFLAKE1)

Thresholds are fixed (5 ms CPU p99 per invocation; 15 ms / 25 ms wall guards) and are never raised to absorb machine load.
Instead the *measurement* is robust to load (helpers: `common/test/cpuBench.ts`, self-tested in `common/test/cpuBench.test.ts`).

| Test | Kind | Statistic |
|---|---|---|
| keeper/relayer/monitor/notifier `test/cpuBudget.test.ts` (incl. relayer bettor-fallback cold scan / warm cache) | **CPU** (`process.threadCpuUsage` deltas around the handler only) | min over K=5 independent batches of each batch's p99 |
| keeper `cpuBudget` wall columns (`idle_wall_p99`, `action_wall_p99`) | wall, in-process (<= 3x the CPU budget = 15 ms) | median over K=5 batches of batch p99 |
| keeper/relayer `worker.miniflare.test.ts` (workerd IPC round trip, 25 ms) | **wall** (genuinely wall: workerd<->node IPC is not Worker CPU) | median over 3 batches of batch p99 |

Why min-of-batches for CPU: scheduler preemption, cache eviction and throttling on a loaded box only ever add time, so the
least-disturbed batch best estimates the handler's cost (standard best-of-N benchmarking). A really slow handler has a heavy tail
in every batch, so its min p99 still exceeds the budget (asserted in the helper tests). Why median for wall: the check is about
typical tail latency; one contended batch can neither fail nor rescue the run. 

## Where they run (D-CPUFLAKE1a)

None of the timing-budget files run in `services npm test` / `./test.sh fast`. They live in `workers/*/test-budget/` and run
serially (one file at a time, `--test-concurrency=1`) in the `budget` step of `./test.sh full` (`npm run test:budget`).
Functional miniflare tests stay in fast (`test/worker.miniflare.test.ts`, harness `test/miniflareHelpers.ts`); `cpuBench`'s own
self-tests stay in fast. `common/test/budgetCoverage.test.ts` fails if a budget file is in neither place. Thresholds unchanged.

## Mainnet (deploy day, familiarcow's go)

WKMAIN1 (D-WKMAIN1): every Worker's `wrangler.toml` carries an `[env.mainnet]` section (drafted, NOT deployed; nothing here runs until familiarcow's go, GATE-11). Worker names are `praetorial-<svc>-mainnet`. Wrangler env sections do not inherit `vars`, D1, triggers, service bindings, DO bindings or migrations, so each is listed in full. Only the keeper has a cron (1 of 5, D-HOST3).

Placeholders left (deploy day only): `DEPLOY_DAY_INDEXER_D1_ID`, `DEPLOY_DAY_REGISTRY_D1_ID`. Two more deploy-day choices: a second independent mainnet RPC in `NEAR_RPC_FALLBACKS` (indexer, notifier, D-DSY1) and an optional `RELAYER_BUDGET_URL`. Accounts: `bets.praetorial.near` (escrow, D-KEYS2), `keeper.praetorial.near` (GATE-07), `praetorial.near` (fee account = guardian, D-KEYS2), `registry.praetorial.near` (D-RCFG1), `relayer.praetorial.near` (PROPOSED name in D-RCFG1 item 3, familiarcow may rename; operator.praetorial.near is not read by any Worker).

**Deploy-day check:** `cd services && node --import tsx workers/scripts/check-mainnet-ready.mjs` prints each finding and exits 1 until the D1 ids replace `DEPLOY_DAY_*` (0 when ready); it also flags `REPLACE_`, `testnet`, key material, a non-uuid D1 id or a missing `[env.mainnet]`. Logic: `common/src/mainnetReady.ts`; today's findings are pinned in `common/test/mainnetReady.test.ts`. No test is skipped (guard: `common/test/noSkippedTests.test.ts`).

```
set -a; . $PRAETORIAL_SECRETS_DIR/praetorial-cloudflare.env; set +a
cd services/workers/indexer  && npx wrangler d1 create praetorial-indexer-mainnet    # paste id over DEPLOY_DAY_INDEXER_D1_ID
cd services/workers/registry && npx wrangler d1 create praetorial-registry-mainnet   # paste id over DEPLOY_DAY_REGISTRY_D1_ID
# from services/: node --import tsx workers/scripts/check-mainnet-ready.mjs (must exit 0), then migrations:
cd services/workers/indexer  && npx wrangler d1 migrations apply praetorial-indexer-mainnet --env mainnet --remote
cd services/workers/registry && npx wrangler d1 migrations apply praetorial-registry-mainnet --env mainnet --remote
# deploy order (service bindings need their targets): indexer, notifier, monitor, relayer, keeper, registry
cd services/workers/<svc> && npx wrangler deploy --env mainnet
```

Secrets (names only; `npx wrangler secret put <NAME> --env mainnet` in each Worker dir):
- keeper: `KEEPER_PRIVATE_KEY` (keeper.praetorial.near), optional `TELEGRAM_BOT_TOKEN`, `KEEPER_ALERT_TELEGRAM_CHAT_ID`
- relayer: `RELAYER_PRIVATE_KEY` (relayer.praetorial.near), optional `TELEGRAM_BOT_TOKEN`, `RELAYER_ALERT_TELEGRAM_CHAT_ID`
- monitor: `ALERT_TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ID`
- notifier: `NOTIFIER_CONTACT_KEY`, optional `TELEGRAM_BOT_TOKEN`
- indexer: none
- registry: none
- funding: `ONECLICK_API_KEY` (1Click partner key; set-mainnet-secrets.sh pipes it from `$PRAETORIAL_SECRETS_DIR/praetorial-oneclick.env`, never printed). See `funding/README.md`.

## Testnet deploy runbook (CF1e)
```
set -a; . $PRAETORIAL_SECRETS_DIR/praetorial-cloudflare.env; set +a
cd workers/indexer && npx wrangler d1 create praetorial-indexer-testnet     # put the id in wrangler.toml
npx wrangler d1 migrations apply praetorial-indexer-testnet --remote
# deploy order (service bindings need their targets): indexer, notifier, monitor, relayer, keeper  (npx wrangler deploy)
node ../../e2e/live-CF1e/printkey.mjs keeper.praetorial-dev-1101.testnet | npx wrangler secret put KEEPER_PRIVATE_KEY   # same for RELAYER_PRIVATE_KEY; NOTIFIER_CONTACT_KEY from `openssl rand -hex 32`
CF env + collect CPU: node e2e/live-CF1e/collect_tail.mjs 420   # sanitized summary (raw events carry client IPs)
```
Config guard: `workers/common/test/deployConfig.test.ts` (no placeholders, `praetorial-<svc>-testnet` names, 1 cron <= 5, D1 uuid). Evidence + open findings: `e2e/live-CF1e/STATUS.md`. Mainnet deploy stays familiarcow's go.

## Deployed-stack check
STACK1 (D-STACK1). Proves from the LIVE deployment that every testnet Worker points at the frozen build: each Worker serves `GET /health` -> `{service, network, escrow_contract_id (registry: registry_id), git_sha, last_tick_at (keeper/monitor/indexer; null before the first tick)}` and nothing else from env (allow-list; per-Worker tests fail if any secret binding value appears). `git_sha` is injected at deploy by `scripts/deploy-testnet.sh` (`wrangler deploy --var GIT_SHA:<sha>`, no manual edits; `-dirty` suffix if the tree is dirty). The private monitor/notifier Workers (`workers_dev=false`) are checked through the keeper's read-only `GET /health/monitor|notifier` over its existing service bindings.

Command (go/no-go checklist item; PM adds it):
```
cd services && node --import tsx workers/scripts/check-deployed-stack.mjs [--network testnet] [--release release/freeze-candidate-2.json] [--subdomain familiarcow] [--url <service>=<url> ...]
```
One PASS/FAIL line per Worker, exit 1 on any FAIL: unreachable / non-200, escrow id differs from the release record, wrong network, `git_sha` unknown, or a cron Worker's `last_tick_at` older than 3x the cron interval (keeper cron `* * * * *` -> 3 min). Redeploy: `set -a; . $PRAETORIAL_SECRETS_DIR/praetorial-cloudflare.env; set +a; cd services/workers && scripts/deploy-testnet.sh`.

Live run 2026-11-09 (after redeploying the seven testnet Workers from commit c48eac62b3f7):
```
deployed-stack check: network=testnet release=release/freeze-candidate-2.json expected escrow=praetorial-frz1b-2611081810.praetorial-dev-1101.testnet
PASS indexer     praetorial-indexer-testnet  network=testnet escrow=praetorial-frz1b-2611081810.praetorial-dev-1101.testnet git_sha=c48eac62b3f7 tick_age=5s
PASS keeper      praetorial-keeper-testnet  network=testnet escrow=praetorial-frz1b-2611081810.praetorial-dev-1101.testnet git_sha=c48eac62b3f7 tick_age=18s
PASS monitor     praetorial-monitor-testnet  network=testnet escrow=praetorial-frz1b-2611081810.praetorial-dev-1101.testnet git_sha=c48eac62b3f7 tick_age=16s
PASS notifier    praetorial-notifier-testnet  network=testnet escrow=praetorial-frz1b-2611081810.praetorial-dev-1101.testnet git_sha=c48eac62b3f7
PASS relayer     praetorial-relayer-testnet  network=testnet escrow=praetorial-frz1b-2611081810.praetorial-dev-1101.testnet git_sha=c48eac62b3f7
PASS registry    praetorial-registry-testnet  network=testnet registry_id=registry.praetorial.testnet git_sha=c48eac62b3f7
PASS sourcecheck praetorial-sourcecheck-testnet  network=testnet escrow=praetorial-frz1b-2611081810.praetorial-dev-1101.testnet git_sha=c48eac62b3f7
deployed stack OK (7/7 PASS)
```
Redeployed versions: indexer 8cccf69a-d3ca-43c9-88b2-25dda76a69b9, notifier ffa4c469-4e28-4e8c-8312-2ee5a49d713b, monitor 8c246ebb-6af3-44eb-80f1-bbcba9f2eee4, relayer 8a5a1e4a-e0fb-430a-a15e-482626d9c133, keeper 6bf0685f-b649-41e9-81ef-ffe1f0fc012c, registry 64524c2a-0053-4e5b-8fb0-afe16b519a05, sourcecheck 37ea635f-1291-4650-b697-db5cc3cf033d.

DONE STACK1: /health on 7 Workers + check-deployed-stack live 7/7 PASS (testnet).

## RFRZ2 (2026-11-09): re-run against the new testnet escrow `praetorial-frz2-2611091914.praetorial-dev-1101.testnet`
Release record `release/freeze-candidate-2.json` (resolver 6517a422... = SRCCHK3 record-b67b3d7, escrow caf134a4 unchanged). All seven testnet Workers redeployed with `scripts/deploy-testnet.sh` (log: `services/e2e/live-RFRZ2/deploy-workers.log`), then:
```
deployed-stack check: network=testnet release=release/freeze-candidate-2.json expected escrow=praetorial-frz2-2611091914.praetorial-dev-1101.testnet
PASS indexer     praetorial-indexer-testnet  network=testnet escrow=praetorial-frz2-2611091914.praetorial-dev-1101.testnet git_sha=a331d539545c tick_age=18s
PASS keeper      praetorial-keeper-testnet  network=testnet escrow=praetorial-frz2-2611091914.praetorial-dev-1101.testnet git_sha=a331d539545c tick_age=23s
PASS monitor     praetorial-monitor-testnet  network=testnet escrow=praetorial-frz2-2611091914.praetorial-dev-1101.testnet git_sha=a331d539545c tick_age=22s
PASS notifier    praetorial-notifier-testnet  network=testnet escrow=praetorial-frz2-2611091914.praetorial-dev-1101.testnet git_sha=a331d539545c
PASS relayer     praetorial-relayer-testnet  network=testnet escrow=praetorial-frz2-2611091914.praetorial-dev-1101.testnet git_sha=a331d539545c
PASS registry    praetorial-registry-testnet  network=testnet registry_id=registry.praetorial.testnet git_sha=a331d539545c
PASS sourcecheck praetorial-sourcecheck-testnet  network=testnet escrow=praetorial-frz2-2611091914.praetorial-dev-1101.testnet git_sha=a331d539545c
deployed stack OK (7/7 PASS)
```
