# Testnet case studies: verification record

Verified 2026-11-12, read-only. Companion data file: `spikes/docs2/cases.verified.json` (12 cases, 102 txs, all confirmed by RPC).

## Method

- **Tx checks:** JSON-RPC `EXPERIMENTAL_tx_status` (`wait_until: NONE`). Endpoint order: `https://archival-rpc.testnet.fastnear.com`, then `https://archival-rpc.testnet.near.org` (used when fastnear rate-limited), then `https://test.rpc.fastnear.com`. For each tx I recorded signer, receiver, top-level method(s), final status, receipt logs and receipt failures. I also decoded the args of every `mt_transfer` receipt to get the exact payout amounts.
- **Relayed (gasless) txs** have a top-level `Delegate` action signed by `relayer.praetorial-dev-1101.testnet`. I decoded the inner call (sender, method, args) from `delegate_action`.
- **State checks:** `query` / `call_function` `get_bet`. I used `finality: final` on `https://test.rpc.fastnear.com` where the escrow still exists (frz3, frz2, l1b, l1b18, l1b20, l1b5, e2e). The `r3c` and `r3e` escrows no longer exist (`UNKNOWN_ACCOUNT`), so for those I ran an archival `get_bet` at a block just before finalize on `archival-rpc.testnet.fastnear.com`.
- **Dates and times** are UTC block timestamps from `block` (by `transaction_outcome.block_hash`). A case's `date` is the UTC date of the tx that settled it.
- **Amounts:** USDC uses 6 decimals and wNEAR uses 24. All assets are testnet mocks: `nep141:usdc.testnet` on `intents-mock.praetorial-dev-1101.testnet`, and `nep141:wrap.testnet`.
- **Short repo paths:** `E/` means `services/e2e/`. `CS/` means `spikes/cs1/`. "fee acct" is `fee.praetorial-dev-1101.testnet`. maker1, taker1 and keeper are `<name>.praetorial-dev-1101.testnet`.
- **Opens and takes in mock-USDC bets** are `transfer_with_msg` (or `mt_transfer_call`) on `intents-mock`. The deposit is the stake plus a per-side storage charge, for example 1,008,000 = 1,000,000 stake + 8,000 storage. The escrow log `open bet_id=N` or `take bet_id=N` in the same tx confirms the escrow accepted it.

---

## 1. btc-both-venues-yes: escrow `praetorial-l1b18-11080038`, bet 1

| Claim | Repo | Chain |
|---|---|---|
| Sheet: BTC 1-min high >= $75,948.00 on BOTH Coinbase and Bitstamp in the same 5-min bucket, by 2026-11-07T06:00Z | E/live-L1/live4/README.md:23; E/live-L1/live4/terms_jason_same_bucket_yes.json (sha256 `8ec17014…f094b3`) | open args `terms_hash` = `8ec17014…f094b3`, and submit_outcome `terms_hash` matches |
| Stake 1 USDC per side | E/live-L1/live4/README.md:20; results_jason_same_bucket_yes.json:81 | open `ESEpUZRC…` inner envelope `stake_maker`=`stake_taker`=1000000, deposit 1008000. `get_bet(1)` stake 1000000 |
| open | README.md:26 | `ESEpUZRCj7djC7xUmFBUfCyDyKQWDfdBRFdMsRWYAS9N` maker1 -> intents-mock `transfer_with_msg`, SuccessValue "1008000", log `open bet_id=1`, 2026-11-08T00:42:12Z |
| take | README.md:27 | `GEK1mW2WkbMnpXBkPGjWVVcEZE3aa7FugJcvkEi3iZj4` taker1 -> intents-mock, SuccessValue, log `take bet_id=1` |
| request_resolution | README.md:28 | `9wr6cjWRDtr28c8wM7EF8gDgepbXZdFd7hWmmPzEqM3A` keeper -> escrow, SuccessValue. OutLayer request 13024 "Execution completed successfully" |
| Both models `met`, quoting Coinbase 75948.99 / Bitstamp 75949.72 in the same minute | results_jason_same_bucket_yes.json (last_resolution_raw) | `get_bet(1).last_resolution_raw`: DeepSeek and GLM both `"answer":"met"`, quote `1794029820,75948.99` plus S_BS; note "decision: all elements met" |
| submit_outcome YES, run_no 1 | README.md:32 | `7hXdtNGAG2TP5vNZ3TDGqi82kyNntSRYWTUaYvW8qvxD` praetorial-dev-1101 -> escrow `submit_outcome`, args outcome YES run_no 1, SuccessValue |
| finalize: maker +1,980,000, fee acct +36,000 | README.md:35, :50, :52, :54 | `Bq15gqfX8Ku83Nhbu169ugvHAabYb9RSCGC1TF98q2Pk` (2026-11-08T01:50:01Z). Receipts: `mt_transfer` 1980000 -> maker1, `mt_transfer` 36000 -> fee acct. `get_bet(1)` Settled / YES |

## 2. btc-one-venue-no: same escrow, bet 2

| Claim | Repo | Chain |
|---|---|---|
| Same sheet at $75,951.00 (reached on Bitstamp only) | E/live-L1/live4/README.md:23; terms_jason_bitstamp_only_no.json (sha256 `1d3796a0…c284`) | open and submit `terms_hash` = `1d3796a0…c284` |
| Coinbase max 75,950; Bitstamp 75952.18 in a bucket where Coinbase topped at 75948.99 | README.md:23 | `get_bet(2).last_resolution_raw`: both models `not_met`, quote `1794029220,75950`; GLM also quotes S_BS `75952.18` |
| Stake 1 USDC per side | README.md:20; results_jason_bitstamp_only_no.json:81 | open `3shnWVup…` envelope stakes 1000000 / 1000000. `get_bet(2)` |
| open / take / request / submit | README.md:26-32 | `3shnWVupqqLvPBAnjddmLxE79NiftTou4TPbRRRMZZHJ` (log `open bet_id=2`), `2ynq9mB5TbNmmQbKnAX3oWztcy2a2dZYvGYMo8ALrjLa` (`take bet_id=2`), `8MTFoQPk4h8Rsy7w1paRUvVmaZRSeys8s5VmPnQfBi31` (keeper, OutLayer 13025 completed), `HbHwJ2Qa3dx777JQC5TwTsg9q6nCNTBuS5sofEvETozk` (outcome NO, run_no 1). All SuccessValue |
| finalize: taker +1,980,000, fee +36,000 | README.md:35, :51-52 | `FMT1dzDc4See83Ag3EdoUKnQNuCDf9doNogKFp1bAM9y` (01:50:15Z). `mt_transfer` 1980000 -> taker1, 36000 -> fee acct. `get_bet(2)` Settled / NO |

## 3. btc-one-venue-no-code-decided: escrow `praetorial-l1b20-11080132`, bet 1

| Claim | Repo | Chain |
|---|---|---|
| Fresh escrow, one-venue NO sheet | E/live-L1/live5/README.md:3 | submit `terms_hash` `1d3796a0…c284` (same sheet as case 2) |
| Stake 1 USDC per side | (by payout arithmetic README.md:33) | open `DfLEvcMW…` envelope stakes 1000000/1000000. `get_bet(1)` |
| Code decided NO; one AI audit agreed; `judge_ran` false | README.md:20 | `get_bet(1).last_resolution_raw`: one diagnostic `{"audit":"agree"}`; notes "the price gate decided NO from complete venue coverage … 17c5 audit agrees with the code outcome NO" |
| OutLayer run 6,617 ms | README.md:21 | request tx log "time_ms: 6617" |
| open / take / request / submit | README.md:14-16 | `DfLEvcMWLLWckaCX3ocPSrqriSkD7KC64x3Wzzgd2L2Q`, `2uFLw11E1Cp24Lmm4u7zTz9w1fi2vtA3zhaRiK78tdTq`, `GmjvD4Sa1jcrhPwhVX6kWqwmj7ZJnrg33fqLJyYT8Wgn` (keeper, OutLayer 13063), `9o8gktL2Beu5N3CbHAcQPqRmfoubo3uz8USeK1bdHLNE` (NO, run 1). All SuccessValue |
| finalize: taker +1,980,000; fee +36,000 | README.md:29, :33-34 | `8DgRHSiAAyx5nWzkFmHjQpnwsBaXsGBb7gTGCxkExif2` (2026-11-08T02:40:02Z). `mt_transfer` 1980000 -> taker1, 36000 -> fee acct. `get_bet(1)` Settled / NO |

## 4. btc-touch-75200-no: escrow `praetorial-frz2-2611091914`, bet 18

| Claim | Repo | Chain |
|---|---|---|
| btc_touch at_or_above $75,200, window 04:48-10:48Z on 2026-11-10 | E/live-DR/DR1/README.md:7-8; run/bet_taken.json:24 | open inner envelope `terms`: `x_usd 75200`, `open_utc 04:48`, `deadline_utc 10:48` |
| 3 wNEAR per side | README.md:7; run/bet_taken.json:18-19 | open `GtURKaDM…` (relayed): inner `transfer_with_msg` from the maker's implicit account, `nep141:wrap.testnet` amount 3017150000000000000000000 = 3 wNEAR stake + 0.01715 storage; `stake_maker`=`stake_taker`=3e24. `get_bet(18)` stake 3e24 |
| open, take (web, relayed, invite link) | README.md:18-19 | `GtURKaDMyR7q6DkhDG6LD3cQi3hCtT8cggvmVe9YsMvG` signer relayer, `Delegate` -> `transfer_with_msg`, log `open bet_id=18`, 04:48:55Z. `9a4F9pfPopervAJQehwvqXe3EiT1vnwXq2UL4sdtDPCs` relayer, `Delegate` -> `transfer_with_msg` (Take with invite_sig), log `take bet_id=18` |
| request_resolution by keeper at 10:49:32Z | README.md:39, :52 | `8Xh3N5dsZsNdKcP9bKuWhVWnuGe7a7zxcNgiDHtU9MDU` keeper, block time 2026-11-10T10:49:32Z, OutLayer 15700 completed |
| Code-decided NO, 3 venues complete, AI audit agreed | README.md:40 | `get_bet(18)` notes: "Coinbase … 360 candles -> Clear", "Bitstamp … 360", "Kraken … 362", "decision: NO (code-decided 1b …)", "17c5 audit agrees" |
| submit_outcome NO | README.md:53 | `ABdWDYZLvTxGWLfjB5fyAifxG5MGN7FBx8yUGoeyT7Vr` praetorial-dev-1101, outcome NO run_no 1, event `outcome_submitted` |
| finalize by keeper: taker 5728260869565217391304348, fee acct 306039130434782608695652 | README.md:65, :67 | `EkMbnyrDyr6s6Nh3iz6JFYdZ7vyLTHeSCmPvx8Wn8Fxv` keeper (17:55:32Z). `mt_transfer` exactly those two amounts, events `bet_finalized`, `payout_done`. `get_bet(18)` Settled / NO |

Repo-only and not used in the JSON: the independent ground-truth highs (Coinbase $74,902.89, Kraken $74,888.80, Bitstamp $74,904.03) at README.md:47. The chain has no record of them.

## 5. fail-safe-void-series: escrow `praetorial-e2e-2611052236` (one name, redeployed between attempts), bet 1

All 32 txs are in the JSON. Every one was found on `archival-rpc.testnet.fastnear.com`, except `6vrWzt9T…` (archival-rpc.testnet.near.org), and every outcome below matches.

| Attempt | Repo | Chain |
|---|---|---|
| 1: open refused (settlement period < 1 h) | E/live-run16/results.json:27 | `3G3H4zqpTN6o8zUSEmCBZj5H9hcCNRwMUvNZDqMKyeAY` SuccessValue "0" (nothing kept), escrow log `open_rejected … settlement_period must be between 1h and 90d` |
| 1: open, take | E/live-run16/results.json (txs) | `8miLQLZV…` log `open bet_id=1` (2026-11-06T09:07:47Z); `BzKNgPYH…` `take bet_id=1`; deposits 10008000 each (10 USDC + 0.008 storage) |
| 1: request, OutLayer rejects args | E/live-run16/results.json:64, :71-73 | `6U8HN1hWiESqhfVgZFna3MMCHcVMYB438EoLu9jCnKEJ` keeper SuccessValue at the escrow, but the receipt on outlayer.testnet failed: "missing field `source`" |
| 1: unwound by 50/50 mutual settle | E/live-run16a/results.json:51, :57, :508 (same terms_hash `ea14703b…` as run16), :534-539 (Settled, MUTUAL) | `CZv3hfUx…` maker1 `mutual_settle {split_maker_bps:5000}`, `3SZ4x8Nr…` taker1 same. Receipts `mt_transfer` 9900000 -> maker1, 9900000 -> taker1, 216000 -> fee acct (09:45Z) |
| 2: VOID, Coinbase page failed and Kraken had no data (only 1 of 3 venues) | E/live-run16f/results.json:73-112, :503, :534-539 | open `CBL4HKLY…`, take `D8qENQU7…`, request `H2QUZSvF…` (OutLayer completed 3,651 ms), submit `HTa3fvXy…` outcome VOID, finalize `4hKJkMaM…` (12:38:23Z): 10000000 -> maker1, 10000000 -> taker1, 16000 -> fee acct. Archival `get_bet` before finalize: notes "price evidence INCOMPLETE for S_CB … page failed", S_KR "no candles" |
| 3: VOID, genuine gap in Coinbase hourly candles | E/live-run16i/results.json:104-137, :350-353, :375-380 | open `G9jgEPuF…`, take `61TpCq4D…`, request `GH8AXxPm…`, submit `2ULysccB…` VOID, finalize `92dvUhfp…` (13:56:14Z): 10 USDC each + 0.016 fee acct. Archival notes: "gap between 1761404400 and 1761426000" |
| 4: VOID, no model configured in the sheet (resolver fell back to a mock id) | E/live-run16l/results.json:106-145, :408-411, :475 | open `FhMCDJoN…`, take `F4DV8MDF…`, request `GWscpAfn…`, submit `BdnGmyFF…` VOID, finalize `qqS5QxAj…` (15:12:12Z): 10/10/0.016. Archival notes: "decision: runs/models disagree or an answer failed verification". The mock-model cause is repo-only (:411) |
| 5: VOID, Qwen model answered but content was unusable; one early request trapped | E/live-run16o/results.json:115-148, :324, :405, :444 | open `8vX83mPf…`, take `8G9QE8MC…`, early request `kcPzKk2z…` **Failure** "unreachable" (no cost), request `HeHAeDr5…`, submit `DJfmoh1s…` VOID, finalize `GXbJnf33…` (18:44:20Z): 10/10/0.016. Archival: models_echoed `Qwen/Qwen3.8-27B`, judge_ran false. The exact cause (token limit) is unproven in the repo too (:405) |
| 6: VOID, AI call got no response | E/live-run16r/results.json:115-141, :192-193, :536, :575 | open `na4wNvSR…`, take `Hw2abMMQ…`, request `HzL3FcPD…`, submit `62iunA47…` VOID, finalize `6vrWzt9T…` (22:26:31Z): 10/10/0.016. Archival diagnostics: `verify_reason "no response (transport failure)"` |

The six attempts use different deployments of one account name, and each has bet_id 1, so a current `get_bet(1)` shows only the latest deployment (Settled VOID, 10 USDC). The per-attempt proof is the tx receipts above plus the archival views.

## 6. knyc-weather-void: escrow `praetorial-r3c-11061912` (deleted), bets 1 and 2

| Claim | Repo | Chain |
|---|---|---|
| KNYC 2026-11-05 daily high >= 70F; NWS report value 72F | E/live-runR3/results.json:288 (terms) | archival `get_bet(2)` GLM quote "TEMPERATURE (F) YESTERDAY MAXIMUM 72 615 PM" |
| Stake 1 USDC per side | E/live-runR3/results.json:282; E/live-runR3e/results_fin_old.json:31 | opens `7rRBaqCX…` (log `open bet_id=1`, 2026-11-07T00:14:26Z) and `9jxQe421…` (`open bet_id=2`) deposit 1008000 each; archival `get_bet` stake_maker 1000000 |
| Bet 1 VOID: AI key bound under the wrong account, offline mock, 0 model calls | E/live-runR3/results.json:375 | archival `get_bet(1)` diagnostics "offline mock: no model was called", models_echoed []; submit `7Xj7Gpn1…` outcome VOID |
| Bet 2 VOID: DeepSeek HTTP 400, GLM `met` | E/live-runR3/results.json:384 | archival `get_bet(2)` `http_status 400` for DeepSeek-V4.1-Flash-1017, GLM `met`, models_echoed [glm]; submit `3Fk45PYF…` VOID |
| Txs | E/live-runR3/results.json:89, :99, :107, :142, :152, :160 | take `96svmDTQ…`, `HCrpYsAo…`; requests `EmsrceCt…`, `RxsgsWYC…` (keeper, OutLayer completed). All SuccessValue |
| Finalize: 1 USDC refunded to each side, fee acct 16,000 each bet | E/live-runR3e/results_fin_old.json:5, :11, :85 | `AsBnfX8U…` and `8MKNnVYu…` (01:37:32Z): each 1000000 -> maker1, 1000000 -> taker1, 16000 -> fee acct |

The model-id explanation for the HTTP 400 is marked "unverified" in the repo (:384), so the JSON says "most likely … not confirmed".

## 7. knyc-weather-yes: escrow `praetorial-r3e-11062012` (deleted), bet 1

| Claim | Repo | Chain |
|---|---|---|
| YES, both models `met` quoting "MAXIMUM 72" | E/live-runR3e/README.md:3 | archival `get_bet(1)` @276570820: Proposed YES, quote "YESTERDAY MAXIMUM 72 615 PM …" |
| Stake 1 USDC per side | E/live-runR3e/results.json:180 | open `1YzMF88P…` deposit 1008000, log `open bet_id=1` (01:16:13Z); archival stake 1000000 |
| Early request rejected | E/live-runR3e/results.json:159 | `23khKvNVWRQ7Q2zFakEXfAPftqbrSrooWZkg2f6pHrNq` **Failure** "WebAssembly trap: unreachable" |
| request, submit | results.json:62, :70 | `Cc9de2Mw…` keeper (OutLayer completed 13,518 ms), `6MDRMMho…` outcome YES run 1 |
| finalize: maker +1,980,000, fee +36,000 | E/live-runR3e/results_finalize.json:5, :39 | `3GqTf4funbFVN45jWcp9sAAKMVhhBBCvRA54yEnqXU37` (2026-11-07T02:29:28Z): 1980000 -> maker1, 36000 -> fee acct |

## 8. early-request-void: escrow `praetorial-l1b5-11071226`, bet 1

| Claim | Repo | Chain |
|---|---|---|
| btc_close_at_t `>` 70000 at T = 2026-11-07T18:38Z | E/live-L1/live2/README.md:9 | open `A5sXF2f8…` envelope terms `{"t_utc":"2026-11-07T18:38:00Z","op":">","x_usd":70000}` |
| Stake 1 USDC per side | (README.md:69 refunds 1000000 each) | open deposit 1008000, stake_maker/taker 1000000. `get_bet(1)` |
| Request at 18:39 (T+1:27), before T+5 min | README.md:58 | `9jAeCBxW…` keeper, block time 2026-11-07T18:39:29Z |
| Resolver refused and signed VOID | README.md:54, :58 | `get_bet(1)` notes "settle request refused (17c1 window check): REQ_BEFORE_T_PLUS_5MIN …"; submit `6HZKRKjm…` outcome VOID run 1 |
| Finalize: 1 USDC each refunded, fee +16,000 | README.md:69 | `CRtqenLX…` (20:30:50Z): 1000000 -> maker1, 1000000 -> taker1, 16000 -> fee acct. `get_bet(1)` Settled / VOID |

## 9. challenged-btc-close-rejudged: escrow `praetorial-frz3-2611100414`, bet 49

| Claim | Repo | Chain |
|---|---|---|
| close >= $74,400 at 20:30Z on 2026-11-11, 20 USDC per side | CS/CASE-STUDIES.md:122, :124; CS/state.json:52 | open `3FtMzC9D…` (relayed, maker implicit acct `979f…7d`) inner `mt_transfer_call` amount 20062783, `stake_maker`=`stake_taker`=20000000, terms `x_usd 74400`, `t_utc 20:30`. `get_bet(49)` |
| First ruling YES (median $74,453.48) | CASE-STUDIES.md:128-131 | `BEZLGN6X…` keeper submit outcome YES run 9 (22:54:42Z); `get_bet(49)` notes list the three closes and "median close of 3 venues = 74453.48" |
| Challenge with a 5.005 USDC bond | CASE-STUDIES.md:140; apps/web/tests/fixtures/v1/bet49-testnet.json:287 | `4N3EanAw…` relayed `mt_transfer_call` amount 5005000, msg `{"kind":"Bond","bet_id":49,"round":1}`, log `challenge bet_id=49 … round=1` (22:57:45Z) |
| Challenger paid for the re-run | CASE-STUDIES.md:141 | `9SbiLsiz…` signed by the challenger's implicit account, `request_resolution` deposit 0.0200625 NEAR, log `round=1` (2026-11-12T01:01:00Z) |
| Finalize refused while the challenge was open (7x) | CASE-STUDIES.md:145-151 | 7 keeper finalize txs, each **Failure** "Smart contract panicked: challenge round pending a ruling" |
| Re-judge YES | CASE-STUDIES.md:152 | `AXvXrG32…` submit outcome YES run 10 (01:08:31Z); `get_bet(49)` all_results [(9,YES),(10,YES)], challenged_by = taker |
| Finalize: maker 44.00 USDC | bet49-testnet.json:431-441 | `3hJouvbQ…` (02:13:32Z): 44000000 -> maker, 5000 -> keeper, 1125566 -> fee acct. `get_bet(49)` Settled / YES |

Arithmetic check: deposits 2 x 20.062783 + bond 5.005 = 45.130566 USDC. Paid out: 44.00 + 0.005 + 1.125566 = 45.130566 USDC, so the residue is 0. One of the two keeper requests before the first ruling (`G46nXFbi…`) ended "Execution promise failed … Refunded"; it is in the JSON with that label. Also on-chain but not in the JSON: the challenger's NEAR deposit. The repo does not explain how the bond was split (5.000 to the winner, 0.005 to the keeper).

## 10. nhl-rangers-flames-yes: frz3, bet 51

- **Repo:** CS/CASE-STUDIES.md:34-56; CS/state.json:152 (stake 3e24).
- **Chain, open:** `5eAKRi31…` (relayed) inner `mt_transfer_call` wrap 3017190000000000000000000. Terms `game_winner`, NHL, pick New York Rangers, event 2026020294.
- **Chain, take:** `4fqyezhr…` (log `take bet_id=51`).
- **Chain, request:** `Hx4j44XK…` (keeper, OutLayer 52,611 ms).
- **Chain, submit:** `7aNpEkKG…` (YES, run_no 2).
- **Chain, finalize:** `AWuw15pM…` (2026-11-12T05:52:32Z): 5728260869565217391304348 wNEAR to the maker and 306119130434782608695652 to the fee acct.
- **Chain, `get_bet(51)`:** Settled / YES, used_run_nos [1,2]. Notes "final: NYR 3 - CGY 1; winner NYR" and "17c5 audit disagreed once, agreed on the re-run".
- **Not in the JSON:** the fee-account amount. The repo does not state it, so I left it out.

## 11. noaa-kp-index-no: frz3, bet 54

- **Repo:** CS/CASE-STUDIES.md:60-81; CS/state.json:320.
- **Chain, open:** `BYiUTbeT…` deposit 15085434, stakes 15000000/15000000, claim text "NOAA's official planetary K-index (Kp) for … 21:00-24:00 UTC on 2026-11-11 is 2.00 or higher".
- **Chain, take:** `4m3pjFNW…`.
- **Chain, request:** `9wtoUgtd…`.
- **Chain, submit:** `475L2Lnn…` (NO, run 1).
- **Chain, finalize:** `J9nZnYBe…` (01:47:32Z): 29000000 to the taker and 1170868 to the fee acct.
- **Chain, `get_bet(54)`:** Settled / NO. The raw record quotes `"Kp":1.33` and "GFZ Potsdam independently shows 1.0".
- **Not in the JSON:** the fee amount. The repo does not state it.

## 12. human-referee-knicks-cavaliers-no: frz3, bet 53

- **Repo:** CS/CASE-STUDIES.md:105-116; CS/state.json:245.
- **Chain, open:** `JEJkDC6A…` deposit 10079932, stakes 10000000/10000000, `referee {mode: Human}`, settlement period 24 h, claim "The New York Knicks beat the Cleveland Cavaliers … 2026-11-11".
- **Chain, take:** `CvDgmjPU…`.
- **Chain, ruling:** `DurcUMBC…` (2026-11-12T02:42:03Z) is relayed and signed by the referee's implicit account. Inner `referee_rule {"bet_id":53,"outcome":"NO"}`, log `referee_rule bet_id=53 … outcome=NO`, `mt_transfer` 19000000 to the taker and 1159864 to the fee acct, all in the same tx.
- **Chain, `get_bet(53)`:** Settled / NO.
- **Repo only:** the final score (Cleveland 115-107). The JSON says only "Cleveland won", which also comes from the repo.

---

## Dropped

### Figures flagged as unchecked in the source log

- **run8 (two-asset mutual settle).** Not a requested case, so it was not included. Its txs do exist and succeeded (open `C2k4SH9E…`, take `HFGm1s4e…`, mutual settles `8E3QVDyi…`/`54gPYGSC…`, BTC-bet open `8YZQxMN1…`, take `5SrREPMT…`, settles `AHECRvWi…`/`5uygWuVN…`). The log's figures are partly wrong; see Discrepancies.
- **R3c.** Kept as case 6. The stake (1 USDC per side), both VOID outcomes, all 10 hashes and the refunds are verified by repo and chain. Both causes are now confirmed from the archival on-chain resolver record. One part stays unverified and is worded as such: the claim that a missing `deepseek-ai/` prefix caused the HTTP 400.
- **L1b-1 (first live run of the both-venues sheet, escrow `praetorial-l1b-11071028`, bet 1).** Not included as its own case because case 1 is the same sheet on a later escrow. All five txs were verified: open `Bp6jcnkW…`, take `8p7i26Wa…`, request `FhTjMxBA…`, submit `5HoRvUJy…` YES, finalize `F3iFfaGx…` paying 1980000 to maker1 and 36000 to the fee acct. Its flagged stake is **wrong** in the log: it was 1 USDC per side (deposit 1008000, `get_bet(1)` stake 1000000), not 10.
- **DR5 (human referee, frz2 bet 12).** Not included as its own case because case 12 covers the human-referee path with a cleaner run. All DR5 figures checked out:
  - take `6KZcvsss…` OK;
  - the first ruling `FqawWQJp…` has a failed receipt "Exceeded the prepaid gas";
  - ruling `ARPG1D9T…` paid 5592391304347826086956522 wNEAR to the maker, which equals the README delta (94683276553292934782608704 -> 100275667857640760869565226). It also paid the 135869565217391304347826 tip to the referee and 306059130434782608695652 to the fee acct, matching E/live-DR/DR5/README.md:53;
  - `get_bet(12)` is Settled / YES with 3 wNEAR per side.

  The open tx was never captured (README.md:32), so the DR5 tx list could not have been complete in any case.
- **WT1 (web-built open then cancel, l1b20 bet 2).** Not a requested case, so it was not included. Its txs are verified:
  - refused attempt `9H6eA3Wu…` returned "0" (full silent refund);
  - open `HrNdCLAj…` (log `open bet_id=2`, deposit 1001706);
  - cancel `7H1NJPXq…`;
  - drain_payouts `4QGjwYoe…` refunded 1001706 to maker1.

  The log's "bet 1 details UNKNOWN" is answered at E/live-WT1/README.md:27: bet 1 is the L1b20 bet (case 3).

### Figures dropped from kept cases

- **Case 5:** the mutual-settle amounts for attempt 1 (9.90 USDC to each side, 0.216 to the fee acct). They are on chain, but I found them in no repo file, which only says "Settled / MUTUAL". The 16r bet 2 retry was also dropped: its open, take and request are on chain, but no submit or finalize is recorded.
- **Case 4:** the venue highs (ground truth). They are repo-only.
- **Cases 10 and 11:** the fee-account amounts. They are chain-only.
- **Case 10:** "asked before the game, the AI answered RETRY and set its own next check at 04:30". The chain shows run 1 was used (`used_run_nos [1,2]`, runs_used 2), but neither the repo nor what I read on chain gives the run-1 request tx or its RETRY text.
- **Case 9:** the "minus the second look's compute cost" phrasing. The chain shows the maker received 44.00 USDC = 39.00 + 5.00, the keeper received 0.005 USDC, and the challenger paid the compute separately in NEAR (0.0200625 NEAR deposit). I state only the 44.00 total.

### Cases not used

- **cs1 bet 50** (BTC close >= $74,500, YES) is verified but not requested. Its txs, all OK: `7tprmjHV…`, `BTFy2kBn…`, `AieLw4Tj…` (execution failed, refunded), `5ckULMFc…`, `J5uB9nag…`, `GK4cNFxT…`, paying 49000000 to the maker.
- **cs1 bet 52** (NWS high) is still unresolved (Taken).
- **RFRZ2** human bet: not checked, because cs1 bet 53 already fills that slot.

---

## Discrepancies

1. **L1b-1 stake.** The log says 10 USDC per side; the repo payouts (E/live-L1/live/README.md:22, +1,980,000) and the chain (deposit 1008000) both show **1 USDC per side**. The log's later "10+10 USDC were locked" for L1b bets 2 and 4 is unchecked and probably wrong for the same reason. Bets 2 and 4 are not used here.
2. **"Two 990,000 legs".** The repo READMEs (live, live4, live5) and the results files describe the winner's payout as two 990,000 rows. On chain each finalize makes **one** `mt_transfer` of 1,980,000 to the winner and one of 36,000 to the fee account. The totals agree; only the row/transfer granularity differs.
3. **run16 series.**
   - **Count.** The task brief calls it a "six-fail-safe-VOID series". The chain shows **five** VOIDs (attempts 2-6). Attempt 1 never reached a judge: the OutLayer call failed, the bet stayed waiting, and it was later ended by a 50/50 mutual settle (on chain and in E/live-run16a/results.json:534-539), not by VOID.
   - **Dates.** The log says "~2026-11-05" for run16. Chain block times put every attempt on **2026-11-06**, from 09:07Z to 22:26Z.
   - **Attempt 2 (16f) cause.** The log gives none. The repo (E/live-run16f/results.json:503) and the on-chain notes agree: the Coinbase paged request failed inside the enclave and Kraken returned no candles.
4. **R3e.** The log lists the finalize tx and stake as UNKNOWN. The repo has both (E/live-runR3e/results_finalize.json:5, :39; results.json:180) and the chain confirms them: finalize `3GqTf4fu…`, 1 USDC per side, 1.98 USDC to the maker.
5. **R3c finalize location.** The log attributes the R3c refunds to R3e (`results_fin_old.json`). That is correct as a file location: the two R3c finalizes were run from the R3e directory against the r3c escrow, as the receivers on chain show.
6. **run8.**
   - **USDC bet payout.** The log says maker and taker "each +4,950,000 (two legs)". On chain each side got **one** 9,900,000 transfer. The log's own balance line (3,775,290,000 -> 3,785,190,000) also shows +9,900,000.
   - **USDC fee.** On chain the fee account got 216,000 for the USDC bet.
   - **BTC bet fee.** On chain the fee account got **8,100** BTC units and 108,000 USDC for the BTC bet. The log's "fee 100 BTC units / 100,000 USDC units" leaves out what is probably storage; I did not verify that split.
7. **Challenge bond size (bet 49).** The bond is 5.005 USDC on a 20 USDC-per-side bet, which is not 10% of the stake or of the pot. The docs plan describes the bond as 10%. If the page states a percentage, don't use bet 49 as the example of it. I did not verify the contract's bond formula (minimums and so on).
8. **WT1 bet 1.** The log says UNKNOWN; the repo says it is the L1b20 bet (E/live-WT1/README.md:27).
9. **DR5 first ruling tx.** `FqawWQJp…` reports top-level `SuccessValue`, but the escrow receipt inside it failed with "Exceeded the prepaid gas", so the state was reverted. The repo correctly calls it failed. Anyone checking only the top-level tx status would misread it.
10. **Early-request case (8).** The repo verifier result for this bet is "B4 FAIL: rule gives NO, signed VOID" (E/live-L1/live2/README.md:54, :69). That reads oddly, because BTC was far above $70,000. I did not investigate it; the case only claims the signed VOID and the refunds, which the chain confirms.

## Appendix: every transaction on the Hackathon page, full hash (generated from cases.verified.json)

Each row was confirmed by read-only RPC tx status (endpoint in the last column). Status is the tx outcome: a Failure row is a refusal the case describes (for example, finalize refused while a challenge was open).

| Case | Step | Hash | Signer | Receiver | Methods | Status | RPC |
|---|---|---|---|---|---|---|---|
| btc-both-venues-yes | open | `ESEpUZRCj7djC7xUmFBUfCyDyKQWDfdBRFdMsRWYAS9N` | maker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-both-venues-yes | take | `GEK1mW2WkbMnpXBkPGjWVVcEZE3aa7FugJcvkEi3iZj4` | taker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-both-venues-yes | request_resolution | `9wr6cjWRDtr28c8wM7EF8gDgepbXZdFd7hWmmPzEqM3A` | keeper.praetorial-dev-1101.testnet | praetorial-l1b18-11080038.praetorial-dev-1101.testnet | request_resolution | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-both-venues-yes | submit_outcome | `7hXdtNGAG2TP5vNZ3TDGqi82kyNntSRYWTUaYvW8qvxD` | praetorial-dev-1101.testnet | praetorial-l1b18-11080038.praetorial-dev-1101.testnet | submit_outcome | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-both-venues-yes | finalize | `Bq15gqfX8Ku83Nhbu169ugvHAabYb9RSCGC1TF98q2Pk` | praetorial-dev-1101.testnet | praetorial-l1b18-11080038.praetorial-dev-1101.testnet | finalize | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-one-venue-no | open | `3shnWVupqqLvPBAnjddmLxE79NiftTou4TPbRRRMZZHJ` | maker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-one-venue-no | take | `2ynq9mB5TbNmmQbKnAX3oWztcy2a2dZYvGYMo8ALrjLa` | taker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-one-venue-no | request_resolution | `8MTFoQPk4h8Rsy7w1paRUvVmaZRSeys8s5VmPnQfBi31` | keeper.praetorial-dev-1101.testnet | praetorial-l1b18-11080038.praetorial-dev-1101.testnet | request_resolution | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-one-venue-no | submit_outcome | `HbHwJ2Qa3dx777JQC5TwTsg9q6nCNTBuS5sofEvETozk` | praetorial-dev-1101.testnet | praetorial-l1b18-11080038.praetorial-dev-1101.testnet | submit_outcome | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-one-venue-no | finalize | `FMT1dzDc4See83Ag3EdoUKnQNuCDf9doNogKFp1bAM9y` | praetorial-dev-1101.testnet | praetorial-l1b18-11080038.praetorial-dev-1101.testnet | finalize | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-one-venue-no-code-decided | open | `DfLEvcMWLLWckaCX3ocPSrqriSkD7KC64x3Wzzgd2L2Q` | maker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-one-venue-no-code-decided | take | `2uFLw11E1Cp24Lmm4u7zTz9w1fi2vtA3zhaRiK78tdTq` | taker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-one-venue-no-code-decided | request_resolution | `GmjvD4Sa1jcrhPwhVX6kWqwmj7ZJnrg33fqLJyYT8Wgn` | keeper.praetorial-dev-1101.testnet | praetorial-l1b20-11080132.praetorial-dev-1101.testnet | request_resolution | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-one-venue-no-code-decided | submit_outcome | `9o8gktL2Beu5N3CbHAcQPqRmfoubo3uz8USeK1bdHLNE` | praetorial-dev-1101.testnet | praetorial-l1b20-11080132.praetorial-dev-1101.testnet | submit_outcome | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-one-venue-no-code-decided | finalize | `8DgRHSiAAyx5nWzkFmHjQpnwsBaXsGBb7gTGCxkExif2` | praetorial-dev-1101.testnet | praetorial-l1b20-11080132.praetorial-dev-1101.testnet | finalize | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-touch-75200-no | open (relayed) | `GtURKaDMyR7q6DkhDG6LD3cQi3hCtT8cggvmVe9YsMvG` | relayer.praetorial-dev-1101.testnet | 8941e607b64ff1b0d62ff6e061ce073df75a53a1205852708f965779240981c7 | Delegate, (inner) transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-touch-75200-no | take (relayed, invite link) | `9a4F9pfPopervAJQehwvqXe3EiT1vnwXq2UL4sdtDPCs` | relayer.praetorial-dev-1101.testnet | dfb218d392c303125e63418daf0e0ee61bba500d83fd1dee436f2bd564af32ba | Delegate, (inner) transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-touch-75200-no | request_resolution | `8Xh3N5dsZsNdKcP9bKuWhVWnuGe7a7zxcNgiDHtU9MDU` | keeper.praetorial-dev-1101.testnet | praetorial-frz2-2611091914.praetorial-dev-1101.testnet | request_resolution | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-touch-75200-no | submit_outcome | `ABdWDYZLvTxGWLfjB5fyAifxG5MGN7FBx8yUGoeyT7Vr` | praetorial-dev-1101.testnet | praetorial-frz2-2611091914.praetorial-dev-1101.testnet | submit_outcome | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| btc-touch-75200-no | finalize | `EkMbnyrDyr6s6Nh3iz6JFYdZ7vyLTHeSCmPvx8Wn8Fxv` | keeper.praetorial-dev-1101.testnet | praetorial-frz2-2611091914.praetorial-dev-1101.testnet | finalize | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 1: open refused (settlement period under 1 hour, deposit returned) | `3G3H4zqpTN6o8zUSEmCBZj5H9hcCNRwMUvNZDqMKyeAY` | maker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 1: open | `8miLQLZVJA49tKKfEHVq38cw7nPPuixsk1agG69hBgpn` | maker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 1: take | `BzKNgPYHRJbYAUkrRoNuTmfQVQiVLtzkv9VNbVVyxvYz` | taker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 1: request_resolution (compute call rejected, bet left waiting) | `6U8HN1hWiESqhfVgZFna3MMCHcVMYB438EoLu9jCnKEJ` | keeper.praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | request_resolution | SuccessValue (with a failed receipt) | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 1: mutual_settle (maker) | `CZv3hfUxCqjp7TfUmMXZzmoxJDXHBDQExfsABgc7L7Yw` | maker1.praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | mutual_settle | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 1: mutual_settle (taker, pays out 50/50) | `3SZ4x8Nrt1VBUA2fcs619AqvkUfsbGpkj7rgtMM1sHUH` | taker1.praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | mutual_settle | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 2: open | `CBL4HKLYWJmf6rF4NNZMrdd1m1TLFq8tj9x11RvUbqGY` | maker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 2: take | `D8qENQU7LoeuVsqiMwJqzFaLHTbskHS4zC7QCmZyULTU` | taker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 2: request_resolution | `H2QUZSvFme65vYekU3UMKP7cs1NiVRLfYqiRfzaREnMK` | keeper.praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | request_resolution | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 2: submit_outcome (signed VOID) | `HTa3fvXyr6SWdxnBgURvyRmtDpsKs2cZFJUBV3w38sH3` | praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | submit_outcome | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 2: finalize (refunds) | `4hKJkMaMd5j5GuQEg6XyJzQqBbxiXY24nsKiMUorkj5r` | praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | finalize | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 3: open | `G9jgEPuFDDPsfXMx2jXNWSPVPZjPYPJWU1TL5X7q3XrN` | maker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 3: take | `61TpCq4Dve8RukcyhiNvyLVHs8HMkRRqNw3uacK8x66g` | taker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 3: request_resolution | `GH8AXxPm9KYGL8v2tTiNb19QTMvxbtF2iMRpFB6G3ewm` | keeper.praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | request_resolution | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 3: submit_outcome (signed VOID) | `2ULysccBa6jKiGQpCiHbMF91VXniZJFaFEoTLzFbdxy3` | praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | submit_outcome | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 3: finalize (refunds) | `92dvUhfpvKJGUDAXnCcWaeZH6CSBaew8H9MdgZimwGjQ` | praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | finalize | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 4: open | `FhMCDJoNVXQ13RKmqb5HgysZqNdAysvjBKVdzP9s5D2x` | maker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 4: take | `F4DV8MDFC9pTSrCJ5Tu2QvMmZhX461GZXeWcGkfHWFwj` | taker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 4: request_resolution | `GWscpAfnAkaNADVMcZGJwRoq1sX9QHxifDroAYn53mEA` | keeper.praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | request_resolution | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 4: submit_outcome (signed VOID) | `BdnGmyFFUeCdJBuhgz9Aj1CVC89hd7EzkjB23qiBmyB4` | praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | submit_outcome | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 4: finalize (refunds) | `qqS5QxAjKDQGqwdZm67aFBt4qbfUmQdmdEfCjyeMTSD` | praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | finalize | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 5: open | `8vX83mPfeV7FSBDAtmuHxJYgv4ddwVfaNJhgdLtCLHMb` | maker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 5: take | `8G9QE8MCnc4TcvxonYepVpF4SvPLwtHEaxaiQdREitaW` | taker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 5: request_resolution sent too early (rejected, nothing spent) | `kcPzKk2z8XCtyysRsuy9kXsnBZqFapxVed7qwUrNYrj` | keeper.praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | request_resolution | Failure | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 5: request_resolution | `HeHAeDr5s1adGoT1eKWxqGD22U3voKsQcAonDSb9C885` | keeper.praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | request_resolution | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 5: submit_outcome (signed VOID) | `DJfmoh1sG8ySVrvrvEXGNvxCaFbtwxin8kqwj3k8DfV2` | praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | submit_outcome | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 5: finalize (refunds) | `GXbJnf33hr7ZMqAeCp8YDr8mXXTFqytroNREL9gR8YVF` | praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | finalize | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 6: open | `na4wNvSRkXcXiZBVSm9SnNmrqLkbsmPpk8tAk1478ZR` | maker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 6: take | `Hw2abMMQhbiWAc3DMvbJJJ9FnZFg6hTLbSgcjALqqf4H` | taker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 6: request_resolution | `HzL3FcPDUzMEmPUF7vum6yxntGrwaniLpSvcQdmm7FwS` | keeper.praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | request_resolution | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 6: submit_outcome (signed VOID) | `62iunA47NrfL8obVwRxfpZu4Km2DUNecBny48T5FygRP` | praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | submit_outcome | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| fail-safe-void-series | attempt 6: finalize (refunds) | `6vrWzt9TjNvZj4B2x1op5yTavt1wm7vGr62C64fDxMhZ` | praetorial-dev-1101.testnet | praetorial-e2e-2611052236.praetorial-dev-1101.testnet | finalize | SuccessValue | https://archival-rpc.testnet.near.org (EXPERIMENTAL_tx_status) |
| knyc-weather-void | bet 1: open | `7rRBaqCXGUeWVxw5mLNk7Q4oNBq2Vv7Yf9gQFFfQTH1k` | maker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| knyc-weather-void | bet 1: take | `96svmDTQPd2CFFRZ8w56ejh8ji7YLrSBiGe5kyjG2DE9` | taker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| knyc-weather-void | bet 1: request_resolution | `EmsrceCtbyjxBd2iE4BgGX5MD9VHFgQta1zbAWny3Gpd` | keeper.praetorial-dev-1101.testnet | praetorial-r3c-11061912.praetorial-dev-1101.testnet | request_resolution | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| knyc-weather-void | bet 1: submit_outcome (signed VOID) | `7Xj7Gpn1Gd7FiV8YdZHE2nNrvfo13SxQMmNwrMNy9ppL` | praetorial-dev-1101.testnet | praetorial-r3c-11061912.praetorial-dev-1101.testnet | submit_outcome | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| knyc-weather-void | bet 2: open | `9jxQe421uLrq8SoRfjF35XiYy81HFBJWCHPMddT4VMuN` | maker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| knyc-weather-void | bet 2: take | `HCrpYsAo8cqNm9hbB3s5tQmhejNKEmeYR4GTXhMpfFjZ` | taker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| knyc-weather-void | bet 2: request_resolution | `RxsgsWYCacvQoEBFKHJLehRTS4HAg8hpb59w3pKtXir` | keeper.praetorial-dev-1101.testnet | praetorial-r3c-11061912.praetorial-dev-1101.testnet | request_resolution | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| knyc-weather-void | bet 2: submit_outcome (signed VOID) | `3Fk45PYFXqjLNk1PkxZxwtz7ZMmBQ1d2ww3WzLg1sRRd` | praetorial-dev-1101.testnet | praetorial-r3c-11061912.praetorial-dev-1101.testnet | submit_outcome | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| knyc-weather-void | bet 1: finalize (refunds) | `AsBnfX8UUBVLEbTLHeh4ERbQCNSiaFKQ8Dx4EqEbjVwU` | praetorial-dev-1101.testnet | praetorial-r3c-11061912.praetorial-dev-1101.testnet | finalize | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| knyc-weather-void | bet 2: finalize (refunds) | `8MKNnVYuh7jq13xpr12CfNpuDoenMu4b7neFJfGiUCzP` | praetorial-dev-1101.testnet | praetorial-r3c-11061912.praetorial-dev-1101.testnet | finalize | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| knyc-weather-yes | open | `1YzMF88PbhF6d9bL8z77qsLCcwjYrTqUZ2SSfNtGuM6` | maker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| knyc-weather-yes | take | `GZx661W5vrxAAC72bwDQ56d2W16RkVHNzaLFBhwKXkfj` | taker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| knyc-weather-yes | request_resolution sent too early (rejected) | `23khKvNVWRQ7Q2zFakEXfAPftqbrSrooWZkg2f6pHrNq` | keeper.praetorial-dev-1101.testnet | praetorial-r3e-11062012.praetorial-dev-1101.testnet | request_resolution | Failure | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| knyc-weather-yes | request_resolution | `Cc9de2MwGHthBaMoBpSRN1yNoty5WfQJhRvRa6Ao5Quq` | keeper.praetorial-dev-1101.testnet | praetorial-r3e-11062012.praetorial-dev-1101.testnet | request_resolution | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| knyc-weather-yes | submit_outcome | `6MDRMMho5N18xGHFAH1nVrzzjUXe7SWEHL343mbPv3r4` | praetorial-dev-1101.testnet | praetorial-r3e-11062012.praetorial-dev-1101.testnet | submit_outcome | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| knyc-weather-yes | finalize | `3GqTf4funbFVN45jWcp9sAAKMVhhBBCvRA54yEnqXU37` | praetorial-dev-1101.testnet | praetorial-r3e-11062012.praetorial-dev-1101.testnet | finalize | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| early-request-void | open | `A5sXF2f8bdosiUmLFwQhyg8cZi6XrcfhHTfaRBjuRhyB` | maker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| early-request-void | take | `EnHybVBfHmKqzzTAdXZGunZxjZSJbY1yXNgaSGcNDozb` | taker1.praetorial-dev-1101.testnet | intents-mock.praetorial-dev-1101.testnet | transfer_with_msg | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| early-request-void | request_resolution | `9jAeCBxWQey6qH7v7DepCK6QnprDxKv4p2JXDG2jdU4D` | keeper.praetorial-dev-1101.testnet | praetorial-l1b5-11071226.praetorial-dev-1101.testnet | request_resolution | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| early-request-void | submit_outcome (signed VOID) | `6HZKRKjmRFum1nnnKPnDDqR1tJZybXfvgUKqas15Tr5X` | praetorial-dev-1101.testnet | praetorial-l1b5-11071226.praetorial-dev-1101.testnet | submit_outcome | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| early-request-void | finalize (refunds) | `CRtqenLXb5xxANvj2KHPBtAgwLqgCCg2htt6Ar8FTzBV` | praetorial-dev-1101.testnet | praetorial-l1b5-11071226.praetorial-dev-1101.testnet | finalize | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| challenged-btc-close-rejudged | open | `3FtMzC9DoXPPGR8rbPLwLDMZAXy19Fgg5FYqL6G3qbDk` | relayer.praetorial-dev-1101.testnet | 979f2614c265b2dfacbde2628b66979c26afac83ba2f98f826a010aaab8eba7d | Delegate, (inner) mt_transfer_call | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| challenged-btc-close-rejudged | take | `7efBWmGaEkYfh5MNgmpETubm7th2cZbmckAV4X6L6N3P` | relayer.praetorial-dev-1101.testnet | 371f9add3a51c946173fafd90dac5c6a0da149bf7f4ddc03f3b5fe6268bc0488 | Delegate, (inner) mt_transfer_call | SuccessValue | https://archival-rpc.testnet.near.org (EXPERIMENTAL_tx_status) |
| challenged-btc-close-rejudged | request_resolution (compute run failed, nothing decided) | `G46nXFbipCyvY1dkkKNsUn4s8pJX8ZWjg5Wo5RiRUA39` | keeper.praetorial-dev-1101.testnet | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | request_resolution | SuccessValue | https://archival-rpc.testnet.near.org (EXPERIMENTAL_tx_status) |
| challenged-btc-close-rejudged | request_resolution | `HzwRD7YhJJdckHe99kdTAtmhCjea56ZtwNNLwtG2pHcz` | keeper.praetorial-dev-1101.testnet | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | request_resolution | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| challenged-btc-close-rejudged | submit_outcome (first ruling YES) | `BEZLGN6Xi76fCiYyKNQrv3izZpFJYeV3v7e8NmW1jo3J` | keeper.praetorial-dev-1101.testnet | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | submit_outcome | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| challenged-btc-close-rejudged | challenge bond (5.005 USDC) | `4N3EanAwrJ4yStku1fwovW1UeVC5aTfyHnuHyGVHjwKW` | relayer.praetorial-dev-1101.testnet | 371f9add3a51c946173fafd90dac5c6a0da149bf7f4ddc03f3b5fe6268bc0488 | Delegate, (inner) mt_transfer_call | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| challenged-btc-close-rejudged | request_resolution for the challenge round (paid by challenger) | `9SbiLsizpBHSGnnragbY5Z8porbzpnZtWggaYfKPLG6j` | 371f9add3a51c946173fafd90dac5c6a0da149bf7f4ddc03f3b5fe6268bc0488 | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | request_resolution | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| challenged-btc-close-rejudged | finalize refused (challenge round pending a ruling) | `7bCmfPymqTzkuuzs4ddTb6YRui2SEiasusNSXejctRw` | keeper.praetorial-dev-1101.testnet | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | finalize | Failure | https://archival-rpc.testnet.near.org (EXPERIMENTAL_tx_status) |
| challenged-btc-close-rejudged | finalize refused (challenge round pending a ruling) | `fJ7LNwZAHHydz61wee2B66GSQdCTgPv3hPEWPm8PdBS` | keeper.praetorial-dev-1101.testnet | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | finalize | Failure | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| challenged-btc-close-rejudged | finalize refused (challenge round pending a ruling) | `FEWawn7qeGn3583zoHtxpW9z7Q7MkvP7XWRnLWNaFqP2` | keeper.praetorial-dev-1101.testnet | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | finalize | Failure | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| challenged-btc-close-rejudged | finalize refused (challenge round pending a ruling) | `9f3P45RCVK6Df6wnhe4992ZNSQHBM4pkCv37hhT51fdq` | keeper.praetorial-dev-1101.testnet | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | finalize | Failure | https://archival-rpc.testnet.near.org (EXPERIMENTAL_tx_status) |
| challenged-btc-close-rejudged | finalize refused (challenge round pending a ruling) | `96Lyg7qAJqG2HQZU3BDqX5gyhWdV8eb7yUGd2No86TpZ` | keeper.praetorial-dev-1101.testnet | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | finalize | Failure | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| challenged-btc-close-rejudged | finalize refused (challenge round pending a ruling) | `83MzTgWDHDfeKYbuUghZ26UEXDmg6fCFwrTd1ZU6fhC2` | keeper.praetorial-dev-1101.testnet | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | finalize | Failure | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| challenged-btc-close-rejudged | finalize refused (challenge round pending a ruling) | `AoroPXs2aNggLg17ASab8jmUu3xyPNKfS9JVZk1k2i7s` | keeper.praetorial-dev-1101.testnet | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | finalize | Failure | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| challenged-btc-close-rejudged | submit_outcome (re-judge ruling YES) | `AXvXrG32NxybxRhrxCWBBVCipWG99PhvDsN8t5WqvJ7m` | keeper.praetorial-dev-1101.testnet | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | submit_outcome | SuccessValue | https://archival-rpc.testnet.near.org (EXPERIMENTAL_tx_status) |
| challenged-btc-close-rejudged | finalize | `3hJouvbQA5vQQGxX1FazaNUgRmxS3CbyGpv63CXJynaK` | keeper.praetorial-dev-1101.testnet | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | finalize | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| nhl-rangers-flames-yes | open | `5eAKRi31QSBNnTT9UNpgDfekGYN6CDNJxXA3jJaQUmWh` | relayer.praetorial-dev-1101.testnet | d958ba3746c645862caab72d8fa4b98c9fe932458bba1f0115e968d8a96dfcf9 | Delegate, (inner) mt_transfer_call | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| nhl-rangers-flames-yes | take | `4fqyezhrBFWyafRuKrsqQL4x9wLztUwghQ6XcahEGwcX` | relayer.praetorial-dev-1101.testnet | 979f2614c265b2dfacbde2628b66979c26afac83ba2f98f826a010aaab8eba7d | Delegate, (inner) mt_transfer_call | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| nhl-rangers-flames-yes | request_resolution | `Hx4j44XKf53y3cqGvduoKBFFJe9VWYj7jz7ED8reHzxW` | keeper.praetorial-dev-1101.testnet | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | request_resolution | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| nhl-rangers-flames-yes | submit_outcome | `7aNpEkKGxNENeZiTvVkZnxwp5djUXAKVenQuhcb8S43x` | keeper.praetorial-dev-1101.testnet | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | submit_outcome | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| nhl-rangers-flames-yes | finalize | `AWuw15pMesnizXokiEdTwejtESBmJmaNhyeFhymJgLR` | keeper.praetorial-dev-1101.testnet | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | finalize | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| noaa-kp-index-no | open | `BYiUTbeTrB3UsMcvD35s8mCbFEikLQQcnfy89jZUGdmk` | relayer.praetorial-dev-1101.testnet | 371f9add3a51c946173fafd90dac5c6a0da149bf7f4ddc03f3b5fe6268bc0488 | Delegate, (inner) mt_transfer_call | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| noaa-kp-index-no | take | `4m3pjFNWWa4btqNbTg3yy5PH41ojg57ut9UPiPVHm1jZ` | relayer.praetorial-dev-1101.testnet | 4b6d883c759b2d60706c926b9c079307b12d9fba5e8ff308ffcdfae7966153a5 | Delegate, (inner) mt_transfer_call | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| noaa-kp-index-no | request_resolution | `9wtoUgtdtikT2ryHPyJJyRmAArqbPgvmbuoLikb7fY65` | keeper.praetorial-dev-1101.testnet | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | request_resolution | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| noaa-kp-index-no | submit_outcome | `475L2LnnHzJhhtmWUJr2Lt1gxKt727tD5rVCvhBHTcX8` | keeper.praetorial-dev-1101.testnet | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | submit_outcome | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| noaa-kp-index-no | finalize | `J9nZnYBeivSPHXQZAZwDAUu78xRgGkrx2fYJPnSwJ5sN` | keeper.praetorial-dev-1101.testnet | praetorial-frz3-2611100414.praetorial-dev-1101.testnet | finalize | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| human-referee-knicks-cavaliers-no | open | `JEJkDC6AMp62doWy3yvt5qRenVjw2dPCD34Y7PkAusNR` | relayer.praetorial-dev-1101.testnet | 4b6d883c759b2d60706c926b9c079307b12d9fba5e8ff308ffcdfae7966153a5 | Delegate, (inner) mt_transfer_call | SuccessValue | https://archival-rpc.testnet.near.org (EXPERIMENTAL_tx_status) |
| human-referee-knicks-cavaliers-no | take | `CvDgmjPU6NMhBjMTP5qtGAUk3bJUviiLbVSHvibak2jM` | relayer.praetorial-dev-1101.testnet | 371f9add3a51c946173fafd90dac5c6a0da149bf7f4ddc03f3b5fe6268bc0488 | Delegate, (inner) mt_transfer_call | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
| human-referee-knicks-cavaliers-no | referee_rule NO (pays out) | `DurcUMBCHfeGBH3X2duvEDwz8q4dcXbqeEtCvy3DDATQ` | relayer.praetorial-dev-1101.testnet | c518ba4659cc7a906098246f477f9dc31b0c352f0694e5daf46c842893894a13 | Delegate, (inner) referee_rule | SuccessValue | https://archival-rpc.testnet.fastnear.com (EXPERIMENTAL_tx_status) |
