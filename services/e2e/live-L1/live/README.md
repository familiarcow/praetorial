# L1b: live testnet pipeline on the L1a examples (2026-11-07)

Fresh escrow `praetorial-l1b-11071028.praetorial-dev-1101.testnet` from main 70bc98d; escrow wasm sha256 `812837958ab87ecdef80fe1d78f2e27adff465b18eff24ae9a150b766908df74` (stripped build);
resolver wasm sha256 `f6c24165f2ca9c24555d9edaa90aa2fd1ef26ad52035780895f5c502a52bdd17` (reproducible build bd6b21e, FastFS upload `upload.log`, secrets bound to that hash `bind_secret.log`, report-pubkey D-KEY2 `report_pubkey_*.log`).
Scripts adapted from `../../live-runR3e` (old dir untouched): `1_create`, `deploy`, `3_deploy_init`, `open_take`, `resolve`, `finish`, `bet`, `resume_finalize.sh`.

| Example | Bet | Expected | Result | Verifier (pre-finalize) | State |
|---|---|---|---|---|---|
| jason_same_bucket_yes | 1 | YES | Proposed YES (2 models `met`) | 7 PASS / 0 FAIL / 3 SKIP | finalize pending (>= 16:42Z) |
| jason_bitstamp_only_no | 2 (+4 retry) | NO | none: both stuck `Resolving` (OutLayer "Execution promise failed", output null, reproducible) | 5 PASS / 0 FAIL / 5 SKIP | NOT DONE, liveness finding |
| close_above_yes | - | YES | not openable: Coinbase 400 "Start cannot be in the future" in sourcecheck | n/a | BLOCKED (finding) |
| flips_100k_messy | 3 | VOID | Proposed **NO** (both models `not_met`) | 7 PASS / 0 FAIL / 3 SKIP | finalize pending; differs from L1a expectation |

No bet is DONE: min settlement_period is 1h (D1), the finalize window opens 16:42Z, after the 50-minute run limit. Per-bet detail: `README_<example>.md`. Remaining work -> L1b2.

## L1b3 finalize (2026-11-07, ~17:04Z, testnet)

`sh resume_finalize.sh` ran clean (no failed steps). Both finalize txs succeeded; `drain_payouts` was not needed (payouts done in the finalize receipts).

| Bet | Example | Proposed | Final | finalize tx | Payouts (USDC base units, 6 dec) | Verifier |
|---|---|---|---|---|---|---|
| 1 | jason_same_bucket_yes | YES | Settled YES | `F3iFfaGxeWsY2GvGsd8dEZJ8jHcDa3wVyo9H3pWXVCYR` | winner maker1 +1,980,000 (2 x 990,000); fee account +36,000 (fee 20,000 + 16,000 storage); loser 0; escrow residue 0 | `verify_final_bet1.txt`: 8 PASS / 0 FAIL / 2 SKIP (E4, B4 partial); B5 and B6 PASS |
| 3 | flips_100k_messy | NO | Settled NO | `8HuHi6rjYdKWGdAnijvWgL8itpYRYyySBTbvpwryx6DH` | winner taker1 +1,980,000 (2 x 990,000); fee account +36,000; loser 0; escrow residue 0 | `verify_final_bet3.txt`: 8 PASS / 0 FAIL / 2 SKIP (E4, B4 partial); B5 and B6 PASS |

Winners match the proposed outcomes (bet 1 YES -> maker, bet 3 NO -> taker).

Bets 2 and 4 (jason_bitstamp_only_no): still `Resolving` (view at finalize time). Left for `void_after_deadline` because this escrow predates the D-RESOLVE4a fix (a138a41). Nothing attempted on them.

Testnet NEAR spent in this item: ~0.003 NEAR (operator praetorial-dev-1101: 4.536 -> 4.533; keeper/attest1/maker1 unchanged at 3 decimals).

### Jason bet tx hashes (from `results_jason_*.json`)

| Step | Bet 1, same-bucket YES | Bet 2, Bitstamp-only NO | Bet 4, Bitstamp-only NO retry |
|---|---|---|---|
| sourcecheck_attest1 | `9LYeXc9wUXRQqPFUXDPPg96kbk8rSwrwcmeCkD2dyC8f` | `G3RhRHSWKHvc3HgMEtrdd2zyQjzREJWAwa1WBom2oXZ7` | `3BcSNANFfeE2wAe5TSgdAah3vKtccd6yQUQomqK1GFSL` |
| mint_usdc_maker1 | `HyDT8bqxd6ceuj61Hp1DPxwyFZmnTB9SeKw2dBrSbQck` | `8ck3SZmecseJ7juU2f6wTCgJFbNr2YZsN23J8Bp6km6c` | `6hnfEmpvWUqV1jLwx5N1evVA6kNZDED2iSX9dqJL5Lbb` |
| mint_usdc_taker1 | `GqkBFcZ5E4KStkScy53TuDJ65dQzJPDqyba8gb7SiDCi` | `pNY7sXbGJNEJCLWnmevt4QwWQxrftVTW9gFANS8TEb6` | `H28jUfxwjbKwfWaxiMywJcKUioR186f9W64wKXXdhuGA` |
| open_usdc | `Bp6jcnkWwEsEZtZzxyPY2osVnCaFv8gjzMdaWnyhUj9r` | `9b7sZaZNaiu7MNRL8DctzMdojz37A4RgrLaEpooKsjfE` | `6GxCioiCD6FGqsa2jKXKhp3U7R2Kt8XNSTkfUm7TdvNS` |
| take_usdc | `8p7i26WaCxpbBEH6kz2T7UM7q1Lm2JAphoMXj2FGVpRK` | `GX7bHgHzDcvPsMV1q5vHXTEBgDEuY8d2iVz7kjqi5vfc` | `GT3AqSNh435ZWSjMavaAZR4RU41RbyB1KsNYHGvizuXr` |
| request_resolution | `FhTjMxBAMEgW1aF3JhxG666eo3gDweU97D3Y5xVB4cvr` | `EytzRWs4wxqtva2whPzT67xwj9v4okfz1HCiwLLT68dT` | `EARNw739Nzo4rgtabGKWUjXUGfLChKJgx2sz3nmgYzX8` |
| submit_outcome | `5HoRvUJydXvGaSzhu1BqQRHzDBeUyMuusKJWxZs4cgW9` | none (stuck Resolving) | none (stuck Resolving) |
| finalize | `F3iFfaGxeWsY2GvGsd8dEZJ8jHcDa3wVyo9H3pWXVCYR` | none | none |
