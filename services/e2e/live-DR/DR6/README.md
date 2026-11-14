# DR6 (rehearsal-concede-ai-bet): expected ending REACHED through the deployed web; STATUS DONE under PM ruling D-DR1c

Target: https://praetorial-web-testnet.familiarcow.workers.dev (bundle index-ytTVcxqc.js; the earlier attempt saw index-D4vtzPT-.js, so the web was redeployed in between). Escrow praetorial-frz2-2611091914.praetorial-dev-1101.testnet; `git diff 6e33faa HEAD -- contracts/escrow/src` empty.
Passing run: 2026-11-10 ~03:10-03:12 UTC (22:10 EST), after the sourcecheck window reset. git_sha start == end: relayer 65d592bdc3d4, sourcecheck a331d539545c.
Sourcechecks used by the passing run: 2 (both HTTP 200), no 429. NEAR AI calls: 0 (the escrow tx list has no request_resolution / submit_outcome).
Stake: wNEAR 3 NEAR/side (faucet mint to maker and taker via the harness, not the UI Move-NEAR flow). Maker real Privy login (OTP not logged); taker via Node-side `__drSign`.
Spec result: `1 passed (1.8m)`; in-spec assertions (money from chain views, no submit_outcome/request_resolution in the escrow tx list, cancel refund) hold.
Resume/rerun: from apps/web, symlink services/e2e/live-DR/node_modules -> ../../../apps/web/node_modules, source $PRAETORIAL_SECRETS_DIR/praetorial-privy.env, then `PLAYWRIGHT_BASE_URL=https://praetorial-web-testnet.familiarcow.workers.dev npx playwright test -c ../../services/e2e/live-DR/harness/playwright.live.config.ts --project=maker DR6.live` (~2 min; uses 2 sourcechecks).

## Scenario A: bet 8 (btc_touch at_or_above $1,000,000, 4h window); taker concedes
| Step | Tx | Signer |
|---|---|---|
| mint wNEAR to maker | Czibm8CVHfoyf8gVgNEGLMbLum8Wxf7GUzBNsdmyR6Qc | harness faucet |
| mint wNEAR to taker | 3XrMVcgPerdKFGHrjzMkbfJZ4YnmHcCdxsofr1cM7M6j | harness faucet |
| open bet 8 (web, maker) | EmR7QMG23WnPGwfftmnvYKjTdTDjpxRSCzXxe8vsSTma | relayer |
| take (web, taker, invite link) | 7PpoFvV8iDgB3kmccvupf6Jy17CMSbE48cTMKABWCt4z | relayer |
| concede (web S12 confirm, taker) | AxMdvSx2moUCfcSXpLhDBFiE1rkrmtFBzgk7hNBuLpwb (concede, mt_transfer, on_payout_result) | relayer |
| drain_payouts | BvQz5WpCBRbN2Yex7VT3FYGcqXqSV25QSFfGUA8RFHPC (also covers bet 9 refund; not split) | keeper |
Bet 8 final: Settled, outcome YES (maker side). ground_truth.json written at take time, before any outcome existed.
Money (chain views via harness money.ts): maker +5,728,260,869,565,217,391,304,348 yocto (two payout_winner legs of 2.864130... NEAR), taker +0 (lost 3 NEAR stake + storage), fee account +306,059,130,434,782,608,695,652 (2 x fee_and_storage). `money_check.mismatches` = [].

## Scenario B: bet 9, second offer opened and cancelled untaken
| open bet 9 (web, maker) | J3DeU9zus3zQLLk7zWCFscgayFPxsUX5Bxhrx7SW4YAp |
| cancel (web, maker) | Fdsd6PMX3zmumrhYm46jnXHaM9K46XsQN2cjEgQrML1D |
Maker betting balance 72060416100980434782608699 -> 69043256100980434782608699 (after open, -3.01716) -> 72060416100980434782608699 (after cancel): full refund 3,017,160,000,000,000,000,000,000 incl. storage 0.01716. Fee account unchanged by the cancel.

## Balances (raw yocto wNEAR, intents mock)
- before: maker 69349315231415217391304351, taker 22882840000000000000000000, fee 617648260869565217391304, escrow 2739935000000000000000000
- after take: maker 66332155231415217391304351, taker 19865680000000000000000000, escrow 8774255000000000000000000
- final: maker 72060416100980434782608699, taker 19865680000000000000000000, fee 923707391304347826086956, escrow 2739935000000000000000000
Escrow final == escrow before: these two bets leave residue 0 (the 2.74 NEAR baseline belongs to earlier orphan bets). `is_fully_paid` true and `pending_payouts` [] for bets 8 and 9 (RPC views ~22:25 EST). The name `pending_payouts_view` returns null on this contract; `pending_payouts` was used. Keeper drained within ~1-2 min; no manual drain.

## Verifier
Escrow code hash caf134a4...0f2f taken from the chain's own view_code (E1 compares the chain to itself, not to a reproducible build).
`verify-bet --network testnet --escrow ... --bet N --expect-escrow-hash caf134a4... --offline` (raw: run/verifier/bet8_verify.txt, bet9_verify.txt):
- bet 8: 5 PASS (E1, E2, E3, B1, B2), 0 FAIL, 5 SKIP (E4 offline, B3, B4, B5, B6).
- bet 9: same shape (B5: outcome null).

## RULING D-DR1c (STATUS: DONE)
The finding below (verifier SKIPs B4, B6, E4 offline besides the allowed B3/B5; no recorder run-dir) was resolved by PM ruling D-DR1c (praetorial-bot under D-PM3, 2026-11-09 22:27, plan file last section). For DR5/DR6/DR7 no-ruling endings, B3, B4, B5, B6 SKIPs and E4 offline SKIP are allowed when the skip reason is "not available"/"no submitted results" AND the tx list proves no request_resolution and no submit_outcome. `verify-bet --offline` is accepted in place of `final_step.sh <run-dir>`.
- Verifier used: `verify-bet --offline` (live chain views), NOT `final_step.sh <run-dir>`. Why: this spec writes results.json only; the recorder needs a proposal/raw resolution that concede and cancel endings never create.
- Skip reasons match the ruling: bet 8 and bet 9 both SKIP B3 "no submitted results in this evidence", B4 "judge record (last_resolution_raw) not available", B6 "proposed_at not available in this evidence", E4 "offline"; B5 SKIPs with "finalize before/after balances not available" (bet 8) / "outcome null" (bet 9). 0 FAIL (run/verifier/bet8_verify.txt, bet9_verify.txt line 12: 5 PASS, 0 FAIL, 5 SKIP).
- Absence proof: DR6.live.spec.ts:175-177 reads the escrow tx list and asserts `forbiddenCalls(...)` (expected.ts:13: submit_outcome, request_resolution, ...) is empty; the recorded list is in run/results.json `escrow_tx_methods` (line 517): only transfer_with_msg/mt_on_transfer/resolve_transfer (open, take) and concede/mt_transfer/on_payout_result. That list is captured after scenario A (bet 8); bet 9 is open then cancel only, and its path has no ruling call (its verifier output shows no submitted results). Spec: 1 passed.
- No test, spec assertion or verifier code was changed.

## Earlier finding (historical, resolved by D-DR1c)
1. Plan section 4 allows SKIP B3, B5 only. A no-ruling bet also SKIPs B4 ("judge record not available") and B6 ("proposed_at not available"), and E4 SKIPs offline (live E4 needs OutLayer CLI homes and spends credit). 0 FAIL, but not the allowed set. Not loosened.
2. `final_step.sh <run-dir> <hash>` needs a recorder evidence dir (layout of live-runR3e). This spec writes results.json only; the recorder requires a proposal/raw resolution a concede ending does not have, so the run-dir call was not made; the live-view verification above is the equivalent.
Options: (a) amend plan section 4 to allow B4, B6 (and offline E4) SKIP for DR5/DR6/DR7 (recommended: no ruling exists to verify); (b) a verifier "no-ruling ending" mode PASSing B3-B6 by proof of absence, plus a recorder concede variant (verifier/harness change, out of scope); (c) run E4 live (spends OutLayer credit; B4/B6 still SKIP).
Not done: `./test.sh fast` and merge (held on the finding).

## Web findings
- Sourcecheck 429 shown as "The check is taking too long. Retry." Proposed TRACK: web: map to "Too many checks, try again in N minutes".
- Create form offers NEAR only (asset select disabled), so DR6 stakes wNEAR.
- Web redeployed between attempts (harmless here).
- Orphans: an attempt at 22:03 got through bet 4 (take + concede, Settled YES) before my tool call timed out mid payout-wait; partial evidence in run_attempt2_bet4_killed/. Bets 5-7 are earlier-attempt leftovers.
- Earlier history (blocked by sourcecheck 429 at 21:17-21:27 EST; local-vite run found relayer CORS missing, superseded by the same-origin /_proxy path on the deployed web): see git history of this file.

## What this proves / does not
Proves: via the deployed web, a Privy-logged-in maker opens an AI bet (live sourcecheck), a taker takes by invite link, the loser concedes through the S12 confirm, the maker is paid both stakes at once with no ruling and no NEAR AI call; an untaken offer cancels with full refund incl. storage; fees match the expected rules.
Does not prove: taker's real Privy login (seam used); mainnet intents; judge behaviour; E1 against a reproducible build; the run-dir final_step.sh path.
