# L1b5 rerun: live testnet pipeline on current main (2026-11-07, ~17:26-18:05Z)

Escrow `praetorial-l1b5-11071226.praetorial-dev-1101.testnet` (testnet), built from main a7c9f23 (stripped, 514005 B), escrow wasm sha256 `a240f3632e956d5eac45c2965b8fdc85b5b2aa17656d00b37bd2eb3e68afbf97` (verifier E1 PASS).
Resolver wasm sha256 `142e98125ce3d1cabd42d87b48cedc6496fce925193ecea8bbe97c97475a7088` (record-71f46b4; reused the reproducible artifact `scratch/rr4/out1/module.wasm`, hash matches; uploaded via `outlayer upload` -> `upload.log`; verifier E3 PASS). Secrets bound to that hash (`bind_secret.log`), report-pubkey (D-KEY2) escrow `report_pubkey_outcome.log` (first attempt `*_attempt1.timeout.log`: OutLayer RPC timeout, retried OK) and attest1 `report_pubkey_attest1.log`. Init per D-MN1 testnet settings via `3_deploy_init.mjs` (outcome pubkey `cda07c41...`, attest pubkey `09336ce0...`).
Old `../live/` untouched. Expectations were written before resolving: `EXPECTATIONS.md`.

| Bet | Sheet | Expected | Result | Verifier | State | Finalizable after |
|---|---|---|---|---|---|---|
| 1 | close_above_future (typed btc_close_at_t, `>` 70000, open 17:31Z, T=18:38Z) | YES at T | opened + taken OK (sourcecheck PASSED = D-SRCCHK2 confirmed live); resolution not yet possible (T in future) | not yet | Taken | resolve after 18:38Z; finalize ~1h after submit_outcome |
| 2 | btc_breaks_76140_messy ("BTC breaks 76,140 today") | VOID (wick-vs-close readings disagree) | **Proposed YES** (both models `met`, quoting the 09:00Z wick highs) | `verify_pre_finalize_bet2.txt`: 7 PASS / 0 FAIL / 3 SKIP (E4, B4 partial, B5) | Proposed | 2026-11-07T18:53:19Z |
| 3 | jason_bitstamp_only_no | Proposed NO | **no output** twice (OutLayer "Execution promise failed", ~123 s after request); escrow returned to `Taken`, runs_used 0, retry allowed | n/a (nothing proposed) | Taken | n/a, needs resolve3 |

## Confirmations
- **D-SRCCHK2 (L1b4): CONFIRMED live.** Open-time sourcecheck for a close-at-T sheet with T = open+67 min returned ok and the bet opened and was taken (L1b: Coinbase 400 "Start cannot be in the future"). Resolution at T not exercised (follow-up).
- **D-RESOLVE4a (L1b2a): CONFIRMED live.** Bet 3's two request_resolution calls ended "Execution promise failed ... Refunded" with output `null`; the escrow reset the bet to `Taken` (not stuck `Resolving`), runs_used stays 0, `can_request_resolution` = null, and the second request was accepted. (Predecessor escrow got stuck Resolving.)
- **D-BUDGET1: wiring confirmed, fix for Jason NOT confirmed.** Bet 2's notes carry `D-BUDGET1: calls_ms=[6773,7443] rerun=false` (resolver run 19.8 s). For bet 3 no output is emitted at all, so no notes/budget_skip exist: the "wall-clock/rerun" explanation is neither confirmed nor refuted for the Jason sheet. Timing: both failures resolved ~123 s after the request (17:36:10->17:38:11, 17:38:31->17:40:34), i.e. at about the 120 s budget mark, well before max_execution_seconds=150, which suggests the platform cuts the run (or the resolver exits without output) near 120 s; a budget that fires at 120 s is too late to help if the worker dies at ~120 s. Needs a local/long-timeout run with timing to settle.

## Findings
1. **MEDIUM, bet 3 (Jason one-venue NO) still yields no resolver output** on 142e9812 (2/2 attempts, same as L1b 2/2 on f6c24165). Fails closed (no funds at risk, retry allowed, 0 runs consumed), but the bet cannot be resolved. Evidence: `resolve_jason_bitstamp_only_no*.log`, tx `7kvmzPWX...`, `B2RKwPbs...`.
2. **MEDIUM (design/expectation), bet 2 messy phrasing resolved YES, not VOID.** Both models read "break 76,140" as a wick touch (candle HIGH; Coinbase 76152.43, Bitstamp 76143.75, Kraken 76146.9 at 09:00Z) and agreed `met`; no reading-disagreement detection fired. Max 1-minute CLOSES were 76135.69 (Coinbase) / 76130.98 (Bitstamp), so a close-based reading gives NO. Because no VOID path exists unless the models themselves disagree (D-L1MESSY1 is evidently not enforced by the resolver on a same-direction pair), the bet is Proposed YES; challengers can still object in the settlement window. Not changed here (evidence-only).
3. **LOW, ops:** `request_resolution` before `funding_deadline` (offer funding_deadline = open+150 s) panics "too early to request resolution" (2 failed txs, no cost besides gas). Scripts should wait for it.
4. **LOW, ops:** `open_utc` must be on a UTC minute boundary (TPL_OPEN_UTC_FORMAT); first sourcecheck attempt (`sourcecheck_close_above_future.attempt1_open_utc_format.log`) failed on that, no funds moved.
5. Bet 2 `resolve.mjs` poll loop never exits on success: bet stays `Resolving` (D-RESOLVE3) until `submit_outcome`; the script's "until not Resolving" loop is wrong for a delivered result (script bug only; killed after ~6 min, then `finish.mjs submit`).

## Tx hashes
Setup: create_escrow_account `HtiMcVXkBoqNmwHUBTY762QcByh4UoQYbjbjje1Fnm25`, deploy_escrow `5AmPex9QH9DUJT9Ypjv7uU14JaxTMwKwBCXpDkxjBUCo`, escrow_new `3x6S9c7cjEZZ6rDCGi8ex5Bme5Sjfuy8yjqybnk9L3H5`, topup_keeper_credit `F3LbgWBrVPySfgP5557GSgx4k5GHj6q7FBrengtoN6dE`; report-pubkey escrow `328udFEVmgrqcruAXMTvYzvn4fiiYXjaEBXj3KJorSfD`, attest1 `7EKTYyqwKS5wp4P92gq6qGyX5uVegDRAkkNW6dfFGt56`; upload chunk txs in `upload.log`.

| Step | Bet 1 close_above_future | Bet 2 btc_breaks_76140_messy | Bet 3 jason_bitstamp_only_no |
|---|---|---|---|
| sourcecheck_attest1 | `Eszp27fPK7HpoJe4ZZtg97HcS8dvqvUQS5EqbVvVcuqV` | `4rBiyuk1636ULiS5WB3XsxYUH2Gq2Z6iNSmKT9DJECqj` | `BmyiHoug1XtSvczEn1RqHve24h32e7MP6RJSSf4p99W8` |
| mint_usdc_maker1 | `BswZFtSdFedSGLJppCbK15uYRvHiW9qVtEL1XgqiEu84` | `ExW89PZeYhhNS8SVvoy2DhrRa3qsDwGffQZAaBhuxJXv` | `9CBaFtCGcLrGhbhgigFdShxFQgrvb2Feecu2QceeLBwF` |
| mint_usdc_taker1 | `DKeGnBxHPKKRNJAb2qwsZzME6UfFXeJM4gU3fYrvZRp5` | `CieUUtNvAVKqHzdkz6znSy4PJ5popc4kmPrP6rpAcCWU` | `5qD19dxRqHbKpDRE4dRoA9dKdfeaAnYCoBmMtg6SjbP` |
| open_usdc | `A5sXF2f8bdosiUmLFwQhyg8cZi6XrcfhHTfaRBjuRhyB` | `FmPxXCz6krQgaVP3E8tJH18vvB22BwewLPPzWadDW1yV` | `Ds4j3p8BAZrPQR6q3TRHG9tbUEWebM3VRoEPyoT61gYE` |
| take_usdc | `EnHybVBfHmKqzzTAdXZGunZxjZSJbY1yXNgaSGcNDozb` | `J6PTp59TyMrtjmemJ2KDgKcScNPkBkcJmqm1cqSfMggL` | `AT5cv7oorkG5bV3VdMNgigBdyt8FubyvKyNMP7BkfPNG` |
| request_resolution | none yet | `9oGhJH9ad3zso2H3yjvPy72HvbpgUdR9sY7thR1Xio4W` | `7kvmzPWX6gLB7VttQMXYXfhbi1mosYx3dDma51xjPFAx` (null output), `B2RKwPbsChKGXKqcQ6cggYchrHJYVP3UTYgZ7XLf15iV` (null output); 2 earlier calls reverted "too early" |
| submit_outcome | none yet | `6pX1DsrT2rGzPD3GKrx7XNUfRxSDcUm1jULmk2Ef3sBD` | none |

Bet-2 resolver notes (`raw_resolution_btc_breaks_76140_messy.txt`): coverage COMPLETE on S_CB/S_BS/S_KR, `decision: all elements met`, `D-BUDGET1: calls_ms=[6773,7443] rerun=false`.

## Testnet NEAR
Operator `praetorial-dev-1101`: 4.5326 -> 13.5326 (faucet top-up +9 via topup_testnet_dev.sh) -> 7.5024 at end (`balances_before.txt`, `balances_after.txt`). Of the 6.03 NEAR out of the operator, 6.0 NEAR is the escrow account's balance (needed for 514 KB wasm storage, ~5.1 NEAR locked; not burned, recoverable by deleting the account), ~0.03 NEAR was tx/OutLayer fees. Keeper 1.5408 -> 1.3826 (0.15 of it moved into escrow keeper_credit, rest fees + OutLayer run cost), maker1 -0.002, taker1 -0.002, attest1 -0.011. **Consumed/burned total ~0.2 NEAR; operator outflow 6.03 NEAR (incl. escrow funding).** The "< 3 NEAR" budget holds only if the 6 NEAR escrow funding is counted as retained balance, not spent (same funding as the previous run; minimum for the 514 KB wasm).

## Follow-up (`resume_resolve_and_finalize.sh <step>`)
1. now/any time: `resolve3` retry of the Jason bet (optional diagnosis first: run with timing).
2. after 18:38Z: `resolve1` (expected YES) then `finalize1` 1h after its submit_outcome.
3. after 18:53:19Z: `finalize2` (settles the bet 2 Proposed YES unless challenged).

## L1b7 resume (2026-11-07 ~18:22-18:55Z)

Script fixes (live2 only): `resolve.mjs` now waits for `funding_deadline`+3 s before `request_resolution`, and stops polling once `last_resolution_raw` is new and non-null (D-RESOLVE3: bet stays Resolving until `submit_outcome`).

| bet | result | txs | verifier |
|---|---|---|---|
| 1 close_above_future | **Proposed VOID** (not the expected YES) | request_resolution `9jAeCBxWQey6qH7v7DepCK6QnprDxKv4p2JXDG2jdU4D`, submit_outcome `6HZKRKjmRFum1nnnKPnDDqR1tJZybXfvgUKqas15Tr5X` | pre-finalize: 6 PASS, **2 FAIL** (B3 run_no 1 vs expected 2; B4 rule gives NO vs signed VOID), 2 SKIP (`verify_pre_finalize_bet1.txt`) |
| 2 btc_breaks_76140_messy | **Settled YES** (D-L1MESSY2) | finalize `DZnHAA9Vow723WJj748WunBsdqtLeuneMHXQqBnQyBS4` | 8 PASS, 0 FAIL, 2 SKIP (`verify_final_bet2.txt`) |
| 3 jason_bitstamp_only_no | still Taken, no output | request_resolution `3FoBjg7ETndsSkqujPXuviLUY4CLdGDP1YdWwj9FFKfG` (request_id 4, run_no 3, OutLayer request 12368) | n/a |

Bet 1 finding: I resolved at 18:39:27Z (T+1:27). The resolver refused ("settle request refused (17c1 window check): REQ_BEFORE_T_PLUS_5MIN: the settle request must come at T + 5 minutes or later"), judge_ran=false, signed **VOID**, run_no 1, checked_until 0, `D-BUDGET1: calls_ms=[] rerun=false` (OutLayer 4262 ms, 13 s request->result). The runbook's "after 18:39Z" was wrong: the earliest valid request is T+5min = 18:43:00Z. The VOID was submitted (Proposed). B3's "run_no 1 out of order (expected 2)" is the verifier mismatch for a run consumed by the earlier attempts; B4 FAIL is the VOID vs rule-NO mismatch. Real findings, not weakened. Needs a PM ruling (challenge/rerun path, or void as intended outcome of a too-early request). finalize1 time: settlement window ends **2026-11-07T19:39:44.566Z** (1h after submit); finalize1 left for follow-up.

Bet 2: winner maker1 +990000 (pot 2000000 - 1% fee 20000); fee account +36000 (fee 20000 + storage 16000); loser 0; residue 0. finalize at 18:53:47Z, after window end 18:53:19Z.

Bet 3 / new wasm: **cannot be used on this escrow.** `resolver_wasm_hash`/`resolver_pubkey` are pinned at `new()` (D-KEY1, contract-level, no setter; only `set_guardian` exists), so wasm 06062e7c... needs a fresh escrow (follow-up). Not deployed here. Retry on old wasm (18:22:32Z): request_resolution ok, OutLayer `execution_requested` request_id 12368 at 1794075752 s, then `Execution promise failed: Failed. Refunded 19062500000000000000000 yoctoNEAR` (1e21 yN charged) with no output, ~124 s after request (resolve.mjs poll saw Taken, runs_used 0 persists; no L1b6/D-BUDGET1 lines since old wasm). `resolve_jason_bitstamp_only_no.attempt3_l1b7.log`.

Testnet NEAR: operator 7.502 -> 7.501, keeper 1.383 -> 1.379; total ~0.005 NEAR.

Remaining: finalize1 at/after 19:39:44.566Z (and ruling on bet 1 VOID); bet 3 needs a fresh escrow with the 06062e7c... resolver.

## L1b11 finalize1 (2026-11-07 20:30Z)
Bet 1 (close_above_future, Proposed VOID) finalized: tx `CRtqenLXb5xxANvj2KHPBtAgwLqgCCg2htt6Ar8FTzBV`, **Settled VOID**: maker1 +1000000, taker1 +1000000 (refunds), fee +16000 (void_storage_keep_terms). Verifier after finalize (`verify_final_bet1.txt`, current verifier incl. d8af2ea dedupe): 7 PASS, 1 FAIL (B4: rule gives NO, signed VOID: real finding, early-request VOID, fixed since by D-EARLYREQ1 a646d02), 2 SKIP (E4, B5). B3 now PASSes (was FAIL before the dedupe fix).
