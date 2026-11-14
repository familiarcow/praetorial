# L1b20 live5: audit-path (D-JUDGETIME1b / L1b19) confirmed live

Fresh escrow `praetorial-l1b20-11080132.praetorial-dev-1101.testnet` (code hash ba96b2ae..e148, main 2a33bb1 build reused from live4), bound to resolver record-0723fe2 (wasm 4b9d937286061cf2ab685bc5c0bc54dde6d5d8ef8d8a01f36b9752718157aa50, reproducible docker `run` build re-run today: sha matches the record). NEAR AI secret bound to that hash (profile praetorial-resolver). Pins: outcome_pubkey f5572c37.. (escrow report-pubkey `public_key`), attest_pubkey 1ef96f5f.. (attest1 report-pubkey `attest_public_key`). Bet 1 = terms_jason_bitstamp_only_no (window 2026-11-07 04:00-06:00Z, ~19.5 h old; Kraken out of retention).

| step | tx |
|---|---|
| create account | 65vRFY227RbgVeT3W2TgC2o9r2GtTDHTTHEUjiYSvPTW |
| deploy escrow (first attempt, 1st) / deploy | CgYxvFZfT49Mswwzg5gxEA7cfjtTtex3EAWF4d6LZmEk / v4MZpV2PZDJFZrjFdKSZaqpoeMqwD2evY7hJX5Mx4PR |
| new() | FL54WGKUDB2RWQC9jQuhQc9wUCD2aRL6VdzvkZnYUZkc |
| keeper credit top-up | HyshS6mfHCcDryudVDsUnJzQyn7ZGyxShwnfevMa5aQ1 |
| resolver upload chunks 1-4 | CYQYYvGjeo2tgmoNa2Eeqr6enYo3FHKmoucDT5y9TiDW, 37HqaiQDUHr7xSzgmvNfiWb97eH8kLVtwYHXj1Mo47CR, GKM3sYsmLTiA42LUtq6pMwFALZqyVUAsgRUw9WVodB1Y, 3kdWf8CCHFZPLxXEbN22zVSTpHH6nZcLfq2J6qkMGPix |
| report-pubkey escrow / attest1 | uAh6ujuVHncr7CmcZwg1jAjsuCpaWruWjbHbdNDjfRk / dK3Y4fKx8Z4mV79brXnx46AByBUR8EZfcRLc4AmZJPq |
| sourcecheck (attest1) | 4gZsnzngVKeE76c34CC9hneFuLoyxUqab9PB9PyXKVY1 |
| open / take | DfLEvcMWLLWckaCX3ocPSrqriSkD7KC64x3Wzzgd2L2Q / 2uFLw11E1Cp24Lmm4u7zTz9w1fi2vtA3zhaRiK78tdTq |
| request_resolution | GmjvD4Sa1jcrhPwhVX6kWqwmj7ZJnrg33fqLJyYT8Wgn |
| submit_outcome | 9o8gktL2Beu5N3CbHAcQPqRmfoubo3uz8USeK1bdHLNE |

## Result
- Outcome **NO**, signed, run_no 1, status Proposed (settlement window ends 2026-11-08T02:39:15.102Z, after this item's time limit).
- Audit path used. Notes: `D-JUDGETIME1 (B): the price gate decided NO from complete venue coverage; the model audits it (short prompt) instead of judging`, `17c5 audit agrees with the code outcome NO`, `D-BUDGET1: calls_ms=[] rerun=false`; Kraken `EXCLUDED, COULDNT_CHECK`; Coinbase + Bitstamp 120/120 candles COMPLETE. `judge_ran:false`, `runs:1`, one run_diagnostics entry `{"audit":"agree"}` (DeepSeek-V4.1-Flash-1017, first_byte 1050 ms, total 1857 ms, HTTP 200).
- Timings: OutLayer execution time_ms 6617; request_resolution tx to result delivered ~15 s (first poll). Funding-deadline wait (139 s) is not part of delivery.
- Verifier (`verify_bet1.txt`): 7 PASS, 0 FAIL, 3 SKIP (E4 offline, B4 partial, B5 no finalize yet).
- Abnormal (not a bug in outcome): run_diagnostics shows `signature_verified:true` but `verify_result:"invalid"`, `verify_reason:"not verified"` (signer not bound to NEAR AI attestation; same B4 PARTIAL as before).

## Finalize
`resume_finalize.sh`: run from this dir NOT BEFORE 2026-11-08T02:39:16Z (settlement window end 02:39:15.102Z). It finalizes bet 1 and runs the verifier.

## Finalized (L1b20f, 2026-11-08T02:40Z)
`resume_finalize.sh` run at 02:39:56Z+. Finalize tx `8DgRHSiAAyx5nWzkFmHjQpnwsBaXsGBb7gTGCxkExif2`: Settled, outcome NO.

| account | payout | expected |
|---|---|---|
| taker1.praetorial-dev-1101.testnet (winner) | +1,980,000 USDC units (2 x 990,000, done) | +1,980,000 (pot 2,000,000 - 20,000 fee) |
| fee.praetorial-dev-1101.testnet | +36,000 (2 x 18,000: fee + storage; 20,000 fee + 16,000 storage) | +36,000 |
| maker1 (loser) | 0 | 0 |

Escrow pending 0, residue 0. Verifier (`verify_final_bet1.txt`): 8 PASS, 0 FAIL, 2 SKIP (E4 offline, B4 partial). B5 and B6 now PASS. NEAR balances before/after in `bal_before.txt`/`bal_after.txt` (dev account 7.673 -> 7.671 gas). Nothing abnormal; same shape as live4.
