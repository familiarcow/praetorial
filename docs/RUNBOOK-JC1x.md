# Judge chain, guardian rotation and params — operator runbook (JC1x, contract 1.0.0)

All guardian calls need exactly 1 yoctoNEAR (`--deposit 1yoctoNEAR`) and are signed by the guardian account.
Replace `$E` with the escrow account, `$G` with the guardian.

## Guarantees (what the contract enforces, whatever the guardian does)
- The judge chain only grows: pairs are appended after a 7-day delay (`apply_judge_pair` is permissionless), never removed, reordered or replaced. Max 12 pairs; `new()` takes 2-4.
- A model id is ASCII `org/model`, <= 128 bytes; the two models of a pair differ; no duplicate pairs.
- `submit_outcome` accepts the first live pair before OR after applying the result's own signed observations, or the request-time snapshot (JCD1 B2); which one is trusted is up to the resolver's signature. A pair is dead when one of its models has 3 signed not-found observations >= 24h apart; `RETRY:no_live_judge` only when none is live. A later successful answer clears observations only below the retirement threshold; retirement (3 observations >= 24h apart) is final (D-JCD1 #4, D-JCD1a/JCD2).
- Observations are signed by the resolver (appended last to the signed buffer, only when present); older evidence keeps verifying.
- Guardian rotation is two-step: `set_guardian` only proposes; the OLD guardian keeps every power until the new account itself calls `accept_guardian`. A typo'd / non-existent account can never become guardian.
- `max_per_side` can never exceed 10^34 raw (overflow-safe ceiling, `MAX_PER_SIDE_CEILING`); `new()`, `propose_params` and `propose_asset` refuse more. Lower it via `propose_params`.
- Events (NEP-297 `EVENT_JSON`, standard `praetorial-escrow`, version `1.0.0`) cover lifecycle and governance changes only, NOT every state change, and are emitted only after every check passed. Emitted: `bet_opened`, `bet_taken`, `bet_cancelled` (also by operator `reclaim`), `bet_expired`, `bet_conceded` (`concede` also emits a second event named `concede` with winner and at_ns), `bet_finalized`, `bet_voided` (deadline and emergency refund), `outcome_submitted`, `outcome_retry`, `referee_ruled`, `terms_amend_proposed`, `terms_amended`, `referee_amend_proposed`, `referee_amended`, `payout_done`, `payout_failed` (from the payout callback), `params_proposed`, `params_applied`, `params_cancelled`, `offers_paused`, `offers_unpaused`, `emergency_shutdown`, `guardian_proposed`, `guardian_rotated`, `guardian_cancelled`, `judge_pair_proposed`, `judge_pair_applied`, `judge_pair_cancelled`, `asset_proposed`, `asset_applied`, `asset_cancelled`, `asset_disabled`.
- No event of its own: bond/challenge, objection, `submit_exhibits`, `extend_window`, `topup_keeper_credit`, `prune_terms`, `drain_payouts` / `retry_payout` (the payout callback emits `payout_done`/`payout_failed`), `sweep_excess_near`. Indexers read those from receipts/state.
- `contract_version()` is `1.0.0`; `bet_count()` is the number of bets ever opened.

## Commands
```
# views
near view $E judge_chain '{}'          ; near view $E pending_judge_pair '{}'
near view $E retired_models '{}'       ; near view $E model_missing '{"model":"org/model"}'
near view $E pending_params '{}'       ; near view $E pending_guardian '{}'
near view $E contract_version '{}'     ; near view $E bet_count '{}'

# append a judge pair (refused while offers are paused; one pending at a time)
near call $E propose_judge_pair '{"pair":{"model_a":"org/m1","model_b":"org2/m2"}}' --accountId $G --deposit 1yoctoNEAR
near call $E cancel_judge_pair '{}' --accountId $G --deposit 1yoctoNEAR
near call $E apply_judge_pair '{}' --accountId anyone.testnet        # after >= 7 days

# params (D-PARAMS1). D-CAP3: launch max_per_side = 10^34 raw (no stake cap). To lower max, propose_params with assets[].max_per_side (24h delay);
# never raise it above 10^34 (overflow-safe limit, see services/release/src/stakeCap.ts).
near call $E propose_params '{...}' --accountId $G --deposit 1yoctoNEAR
near call $E cancel_params '{}'   --accountId $G --deposit 1yoctoNEAR
near call $E apply_params '{}'    --accountId anyone.testnet

# guardian rotation (two-step)
near call $E set_guardian '{"new_guardian":"new.near"}' --accountId $G --deposit 1yoctoNEAR   # proposes only
near call $E accept_guardian '{}' --accountId new.near --deposit 1yoctoNEAR                  # new account takes over
near call $E cancel_guardian '{}' --accountId $G --deposit 1yoctoNEAR                        # withdraw an unaccepted proposal
```
Verify a rotation: `pending_guardian` is null after accept; the `guardian_rotated` event names old and new; the verifier's E1 replays guardian + judge-chain events from `new()` and compares them to the views.

## Total outage (guardian response)
- `propose_judge_pair`, `propose_params` and `propose_asset` are refused while offers are paused (and after shutdown). So propose the replacement judge pair FIRST, then `pause_new_offers`.
- While paused, `apply_judge_pair`, `cancel_judge_pair`, `apply_asset`, `cancel_asset`, `cancel_params` and the guardian rotation calls still work. `apply_params` is refused while paused or shut down: unpause first. After `emergency_shutdown`, `apply_judge_pair` and `apply_asset` are refused too.
- A pending guardian, params, judge-pair or asset proposal never expires on its own (no expiry in the code). It stays until applied (after its delay) or cancelled; check the `pending_*` views before proposing a new one.
- Order: `propose_judge_pair` -> `pause_new_offers` -> wait 7 days -> anyone `apply_judge_pair` -> unpause once the new pair is live.

## Release
`freeze-candidate-1.json` was renamed `freeze-candidate-2.json` (the contract changed: re-run `freeze-record`). `gen-new-args` now rejects chains outside 2..=4 pairs and model ids that are not ASCII `org/model` (<= 128 bytes).

## JCD1 notes (D-JCD1, 2026-11-08)

- **Retirement is final (B4).** Three observations at least 24h apart retire a model for good. "A later success clears the observations" applies only below the threshold: a pair with a retired model is never first-live, so it can never judge again. The only recovery is appending a new pair (`propose_judge_pair`, 7-day delay, then `apply_judge_pair`).
- **Observations must be fresh (B3).** `observed_ns` has to be within 1h before the block time (and not in the future), and a result may carry at most one observation per model. Retiring a model therefore needs three separate signed results at least 24h apart.
- **In-flight runs (B2).** `request_resolution` records the first-live pair index at request time; the run it belongs to may be signed against that index even if the chain changed before `submit_outcome`. Any other index must still be the first live pair (before or after the result's own observations).
- **RETRY after a request (B1).** An accepted `RETRY` or `RETRY:no_live_judge` for a pending request puts the bet back in its prior status (Taken / Challenged / Evidence) and clears the pending request, so the keeper can re-request after `next_check_ns` (and after the JCB1 gate for `no_live_judge`).
- **Event names (B5).** Events are emitted only after every check passed. `amend` / `amend_referee` emit `terms_amend_proposed` / `referee_amend_proposed` for the first (proposing) call of the two-party commit and `terms_amended` / `referee_amended` for the committing call (an untaken offer's maker edit applies at once: `referee_amended`). Indexers should still ignore logs of failed receipts.


## AS1 (D-ASSET1): guardian-added assets, 24h delay

The guardian can append assets to the table; nothing can remove one. Delay is **24 hours** (not 7 days; familiarcow 2026-11-08).

```
near call $E propose_asset '{"token_id":"nep141:new.near","limit":{"min_per_side":"1000","max_per_side":"10000000000000000000000000000000000","min_fee_per_side":"10","min_fee_cap_per_side":"0","run_price":"5","min_bond":"100","min_objection":"20","storage_per_kib":"6305"}}' --accountId $G --deposit 1yoctoNEAR
near call $E cancel_asset '{}' --accountId $G --deposit 1yoctoNEAR
near call $E apply_asset '{}' --accountId anyone.testnet        # after >= 24h; anyone
near call $E disable_asset_for_new_bets '{"token_id":"nep141:new.near"}' --accountId $G --deposit 1yoctoNEAR   # immediate
near view $E pending_asset '{}' ; near view $E asset_disabled '{"token_id":"nep141:new.near"}' ; near view $E asset_limit '{"asset_id":"nep141:new.near"}'
```

- Limits are validated exactly like `new()` (min<=max, min-fee in (0, min/20], min-fee cap >= min fee, run_price/storage/bond/objection > 0). `max_per_side` must be <= 10^34 raw: the contract refuses more (CAP3b, D-CAP3b).
- Flow: `propose_asset` -> wait 24h -> anyone calls `apply_asset`; the guardian can `cancel_asset` before it is applied; `disable_asset_for_new_bets` stops new offers at once.
- One pending proposal at a time. `propose_asset` is refused while paused or shut down; `apply_asset`/`cancel_asset` still work while paused; `apply_asset` is refused after shutdown.
- An asset already in the table cannot be proposed again (no limit replacement). The one exception is re-enabling a **disabled** asset: propose it with its stored limits unchanged, then apply after 24h.
- `disable_asset_for_new_bets` closes the asset to NEW offers (either side, any taker option) at once. Existing bets in it take, finalize, void and refund normally; the asset stays in the table.
- Events (NEP-297): `asset_proposed`, `asset_applied`, `asset_cancelled`, `asset_disabled`. The verifier's E1 replay and the monitor handle them; `disable` alerts as critical.
