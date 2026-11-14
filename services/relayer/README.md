# relayer (real NEP-366 meta-tx)

Replaces the old mock (`submitSignedTransfer`, which required
`signer==sender` because testnet mock-intents has no independent
signature check). This relayer lets a user with **zero NEAR** act: they
sign a `DelegateAction` with their own key (in the app, via Privy
`signRawHash` in the browser — D-PRIVY1), send us the borsh+base64
`SignedDelegateAction`, and we verify + sponsor + broadcast it. Our key
only pays gas; it never holds or moves user funds.

## Endpoint

`POST /relay` — body `{ "signedDelegate": "<base64 borsh SignedDelegateAction>" }`
→ `{ "ok": true, "txHash": "..." }` or `{ "ok": false, "error": "..." }` (400).

## Pipeline (`src/relayer.ts`)

1. **Decode** (`src/delegate.ts`) — borsh-decode the `SignedDelegateAction`
   (`@near-js/transactions` `SCHEMA.SignedDelegate`). Malformed input →
   `BadSignedDelegate`, rejected before any other check.
2. **Verify signature** — ed25519 (`tweetnacl`) over the NEP-461-prefixed
   borsh hash of the `DelegateAction`, under the key the delegate itself
   claims. Fails closed.
3. **Shape check** — exactly one action, and it must be `FunctionCall`.
   No `Transfer`/`AddKey`/`DeleteKey`/`Stake`/`DeployContract`/
   `CreateAccount`/`DeleteAccount` is ever sponsored.
4. **Allowlist** (`src/policy.ts`) — receiver + method must be on the
   allowlist; `transfer_with_msg`/`ft_transfer_call` additionally checks
   the embedded `receiver_id`/`token_id`/`amount`.
5. **`maxBlockHeight` sanity** — rejects already-expired delegates and
   delegates with a window further out than `RELAYER_MAX_BLOCK_HEIGHT_FUTURE`.
6. **Guards** (`src/guards.ts` over `src/guardStore.ts`, **persistent**,
   per `senderId`): rate limit, daily sponsored-gas budget (reserve/settle,
   see below), and nonce-based replay protection (`(senderId, publicKey,
   nonce)`, marked seen only after every other check passes). Backed by
   SQLite (`node:sqlite`, no extra dependency) so a relayer restart does
   not reset any user's counters.
7. **Broadcast** — wraps the delegate in our own outer tx (`signedDelegate`
   action, `receiverId = delegateAction.senderId` per NEP-366) and
   signs+sends it with the relayer's own key.
8. **Settle actual gas** — reads `tokens_burnt` off the broadcast outcome
   (outer tx + every receipt) and settles the user's budget reservation
   to that real number, refunding the gap between the flat estimate
   reserved up front and what was actually spent.

## Persistent guard store (`src/guardStore.ts`)

Nonces, rate-limit timestamps, and daily budgets live in a SQLite file
(`RELAYER_GUARD_DB_PATH`, default `./data/relayer-guards.sqlite3`; the
real runner always sets this — only tests use `:memory:`). WAL mode +
`busy_timeout` for concurrent access; every check-then-write (replay
mark, rate-limit slot, budget reserve/settle) runs inside one `BEGIN
IMMEDIATE` transaction, so two requests for the same user racing on the
event loop serialize at the SQLite level instead of both reading stale
state. Tested directly (`test/guardStore.test.ts`): a nonce/rate-limit/
budget state survives closing and reopening the same file (simulated
restart), and 20 concurrent attempts at the same `(sender, key, nonce)`
or against a tight shared budget always yield exactly the right number
of winners, never more.

## Real gas accounting (reserve → broadcast → settle)

Previously a flat `RELAYER_PER_CALL_SPONSORSHIP_YOCTO` estimate was
charged against the user's daily budget on every call, whether the call
actually cost that much or not. Now:

1. **Reserve** the flat estimate against the budget *before* broadcast
   (the real cost isn't known yet — this is the conservative gate that
   still protects against concurrent in-flight calls and runaway
   estimates).
2. **Broadcast.** If this throws (RPC/network failure, not a policy
   rejection), the reservation is released, not charged.
3. **Settle** the reservation to `sumTokensBurnt(outcome)` — the real
   `tokens_burnt` (yoctoNEAR) summed across the outer `signedDelegate`
   transaction and every inner receipt it fanned out to. The user's
   permanent daily spend is the real number, not the estimate; only the
   up-front *reservation* (gating concurrent calls) still uses the flat
   estimate, because the real cost genuinely isn't known until the chain
   returns an outcome.

If broadcast partially succeeds then the client throws before returning
(rare network edge case), the reservation is released and the nonce
stays marked seen — NEAR nonces are monotonic per access key, so retrying
with the same nonce after a maybe-broadcast would be rejected by the
chain anyway; failing closed here avoids a double-broadcast risk.

## Allowlist mapping (method names vs. the real contract)

The task's method list (open/take/challenge/submit_exhibit/cancel/
claim) doesn't map 1:1 onto `contracts/escrow/src/lib.rs`'s
actual `pub fn` list (verified by reading it, not guessed):

| Task name | Real mechanism |
|---|---|
| open / take / challenge | no direct escrow method — these move stake, so they travel as `transfer_with_msg` (NEP-245-style, the MOCK intents contract's testnet-only shape: `{ token_id, receiver_id, amount, msg }`) on the intents contract, `msg` kind Open/Take/Bond, same as `services/privy-e2e/lib/signerPolicy.ts` and the old relayer's own module doc already describe. Enforced: receiver must be the escrow contract's address embedded in `receiver_id`, token must be the configured USDC, amount capped. |
| submit_exhibit | `submit_exhibits` |
| cancel | `cancel` |
| mutual_settle | removed (D-SETTLE3, 17e) — not allowlisted |
| claim | no method literally named `claim`; closest real equivalents are `request_resolution` (user triggers judging) and the permissionless `drain_payouts`/`retry_payout` (payout fan-out) — all three are allowlisted. |
| emergency_refund | `emergency_refund` — permissionless post-`emergency_shutdown` refund (`pub fn emergency_refund(&mut self, bet_id: u64)`, no `#[payable]`, so no deposit). Allowlisted so a gasless user can self-serve their own refund once a contract is shut down; `assertAllowedCall` in `src/policy.ts` additionally requires args to be exactly `{ bet_id: <non-negative integer> }`, rejecting any extra/unknown field. Counts against the per-user daily sponsorship budget like every other escrow method. |
| open / take / challenge, real-token path | the REAL NEP-141 `ft_transfer_call` (standard shape: `{ receiver_id, amount, msg, memo? }`, **no `token_id`** — the token contract itself is the DelegateAction's `receiverId`). Allowlisted when `receiverId === cfg.usdcTokenId`; `assertFtTransferCallArgs` in `src/policy.ts` rejects a `token_id` field outright (that's the mock's shape leaking in), requires `amount` as a decimal string (not a JSON number — NEP-141 avoids float precision loss above 2^53), requires `receiver_id` to equal the escrow contract, and rejects any field beyond `receiver_id`/`amount`/`msg`/`memo`. Verified live against the real `usdc.testnet` and `wrap.testnet` NEP-141 contracts on `test.rpc.fastnear.com` (`scripts/live_nep141_probe.ts`) — see below. |

## Env

`RELAYER_ACCOUNT_ID`, `RELAYER_KEY_FILE` (never printed/committed),
`ESCROW_CONTRACT_ID`, `INTENTS_CONTRACT_ID`, `USDC_TOKEN_ID` (the real
NEP-141 token contract id, e.g. `usdc.testnet` — this is also the id
`ft_transfer_call` must be addressed to),
`NEAR_NETWORK_ID`/`NEAR_NODE_URL` (D-RPC1: default a single
`test.rpc.fastnear.com`, client-paced), `RELAYER_MAX_TRANSFER_AMOUNT`,
`RELAYER_MAX_BLOCK_HEIGHT_FUTURE`, `RELAYER_PER_CALL_SPONSORSHIP_YOCTO`
(the up-front reservation estimate; actual spend is settled to real
burnt gas after broadcast), `RELAYER_MAX_REQUESTS_PER_WINDOW`,
`RELAYER_WINDOW_MS`, `RELAYER_DAILY_BUDGET_YOCTO`,
`RELAYER_GUARD_DB_PATH` (SQLite file for persistent guard state;
default `./data/relayer-guards.sqlite3`, gitignored), `RELAYER_PORT`.

### Global daily cap (RLY1 / D-RLY1)

Per-sender budgets alone allow unlimited fresh keypairs, so there is also a
relayer-wide cap across all senders, persisted in the guard DB and taken in
the same SQLite transaction as the per-sender reservation (same
reserve/settle/release semantics, incl. charging on-chain failures; 24h
window rollover resets it and a stale pre-rollover reservation cannot erase
the new window's holds).

| Var | Default | Meaning |
|---|---|---|
| `RELAYER_GLOBAL_DAILY_BUDGET_YOCTO` | 50 x `RELAYER_DAILY_BUDGET_YOCTO` | global daily cap. Mainnet: 1.4 NEAR/day (`1400000000000000000000000`, D-RLY1a) in the relayer Worker `[env.mainnet.vars]`. |
| `RELAYER_RESERVED_SHARE` | `0.5` | fraction of the cap only existing bettors may use. The open share (1 - share) is available to anyone; once spent, only accounts that are maker/taker of a bet on the escrow draw from the reserve. |
| `RELAYER_BETTOR_CACHE_TTL_MS` | `60000` | bettor-lookup cache TTL (bounded cache, failures never cached) |
| `RELAYER_BETTOR_LOOKUP_TIMEOUT_MS` | `2000` | lookup timeout; failure or timeout => treated as NOT a bettor |
| `INDEXER_URL` | unset | bettor lookup via indexer `GET /history?account=`; if unset, falls back to the escrow `get_bet` scan (same as keeper/monitor, `common/discovery.ts`) |

Capped requests get **HTTP 429** `{ "ok": false, "error": "global daily ..." }`
(same body shape as other guard rejections, which stay 400). `GET
/budget/global` returns spend vs cap (aggregate only) for the monitor; set
monitor `RELAYER_BUDGET_URL` to it and it alerts at 80% (`relayer_global_budget`,
critical at 100%; unreadable => `relayer_global_budget_unchecked`).

## Tests

`npm test` (from `services/`) runs the whole `services/` suite — relayer
contributes **32 tests** across `relayer/test/relayer.test.ts` (24,
end-to-end through `Relayer.relay()` against a fake `ChainPort`: happy
path, bad signature, wrong receiver, disallowed method,
`transfer_with_msg` to a non-escrow `receiver_id`, over-cap amount,
expired/too-far-future `maxBlockHeight`, nonce replay, daily budget
(reserve-time enforcement), real-gas settlement to actual burnt cost,
budget release on a failed broadcast, rate limit, non-FunctionCall
action, and 8 dedicated real-NEP-141 `ft_transfer_call` shape tests) and
`relayer/test/guardStore.test.ts` (5, direct `GuardStore` tests: nonce/
budget/rate-limit state surviving a close+reopen of the same SQLite
file, and two concurrency races — 20 "simultaneous" double-submits of
one nonce yield exactly 1 winner, and 20 simultaneous reservations
against a 5-reservation budget yield exactly 5 winners). All green, no
regressions (full `services/` suite: 107/107).

**Live testnet proof** (`scripts/live_testnet_probe.ts`, run once, not
part of `npm test` since it spends real testnet NEAR and takes network
RTT): generated a fresh ed25519 keypair, funded it with exactly 1
yoctoNEAR from `praetorial-dev-1101.testnet` (the only onchain footprint
a "zero NEAR" account needs to get a nonce at all — same finding as
`services/privy-e2e`'s script 06/07), had it sign a real NEP-366
`DelegateAction` calling `cancel(bet_id: 999999999)` on
`escrow3.praetorial-dev-1101.testnet` (a nonexistent bet id, so the inner
call is a safe no-op for funds either way), and ran it through this
relayer's `Relayer.relay()` unmodified.

- Funding tx: `21f9wbcEAskA4B1bzfpxh8PUCciwyGYrx6sHQG3VGLKd`
- Fresh 0-NEAR implicit account: `06d8634e6f59319a87dd2d77e96f4b567ca52be55c01d19dca3b22f63094b685`
- Relayed meta-tx hash: `EUz1jFYd9mgeMQLQo9gMJAaWJxve2qATtq6JzC6rQXQJ`
- Inner receipt: `Smart contract panicked: unknown bet_id` (expected —
  proves signature verification, allowlist, and broadcast end to end; a
  real bet id would have succeeded identically).
- Spend: 1 yoctoNEAR + relayer gas (a few hundredths of a NEAR at most),
  well under the 0.2 NEAR ceiling, from `praetorial-dev-1101.testnet`.

**Live NEP-141 shape proof** (`scripts/live_nep141_probe.ts`, read-only —
no funds moved at all, only `view` calls): fetched real `ft_metadata`
and `storage_balance_bounds` from the real `usdc.testnet` (6 decimals,
symbol USDC) and `wrap.testnet` (24 decimals, symbol wNEAR) NEP-141
contracts on `test.rpc.fastnear.com`, then ran the relayer's own
`assertAllowedCall`/`assertFtTransferCallArgs` (`src/policy.ts`) against
each with that real contract id configured as `usdcTokenId`: the real
`{ receiver_id, amount, msg }` shape was accepted for both, and the
mock's `token_id`-bearing shape was correctly rejected for both — run
2026-11-04, exit 0, `realNep141ShapeAccepted=true
mockShapeWithTokenIdRejected=true` for `usdc.testnet` and
`wrap.testnet`.

## Known gaps / not done

- **No USDC-funded live broadcast test for `ft_transfer_call`.** The
  real-shape validator (`assertFtTransferCallArgs`) is proven against
  real `usdc.testnet`/`wrap.testnet` metadata and is exercised true
  end-to-end in the unit suite against the fake `ChainPort`, but no
  actual signed `ft_transfer_call` was broadcast on testnet in this
  session — that needs the probe account to hold real testnet USDC (no
  faucet was available) or wrapped NEAR (`near_deposit` would need a
  real attached-deposit transaction, out of scope for a read-only
  probe). The live NEP-366 broadcast path itself (steps 1–8 above,
  including real gas settlement) IS proven end-to-end via
  `live_testnet_probe.ts`'s `cancel` call; only the NEP-141 arg shape
  was proven via view-calls-plus-validator rather than a full broadcast.
- **No metrics/structured logging** beyond stdout — persistence (this
  change) covers restart-safety, but there's no dashboard/alerting on
  guard-store state yet.
- **No real open/take with actual testnet USDC moved end-to-end.** No
  test USDC faucet was available in either this session or the prior
  one; `cancel` (view-safe, no funds at risk) stands in for the full
  NEP-366 broadcast proof, and the NEP-141 arg-shape proof above
  substitutes real metadata + the real validator for a full broadcast.
- *Fixed in this change (previously listed as gaps here):* guards used
  to be in-memory only and reset on restart (now SQLite-backed,
  `src/guardStore.ts`); gas/budget accounting used to charge a flat
  per-call estimate regardless of actual cost (now reserve-then-settle
  against real `tokens_burnt`); only the mock's `transfer_with_msg`
  shape had been exercised, never the real NEP-141 `ft_transfer_call`
  shape (now validated by `assertFtTransferCallArgs` and proven against
  real `usdc.testnet`/`wrap.testnet`).
