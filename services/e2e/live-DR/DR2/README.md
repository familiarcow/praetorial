# DR2: rehearsal-game-winner-ai (AI-judged `game_winner`, deployed testnet web)

Status: **DONE, verify-only finish** (phase 1 web open+take; phase 2 request/submit/finalize were done by the KEEPER before the harness ran, so phase 2 is the committed read-only verify-only path `finishVerify.ts`). Outcome YES == ESPN truth (NY 117, MIL 85). Verifier 8 PASS / 0 FAIL / 2 SKIP (E4 offline allowed; **B4 PARTIAL**, pending PM ruling, NOT a PASS).

- Web: https://praetorial-web-testnet.familiarcow.workers.dev. Escrow: `praetorial-frz3-2611100414.praetorial-dev-1101.testnet` (== apps/web/lib/network.ts testnet escrow on main).
- Escrow checks (done before the run): `git diff freeze-candidate-2 HEAD -- contracts/escrow/src` empty; `npx tsx DR2/pin.ts`: resolver_keys contains `8791413ff7943f5e5b99df4c5cafc50cb9baf5696cf32837e1a8afd31baa2473` == apps/web/lib/release.json (full 64 hex): `full_match: true`.
- **Bet 35**: NBA game 401909960, **New York Knicks (ESPN team id 18, abbr NY) vs Milwaukee Bucks**, ESPN scoreboard date 2026-11-10, scheduled start **2026-11-11T00:30Z** (about 3 h after open at 21:35Z; >= 1 h rule). Maker (YES) backs the Knicks. Stake 3 NEAR (wNEAR on mock intents) each side, odds 1:1, settlement period 1h, AI judge (no referee), fee 1% min 0.14/side.
- Maker: real Privy test login `8941e607...81c7` (OTP never logged). Taker: **fresh per-run** implicit account `ba4e436b...1f98` (balance 0 asserted before funding; key 0600 in scratch, outside the repo), `__drSign` test wallet; it claimed a username through the first-login dialog and took through the maker's invite link (take dialog = take-next, take-confirm).
- Game choice: the builder's game_winner template offers MLB/NHL/NFL/NBA. NHL needs the NHL api-web id for the open check (ESPN ids do not match), so NBA (ESPN only source, `single source` clause) was used. The game is a genuine toss-up; the pick (Knicks) was made before seeing anything about the result.

## Tx table (who did what)

| step | by | tx |
|---|---|---|
| mint wNEAR to maker | harness (keeper key) | HpHBWzCMaUVzYxc1h7WsaJE6bBH5PUBej9B8JweherB3 |
| mint wNEAR to taker | harness | 8YbwiChQ87LcSnJqAWSC5WYT1E4xKRLesGuFkVYETP8B |
| tNEAR to taker implicit | harness | 5J3dD1pRCX9HsJrtY4G31Lamh7h2JPL6QC6fAYrVEsgQ |
| open (bet 35, `mt_transfer_call`) | web (maker, Privy) | 6oU7YqyoHKQNb6Td4g7Rxr3cCm3Kab2eReDoWj9RaQQY (the web UI does not show an open tx hash; found with `npx tsx DR2/txs.ts`) |
| take | web (fresh taker) | 2TDSsREFzp1UcTK2BNqTdWARb9cib1ZB48XRrauDBM3N |
| request_resolution run 1 | **keeper**, NOT web | p85bp4jhm4YmnpBRwCdB8JGm9UXm1Xwq8MRuFhzttG2 |
| submit_outcome run 1 (**RETRY**) | **keeper** (submits the resolver's signed ruling), NOT web | 97s9UP6Zt7XKk6pbNamswZ9Kte1z5yhXApSY81t6XbQj |
| request_resolution run 2 | **keeper**, NOT web | 4jNnNcSnwmhFsNi3eHnWRrAWouXpC41tB9zaKQkfmCGp |
| submit_outcome run 2 (**YES**) | **keeper**, NOT web | HkPCczWjqpbtU9BJpqxEpABdCZj9tGPkmi2MUNyHRVCc (proposed_at 1794372092553553208 = 2026-11-11T05:41:32Z) |
| finalize | **keeper**, NOT web (2026-11-11T05:48:32Z, 7 min after the window ended) | Bc15i7y87gtSgVT4ZQZppfSf5jeGjuJhhCPrK4sbrjjq (events bet_finalized 35, payout_done [62,63], [64,65]) |
| payouts | escrow via intents `mt_transfer` (receipts of the finalize tx) | maker +5728260869565217391304348, fee +306109130434782608695652 |

Balances after take (run/results.json `balances_after_take`; run/state.json `mid`): maker 124.0148 wNEAR, taker 0.0828 wNEAR (3.1 minted, 3 stake + storage taken out).

## Phase 2 (2026-11-11): bet was already Settled by the keeper; verify-only

The orchestrator missed the resume window. Before the harness ran, the keeper path had done request_resolution, submit_outcome and finalize. **None of request_resolution / finalize was driven through the web, and the taker never called anything**: the web request/finalize checks of the plan are NOT exercised by this run (not web-driven). The playwright `DR2_PHASE=finish` spec cannot run on a Settled bet, so `verifyOnly.ts` (pure, unit-tested RED first: `test/dr2.verifyonly.test.ts`, 4 tests) and `finishVerify.ts` (read-only: ESPN + chain views + public tx indexer + finalize receipts) were added. `finishVerify.ts` refuses to run unless the bet is Settled.

- **Ground truth (honest ordering).** `run/ground_truth.json`: ESPN event 401909960 (scoreboard 20261110) FINAL, **NY 117 - MIL 85**, winner NY, pick NY => YES. `outcome_read_before_this: true`: the chain outcome (YES, proposed_at 1794372092553553208) existed before the harness fetched ESPN. ESPN is independent of the judge, so chain-vs-truth is still a valid comparison, but the truth was NOT written ahead of the outcome.
- **Chain outcome YES == ESPN truth YES.** No wrong winner.
- **Run 1 explained (not a VOID, not an audit flag).** `runs_used` 2, `used_run_nos` [1,2], `all_results` only run 2. Run 1 = `submit_outcome` **RETRY** (tx 97s9UP6Z..., escrow log `submit_outcome RETRY bet_id=35 retry_count=1 next_check_ns=1794371400000000000`, event `outcome_retry`); it was submitted 2026-11-10T22:50Z, ~1.7 h before the game's scheduled start (00:30Z), so the game cannot have been final (inferred: the raw run-1 judge record was overwritten by run 2, only the RETRY result survives on chain); the contract consumed run_no 1, stored no result (RETRY is not a result), set `retry_count` 1, `first_unavailable_ns` 1794347432993180000 and `next_check_ns` ~2026-11-11T05:30Z. Run 2 (request 4jNnNcSn... at 05:32Z, after next_check) judged and returned YES. `next_expected_run_no` 3 shows no run 3 is pending. This is the designed RETRY path, not an error. Keeper logs were not available on this host; the explanation rests on the chain events/args above (`run/txs_bet35.json`).
- **Audit-flag check (bet 42 pattern): NOT present.** Bet 35's last_resolution_raw (run 2) has `{"audit":"agree"}` (note `17c5 audit agrees with the code outcome YES`), `final: MIL 85 - NY 117; winner NY (single source: ESPN)`. Observations carried from the raw record, not new defects: `judge_ran: false` yet an audit call to deepseek-ai/DeepSeek-V4.1-Flash-1017 was made, and its `verify_result: "invalid"`, `verify_reason: "not verified"` while `signature_verified: true` (the NEAR AI signature proof itself re-verified in the verifier). The notes say the outcome came from ESPN by code (single source) with the AI only auditing, which fits `judge_ran: false`, but I did not check that against bet 42's record; the PM may want to confirm the `verify_result: invalid` semantics.
- **Money (`run/money_check.json`, DR1b receipts method).** From the finalize tx receipts: maker (winner, Knicks YES) **5728260869565217391304348** = 2x3 NEAR - 2x side_fee 135869565217391304347826; fee account **306109130434782608695652** = 2 side fees + 2x17.185 mNEAR storage; taker (loser) 0; sum = deposits 6.0343 NEAR, residue 0. Equal to `expectedDecisive` (same math as dr2.test.ts maker-win, 2x stake - 2x side_fee, fee + storage) to the yocto, 0 mismatches. `is_fully_paid` true, no undone `pending_payouts`. The fresh taker's wNEAR balance is unchanged since the take (82815000000000000000000 = 0.082815), i.e. delta exactly 0 as the loser. Maker/fee/escrow account deltas are not asserted (shared accounts).
- **Verifier** (`run/verify_bet35_offline.txt`): `verify-bet --network testnet --escrow praetorial-frz3-2611100414.praetorial-dev-1101.testnet --bet 35 --expect-escrow-hash caf134a484bc68c2e6900bd03cba7b3eb29af40b67d65f61db1fe04831450f2f --offline`: **8 PASS (E1 E2 E3 B1 B2 B3 B5 B6), 0 FAIL, 2 SKIP**: E4 (offline, allowed) and **B4 PARTIAL** (decision rule re-applied gives YES == signed outcome; answer text hash and 1 NEAR AI signature re-verified; NOT re-verified: the raw NEAR AI stream and attestation report for signer 40599fb2...; pending the PM ruling that the judge keeps only fingerprint + signature). Recorded as PARTIAL, not PASS. B3: 2 signed results run_no 1,2 valid. `services/verifier/final_step.sh <run-dir> <hash>` was run too exactly as for DR1 and, as for DR1, errors with ENOENT `raw_resolution.txt` (this harness records no live-runR3e layout; `run/final_step_rundir_attempt.txt`), so verify-bet live-views `--offline` is the equivalent, as in DR1.

## Verified so far / findings

- Offline unit tests: `DR2/test/dr2.test.ts` (10 pass): money per party for maker-win, taker-win and VOID, ESPN ground-truth decision (YES/NO/VOID, refusal of unknown event or wrong pick), 1 h lead rule, verifier SKIP set (E4 only offline, B4 PASS), fresh wallet, escrow = web escrow.
- Observation (not a new finding): DR3's F1 (funding window floored at open+60 s for a game_winner/NWS whose date has started) applies here too: bet 35's funding deadline was 21:36:43Z, open at ~21:35:30Z. It worked in this run because the taker was pre-warmed and the sourcecheck was fast (54 s whole test); it is tight and would fail on a slower sourcecheck. Same web fix item as DR3 F1.
- The web gives no open tx hash (`open-tx` absent), recovered from chain history.

## What this proves / does not prove

Proves: a game_winner AI bet built, source-checked, opened and taken through the deployed web with a fresh taker settled on chain to the outcome the league box score gives (YES, NY won 117-85, ESPN fetched independently); the RETRY path (run 1 before the game) then a decisive run 2 behaves as designed; payouts match the committed offline expectations to the yocto, residue 0, fully paid; verifier 0 FAIL.
Does not prove: (a) that the web's request_resolution and finalize controls work for a game_winner bet (the keeper did both; not web-driven); (b) truth-before-outcome ordering (ESPN was fetched after settlement, recorded `outcome_read_before_this: true`); (c) B4 full pass (PARTIAL pending PM ruling); (d) E4 (offline only); (e) keeper log evidence (not on this host).

## Final on-chain state (MISS1 salvage, read-only check 2026-11-13 ~05:51Z)

Salvaged onto main by MISS1 from branch `feat/dr2` (the run never merged). `run/chain_final_miss1.json` = `get_bet` view at that time (`spikes/miss1/chain_final.py`, view calls only).

- Bet 35 on frz3: **Settled YES**, runs [1 RETRY, 2 YES], judge_backend near-ai. Matches the README and the ESPN truth (NY 117-85).
- Correction: the README's "proposed_at ... = 2026-11-11T05:41:32Z" is the window END; `proposed_at` itself is 2026-11-11T04:41:32Z (1 h settlement window), which is why finalize at 05:48:32Z was "7 min after the window ended".
