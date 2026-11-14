# Praetorial escrow contract v1

Implements `Praetorial - Escrow contract spec v1.md`, governed by
`Praetorial - MASTER MAP.md` §3/§4 (rulings C1-C18) and
`Praetorial - Intents funding and payout spec v0.md` §3 (funding/payout
wire format). USDC only (v1). Native code; no NEAR-NEAR intermediary other
than `intents.near`'s multi-token ledger.

## Layout

```
contracts/
  escrow/        the contract (this crate)
  mock-intents/  minimal NEP-245-ish mock of intents.near, test/E2E only
  mock-outlayer/ mock of OutLayer's request_execution, test/E2E only
```

## Build

```
cargo near build non-reproducible-wasm --no-abi
```
(`--no-abi` because `SubmittedResult`/`Envelope` don't derive `JsonSchema`;
ABI generation is cosmetic and not required for this project's testnet use.)

## Test

```
cargo test -p escrow
```
29 unit tests (host-build, `testing_env!`), including a `proptest` property
test (`random_sequences_never_violate_i2`, 200 cases) that drives random
sequences of submit/finalize/void/double-take ops against a funded bet and
asserts cumulative scheduled payouts never exceed total deposited (I-2).
near-workspaces sandbox was not used (see build log "Testing approach").

## Methods added after v1 (changelog)

- **`concede(bet_id)` (C1, D-CONCEDE1, 2026-11-07).** Maker or taker only; allowed in
  Taken/Resolving/Proposed/Challenged/Evidence/Rejudge (D-PM3 scope), refused in Open,
  Finalized, Settled, Voided/Cancelled/Expired, after `emergency_shutdown`, and from anyone
  else. The caller's side loses: the counterparty gets the pot minus the normal fee through
  the ledger (`schedule_payout` + `drain_payouts`); bonds and objection/rebuttal deposits are
  refunded to their holders (`concede_bond_refund` / `concede_objection_refund`); the bet goes
  straight to `Finalized` so a late OutLayer callback or `submit_outcome` is a no-op. Emits a
  `concede` event. Mutual settle stays removed (D-SETTLE3).
- **Pinned protocol fee (G5F, D-FEEPIN1, 2026-11-07).** The fee rate is fixed by the contract
  (`PROTOCOL_FEE_BPS_V1 = 100`, stored as `protocol_fee_bps`, view `protocol_fee_bps()`), not chosen
  per bet. `handle_open` refuses any envelope whose `fee_bps` differs (0, 99, 101, 10000 ... all
  refused, logged `open_rejected`, full refund). Previously only `fee_bps <= 10000` was checked.
- **Minimum fee per side (G5F, D-FEEMIN1, D-MINSTAKE1).** `AssetLimit.min_fee_per_side` is pinned at
  `new()` (> 0 and <= `min_per_side / 20`; `new()` refuses otherwise). At `finalize` and `concede`
  each side pays `min(stake, max(stake * fee_bps / 10000, min_fee_per_side of THAT side's asset))`
  (shared helper `side_fee`). Release values: USDC/USDT `min_per_side` 10,000,000 and
  `min_fee_per_side` 500,000; the fee is a flat 1% from $50 per side. No fee on VOID, cancel or
  expire. `new()` signature unchanged (the fee rate is a constant); the `AssetLimit` JSON gains
  `min_fee_per_side`, so init args must include it.
- **Max horizon (H1/H1b, D-HORIZON1a supersedes D-HORIZON1's 365 days, 2026-11-07).** `handle_open` (shared by `mt_on_transfer`
  /`ft_on_transfer`) refuses an Open whose `resolve_deadline` is more than `MAX_HORIZON_NS`
  (1,461 days = 4 years incl. one leap day = 1461*86400*1e9 ns) after the open block time; exactly
  1,461 days is accepted, +1 ns is refused with a logged
  `open_rejected ... at most 1461 days after open (D-HORIZON1a)` and a
  full refund. Open-time only, existing bets unaffected. Mirrored in `buildOpenMsg`
  (services + web) and the web term-sheet validator.
- **Retired stays retired on the B2 snapshot path (JCD2, D-JCD1a, 2026-11-08).** `commit_observations`
  clears a judged pair's `model_missing` entries on a YES/NO success only for models that are NOT retired
  (3 observations >= 24h apart) at submit time. The in-flight verdict from a pair retired mid-flight is still
  accepted (D-JCD1 #2); its models stay retired with byte-identical stored observations. No money path change.

## Invariants (I-1..I-6) — where enforced

- **I-1** (funds only to maker/taker/fee/keeper): every `schedule_payout`
  call site is enumerated in `finalize`/`void_after_deadline`/
  `cancel`/`expire`/`emergency_refund`; test
  `i1_payout_receivers_are_always_maker_taker_fee_or_keeper` asserts this
  mechanically for the YES path. No method sends anywhere else.
- **I-2** (total out ≤ total in, per bet and contract-wide): every payout
  amount is derived from the bet's own stored stake/storage fields,
  never a caller-supplied number; `finalize`'s YES/NO branch asserts
  `winner_payout + fee == pot` inline. `i2_finalize_never_pays_more_...`
  and the proptest check it end-to-end.
- **I-3** (`mt_on_transfer` never panics, full accept/reject only):
  `mt_on_transfer` itself contains no `unwrap`/`panic_str` on any
  caller-controlled input; every rejection path returns `amounts` 
  unchanged, every acceptance returns `vec![U128(0)]`. Verified by
  `wrong_token_rejected`, `malformed_msg_rejected_not_panicked`,
  `over_amount_open_rejected`, `under_amount_take_rejected`,
  `double_take_race_second_rejected`, `not_predecessor_intents_rejected`,
  `bond_wrong_amount_rejected`.
- **I-4** (pending-payout ledger, retryable): `schedule_payout` inserts a
  `PendingPayout{done:false}` row *before* firing the cross-contract
  `mt_transfer`; `on_payout_result` flips `done=true` only on a
  `PromiseResult::Successful`; `retry_payout` re-fires for any row still
  `done=false`. Verified live on testnet (16/16 payouts across the full
  E2E run show `done:true`) and in `retry_payout_only_for_incomplete`.
- **I-5** (pause blocks only open/take): `self.paused` is checked exactly
  twice, inside `handle_open`/`handle_take`; no other method reads it.
  `pause_blocks_open_and_take_only` asserts a paused contract still
  executes `void_after_deadline`.
- **I-6** (no owner/upgrade/admin-withdraw/outcome-override): no method
  takes a code hash or raw-bytes deploy action; `operator` can only flip
  `paused`; `sweep_excess_near` is permissionless and NEAR-only (never
  touches USDC/intents balances); there is no outcome-setting method
  reachable by any single account other than the resolver's own signature
  (`submit_outcome`) or the two-party commit patterns (`amend`/`prune_terms` only; `mutual_settle`
  was removed, D-SETTLE3), and `referee_rule` gated on the pre-named
  FinalSay referee; the old arbiter entry points are gone).

## Deviations from the literal spec text (SPEC ISSUES)

See the build log for the full list with context; summary:

1. **Fee timing**: charged from the pot at `finalize`, not prepaid
   separately at `Open` (the spec's lifecycle table text and payout table
   disagree on this; the payout table's "pot − fee" is treated as
   authoritative since it's the one that actually balances I-2).
2. **`amend`/`prune_terms` "sig_maker/sig_taker"**:
   implemented as a two-call commit pattern (each party calls the method
   themselves; the change commits only once both calls agree) instead of
   verifying an offline ed25519 signature, because this contract has no
   pubkey registry for arbitrary bettor NEAR accounts and the master map
   says bettors hold no NEAR key at all. Flagged for familiarcow before mainnet
   (needs either a relayer meta-tx format or a registered-pubkey scheme).
3. **`challenge(bet_id)`** is not a separate method; a `Bond` transfer's
   `mt_on_transfer` *is* the challenge (matches "challenge via Bond
   transfer from a party" in the lifecycle table more literally than
   adding a second no-op entry point).
4. **`prune_terms`'s "storage NEAR refunded 50/50"**: this contract
   sponsors offer storage from a shared pool, not a per-bet NEAR escrow,
   so there is no per-bet NEAR balance to literally split; prune clears
   terms/exhibits/rebuttals/the referee proposal and keeps a stub, which is
   the resource-freeing effect the spec is after, without a matching
   outgoing NEAR transfer.
5. **Bond win/loss rule** (not specified in the literal text beyond "lost
   bond → counterparty, won bond → returned"): "won" is defined here as
   "the outcome at `finalize` differs from the outcome snapshotted when the
   bond was accepted" — i.e. the challenge changed the result. (Each
   round's run cost comes out of that round's own bond either way; only the
   remainder is returned or forfeited.) `finalize` is refused while a bond
   still awaits a ruling, until `resolve_deadline` passes or paid runs are
   exhausted; `referee_rule` (FinalSay) requires every pre-final AI round
   to have landed. Verified by
   `challenge_bond_lost_when_outcome_unchanged` /
   `challenge_bond_won_when_outcome_changes` and live on testnet.
6. **Objection/rebuttal deposit forfeiture** (D-BD6a, design decision: this is the
   approved rule; it replaces the older refunded-in-full wording): not specified in the literal
   text; implemented in `finalize` (see `ObjectionDeposit`), each deposit in
   the depositor's own stake asset. An *objection* is returned to its
   depositor if the final outcome differs from the outcome standing when it
   was filed (upheld) and forfeited to the counterparty if the outcome is
   unchanged (rejected). A *rebuttal* is the mirror image: returned if the
   final outcome still equals the outcome standing when it was filed,
   forfeited to the counterparty if the outcome flipped. There is no
   per-bet reserve (D-ECON5) and no 50/50 split. Tests:
   `objection_rejected_forfeits_to_counterparty`,
   `objection_upheld_is_returned_to_depositor`,
   `usdc_objection_forfeited_exact_amount_to_counterparty`,
   `btc_objection_returned_exact_amount_to_depositor_when_upheld`.
7. **`request_resolution`'s OutLayer call**: per the b0nd ruling
   (2026-11-01) that supersedes the stale "Canonical design v1
   (reconciled)" doc, the CONTRACT calls OutLayer (never the keeper
   directly); `source` is a bare pinned-hash `WasmUrl` (never `Project` or
   an `attached_usd` self-pay mode); `input_data` is built entirely from
   the contract's own stored envelope, never from caller bytes;
   `request_resolution` itself stays permissionless+payable so any keeper
   can front the NEAR.
8. **Gas**: no hardcoded "enough gas for N payouts" constant for
   `finalize`/`void_after_deadline` — callbacks request a weighted share of
   unused gas (`with_unused_gas_weight`) on top of small fixed floors, but
   the *caller* still needs to prepay enough total gas for however many
   cross-contract payouts a given bet schedules; measured on testnet,
   100 TGas was insufficient for `finalize` (4-6 scheduled payouts),
   300 TGas (NEAR's per-call max) succeeded. Keepers should always prepay
   300 TGas for `finalize`/`void_after_deadline` calls.

## Mock contracts (test/testnet only, never deployed to mainnet)

- `mock-intents`: reimplements only `mt_transfer` (predecessor-authed
  balance move) and `transfer_with_msg` (stands in for a user signing an
  intents `Transfer`+`NotifyOnTransfer` intent); has a test-only `mint`
  faucet that doesn't exist on real intents.near.
- `mock-outlayer`: `request_execution` does not run any wasm or hold a
  signing key; it just echoes back that a request was dispatched. The
  "OutLayer signs a result" step is modeled off-chain by a throwaway
  ed25519 keypair whose public half is pinned in the bet's envelope and
  whose secret half lives only in a local test harness file
  (`resolver_sign.py`), never on any chain.

## D-MN1 (2026-11-07): mainnet never calls `near_deposit_and_credit`

An escrow whose pinned `intents` account is `intents.near` treats the
AuthCall unused-compute refund as a no-op: it emits no promise, the NEAR
stays in the escrow (real OutLayer refunds plain NEAR, D-OL-REFUND1) and is
recovered by the permissionless `sweep_excess_near`. Any other intents
account (testnet `mock-intents`) keeps the `near_deposit_and_credit` path.
The wNEAR token id is derived from the same check (`nep141:wrap.near` on
mainnet, `nep141:wrap.testnet` otherwise); the old public `WNEAR_TOKEN_ID`
testnet constant is gone. No new field and no `new()` signature change, so
state layout and init JSON are unchanged. Tests: `mn1_*` in `src/tests.rs`.
