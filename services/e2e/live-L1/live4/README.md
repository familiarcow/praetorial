# live4 (L1b18, 2026-11-08 00:38Z-, testnet): both Jason forms on a fresh escrow, resolver record-6d8fd4c

Escrow `praetorial-l1b18-11080038.praetorial-dev-1101.testnet`, escrow wasm (main 66fbdf7, stripped, `contracts/escrow`) sha256 `ba96b2ae35796c1f28b309e25b8a9961d9f20a10aa5f1b98ca14531e79c6e148`.
Resolver wasm sha256 `b471d7e34ecbd56d0e1d3d0238dae488e1e268832ab30c132cdd42ad1bb800b2` (record-6d8fd4c; the reproducible artifact `scratch/rb16/run1/module.wasm`, hash equal to the record) uploaded to FastFS (`upload.log`), NEAR AI secret bound to that hash (`bind_secret.log`).
Scripts copied from `../live3/` (config/bind_secret/ol_login paths re-pointed; open_take ATTEST1 pin updated).

## Setup txs
| Step | tx |
|---|---|
| create_escrow_account (6 NEAR) | `5yio6LWqjp6hfqLbJtodjCkquvcEgafNMa3BRwCUBU2a` |
| deploy_escrow | `3gjjGpMXZenxrRBRmoqKHJP8uTZSWNCT3nDvbJB8iL6v` |
| escrow_new | `8kAW8xrpz3jux9CrgJapNTxLGKa2EJxxoCWrTpCkb9EM` |
| topup_keeper_credit (0.15) | `AcLQTzi3hyecSB4o1A9n7iFEzwjdeep8zevohckT9ed1` |
| report-pubkey (D-KEY2) escrow / attest1 | `7SKEqcTPiPWcSiNMNqyQAB41jsjvwpC9p6CmsU1nvASQ` / `Ckcbedp8DSvbLpNkFJHc6EVnmGATfpofr5GyW52YdeAy` |
| upload chunks 1-4 | `FxEwURYMTVf4jExQDrWYgrkroB1Jpi6EfEuhAr9LQTFx`, `GbWeyzmXyEsPpPJsdSgGEZ2hArrkyUSiKJNehcapfFW9`, `B1REuVBoHUqbcf8LPEvtQM7LhAtcixU58NxfmpeBqrr6`, `YCFqKoUMG1vN8nFXVoWBbMsFPzfrd9bHeexbqFafjGu` |

Pins: outcome_pubkey `8aa74b57...` (escrow report-pubkey `public_key`), attest_pubkey `d09e11c6...` (attest1 report-pubkey `attest_public_key`).
**Operator slip (cost ~0.00 NEAR, recorded for honesty):** the first init used attest1's `public_key` (`3fe8eb30...`) instead of `attest_public_key`; sourcecheck then mismatched, no bet was opened. `new()` has no setter, so the first escrow was deleted (`delete_escrow_wrong_attest_key` `Hg4EcdYDjFuRBHAbj2tg3DEtgdTQt5G1GSheRyKcscSP`, balance refunded to operator) and the same name recreated. Superseded txs: create `EVW1Sn1F2a1hGXpx3xN8Md43Uwf8rxLNydjVyyqFFR8K`, deploy `2D9BBoJeNqAjcve9tZzr2WSuCNFrzQgw3q9Q8d12JfWo`, new `GEyA9NnBDW6VM7gp9nesysqgrykADemx3ue8sLK8Zyjt`, topup `19z41uRHqxjpZxdxQEAAdxPDGt426XF4TJvBs7QAzA2` (`results_attempt1_wrong_attest_key.json`). The verifier correctly ignores the deleted incarnation.

## Bets (stake 1.000000 USDC each side, settlement_period 3600 s, resolve_deadline open+30 d <= 365 d (H1))
| | Bet 1: both-venue YES (past window 04:00Z-06:00Z 2026-11-07) | Bet 2: one-venue NO (`jason_bitstamp_only_no`) |
|---|---|---|
| claim | BTC-USD 1-min high >= 75,948.00 on BOTH Coinbase and Bitstamp in the same 5-min bucket by 2026-11-07T06:00Z (terms from L1b3, `terms_jason_same_bucket_yes.json`) | same sheet, level 75,951.00 (reached on Bitstamp only; Coinbase max 75,950) |
| sourcecheck_attest1 | `48vtpoiPiRso4D1SaiFzDUAG55QHjTXp6KfxiNmAB9Uk` | `9EssamVK3zZkX18ejmgQDMNLfNxRXTmSxdRi5e9qMPDS` |
| mint maker / taker | `B6JUCkwn...` / `J9Te9UwY...` (full hashes in `results_*.json`) | `HJReftw2...` / `FgTQc65s...` |
| open | `ESEpUZRCj7djC7xUmFBUfCyDyKQWDfdBRFdMsRWYAS9N` | `3shnWVupqqLvPBAnjddmLxE79NiftTou4TPbRRRMZZHJ` |
| take | `GEK1mW2WkbMnpXBkPGjWVVcEZE3aa7FugJcvkEi3iZj4` | `2ynq9mB5TbNmmQbKnAX3oWztcy2a2dZYvGYMo8ALrjLa` |
| request_resolution | `9wr6cjWRDtr28c8wM7EF8gDgepbXZdFd7hWmmPzEqM3A` | `8MTFoQPk4h8Rsy7w1paRUvVmaZRSeys8s5VmPnQfBi31` |
| result delivered (poll, from request tx send) | +61 s | +111 s |
| judge calls (D-BUDGET1 `calls_ms`, 2 models in parallel) | 18422 / 30183 ms | 22274 / 73862 ms |
| judge path | **full judge** (evidence verdict answers, `judge_ran` true) | **full judge**, NOT the audit path (see FINDING.md) |
| submit_outcome | `7hXdtNGAG2TP5vNZ3TDGqi82kyNntSRYWTUaYvW8qvxD` -> Proposed **YES** | `HbHwJ2Qa3dx777JQC5TwTsg9q6nCNTBuS5sofEvETozk` -> Proposed **NO** |
| verifier (`verify_pre_finalize_bet*.txt`) | 7 PASS / 0 FAIL / 3 SKIP (E4, B4 partial, B5 pre-finalize) | 7 PASS / 0 FAIL / 3 SKIP (same) |
| settlement window ends | 2026-11-08T01:47:52Z | 2026-11-08T01:47:58Z |
| finalize | `Bq15gqfX8Ku83Nhbu169ugvHAabYb9RSCGC1TF98q2Pk` (2026-11-08T01:50:01Z) -> Settled YES | `FMT1dzDc4See83Ag3EdoUKnQNuCDf9doNogKFp1bAM9y` (01:50:16Z) -> Settled NO |

Winners expected: bet 1 YES -> maker1 (+1,980,000 USDC base units), bet 2 NO -> taker1 (+1,980,000); fee account +36,000 each; escrow residue 0. NOT yet observed on chain (B5 SKIP).
Both outcomes correct, signed, no VOID, no stuck funds (stakes held in escrow until finalize).

## Finalize follow-up (do not run before 2026-11-08T01:48:00Z)
`cd services/e2e/live-L1/live4 && sh resume_finalize.sh` (runs `finish.mjs finalize` for bets 1 and 2, then `verify-bet` on each -> `verify_final_bet{1,2}.txt`; fill payouts from `results_*.json`).

## Testnet NEAR
Wallet total (operator+keeper+attest1+maker1+escrow) 12.953 before (incl. 9 NEAR faucet top-up) -> 12.882 after: ~0.07 NEAR consumed. ~6.0 NEAR remains parked on the escrow account (account funding, recoverable by delete) and 0.15 as keeper credit.

## Finalize result (L1b18f, 2026-11-08 ~01:50Z, `finalize_run.log`, `verify_final_bet{1,2}.txt`)
Ran `sh resume_finalize.sh`; `finish.mjs` finalized and drained payouts (all 4 payout rows per bet `done`). Verifier final: **8 PASS / 0 FAIL / 2 SKIP** on each bet (SKIP = E4 offline, B4 partial); B5 now PASS.
| USDC base units (mt_balance_of on Intents) | before | after | delta | expected |
|---|---|---|---|---|
| maker1 (bet 1 winner) | 3,890,768,000 | 3,892,748,000 | +1,980,000 | +1,980,000 |
| taker1 (bet 2 winner) | 3,710,347,000 | 3,712,327,000 | +1,980,000 | +1,980,000 |
| fee account, bet 1 / bet 2 | 2,792,000 / 2,828,000 | 2,828,000 / 2,864,000 | +36,000 / +36,000 | +36,000 each |
| escrow | 4,032,000 | 0 | -4,032,000 total (2,016,000 per bet; both bets paid out) | residue 0 |
Pending payouts 0, residue 0. The 36,000 fee-account credit = 20,000 fee (1% of 2,000,000 pot) + 16,000 storage (verifier B5: "fee + 16000 storage"; payout reason `fee_and_storage`); winner = 2,000,000 - 20,000 = 1,980,000 (paid as two 990,000 legs). Escrow held 2,016,000 per bet (2,000,000 pot + 16,000 storage) and paid out exactly 1,980,000 + 36,000; no discrepancy.
