# DRILL1: emergency drills on a fresh throwaway testnet escrow (D-DRILL1, TESTNET ONLY)

Escrow: `drill1-2611091903.praetorial-dev-1101.testnet` (wasm sha256 `caf134a484bc68c2e6900bd03cba7b3eb29af40b67d65f61db1fe04831450f2f` == release/freeze-candidate-2.json; NOT the FRZ1b rehearsal escrow). Not deleted.
Guardians (new accounts, keys in ~/.near-credentials/testnet): G1 `drill1-g1-2611091903.praetorial-dev-1101.testnet`, G2 `drill1-g2-2611091903.praetorial-dev-1101.testnet`, G3 `drill1-g3-2611091903.praetorial-dev-1101.testnet`.
Init args = FRZ1b's (`live-FRZ1/results.json` new_args) except `guardian` -> G1 and `outcome_pubkey` -> the report-pubkey bound to the NEW escrow account (see `new_args.json`, `report_pubkey_outcome.log`). attest_pubkey, resolver hash, outlayer_config, judge chain, limits, assets unchanged.
Reproduce: `0_setup.mjs` -> `1_bets.mjs` -> `2_drill.mjs` (+ `2b_fixup.mjs`) -> `3_keeper.sh` -> `4_residue.mjs` -> `node verify.mjs` (chain views only; exit 0 = all expectations met). Offline logic test: `node --test assertions.test.mjs`.

## Result
`verify.mjs` exit **0** (verify.txt). Every contract behaviour matched the contract source; residue 0 on every account and on the escrow. No money bug found. Findings/deviations below.

## Mapping / deviations from the item text
- Asset: **mock-intents USDC `nep141:usdc.testnet`**, not wNEAR: the FRZ1b asset table (copied) whitelists only usdc + btc.mock. Changing config would diverge from "same config as FRZ1b". Stake 10,000,000 raw per side, storage 137,617 per side (contract-computed), fee = max(1%, 500,000 min).
- Method names match the item: pause_new_offers / unpause_new_offers / set_guardian / accept_guardian / cancel_guardian / emergency_shutdown / emergency_refund / void_after_deadline / concede / drain_payouts. Real strings: `only guardian`, `only the proposed guardian may accept`, `already shut down`, `contract is shut down; unpause is impossible after shutdown`, `contract is shut down`.
- **FINDING F1 (no `guardian` view):** the frozen contract exposes `pending_guardian` but no `guardian` view method (MethodNotFound). The "assert `guardian` view = G2" step was done by decoding the borsh `STATE` via RPC view_state (`guardianOf` in lib.mjs) plus the `guardian_rotated` event log. Anything that needs the current guardian on-chain (verify-escrow E1 does it via tx-history governance replay) must do likewise. Not a money bug.
- **Paused open/take are silent refunds, not panics:** `mt_on_transfer` returns the full amount (the transfer tx itself succeeds). Asserted via bet_count unchanged, A still Open/no taker, sender and escrow intents balances unchanged.
- **Payout view:** `pending_payouts(bet)` is empty once lines are done (pruned); verification uses `is_fully_paid` + balance deltas.
- **Script defects found and corrected in-run (not contract behaviour; history kept in results.json):** (a) my first run attached 1 yocto to non-payable methods (void_after_deadline, concede, pre-shutdown emergency_refund) so those 3 refusals were NEAR's `doesn't accept deposit`, marked `invalid`; void_after_deadline and concede were re-run with 0 deposit after shutdown (`2b_fixup.mjs`). (b) Two state reads raced finality and were re-established from the txs' event logs. (c) expected-net math forgot that deposits were funded by exact mints after the 'before' snapshot (corrected to credits-only; see `expected_credits_note`).
- **NOT drilled live: `emergency_refund` refused before shutdown.** My attempt was invalid (see a); shutdown is irreversible so it cannot be re-run on this escrow. Covered by contract unit tests only.
- Keeper run: the real `services/keeper/src/runner.ts` one-shot (KEEPER_RUN_ONCE=1, ESCROW_CONTRACTS pointed ONLY at the throwaway escrow, keeper account = the init-config keeper, key loaded from file in-process). It does ONE emergency_refund per tick (rate limit): tick1 bet1 ok, bet3 `InvalidNonce` (back-to-back send from the same key, no retry in the runner; benign, observed), tick2 bet3 "rate-limited" + drain bet1, tick3 bet3 ok, tick4 drain bet3. Bet 2 (terminal) was never actioned = skipped. With label `@v2` the keeper raised a `contract_version_mismatch` critical alert (label vs contract_version 1.0.0); re-run with `@v1` clean. Archive was inert (no ARCHIVE key), irrelevant here.
- **verify-escrow after the drill: E1 PASS, E2 FAIL (`is_shutdown()` is true), E3 PASS, E4 PASS** (attempt 1 E4 timed out in `outlayer run` at the OutLayer RPC, `verify-escrow_attempt1_e4_timeout.txt`; re-run clean). E2 FAIL is the verifier correctly flagging a shut-down escrow, expected after step 5; it is NOT a regression. Consequence: the E1-E4 all-PASS gate cannot be shown on a post-shutdown escrow; FRZ1b's verify-escrow.txt remains the all-PASS evidence for the pristine state.

## Refund / fee rule (read from lib.rs, not assumed)
- `emergency_refund`: maker and taker each get exactly stake + their storage charge back; **no protocol fee** on a refund. Open bet: maker only. Terminal bets skipped.
- `concede` (B): winner gets both stakes minus per-side fee (`min(stake, max(stake*100/10000, 500000))` = 500,000 each) = 19,000,000; fee account gets 2*500,000 + both storage charges = 1,275,234.

## Balances (raw intents USDC units; before = pre-drill, deposits were funded by exact mints, so delta = credits)
| account | before | after | expected delta | residue |
|---|---|---|---|---|
| maker1 | 4106069855 | 4145345089 | 39275234 | 0 |
| taker1 | 3714307000 | 3724444617 | 10137617 | 0 |
| fee | 2900000 | 4175234 | 1275234 | 0 |
| drill1-g3-2611091903 | 20275234 | 20275234 | 0 | 0 |
| escrow drill1-2611091903 | 0 | 0 | 0 | 0 |

Escrow held 50,688,085 (5 deposits x 10,137,617) while all three bets were live; 0 after.

## Refusals / state checks
| result | step | observed text |
|---|---|---|
| OK | non-guardian (G3) pause_new_offers refused | `{"index":0,"kind":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: only guardian"}}}} "ActionError"` |
| INVALID (superseded) | emergency_refund before shutdown refused | `{"index":0,"kind":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: Method emergency_refund doesn't accept deposit"}}}} "ActionError"` |
| OK | open_bet while paused refused (silent full refund) | `tx succeeded; mt_on_transfer returned the full amount. bet_count 3->3; maker balance 20275234->20275234; escrow balance 50688085->50688085` |
| OK | take of Open bet A while paused refused (silent full refund) | `A status Open, taker null; taker balance 20275234->20275234` |
| OK | B concede while paused: payout lands exactly | `maker +19000000 (exp 19000000), fee +1275234 (exp 1275234), taker 0` |
| OK | unpause: is_new_offers_paused false | `re-established from tx logs (view read raced finality): EVENT_JSON:{"standard":"praetorial-escrow","version":"1.0.0","event":"offers_unpaused","data":[{"guardian":"drill1-g1-2611091903.praetorial-dev-1101.testnet","at_ns":"1794251` |
| OK | pause again: is_new_offers_paused true | `` |
| OK | non-guardian (G3) set_guardian refused | `{"index":0,"kind":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: only guardian"}}}} "ActionError"` |
| OK | set_guardian(G2) proposes only (guardian still G1, pending G2) | `` |
| OK | G3 accept_guardian refused (not the proposed) | `{"index":0,"kind":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: only the proposed guardian may accept"}}}} "ActionError"` |
| OK | cancel_guardian clears pending | `` |
| OK | after accept: guardian view == G2 | `re-established from tx logs: EVENT_JSON:{"standard":"praetorial-escrow","version":"1.0.0","event":"guardian_rotated","data":[{"old_guardian":"drill1-g1-2611091903.praetorial-dev-1101.testnet","guardian":"drill1-g2-2611091903.praet` |
| OK | old guardian G1 pause_new_offers refused after rotation | `{"index":0,"kind":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: only guardian"}}}} "ActionError"` |
| OK | non-guardian (G1, old) emergency_shutdown refused | `{"index":0,"kind":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: only guardian"}}}} "ActionError"` |
| OK | is_shutdown true | `` |
| OK | G2 unpause_new_offers refused after shutdown | `{"index":0,"kind":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: contract is shut down; unpause is impossible after shutdown"}}}} "ActionError"` |
| OK | second emergency_shutdown refused | `{"index":0,"kind":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: already shut down"}}}} "ActionError"` |
| INVALID (superseded) | void_after_deadline refused after shutdown | `{"index":0,"kind":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: Method void_after_deadline doesn't accept deposit"}}}} "ActionError"` |
| INVALID (superseded) | concede on C refused after shutdown | `{"index":0,"kind":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: Method concede doesn't accept deposit"}}}} "ActionError"` |
| OK | void_after_deadline refused after shutdown (0 deposit) | `{"index":0,"kind":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: contract is shut down"}}}} "ActionError"` |
| OK | concede on C by maker refused after shutdown (0 deposit) | `{"index":0,"kind":{"index":0,"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: contract is shut down"}}}} "ActionError"` |

## verify-escrow output (verify-escrow.txt)
```
# live testnet escrow drill1-2611091903.praetorial-dev-1101.testnet (read-only RPC views + tx history from https://tx.test.fastnear.com; no keys, no txs)
PASS E1  deployed code hash == expected build hash caf134a484bc68c2e6900bd03cba7b3eb29af40b67d65f61db1fe04831450f2f; governance replay: guardian drill1-g2-2611091903.praetorial-dev-1101.testnet, 4 judge pair(s), 2 asset(s)
FAIL E2  contract is_shutdown() is true
PASS E3  resolver wasm (3401349 bytes) hashes to the pinned resolver_wasm_hash c1fa42424cb7274eb8a3a0ac63afcd6cc5a267b1ffc9d146fdd707dac5bdf6b5
PASS E4  live report-pubkey of the pinned wasm reproduces the bound outcome pubkey (predecessor drill1-2611091903.praetorial-dev-1101.testnet) and attest pubkey (predecessor attest1.praetorial-dev-1101.testnet)
# 3 PASS, 1 FAIL, 0 SKIP
```

## Every tx
| step | hash |
|---|---|
| fund_dev_from_pf-109110569 | `EWfYhE9UJnX9U2ae5Me1wG3hPeh2E3nNpguWadKNQoxq` |
| create_escrow_account | `CMPxoiFo4xA5s3xWkAz4vv2MGkPWd8z7aRWvdf981Jce` |
| create_guardian_account | `EUaXf3FnvjhCu8twa4zGMfQwD42zxhiqUC6gzXdAjf9g` |
| create_guardian_account | `5Ex6vjWY7fTDmYJTsiJNbo9JgQJtsKhgVUBzLLeAHr3F` |
| create_guardian_account | `9izg4QqondJjh5JrY7mXmk3BJJQrqCmtSCa9yWzFHtAK` |
| deploy_escrow | `3seR4EmrYrhTuxGFDiSuFkAi7eee5NnRnbKAccMBz5Vu` |
| escrow_new | `BFDZBaJjW5Fz4iSURw4RBRqs5BG5t5FUNLReHCHHVjAR` |
| sourcecheck_A | `AYxND9JFPehdtrquujxdoay5N8GCC5BVBQEwwkvhAJfd` |
| mint_A_maker1 | `EKQsXrPmSFWFhwjoQSQx9DxuRsGFwbdedCd6NoE5jWvJ` |
| open_A | `8yyVgRKFZ9J7Lorh2ebz1NMeWSRtnPuX6qreoQ8AcqYX` |
| sourcecheck_B | `2xsrnYt5raXxsggzGXcAuSDuVRPupK9AdXSCSQNrqUhq` |
| mint_B_maker1 | `5ESLHKE6jrnbG9abJRYhVU4avz9HJiJrXKsWKxZS9nHZ` |
| mint_B_taker1 | `E2NfBU9K2qsouXGwPsJPctHGKY5jAR2Pj6iETqpVLXz4` |
| open_B | `3YG6YJoQxXBN4Z7cmNgAkHb1C9GjpmUzZxK7eGV9UNi9` |
| take_B | `5hgvK6GuwV3rkgdKvC747yAVUGZTwMavYBedXHweMe3o` |
| sourcecheck_C | `73MUkqRzNPjwCWrh6WAuNy6FwbaK5Sr7haaWPhcCPTrH` |
| mint_C_maker1 | `G1yfWVvq55CdTFgvQgXUi45duyhf3dudtcgcC9FwqxSZ` |
| mint_C_taker1 | `GXax7owVcM1aKnmLXCtpPYqjotLZY8JdoU9SMZ6o471i` |
| open_C | `JCdk8y7dSuT4iTwr7pBnbywpY2ByBNYo6mwteBK2rxgF` |
| take_C | `5rZFuB55WYuiteDcbkgCXpF2cboZNvd2xKgNBqau5c4Y` |
| non-guardian (G3) pause_new_offers refused_refused | `FD6DGjKHG4KQD8BoejzqjwBgSmbebPACqjwP6SMt4SLN` |
| emergency_refund before shutdown refused_refused | `Hz1apygczYmbguErzapc95QWXUWKxZXne6LPAZXkhGpE` |
| pause_new_offers_1 | `7ioZYcHReSxbvHU1STH3SHTRPJ5zcY5Hgxo6H19Y1n2j` |
| mint_G3_for_refused_open_and_take | `B51xDL9qgoXckdMv7ypt3SBgUhWu4Rg4wY1XbrLwBmb4` |
| open_while_paused_refused | `UnwRNWtyXzrPDSjNDEfrLKAJAZmTzQWRaeNCE8EW9Aa` |
| take_A_while_paused_refused | `4WoZgmRyaNaas8ruWc7mbVJ5xS4RpaoU24xmX4BJGtxG` |
| concede_B_while_paused | `3wPqL68W8WdT38K3gbJ2U2qg1j9qDbmi3EPakeY3n3hq` |
| unpause_new_offers | `9aaBv1HdyCbG7i2tVVFdj5PymNtx9LijH4AryLvyZ9S` |
| pause_new_offers_2 | `5iJPunk7Z9kkoV1xGyiitDtWCvEDq7X6mesgCNAKh9sa` |
| non-guardian (G3) set_guardian refused_refused | `CyqpeqnfNJqYCS2M43gT87kv7jcuW8eNRDGoNAy3fAoK` |
| set_guardian_G2_1 | `CoRjSQNk2vXgX3DEkUm6QZD7ZiTfWctjH2FrJs1XGTQt` |
| G3 accept_guardian refused (not the proposed)_refused | `H9UvCrhK8KibBoLz3ncvxAQzhjcp7aw6hNuhqsx8gSM2` |
| cancel_guardian | `E9cJyL3jRzUvwxsSSKd64HC8rHESUdXQQQMZvTanPKU7` |
| set_guardian_G2_2 | `AqAXwcFZLsQRT28VAxh6zumgR4JnSonXUR9iFred8JL9` |
| accept_guardian | `46skGfx9LSMG9qbKPZc2HheWdannduteKmG8jESzhATM` |
| old guardian G1 pause_new_offers refused after rotation_refused | `CbkKEHsMm2xe5FHHyxJswNCkn2SvCTTVQbSqmXBk1uiU` |
| non-guardian (G1, old) emergency_shutdown refused_refused | `AxRTMpLeh8DF4qehNDqZUU5kRcKfpPVq4XEy11wKAtTG` |
| emergency_shutdown | `8Ly2t36BYLVZ8CphhNPCoMwE9yWQoqyP97M6i43CqUS5` |
| G2 unpause_new_offers refused after shutdown_refused | `FxLWdh8Bo3sxmo7zX3BFBYk4xJ73Y9Psfp99ayT166cp` |
| second emergency_shutdown refused_refused | `ALGozHu5pd7QMKwoapiv9iATw86iTYVnDUueoMQJfgzg` |
| void_after_deadline refused after shutdown_refused | `HgFVpGZ9JDAM5dUb2rJ3446NFvXLAJo13gYhEDniN8TH` |
| concede on C refused after shutdown_refused | `2bFtNkWTsi3UeKwKx4qVbBJ4M65uVdnfgaT5qqXi2HuW` |
(explorer: https://testnet.nearblocks.io/txns/<hash>; keeper txs: keeper-tx-log.jsonl)

## What this proves
- On the freeze-candidate-2 wasm, fresh deploy: guardian-only pause/unpause/rotation/shutdown gates and their exact refusal strings; rotation needs propose+accept by the proposed account and cancel works; old guardian loses power; shutdown is one-way and blocks unpause, second shutdown, void_after_deadline and concede.
- Pause blocks open and take (full silent refund, no state change) but a taken bet can still be conceded and its payout lands exactly.
- The real keeper policy issues emergency_refund for every non-terminal bet (A Open, C Taken) and skips terminal B; drained refunds credit exactly stake+storage, no fee, to the right accounts; escrow balance attributable to the bets returns to 0.
## What this does NOT prove
- Ledger signing UX / hardware guardian flow; mainnet behaviour (testnet mock intents, not the real intents.near); the deployed testnet keeper Worker (a local one-shot was used); the monitor alert and the stuck-payout path (stay DR9); `emergency_refund` pre-shutdown refusal (see above); wNEAR (usdc used); concurrent/high-volume refund backlogs.
