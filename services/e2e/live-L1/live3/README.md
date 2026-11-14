# L1b11: fresh-escrow rerun on current main + resolver record-7683e0f (testnet, 2026-11-07 ~20:30-20:50Z)

**Status: PARTIAL.** Setup complete; bet A (Jason one-venue NO) failed to produce output 3/3 on the new resolver (open finding); bet B (close_above) is opened+taken but T is 21:39Z (see below), so its early/late requests are **resume steps** (`resume_resolve_and_finalize.sh early1` / `late1` / `finalize_b`).

Escrow `praetorial-l1b11-11072031.praetorial-dev-1101.testnet`; escrow wasm sha256 `a240f3632e956d5eac45c2965b8fdc85b5b2aa17656d00b37bd2eb3e68afbf97` (main 79c4bd4, stripped, rebuilt reproducibly-equal to live2's; verifier E1 PASS). Resolver wasm `2576b08ecd329f83f14179cd8d0c25733610a9c8859ebe80a36f5a462c05b773` (record-7683e0f): rebuilt with `resolver/release/build_reproducible.sh 7683e0f run ...` (colima amd64 image), hash verified equal BEFORE upload, uploaded (`upload.log`), secrets bound to that hash (`bind_secret.log`), D-KEY2 report-pubkey for escrow (`report_pubkey_outcome.log`, first attempt `*_attempt1.timeout.log` = OutLayer RPC timeout, retry OK) and attest1 (`report_pubkey_attest1.log`). Init per D-MN1 testnet settings (`3_deploy_init.mjs`): outcome pubkey `1ba26572...`, attest pubkey `b92575a2...`. Expectations: `EXPECTATIONS.md` (written before the first request_resolution).

**Setup mistake (mine, recorded):** the first `new()` was given the attest1 run's `public_key` (accc1a86...) instead of its `attest_public_key` (b92575a2...). The escrow cannot be re-initialised, so I deleted the account (funds back to the operator, tx `EgaXng...`) and recreated it under the same name with the right key. Consequence: the verifier's E2 reads the *first* `new()` in the account's tx history (the deleted instance) and reports `FAIL E2 attest_pubkey: pinned view b92575a2... != new() arg accc1a86...`. That is a false FAIL caused by the account-name reuse (the live view and the new live `new()` agree); not weakened. Possible verifier hardening (LOW): use the newest `new()` after the latest deploy.

Setup txs: create `FtxJttQ6...`(deleted instance), deploy `25h13hqm...`, new(wrong) `GaAzVHEL...`, topup `6WT88Z8V...`, delete `EgaXngJs...`; live instance: create `5juwKC7Rmy7vcZuvRmPx1hckHnkHjHy2WzZFZKByidLK`, deploy `H7UW6oFnSuzWM5KscSNZnJdw7MWGWi5thVNidFZFgPrW`, new `Ax6Xd9RauWAqjAvpevfUN4fRvpAEFTAZyVDHZRKoHH5N`, topup_keeper_credit `DN55tjqLgXXcV32zsAroX5BNvggeh9CDtMYs6NH4REX3`. Report-pubkey: escrow `8nzjGPpuERxcAxZe7uDnwSnxdhxzU4ojT4dj6rHC3XhS` (attempt 1 timed out at the RPC, no tx hash), attest1 `2sN8SxCeprazovMGusBugf59Srd1CSJ1BFKB7RVL8zAg`. Upload chunks in `upload.log`.

## Bet A: bet id 1, jason_bitstamp_only_no (live2 bet 3's sheet)
- Claim: Coinbase AND Bitstamp 1m highs >= 75951 in one 5-min window before 2026-11-07T06:00Z. Expected Proposed NO.
- sourcecheck_attest1 `FP8C5hEAGg1SHvt41ddoGGThxNVsjBup9MUXE3ncVxDC`, mint maker `u2enUkwa5oNgTKq2g3CeeZpZMFwhibMoBcLbXGa4h9r`, mint taker `DM1AethtaLbwTcdSd2J5uunbk3Jsgo5nAQkjF9FBUwTD`, open `D9j4FEhSK25x6XBgP95VhkG95CM2C6a2FWZoJmUGR4mt`, take `Dn1vFFEkc2wB2QKq8qKbscNS9fnodHadon9FpJizHXh7` (Taken).
- request_resolution x3 (each after funding_deadline): `G3gVTGucNwKbTBBfp4LTDd5FrFF5FjMe8uNv16aoNSMw`, `2gWNqTgit5SpEgvudhr5irJS9Ug9NqkAYbvJBLL9oGkY`, `CKhwvoMo1kjYnu85PMEPMgJdJ7niRYnhVRmhujc2obMD`. **All three: "Execution promise failed: Failed. Refunded 19062500000000000000000 yoctoNEAR", `last_resolution_raw` null, +126-127 s after the request; bet reset to `Taken`, runs_used 0** (D-RESOLVE4a confirmed live again, third time). Logs `resolve_jason_bitstamp_only_no*.log`.
- Judge answers / sources / stage timing: **none obtainable** - no resolver output, so no D-BUDGET1/L1b6 stage timing lines (notes/budget fields are only emitted with the result). No submit_outcome/finalize. State: Taken.
- Verifier (`verify_pre_finalize_bet1.txt`): 4 PASS, 1 FAIL (E2, artifact above), 5 SKIP (E4, B3-B6: nothing submitted).
- **OPEN FINDING (MEDIUM): Jason one-venue sheet gets no output on the L1b6/L1b10-era resolver 2576b08e as well (3/3 here; 2/2 on 142e9812; 2/2 on f6c24165)** - the platform ends the run at ~120-127 s every time; the D-BUDGET1 budget therefore either does not fire early enough or the stall is before the resolver's first stage. Fails closed; not fixed here by scope.

## Bet B: bet id 2, close_above_future (btc_close_at_t `>` 70000), open_utc 2026-11-07T20:38:00Z, **T = 21:39:00Z**
- The task assumed T ~10-15 min after open. The open-time sourcecheck **rejects that**: `OPEN_T_TOO_SOON: t_utc must be at least 1h after open` (template rule; also noted in `../live/README_close_above_yes.md`). So the earliest possible T is open+1h = 21:39Z, past this item's 50-min budget (~21:20Z). (Finding LOW, task-premise: close-at-T needs a >= 1h wait + 5 min.)
- sourcecheck `CnNPMA2JTbt1vv18WnhSX54REq5WBNyNRHteh3LKnM4s` (ok, D-SRCCHK2 again), mint maker `7VvMFQ78UzCNRUS7GMKaEciNkDSGv1J1A528kpVKkQyk`, mint taker `DJLPSbFfrBzh7mGAPCAukD6Q5T3zmrshuwBEELNCDJcX`, open `6qvFyuqhfCAgYQ4AXDm9HrDLo6bz6zCFu1vNki53CgYi`, take `D5mexvjRA3LmkCskGdV4mWsbNiCw3HVPUvQRVFLJYcZV`. Status Taken.
- Not yet run: request #1 in [21:39,21:44) expecting signed NO + back to Taken; request #2 >= 21:44 expecting Proposed YES (BTC ~75.6k). Resume: `sh resume_resolve_and_finalize.sh early1` then `late1` then ~1h later `finalize_b` (the script also runs the verifier). The sourcecheck/bets remain valid (resolve_deadline +30d).
- Verifier pre-request (`verify_pre_finalize_bet2.txt`): 4 PASS, 1 FAIL (E2 artifact), 5 SKIP.

## Spend
Operator `praetorial-dev-1101` 7.50 NEAR at start, 1.60 now with 6.0 locked on the escrow account (recoverable); keeper 1.379 -> 1.071 (of which 0.15 NEAR is escrow keeper credit, ~0.003 burned per failed request's gas/charges; the 3 failed requests were refunded by OutLayer apart from the 0.001 NEAR "charged" log); maker/taker/attest1 ~0.02. Burned total roughly 0.3 NEAR (< 3 budget), excluding the 6 NEAR escrow funding.

## L1b11b results (2026-11-07)
| step | time (UTC) | tx | result |
|---|---|---|---|
| early1 attempt 0 (accidentally BEFORE T, ~21:38:18Z; my script-wait was blocked) | 21:38 | 9ooyAsy2Qn45qJvLc4nD85oU25NoGzf2SXxedkCJMpj9 | resolver output empty ("Failed to parse output as JSON: EOF"), no outcome, bet Taken, runs_used 0 (early_attempt0_pre_T/) |
| early1 (in window) | 21:39:36 | 4813rwvX4boMjbGQU5YjNnw5WtPdictQpPHt9CDb7YVd | resolver output empty/refused, no signed outcome, bet Taken, runs_used 0, retry_count 0, pending_run_no null, refunded |
| late1 request_resolution | 21:44:35 | 31Lb74vjTKeN5FFdGbFCeUpHcnhaQpFMMRx99U8xmQq8 | delivered, Proposed YES (Coinbase 75529.97, Bitstamp 75538.29, Kraken 75532.9; median 75532.9 > 70000) |
| late1 submit_outcome | 21:45 | ESDASk29VaAKtBSRNeqiz9vFZvX8d27dujG64igeCRX4 | Proposed YES, run_no 3 |

- Judge: code-decided 1a; only judge call = 17c5 audit (deepseek-ai/DeepSeek-V4.1-Flash-1017) answered `{"audit":"agree"}`; judge_ran=false. D-BUDGET1: `calls_ms=[] rerun=false`. No L1b6 timing line in raw output; request took ~17s.
- settle_ready = proposed_at 1794087896.3s + 3600s = **2026-11-07T22:44:56Z** (finalize = L1b11c).
- Verifier (verify_pre_finalize_bet2.txt): 5 PASS, 2 FAIL, 3 SKIP. E2 = known account-recreate false FAIL (not weakened). **B3 FAIL: run_no 3 out of order (expected 1)** - the two early refusals consumed run numbers (next_run_no 3) although runs_used stayed 0 and used_run_nos empty; finding, see report.

## L1b14 verifier fixes (2026-11-07, feat/l1b14): both false FAILs above are fixed in the verifier
- **B3 (run_no gap)**: BY DESIGN per D-RUNNO1 (the two early refusals consumed run_no 1 and 2; `next_run_no` stays advanced). B3 now derives the run_no the escrow ASSIGNED to every `request_resolution` for the bet (from the `input_data` the escrow sent to OutLayer in that call, failed/refused runs included) and requires each submitted run_no to be an assigned one, the pending (latest assigned) one at submit time, strictly increasing, and never submitted twice. Replay / unassigned run_no still FAIL.
- **E2 (account recreate)**: E2 uses only the DeployContract + `new()` after the latest CreateAccount of the escrow account (current incarnation); a wrong current deploy hash or init args still FAIL, and a stale earlier incarnation is never accepted.
- Re-run read-only against testnet: `verify_l1b14_bet2.txt` (7 PASS, 0 FAIL, 3 SKIP: E4 B4 B5), `verify_l1b14_bet1.txt` (5 PASS, 0 FAIL, 5 SKIP). live2 bet 1 (`../live2/verify_l1b14_bet1.txt`): B3 PASS, B4 FAIL remains (correct detection of the old early-VOID bug).

## L1b11c: bet 2 finalized (2026-11-07, feat/l1b11c)
| step | time (UTC) | tx | result |
|---|---|---|---|
| finalize (`sh resume_resolve_and_finalize.sh finalize_b`, 1st try, no retry needed) | 22:45:46Z (settle_ready 22:44:56Z passed) | DUKbhbhV28JDXVay7p8hBdiDMdTcBbKXMBGsVwcdBrMc | Settled, outcome YES |

- Pre-check: bet 2 Proposed YES (run_no 3, proposed_at 1794087896325947600 ns). Final: **Settled / YES**.
- Payouts (`pending_payouts_view`, all `done: true`, pending 0; escrow residue 0): winner `maker1.praetorial-dev-1101.testnet` 990000 + 990000 = 1,980,000 usdc.testnet units (`payout_winner`); fee account `fee.praetorial-dev-1101.testnet` 18000 + 18000 = 36,000 (`fee_and_storage` = 20,000 fee (1% of pot 2,000,000) + 16,000 storage); loser 0. Each amount appears as two equal rows (the view lists two entries per receiver); the sums match verifier B5.
- Verifier on final state (`verify_final_bet2.txt`, full output in `finalize_b.log`): **8 PASS, 0 FAIL, 2 SKIP** (E4 needs a live report-pubkey run; B4 partial: raw NEAR AI stream/attestation not supplied). B3, E2, B5, B6 PASS.
- Operator spend for this step: only finalize gas (balances: operator 1.601, keeper 1.067 NEAR); well under 0.5 NEAR.
- **Bet 1 (Jason one-venue NO) remains unresolved (Taken, no outcome) on this escrow.** Its resolver build 2576b08e predates L1b13/L1b15 and the D-JUDGETIME1(B) audit path (L1b16, pending), so it needs a fresh escrow on a newer resolver release.
