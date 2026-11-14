# Praetorial offchain services v0

TypeScript services that operate the escrow contract without ever holding
a key that can move funds or decide an outcome (design ground rule:
"services can't move funds or decide outcomes; anyone can self-trigger").
Every permissioned-looking action here is actually permissionless on the
contract side — the keeper is just the account that happens to pay gas
for calling it.

## Services

- **keeper** (`keeper/src/`) — polls the escrow contract and fires the
  permissionless triggers whose time has come: `request_resolution`,
  `finalize`, `void_after_deadline`, `expire`, `retry_payout`. Decision
  logic lives in `policy.ts` as a pure function of `(bets, now)` — no
  RPC, no I/O — so it's unit-testable without a network and the keeper
  runner (`runner.ts`) is the only file that touches RPC/state files.
  Idempotent (rate-limited retries), capped attached-NEAR per call
  (`MAX_ATTACHED_NEAR_YOCTO`, see `common/src/config.ts`), and `finalize`
  is called with up to 300 Tgas per the spec.
- **indexer** (`indexer/src/`) — read-only HTTP server: open-offers board
  + per-account history. Holds no key at all; `board.ts` (the pure logic)
  makes zero contract calls and is tested to never require a private key.
- **notifier** (`notifier/src/`) — computes proposed/closing-soon/
  settled/voided notices into a local outbox file. No contract call,
  ever (alerts are a convenience, never load-bearing). Ships a `NoOpEmailProvider`
  stub only — no real email provider wired, no PII store.
- **monitor alerts** (`monitor/src/alerts.ts`, `alertChannel.ts`,
  `runner.ts`) — periodic operator alerting on top of the existing
  invariant monitor (`monitor/src/snapshot.ts`/`invariants.ts`, reused
  as-is, no duplicated invariant math). Fires on: (1) any invariant
  violation (I-1/I-2/I-4/I-5/I-7) on a bet's latest `MonitorResult`,
  (2) a keeper action (`keeper/src/policy.ts`'s `nextActionForBet`)
  still due past a configurable grace period (`StallTracker`), (3) a
  sustained RPC 429/error rate across consecutive ticks
  (`RpcErrorRateTracker`, fed by `common/src/rpc.ts`'s attempt/429
  counters), (4) the escrow contract reporting `is_paused`/shut down.
  Repeated alerts for the same condition (`Alert.key`) are deduped by
  `AlertDedupe` and not resent within a configurable cooldown; dedupe
  state persists to `ALERT_STATE_FILE` across restarts. Delivery goes
  through an `AlertChannel`: log-only/dry-run by default
  (`LogOnlyAlertChannel`), with an opt-in operator Telegram channel
  (`TelegramAlertChannel`, reusing `notifier/src/telegram.ts`'s
  `TelegramChannel` verbatim) additionally fanned out via
  `MultiAlertChannel` when `ALERT_TELEGRAM_BOT_TOKEN` +
  `ALERT_TELEGRAM_CHAT_ID` are set — same "alerts are a convenience,
  never load-bearing" posture as the rest of this directory. Config:
  `ALERT_STALL_GRACE_MS` (default 10m), `ALERT_COOLDOWN_MS` (default
  30m), `ALERT_RPC_ERROR_THRESHOLD` (default 0.5),
  `ALERT_RPC_MIN_CONSECUTIVE_TICKS` (default 3), `ALERT_POLL_INTERVAL_MS`
  (default 30s), `ALERT_RUN_ONCE=1` for a single tick. All tests
  (`monitor/test/alerts.test.ts`, `alertChannel.test.ts`,
  `runner.test.ts`) use mocked chain/RPC snapshot providers, a mocked
  Telegram `fetch`, and a fabricated clock — no network, no real
  timers.
- **ops alert gaps** (MON4, `monitor/src/opsAlerts.ts`; the operations
  runbook sections 1/4/5/6/8). Five kinds through the existing `Alert` /
  `ServiceAlertRaiser` (cooldown dedupe) / channel path; each alert detail names its
  runbook section, and a cleared condition sends one `info` recovery (`<key>:recovered`).
  1. `nearai_credit_exhausted` (critical, "NEAR AI credits exhausted. Please top up."):
     HTTP 402, or a 4xx body matching insufficient/credit/quota; **429 never alerts**.
     Keeper producer: a failed `request_resolution` whose error text carries it
     (`alertForNearAiError`). Resolver-side `run_diagnostics.http_status` is not polled yet.
  2. `outlayer_unhealthy` (critical): `OUTLAYER_FAIL_THRESHOLD` (3) consecutive failed
     `request_resolution` runs within `OUTLAYER_FAIL_WINDOW_MS` (30 min); keeper-side.
  3. `keeper_credit_low` (warning; critical at 0): monitor env `CREDIT_WATCH=
     account:floorYocto[:burnPerDayYocto],...` (keeper, attest, relayer accounts) via
     `view_account`; detail has the runway estimate.
  4. `service_heartbeat_missing` (critical): keeper, relayer, notifier and monitor write
     `<HEARTBEAT_DIR>/<name>.heartbeat`; the monitor alerts when older than 2x the
     interval (`KEEPER_POLL_INTERVAL_MS`, `RELAYER_HEARTBEAT_INTERVAL_MS` 60s,
     `ALERT_POLL_INTERVAL_MS`, `NOTIFIER_POLL_INTERVAL_MS`) or missing. Off unless
     `HEARTBEAT_DIR` is set. The monitor itself is covered by the keeper's/others' own
     alarm channel only if run elsewhere; a dead monitor cannot alert (see runbook).
  5. `source_unreachable` (warning): `SourceCheckTracker` (3 consecutive failures per
     bet, recovery on success) is fed by the keeper's LH3b archive runs (MON4b,
     `keeper/src/sourceFeed.ts`): each run per bet is one check (all sources signed = ok;
     failed/unsigned/signing_error/thrown = failure; 429-only = no check), warning once per
     streak via the keeper alarm channel, one recovery message. `SOURCE_FAIL_THRESHOLD`
     (default 3). The same feed raises `nearai_credit_exhausted` when the archive
     run result's `run_diagnostics[].http_status` is 402 or a credit/quota body (never 429).

- **escrow storage-headroom alert** (`monitor/src/storageHeadroom.ts`, MON1 /
  D-RTGAS1) — the escrow pays its own NEAR storage staking, so a spammer
  could drain the buffer above storage until `finalize` fails with
  `LackBalanceForState`. Each alert tick computes `headroom = view_account.amount
  - storage_usage * runtime_config.storage_amount_per_byte` from public keyless
  RPC (`query`/`view_account`, `EXPERIMENTAL_protocol_config`) and alerts
  (kind `storage_headroom`) when headroom < `MIN_HEADROOM_YOCTO` (0.5 NEAR) or
  when the linear trend over the in-memory sample store (resets on a top-up
  and on process restart; 48h retention) projects 0 within 24h
  (`PROJECTION_HORIZON_NS`). An RPC/parse failure raises a distinct
  `storage_headroom_unchecked` ("cannot check") alert, never a silent OK.
  Recorded testnet responses live in `monitor/test/fixtures/`.
  **Runbook: anyone can top up by sending NEAR to the escrow account; nothing
  else needed.**
- **relayer** (`relayer/src/`) — forwards an already-authorized transfer+msg
  to mock-intents' `transfer_with_msg`. On real `intents.near` this
  becomes `execute_intents` with the user's own signed intent and the
  relayer never needs the sender's key; on testnet mock-intents has no
  independent signature check, so the relayer asserts `signer==sender`
  explicitly rather than silently relying on that limitation.
- **common** (`common/src/`) — `NearClient` (thin near-api-js wrapper,
  hard per-call attached-NEAR ceiling), config loader (every secret/account
  from env vars, no hardcoding), borsh writer + `resolverSign.ts` (testnet
  stand-in for OutLayer's TEE signing key — never used by a real deployment).
- **e2e** (`e2e/run.ts`) — drives a full bet lifecycle on testnet with no
  manual contract calls after maker-opens/taker-takes: keeper alone pushes
  it through `request_resolution` -> `Resolving` -> (testnet resolver-sim
  submits a signed outcome) -> `Proposed` -> `finalize` -> `Settled`.

## Version check and second-RPC confirmation (D-DSY1)

**contract_version check.** The keeper (every tick), indexer (every refresh)
and notifier (every tick) read `contract_version()` (Cargo semver) from each
`ESCROW_CONTRACTS` entry and compare it with the `@label`:

- label `vN` matches iff the contract's semver **major** is `N` (`v1` ~ `1.x.y`);
- a full-semver label (`1.2.3` / `v1.2.3`) matches iff equal to the contract's version;
- anything unparsable is a mismatch.

Mismatch raises alert `contract_version_mismatch`; an unreadable/empty
version raises the distinct `contract_version_unchecked`. Alerts are logged
(LogOnlyAlertChannel, stderr) and deduped per condition (15 min cooldown).
Services never refuse to start over this (yet). Code: `common/src/versionCheck.ts`,
`monitor/src/serviceAlerts.ts`.

**Second-RPC confirmation.** A terminal bet (`Settled` or `Voided`) is shown
(indexer `/board` `/history` `/bet/:id`) or announced (notifier) only after
`rpcUrls[1]` (the first `NEAR_RPC_FALLBACKS` entry, queried directly, no
failover) returns the same state for the same contract and bet identity
(maker, terms_hash, created_at) with the same status and outcome.

- Disagreement or second RPC down: indexer entries get additive field
  `display_status: "settling, confirming"` and `status` is masked to the same
  text with `outcome: null` (no winner leaks); notifier sends nothing for that
  bet this tick and retries next tick (announced once when confirmed). Alert
  `terminal_unconfirmed`.
- **Only one RPC configured:** terminal outcomes are never shown/announced
  (always "settling, confirming") and alert `terminal_single_rpc`
  ("single RPC: terminal outcomes unconfirmed") is raised. Configure a second
  URL (`NEAR_RPC_FALLBACKS`) in every real deployment. Local dev/tests may
  set two URLs pointing at the same fake.
- Once confirmed, the indexer caches the bet as terminal (`confirmed: true`,
  existing terminal lock); non-terminal bets never query the second RPC.
- For non-terminal and confirmed bets `display_status` equals `status`.

## Test

```
npm test     # 26 tests, node:test + tsx, no network
npm run build  # tsc --noEmit
```

Every test traces to a spec line (design map / offchain services and
surfaces spec v0) or a contract invariant; see the build log for the
RED/GREEN + mutation-testing evidence per test group.

## E2E (testnet)

```
export ESCROW_CONTRACT_ID=praetorial-e2e-2611052236.praetorial-dev-1101.testnet   # item 8 deployment (live-run8)
export INTENTS_CONTRACT_ID=intents-mock.praetorial-dev-1101.testnet
export OUTLAYER_CONTRACT_ID=outlayer-mock.praetorial-dev-1101.testnet
export USDC_TOKEN_ID=nep141:usdc.testnet
npm run e2e
```

Requires `~/.near-credentials/testnet/{maker1,taker1,keeper}.praetorial-dev-1101.testnet.json`.
Tx hashes land in `data/e2e-tx-log.jsonl` (e2e script's own actions) and
`data/keeper-tx-log.jsonl` (every keeper tick). See the build log for a
specific run's hashes.

**Known trap**: the escrow contract's `Envelope.terms` field must be a
non-empty string whenever `keep_terms: true` (contract's `sanity_check`);
if it's missing, `open` fails *validation* (not a panic) and the whole
deposit is silently refunded via the standard on_transfer path — no
error, no bet, `open_offers` just stays empty. The services' own
`Envelope` TypeScript type (`common/src/types.ts`) didn't have a `terms`
field until this was hit live in E2E after a contract redeploy; fixed by
adding `terms?: string | null` to the type and always setting it in
`e2e/run.ts`.

## Contract redeploy checklist (testnet)

1. `cargo near build non-reproducible-wasm --no-abi` from
   `contracts/escrow/`, then compare its SHA-256 against
   `near account view-account-summary <contract> network-config testnet now`'s
   "Local Contract" checksum. If they differ, the deployed code is stale.
2. If the Envelope/Contract struct layout changed since the last deploy
   (new/removed/reordered fields on anything borsh-serialized and
   already stored on-chain), **delete and recreate the account** rather
   than deploying over it — a borsh layout change can't deserialize old
   stored `Bet`s and will brick `get_bet`/keeper discovery for every
   existing bet.
3. Fund the fresh account with enough NEAR for storage before `deploy
   ... with-init-call new`: ~303KB of wasm needs ~2.15 NEAR minimum
   balance; a fresh `create-account fund-myself ... '1 NEAR'` is not
   enough on its own.
4. Re-verify the "Local Contract" checksum against your build hash
   post-deploy before trusting anything via it.
