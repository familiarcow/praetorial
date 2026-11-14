# treasury (D-ECON2 offchain treasury swap job)

Completed bets pay a 1% protocol fee per asset plus a per-asset
`run_price`, collected into a single fee account. This job reads that
account's per-asset balances and plans swaps, via the NEAR Intents
1Click Swap API, into two targets:

- **NEAR float** — tops up the relayer and keeper gas accounts toward
  their configured target levels (`relayerFloatTarget`,
  `keeperFloatTarget`).
- **USD-stable bucket** — whatever is left over once the NEAR float is
  satisfied, destined to fund NEAR AI credits.

**Dry-run is the default and the only mode this package's tests ever
exercise.** Every quote request sent by `planTreasuryRun` has
`dry: true` unless `liveModeEnabled(cfg)` returns true, which requires
**both**:

1. `cfg.live === true`, and
2. the `TREASURY_ALLOW_LIVE_SWAPS=1` environment variable.

No test in this package sets the env var, so live execution is never
exercised here, and no network call is made anywhere in the test
suite — the 1Click client is always an injected fake implementing
`OneClickClient` (`src/oneClickClient.ts`).

## 1Click API shape

Request/response types in `src/oneClickClient.ts` are based on the
**public** NEAR Intents docs:

- https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote
  (`POST /v0/quote`, including the `dry` flag: "If `true`, the
  response will NOT contain [a `depositAddress`]... useful for
  previewing swap parameters... without committing to an actual
  swap.")
- https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request
  (full request body shape: `swapType`, `slippageTolerance`,
  `originAsset`, `depositType`, `destinationAsset`, `amount`,
  `recipient`/`recipientType`, `refundTo`/`refundType`, `deadline`)
- https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api
  (overview: "Assets move to a quote-specific deposit address and
  settle on-chain; 1Click does not take custody of them.")

No insider/non-public source was used. The real HTTP client (hitting
`https://1click.chaindefuser.com`) is not implemented in this change —
only the interface and types are, since live mode is explicitly out of
scope for this task.

## Planning logic (`src/treasuryJob.ts`)

`planTreasuryRun(feeReader, floatReader, client, cfg)`:

1. Reads collected per-asset fee balances (`FeeBalanceReader`, injected)
   and the current relayer/keeper NEAR balances (`FloatBalanceReader`,
   injected).
2. Computes each float's deficit (`target - current`, floored at 0)
   and sums them into `remainingNearDeficit`.
3. Walks the collected balances in a deterministic (sorted by asset
   id) order. For each asset:
   - The configured `nearAssetId` itself is never swapped (swapping
     NEAR for NEAR is meaningless) — skipped and logged as such.
     Routing an already-NEAR fee balance into the floats directly is
     outside this job's scope.
   - Zero balances and balances below the configured minimum swap size
     (`minSwapSize[assetId]` or `defaultMinSwapSize`, a dust floor) are
     skipped **without ever calling the 1Click client**.
   - Otherwise, the asset's **entire** collected balance (never more)
     is quoted via `client.getQuote()` into `nearAssetId` while
     `remainingNearDeficit > 0`, else into `usdAssetId`.
   - A quote failure (the client throws) skips that asset — no swap is
     recorded — and is logged via `cfg.logger` (defaults to
     `console.error`).
4. NEAR raised this run is attributed across the two floats: relayer's
   own deficit first, then keeper's, never exceeding either float's
   individual remaining deficit.
5. Returns `{ dryRun, swaps, skipped, remainingNearDeficit }`. A
   positive `remainingNearDeficit` means this run's available balances
   weren't enough to fully top up both floats (a partial top-up) —
   expected and not an error; the next run will continue from wherever
   the floats and fee balances stand then.

The planner is a pure function of its injected readers' and client's
return values for a single call, and executes nothing against the fee
account itself in dry-run mode — so re-running it against the same
unchanged balances is idempotent (`treasuryJob.test.ts`, "idempotent
re-run").

## Config (`TreasuryConfig`, `src/types.ts`)

`nearAssetId`, `usdAssetId`, `relayerFloatTarget`, `keeperFloatTarget`,
`minSwapSize` (per-asset dust floor map), `defaultMinSwapSize`,
`slippageToleranceBps`, `treasuryAccountId` (used as the quote's
`refundTo`/`recipient`), `live`, optional `logger`.

## Tests

`npm test` (from `services/`) runs the whole suite; this package
contributes **10 tests** in `treasury/test/treasuryJob.test.ts` (the
planner, unchanged by the follow-ups below), plus **7** in
`test/rpcBalances.test.ts`, **7** in `test/oneClickHttpClient.test.ts`,
and **6** in `test/runner.test.ts` — **30 tests total**, all against
fakes/mocks (no network, no mainnet, no testnet, no keys):

- nothing to swap (empty balances / floats already at target)
- partial top-up (available swap value less than the float deficit)
- full top-up with leftover correctly routed to the USD bucket, with
  NEAR allocated across relayer/keeper by their own deficits
- below-minimum dust skipped without ever reaching the 1Click client
- native NEAR collected balance never swapped
- quote failure → asset skipped, no swap recorded, failure logged
- never offers more than the asset's actual collected balance
- idempotent re-run (same inputs twice → identical plan)
- dry-run is what's actually sent on the wire by default (`dry: true`
  on every request)
- `liveModeEnabled` requires both the config flag and the env var —
  neither set anywhere in this suite

## Follow-ups (real I/O + scheduler)

Three previously-listed gaps are now implemented, each behind the same
dry-run-by-default / live-mode-gated discipline as the planner, and
each tested only against mocked RPC/HTTP (no network, no mainnet, no
testnet, ever, in `npm test`):

- **`src/rpcBalances.ts` — real `FeeBalanceReader`/`FloatBalanceReader`.**
  `getNearBalanceYocto()` reads native NEAR balance via the standard
  JSON-RPC `query`/`view_account`
  (https://docs.near.org/api/rpc/contracts#view-account).
  `getIntentsMultiTokenBalances()` calls `mt_batch_balance_of` on the
  NEAR Intents Verifier contract — request/response shape (args
  `{account_id, token_ids}`, response a same-order JSON array of
  decimal-string amounts) per
  https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/balances.
  `RpcFeeBalanceReader`/`RpcFloatBalanceReader` wrap those into the
  existing injected interfaces; `getTreasuryAccountSummary()` reads
  both the fee account's native NEAR balance and its Intents
  multi-token balances in one call, for logging/display.
  **Important caveat, per the public FAQ**
  (https://docs.near-intents.org/resources/faqs, "Is there a testnet
  deployment?"): *"There is no testnet deployment ... We recommend
  testing on NEAR mainnet using separate dev/test NEAR accounts."* The
  Intents/Verifier contract (`intents.near`) therefore has no testnet
  equivalent to default to; `DEFAULT_INTENTS_CONTRACT_ID` is the real
  mainnet address. Every test in this package depends only on a minimal
  `RpcSender` shape and exercises it through a real
  `PacedRpcClient` (`services/common/src/rpc.ts`) with a **mocked**
  `fetchImpl` — no RPC endpoint, mainnet or testnet, is ever actually
  contacted by this task's work.
- **`src/oneClickHttpClient.ts` — real `OneClickClient` over HTTP.**
  `HttpOneClickClient` POSTs to `{baseUrl}/v0/quote` (default
  `https://1click.chaindefuser.com`) with
  `Authorization: Bearer <ONECLICK_API_KEY>` per
  https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication,
  reading the JWT from env (or an injected override for tests) and
  using it **only** as that header value — never logged, never in a
  thrown error message, never serialized into the request body.
  Structurally, it **refuses to send a non-dry request at all**
  (throws before calling `fetch`): real swap submission stays
  unimplemented-to-network at the client level, independent of (and in
  addition to) `treasuryJob.ts`'s own `liveModeEnabled()` gate. Tests
  mock `fetchImpl`; no network call is made.
- **`src/runner.ts` — scheduler entrypoint.** `startScheduler()` runs
  `runOnce()` (plan → quote, dry-run, logged) on a `setInterval` whose
  period is `TREASURY_INTERVAL_MS` (default 15 minutes,
  `resolveIntervalMs()`). The scheduler is **disabled by default**:
  `main()` (the real process entrypoint, guarded by the
  `process.argv[1].endsWith("runner.ts")` convention shared with
  `keeper`/`relayer`) only calls `startScheduler()` when
  `schedulerEnabled()` — i.e. `TREASURY_SCHEDULE_ENABLED=1` is
  explicitly set. A failed run is logged, not thrown, so one bad tick
  never crashes the process. Real swap execution remains gated on two
  independent layers even if the scheduler is enabled: (1)
  `planTreasuryRun`'s own `cfg.live && TREASURY_ALLOW_LIVE_SWAPS=1`
  requirement, and (2) `HttpOneClickClient`'s structural refusal of
  non-dry requests described above. `runOnce`/`startScheduler` take
  injected readers/client exactly like `planTreasuryRun`; the test
  suite (`test/runner.test.ts`) only ever exercises those with fakes —
  `main()` itself is never invoked by tests.

## Known gaps / not done

- **No live swap submission anywhere.** `HttpOneClickClient` only ever
  sends `dry: true` quotes (structural refusal of anything else); no
  code path in this package submits a deposit, polls `/v0/status`, or
  otherwise executes a real swap. This is intentional — it was
  explicitly out of scope for this task.
- **No partial-asset splitting.** Each asset's full collected balance
  is routed to one destination (NEAR float while there's deficit, else
  USD); a single asset's balance is never split across both
  destinations in one run. Acceptable for the stated behavior (deficit
  gets filled across *multiple* assets as needed) but means a very
  large single-asset balance can overshoot the NEAR float target
  before any of it reaches the USD bucket in the same run.
