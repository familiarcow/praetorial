# Praetorial testing

One entry point: `./test.sh [fast|full|live]`. Every tier prints a final
table and exits non-zero on any red. **Never skip or ignore failing
tests** — red-by-design probes (documented, expected-red invariant
checks) still count as red and are listed by name, never hidden as
"skipped".

## RPC config (D-RPC1)

ONE shared NEAR RPC config lives in `services/common/src/rpc.ts` — every
service, `test.sh`'s `live` tier, and the privy-e2e/privy-web-e2e
harnesses route through it instead of hardcoding a URL. `chaos/` is the
one exception: it only ever talks to a local sandbox, never
testnet/mainnet, so it's out of scope for this config.

## Multi-version escrow contracts (D-UPGRADE1, queue item 10)

`ESCROW_CONTRACTS` configures every escrow contract version the keeper
and indexer watch: a comma-separated `id@version` list, e.g.
`escrow-v1.testnet@v1,escrow-v2.testnet@v2`. Falls back to a single
entry built from `ESCROW_CONTRACT_ID` (tagged `v1`) when unset, so an
existing single-contract deployment needs no env change. Newest =
highest version; the keeper only does opening/sourcecheck work on the
newest contract, finishes every live bet on whichever contract it
started on, and calls `emergency_refund` (never resolution/finalize)
for every non-terminal bet on a contract whose `is_shutdown()` view
reports true, while payout draining continues normally. The indexer's
board/history tag every row with its contract id + version and expose
the newest contract id for "create new bets here". See
`services/common/src/config.ts` (parsing), `discovery.ts`
(`discoverAllBetsMulti`, `TaggedBet`), `shutdown.ts`
(`checkContractShutdown`), `keeper/src/policy.ts`
(`planActionsForContracts`), and `indexer/src/board.ts`.

- `NEAR_RPC_URL` selects the endpoint; default is derived from
  `NEAR_NETWORK`/`NEAR_NETWORK_ID` (testnet default):
  `https://test.rpc.fastnear.com` (testnet) /
  `https://free.rpc.fastnear.com` (mainnet).
- `NEAR_RPC_FALLBACKS` is a comma-separated list of backup endpoints
  (empty by default). A fallback is only tried after the current URL's
  retries are exhausted — add a backup provider later with zero code
  change.
- Client-side pacing: max 3 requests/s, max 4 in flight, tx status
  polled every 1.5s. Retries use exponential backoff + jitter on HTTP
  429/5xx/network errors, honoring `Retry-After` when the server sends
  one, bounded by a max-retry count.
- 429s are counted per process (`get429Count()` in `rpc.ts`) so a full
  testnet run can report sustained throttling.
- `services/common/test/rpcStatic.test.ts` fails the build if any
  `services/` source file hardcodes an RPC URL outside `rpc.ts`.

## NEAR AI key lookup (which OutLayer account the wasm reads)

The resolver wasm never reads the NEAR AI key from the job JSON. In a `real-http` build it reads
`NEAR_AI_API_KEY` (and optional `NEAR_AI_API_BASE`) from its **environment**, which OutLayer fills from the
secret stored under the request's `secrets_ref {profile, account_id}`. The escrow sends that ref from its
`outlayer_config`: `secrets_profile` (e.g. `praetorial-resolver`) and `secrets_account_id`. So the secret must be
bound under **`secrets_account_id`'s** OutLayer home (the dev/secrets-owner account, NOT the escrow account
itself), with `--wasm-hash <resolver wasm sha256>` as the accessor and the escrow whitelisted via `--via`.

Bind it with `services/e2e/live-run16r/bind_secret.sh` after pointing `OUTLAYER_HOME` at the **secrets-owner
account's** home (the R3c run bound it under the escrow account's home, the wasm looked under the dev
account, and bet 1 silently used the mock). The key itself comes from `$PRAETORIAL_SECRETS_DIR/praetorial-nearai.env`
and is never printed.

**NOKEY1 (D-NOKEY1): a real-http build with no key never signs an outcome.** Without `NEAR_AI_API_KEY` the run now prints an
UNSIGNED error object (`{"error":"no_live_judge_key","reason":<NO_KEY_REASON, names the missing key + secrets_ref>,"judge":{"judge_backend":"offline-mock",...}}`:
no `result`, no `signing`; pinned by `contracts/escrow/tests/fixtures/nokey1_no_key_output.json`). The frozen escrow handles it as an executed-but-unusable
run (`on_resolution` stores it in `last_resolution_raw`): `runs_used` unchanged, the bet stays `Resolving` (cannot be re-requested), no recovery/VOID-refund clock
(`first_unavailable_ns` None, `retry_count` 0); the parties are refunded by `void_after_deadline` at `resolve_deadline`. (`RETRY:no_live_judge` is not usable here:
the escrow accepts it only when no judge pair is live.) Tests: resolver `nokey1_*` (wasm-bin, with and without `--features real-http`),
escrow `tests/nokey1_no_key_output.rs`. The non-real-http (default/test) build keeps `OfflineMock` (`offline_mock_never_decides_yes`).
**Release preflight (run before every deploy/mainnet go, after every resolver rebuild):**
`OUTLAYER_HOME=<secrets-owner home> python3 -I resolver/release/check_key_bound.py --escrow <escrow> --hash <64-char resolver hash>` exits 1 unless
`outlayer secrets list -v` has a row `praetorial-resolver WasmHash(<first 8>...) from:<escrow>`; it never prints a key (the list is metadata-only, long tokens redacted;
the list shows 8 hex chars, so also compare all 64 against the escrow's pinned hash). Unit tests: `resolver/release/test_check_key_bound.py` (in `./test.sh fast`, step "release record").

Before NOKEY1 (older wasm builds), if no key reached the wasm a real-http build fell back to the offline mock and still signed, but the output's
`judge` block said so: `judge_backend: "offline-mock"` plus `judge_backend_reason` (naming
`NEAR_AI_API_KEY` and `secrets_account_id`). A real run reports `judge_backend: "near-ai"`. **Always check
`judge_backend` before treating a live run as real.** Model ids must be ones NEAR AI lists
(`resolver/wasm-bin/fixtures/near_ai_models.json`, from `GET /v1/models`); a unit test pins the judge constants to it.
Per-call `run_diagnostics` carry `http_status`, `error_body_head` (non-2xx, sanitised, <=300 chars),
`first_byte_ms`, `total_ms`, `idle_timeout_hit`, `total_timeout_hit`, `signature_verified` (true/false, null when not attempted).

**frz2 specifics (FRZ2SEC1).** Escrow `praetorial-frz2-2611091914.praetorial-dev-1101.testnet`: `outlayer_config` = `{secrets_profile: "praetorial-resolver", secrets_account_id: "praetorial-dev-1101.testnet"}`;
pinned resolver hash (`resolver_keys()[2]`, equals `apps/web/lib/release.json`) = `6517a422f55639d5d452ba2abcea93cc261c33729025be2afd5efcfa42d3b1c3` (compare all 64 chars). `praetorial-dev-1101.testnet`'s OutLayer
home is the default `~/.outlayer` (the `olhome-*` dirs hold per-escrow accounts, not the secrets owner). Every new escrow or resolver hash needs its own binding:
`OUTLAYER_HOME=~/.outlayer bash services/e2e/live-run16r/bind_secret.sh <escrow> <64-char hash>` (the script defaults to the old e2e escrow; profile via `PROFILE`).
Check with `outlayer secrets list -v` (row `praetorial-resolver WasmHash(6517a422...) from:<escrow>`). DR4 bet 25 ran unbound and got `offline-mock`; bet 26 after binding got `near-ai` with http_status [200, 200].
Guard: `services/e2e/live-DR/harness/judgeBackend.ts` `assertRealJudge(last_resolution_raw)`; the evidence recorder calls it, so no DR finish phase can record an offline-mock run.
Also: `request_resolution` needs keeper credit (`keeper_credit_balance`, `topup_keeper_credit` from the keeper/fee account) and the keeper account balance must cover the gas reserve.

## Tiers

- `./test.sh fast` — escrow `cargo test`, wasm-bin `cargo test` (resolver/wasm-bin), services `npm test`,
  services `tsc --noEmit` (TSC1: the test runner doesn't typecheck, so this step fails on any type error in src or tests),
  `apps/web` `npm test`, `tests/conformance/run.sh`, (PUB1: every step that needs node deps runs
  `tests/lib/deps.sh` `ts_ensure_node_deps` first, for `services/` and `apps/web` alike: `npm ci` when
  `node_modules` is missing; meta-test `tests/test_sh_deps.sh`, run inside the services npm test step),
  `judge-proto/redteam_evidence`. No sandbox. ~45-60s. (`CM-18b` closed 2026-11-04 per Decision register
  D-TTL1 — single offer-TTL ceiling, no self-paid tier; conformance is
  now fully green.) `judge-proto/redteam_evidence` is now fully green
  too (0 red-by-design, 0 unexpected failures) — see "Known
  red-by-design" below for what closed and when.
  **redteam_evidence (RTE4/RTE4b, D-RTE4/D-RTE4a):** JUDGE cases run on the production pair (DeepSeek-V4.1-Flash + GLM-5.3-flash, NEAR AI, temp 0)
  via `production_pair.py`; the decision is made by the Rust path (`resolver/core/examples/decide_element.rs`: `judge_element_tiered_at` + `decide`
  + insufficient-stays-insufficient + ESCALATE->VOID), one shared `decide_from_raws`. Cases with no tier spanning >= 2 origins assert
  `outcome != YES` and `== Rust decision` (their haiku `expect` is unchanged for the nightly); two-origin twins (`attacks_rte4b.py`) assert NO.
  Offline parity step `rte4b parity` (`test_rte4b_parity.py`) compares a Python reference with the Rust path. A glm empty response is INFRA (exit 3), never green.
  **RTE4c (D-RTE4b): the fast gate is now OFFLINE** — it replays the real recorded production-pair raw answers committed in
  `judge-proto/redteam_evidence/replay/` (one fixture per JUDGE case + one recorded EMPTY-reply fixture; `MANIFEST.json` = sha256 + run id + model ids
  + UTC time; fixtures carry an inputs hash, a changed case makes its fixture stale = red) through the same Rust `decide_from_raws`; `test_rte4c_replay.py`
  (step "rte4c replay") asserts zero network calls/key access, the manifest, the empty-reply -> VOID mapping and that the harness transport-retry bound
  equals `resolver/wasm-bin` `STREAM_MAX_ATTEMPTS`. Re-record fixtures live with `record_replay.py RUN_ID` (NEAR AI spend). The LIVE production-pair run is the
  nightly step `nightly_production_pair.py` in `./test.sh full` (each case 5 non-INFRA runs, <=10 attempts; empty reply = production-mirroring transport retry,
  then INFRA, reported separately; INFRA > half of attempts = red; a decisive wrong verdict = `ACTION NEEDED: wrong-winner finding`, exit 4);
  the claude:haiku comparison also stays in the nightly.
  The local NEAR spend cap (`NEAR_SPEND_CAP_USD`, default $5, ledger `judge-proto/nearai_spend.jsonl`) applies to the live/nightly and recording paths: raise it for long runs.
- `./test.sh full` — fast tier + a serial `budget` step + the whole chaos suite via
  `node chaos/run.mjs` (all 9 families, parallel sandboxes, default
  concurrency 3). Chaos families only get added here, never to fast.
  **`budget` step (CPUFLAKE1 / D-CPUFLAKE1a):** every CPU-budget (5 ms p99) and wall-budget (15 / 25 ms) timing
  test lives in `services/workers/*/test-budget/*.test.ts` and is NOT in the parallel `services npm test` glob
  (they flake when the box is loaded). `cd services && npm run test:budget` (`scripts/run-budget.mjs`) runs them
  one file at a time with `node --test --test-concurrency=1`; thresholds are unchanged. Files: keeper/monitor/
  notifier/relayer `cpuBudget.test.ts`, keeper + relayer `worker.miniflare.budget.test.ts`. The functional
  miniflare tests (`test/worker.miniflare.test.ts`, shared `test/miniflareHelpers.ts`) and the `cpuBench`
  helper tests stay in fast. `./test.sh fast` prints one `NOTE:` line listing the budget files it does not run.
  `workers/common/test/budgetCoverage.test.ts` (fast) fails if any budget file is in neither place.
  Run the budget step on a quiet box; it is meaningless under load.
  **Nightly deep tests must run `./test.sh full`** (not `fast` + chaos by hand) so the budget step is included.
  The nightly is the cron prompt "Praetorial nightly deep tests + red team" (not in this repo): it needs a
  one-line update by praetorial-bot to call `./test.sh full`.
- `./test.sh live` — testnet g4 lifecycle + `services/privy-web-e2e`
  `npm run e2e`. Refuses to run unless the deployed testnet escrow code
  matches the local `cargo-near` build, and prints the redeploy command
  when it doesn't.

## Web e2e port isolation (FE1b)

The `web e2e (mocked)` step asks the OS for a free port every run (`apps/web/scripts/free-port.mjs`) and sets `PW_CI=1`, under which `playwright.config.ts` has `reuseExistingServer: false`: it never reuses another worktree's vite, and fails loudly if the port is taken. Local manual `npm run test:e2e` (no `PW_CI`) still reuses a running dev server. Guarded by `apps/web/tests/e2ePortIsolation.unit.test.ts`.

## Per-run log directory (TS2)

`./test.sh` writes every step log into one per-run directory, `mktemp -d "${TMPDIR:-/tmp}/praetorial_test.XXXXXX"`
(exported as `PRAETORIAL_TEST_LOGDIR`), so two concurrent runs in different worktrees never overwrite each
other's logs. File names are unchanged: `praetorial_test_<step_with_underscores>.log`
(e.g. `praetorial_test_services_npm_test.log`, `praetorial_test_chaos.log`, `praetorial_test_release_sandbox.log`,
`praetorial_cargo_near_build.log`, and `praetorial_conformance_last.log` from `tests/conformance/run.sh`).
The summary prints `Logs: <dir>` and, for each FAIL, `FAIL log: <step> -> <path>`. Read the log from that
path, never from a fixed `/tmp` name. The logging helpers live in `tests/lib/logdir.sh`; the standalone test
`tests/test_sh_logdir.sh` runs two fake concurrent runs and checks isolation (run it directly; it is not a
`test.sh` step, so the step list is unchanged). The dirs are not auto-deleted (they sit under `$TMPDIR`).

## Chaos suite (`chaos/run.mjs`)

```
node chaos/run.mjs [--family NAME] [--scenario NAME] [--parallel N]
```

- Sweeps stale `near-sandbox`/`sandbox-launcher` processes once, up
  front — never mid-run (that would kill a sibling family's sandbox
  when running in parallel).
- Global `SIGINT`/`SIGTERM`/`uncaughtException`/`unhandledRejection`
  handlers in `chaos/harness.mjs` track every sandbox process group
  started and kill it on exit, even if the whole run is interrupted
  mid-scenario.
- Each scenario gets a 120s timeout (`CHAOS_SCENARIO_TIMEOUT_MS` env to
  override); a scenario that doesn't finish in time is marked
  `TIMEOUT`, still torn down, and counts as red.
- Results: `chaos/results/latest.json` (machine-readable) +
  `chaos/results/log.jsonl` (append-only history) + a plain stdout
  table (scenario, verdict, seconds).
- `chaos/run_*.mjs` are kept as thin one-line wrappers for the old
  per-family invocation style; nothing new should depend on them —
  use `chaos/run.mjs --family X` instead.
- **Known gap**: this run.mjs does NOT yet boot one shared sandbox per
  family (each scenario still boots its own, as before) — that
  optimization from the original plan was cut for time. Scenarios are
  already fully isolated either way; it's a speed optimization, not a
  correctness one.

### Adding a scenario

1. Add a new `runScenario(family, name, fn)` call inside the relevant
   `chaos/scenarios/<family>.mjs` file (or a new file — register it in
   the `FAMILIES` map at the top of `chaos/run.mjs`).
2. `fn(ctx)` gets a fresh sandbox + funded accounts (`ctx.maker`,
   `ctx.taker`, etc.) and must return `{verdict: "pass"|"break", ...}`
   or throw.
3. Run just that one scenario while developing:
   `node chaos/run.mjs --family <family> --scenario <name>`.
   Never rerun the whole family to check a one-line fix.

## Known red-by-design (as of 2026-11-05)

- `judge-proto/redteam_evidence`: **none currently** — all three probes
  previously listed here now PASS and are closed:
  - `relitigation_new_round_evidence_is_scoped_or_frozen` (re-litigation
    scoping — exhibits from later rounds are no longer admitted as if
    round 0; D-DISPUTE1 fix landed).
  - the exhibit-length-cap redteam probe (`exhibit_text_length_is_capped`
    — `MAX_EXCERPT_CHARS=4000` is enforced; D-DISPUTE1 fix landed).
  - `OQ_T9_window_close_uses_onchain_timestamp` (on-chain timestamp
    check — `admit()`'s window-close check now compares
    `onchain_submitted_at`, not the self-reported `submitted` field;
    D-AUDIT10/OQ-T9 fix landed).
  Verified by running `python3 judge-proto/redteam_evidence/test_redteam_evidence.py`
  directly: 21 pass, 0 red-by-design, 0 unexpected failures. (One of
  those 21, `revision_window_corrects_ignores_publisher_identity`, was
  itself a real, newly-found bug as of the 2026-11-05 nightly run —
  fixed same day; see the REVISION_WINDOW_V1 publisher-identity fix in
  the git log / Decision register.)
- `chaos drain_payouts` family: **both** scenarios
  (`worst_case_bet_drains_via_repeated_calls`,
  `failed_transfer_mid_batch_pays_exactly_once`) currently **TIMEOUT**
  at 120s against current `contracts/escrow` — the harness keeps
  retrying a `request_resolution`/`submit_outcome` cycle that panics
  with `settlement_period not elapsed` and never reaches
  `drain_payouts`. This is reported as-is per policy; the contract was
  not touched to fix it. Root-cause not yet investigated — needs a
  `fastForward` placed before that cycle, or the panic means
  `settlement_period` legitimately isn't satisfied yet by the
  scenario's fixture ordering. Follow-up task.
- `chaos infra` family: all 7 scenarios PASS as of this run.

## Testnet redeploy (step 5) — NOT DONE

Not attempted this session: the 45-minute hard wall-clock limit on this
task was spent on the leak fix, the `run.mjs` rewrite, and running
`drain_payouts`/`infra` for real (see commit log). Redeploying to a
fresh `escrow4.praetorial-dev-1101.testnet` via `cargo near build
non-reproducible-wasm`, wiring g4/privy-web-e2e env to it, and running
one lifecycle path remains open. `test.sh live`'s hash-check scaffold
is in place but unexercised against a real deploy.

## Source Catalog (item 17a, OutLayer testnet TEE probe)

One OutLayer testnet run of the probe-only wasm (`probe-sources` feature, sha256 `f9adbe6f…e5a2`, signs nothing, no NEAR AI calls),
2026-11-06. All 66 fetches fit **one** run (25 s in-wasm; OutLayer's default 10 s limit must be raised via `resource_limits`
on a direct `request_execution`, see `services/e2e/probe17a/run_probe.mjs`). Raw data: `services/e2e/probe17a/results.json`.
"TEE status" = HTTP status seen from inside the TEE. History depth = age of the oldest record returned by a request that asked for that window.

| Source | Endpoint | TEE status | Bytes | Records | History depth | Notes |
|---|---|---|---|---|---|---|
| Coinbase 1m | api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60 | 200 (now/30d/60d) | ~3.5k per 60 candles | 60 | ≥60 d (asked 60 d back, got it) | Works from TEE (earlier block did not recur). 300-candle cap per request |
| Coinbase 1h | …granularity=3600 | 200 | ~1.5k per 24 | 24 | ≥60 d | same |
| Bitstamp 1m | www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&start= | 200 | ~8k per 60 | 60 | ≥60 d | `start` honoured at all offsets |
| Bitstamp 1h | …step=3600 | 200 | ~3.3k per 24 | 24 | ≥61 d | same |
| Kraken 1m | api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1&since= | 200 | 57,256 | 721 | **~12 h only** | `since` older than retention is ignored: the latest 721 candles come back. 1m is unusable for settling anything older than ~12 h |
| Kraken 1h | …interval=60&since= | 200 | 59,449 | 721 | **~30 d** | 30 d and 60 d requests return the same newest 721 candles (oldest 30.0 d) |
| Gemini 1m | api.gemini.com/v2/candles/btcusd/1m | 200 | 88,696 | 1,439 | ~1 d | No time parameters, so no 30/60 d request exists; always the latest window |
| Gemini 1h | …/1hr | 200 | 90,479 | 1,463 | ~61 d | same |
| MLB schedule | statsapi.mlb.com/api/v1/schedule?sportId=1&date= | 200 | 262 | 0 games (off-season day) | n/a (date param, not probed for depth) | reachable; empty for that date |
| NHL score | api-web.nhle.com/v1/score/{date} | 200 | 21,637 | 3 games | n/a | reachable |
| ESPN NFL | site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates= | 200 | 5,050 | 0 events | n/a | no game that day; reachable |
| ESPN NBA | …basketball/nba/… | 200 | 149,329 | 9 events | n/a | big body; unofficial API |
| ESPN MLB | …baseball/mlb/… | 200 | 1,393 | 0 events | n/a | off-season |
| ESPN NHL | …hockey/nhl/… | 200 | 72,928 | 3 events | n/a | matches the NHL API count |
| NWS CLI | api.weather.gov/products/types/CLI/locations/{NYC,LAX,…} | 200 for all 20 stations | 5.7–11.3k | 14–28 products | ~7 days (oldest 6.8–6.9 d; newest <6 h old) | location code = station minus the K. Rolling list only: short history |
| IEM cli.py | mesonet.agron.iastate.edu/json/cli.py?station=K…&year=2026 | 200 for all 20 stations | 384–392k | 310 days (309 for KSAN) | whole year (back to 2026-01-01) | `dt=` is ignored (returns a stale year); use `year=`. ~390 KB per station-year |

Stations probed (NWS and IEM, all 200): KNYC KLAX KORD KMIA KDFW KDEN KPHX KSEA KATL KBOS KIAH KMSP KDCA KPHL KSFO KLAS KAUS KDTW KMDW KSAN.

## Build cache isolation (L1b12)

**Symptom:** after a `cargo clean -p near-sdk-core ...`, `./test.sh fast` passed once, then the next run failed in the escrow step (0s, E0308 "multiple different versions of crate `near_sdk_core`") and in conformance.

**Findings (honest):** every fast-tier cargo step that touches `contracts/target` (escrow `cargo test`, and conformance run.sh's "escrow (existing suite)") uses identical flags (debug, `unit-testing`, no RUSTFLAGS, toolchain 1.97.1 from `contracts/rust-toolchain.toml`); wasm-bin, resolver/core and the escrow_conformance/resolver_conformance crates use their own `<crate>/target`. With a clean environment I could NOT reproduce the failure (clean + 2 runs and clean + 3 runs all passed). The only things that write different near-sdk-core builds into `contracts/target` are outside the fast tier: `chaos/harness.mjs` (`--release --target wasm32-unknown-unknown`, `--cfg near` from `contracts/.cargo/config.toml`), `cargo near build`, and stripped release builds (`CARGO_PROFILE_RELEASE_STRIP=symbols`), plus any caller-exported `CARGO_TARGET_DIR`/`RUSTFLAGS` (agent shells here export a shared `CARGO_TARGET_DIR`), which redirect/mix builds into whatever dir the caller shares across runs. Most likely cause: concurrent/alternating builds with different env sharing `contracts/target`, leaving several `libnear_sdk_core-*` candidates.

**Fix (build plumbing only):** `test.sh` now `unset`s any inherited `CARGO_TARGET_DIR` and runs the escrow test step (and conformance's escrow suite, via `tests/conformance/run.sh`) in a dedicated, gitignored `contracts/target-test/`. All other crates use their default `<crate>/target`. Wasm/release/chaos builds keep `contracts/target`, so they can no longer poison the test cache. No test, assertion or contract code changed. (Release/stripped build scripts in services/e2e are comments/docs only; not changed.)

**Counts, before == after:** escrow 324 + 4 passed (+0 doc); conformance "passed tests: 574", 0 failing.

**Acceptance:** after `cargo clean -p near-sdk-core -p near-sdk -p near-global-contracts -p escrow`, with a foreign `CARGO_TARGET_DIR` exported, 3 consecutive `./test.sh fast`: all 9 steps PASS each run (exit 0): run1 escrow 22s/redteam 51s, run2 escrow 5s/redteam 43s, run3 escrow 5s/redteam 46s.

## Mainnet Worker config deploy-day gate (WKMAIN1)

The deploy-day check is a script, not a skipped test (WKMAIN1b, D-WKMAIN1a): `cd services && node --import tsx workers/scripts/check-mainnet-ready.mjs`
runs the pure `checkMainnetReady()` (`workers/common/src/mainnetReady.ts`) on the six wrangler.toml files, prints each
finding and **exits 1 until the `DEPLOY_DAY_*` D1 ids are replaced** (0 when ready). Today it lists exactly the two
placeholders (pinned in `workers/common/test/mainnetReady.test.ts`). There is no PRAETORIAL_DEPLOY_DAY gate, and
`workers/common/test/noSkippedTests.test.ts` fails if any test under `services/**/test/**` uses `skip:` / `.skip(` / `todo:`.
See services/workers/README.md "Mainnet (deploy day, familiarcow's go)".

**frz3 (NOKEY1b, testnet current).** Escrow `praetorial-frz3-2611100414.praetorial-dev-1101.testnet` (same frozen escrow wasm caf134a4 as frz2), resolver `resolver_keys()[2]` = `8791413ff7943f5e5b99df4c5cafc50cb9baf5696cf32837e1a8afd31baa2473` (resolver/release/record-f9c61ec.json; equals apps/web/lib/release.json). Key bound for (frz3, that hash) with `bash services/e2e/live-run16r/bind_secret.sh <frz3> <hash>`; `check_key_bound.py --escrow <frz3> --hash <hash>` -> OK, made-up hash -> FAIL (evidence: services/e2e/live-NOKEY1b/). Keeper/indexer/notifier Workers watch frz3 + frz2 (`ESCROW_CONTRACTS`, D-UPGRADE1) so frz2 in-flight bets still pay out; frz2 stays bound to 6517a422 and is not a NOKEY1 target. Every new escrow/hash needs its own key binding and its own report_pubkey jobs (D-KEY2).

## Python for test.sh (TESTPY1)

Every python step in `./test.sh` (rte4b, redteam_evidence, rte4c, release record, nightly)
runs under ONE interpreter resolved by `tests/lib/python.sh`: `$PRAETORIAL_PYTHON` if set
(must import `cryptography`, else loud failure, no fallback); otherwise the repo-local
`.venv` (gitignored), which test.sh creates/repairs from `judge-proto/requirements.txt`
(pip from PyPI). If neither works, test.sh aborts with an actionable message; it never
skips the python steps. `tests/test_sh_python.sh` (run inside the rte4b step) proves the
resolver picks `PRAETORIAL_PYTHON` and fails loudly when cryptography is missing.
