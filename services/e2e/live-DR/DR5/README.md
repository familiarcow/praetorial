# DR5 (rehearsal-human-referee-yes): PASS (live, bet 12, referee ruled YES through the deployed web after the REFGAS1 fix)

The first blocker (no testnet sourcecheck endpoint) is gone: through the DEPLOYED web the maker reached Open, the taker took by invite link, and the referee screen was reached.
The ruling itself fails on chain. Bet 12 stays `Taken` with 6 NEAR + storage locked until `resolve_deadline` (2027-11-10 04:22 UTC), then both sides are refunded.

Target: https://praetorial-web-testnet.familiarcow.workers.dev (bundle index-WPWjfFk9.js, names escrow `praetorial-frz2-2611091914.praetorial-dev-1101.testnet`; `git diff 6e33faa HEAD -- contracts/escrow/src` empty).
git_sha: relayer 5a9c95356432 at start -> 6984faf74f8c at end (redeployed mid-run by another session); sourcecheck ea9689f95c4a start and end. NEAR AI calls: 0 (no request_resolution / submit_outcome). 429s: none.
Stake: wNEAR 3 NEAR/side (harness faucet mint, not the UI Move-NEAR flow). Maker real Privy login (OTP not logged); taker and referee via Node-side `__drSign`.
Spec adaptations this session (test-first, nothing loosened): chain.ts single-sources escrow/token via webConfig.ts, typed `pw.ts` shim (DR6 pattern), wNEAR 3-NEAR stake, `nav-create` counts as past the username step, and a guard that a refused/pending referee result fails the spec before any money check. `services npx tsc --noEmit` clean; DR5 unit test 5/5.

## FINDING (blocks DR5): the web's referee_rule delegate carries 80 Tgas, the escrow needs more, and the screen then lies
Bet 12 (btc_touch at_or_above $1,000,000; Human; referee dr5ref1631 picked by username in the maker's picker, WEBREG1 lookup OK; maker ticked the tip, taker did not; taker took via invite link; waiting views showed no challenge button).
At the funding deadline the referee screen offered YES; its confirm text was "You're ruling YES: ... wins 5.592391304347826086956522 NEAR. This pays out immediately ...". Clicking confirm:
- relayer `/relay` returned HTTP 200 `{"ok":false,"txHash":"FqawWQJpM67YzBKEutNStjQcqfRiB3bdMkk3NPCgsfyJ","receiptFailure":"...frz2...: Exceeded the prepaid gas."}`.
- On chain (EXPERIMENTAL_tx_status): the delegate's FunctionCall `referee_rule` has `gas: 80000000000000` (80 Tgas); the escrow receipt FAILED with `ExecutionError: Exceeded the prepaid gas` (4.66 Tgas burnt). Bet 12 unchanged (`Taken`, outcome null, `is_fully_paid` true because nothing was scheduled).
- The screen showed "The ruling didn't go through. Nothing was sent and no money moved." (data-kind `refused`). A transaction WAS sent (and charged relayer gas); no money moved is true.
- Reproduced twice: the live spec at 04:22:33Z, and a scratch re-drive of the same referee screen (script in the profile scratch dir, same UI clicks) which got the same relayer body.
Cause (code reading, not changed): `apps/web/lib/useRelayAction.ts` defaults `gasTgas` to 80; `BetPage.tsx` `ruleAction.run(...)` passes none. `referee_rule` (lib.rs ~3399) schedules payouts inline (winner x2, fee x2, plus 1-2 referee_tip lines when a tip is ticked) then `drain_payouts`, each leg costing PAYOUT_GAS 15 + PAYOUT_CALLBACK_GAS 10 Tgas. With a tip that is 5 legs, so 80 Tgas is not enough. (Concede, 4 legs, passed at 80 in DR6; the no-tip referee_rule path may also be on the edge.) This also hits the exact DR5 case "tip paid only if ticked" and any real referee on a tipped bet.
Money assertions were NOT reached: the spec correctly stopped (before the guard was added the money check reported the delta-0 mismatches below, which are consequences, not separate findings): maker +0 (expected +5,592,391,304,347,826,086,956,522), referee +0 (expected 135,869,565,217,391,304,347,826).

### Options
1. (rec) TRACK: web fix: `ruleAction.run` passes `gasTgas: 300` (same as challenge/finalize-class heavy calls) plus a unit test that the referee_rule delegate gas covers 5 payout legs; also map a relayer `{ok:false, receiptFailure}` to "The ruling was sent but the contract refused it" instead of "Nothing was sent". Then redeploy the testnet web and re-run DR5 (about 12 min wall; 1 sourcecheck).
2. Raise the default gas in `useRelayAction` (blast radius: every relay action, relayer per-call budget).
3. Relayer-side: clamp/raise gas for `referee_rule` in policy.ts (changes the signed delegate? no: the delegate action's gas is signed by the user, so this cannot be done relayer-side; listed only to rule it out).
Recommendation: option 1. No retry-until-green was attempted: a re-run on the same deployed web fails identically.

## Passed on the way (evidence in run/results.json, run/ground_truth.json)
| Step | Tx / result |
|---|---|
| mint wNEAR to maker | 5L2oMWxkFKFWHy1vEYrb6bsjLCqAygAdBJeRwK6aPhyo |
| mint wNEAR to taker | CqPXqxdSeZ6MTB38p4viMyAyaYm4BJN12Z9ZWxw8oF7K |
| open bet 12 (web, maker, Privy) | not captured by the spec (share screen reached, `get_bet` status Open, referee account+Human mode+tip_maker true verified from chain) |
| take (web, taker, invite link) | 6KZcvsssKbFfPWVTW8A9gvNzeeP7fUezX6jkZauBPxCC |
| referee_rule (web referee screen) FAILED | FqawWQJpM67YzBKEutNStjQcqfRiB3bdMkk3NPCgsfyJ (Exceeded the prepaid gas) |
Balances (raw yocto wNEAR, intents mock) before: maker 78260416100980434782608699, taker 6200000000000000000000000, referee 0, fee 1235296521739130434782608, escrow 0. After take: maker 75243256100980434782608699, taker 3182840000000000000000000, escrow 6034320000000000000000000 (2 x 3 NEAR + storage). After the failed ruling: unchanged except fee +311589130434782608695652 (other bets' payouts; not bet 12).
Reached through the UI: Privy login, create form (btc_touch), "a person decides", referee found by username (registry search + lookup), tip ticked, review card (sourcecheck passed), open, share + invite link, take through the invite link, waiting views (no challenge button), referee banner and YES button, confirm text.
Verifier: not run (no ruling exists). Residue/is_fully_paid: bet 12 not finalized.
Web bugs: (1) the gas finding above (proposed TRACK: web); (2) refused-vs-sent message above; (3) the Privy-wallet UI username claim 400 was NOT re-checked (the maker was not prompted for a username this run; the Node-wallet taker's UI claim returned 200 against the deployed registry proxy).
Resume (after the web fix is deployed): from apps/web, symlink services/e2e/live-DR/node_modules -> ../../../apps/web/node_modules, source $PRAETORIAL_SECRETS_DIR/praetorial-privy.env, then `DR5_REF_USERNAME=dr5ref1631 PLAYWRIGHT_BASE_URL=https://praetorial-web-testnet.familiarcow.workers.dev npx playwright test -c ../../services/e2e/live-DR/harness/playwright.live.config.ts --project=maker DR5.live`. Then verify-bet --offline per D-DR1c, vault case study, test.sh fast, merge.
Also found: DR6's `webConfig.ts` imports `network.js`/`assets.js` by file URL, which does not resolve under the Playwright loader (DR5's copy uses `.ts`); DR6 passed live before its tsc fix, so a DR6 re-run would hit it. Proposed one-line follow-up.


## Result (resume run, DR5_PHASE=rule DR5_BET_ID=12)
History: first attempt (23:08) opened + took bet 12 via the web, then the referee's YES failed on chain "Exceeded the prepaid gas" (FqawWQJpM67YzBKEutNStjQcqfRiB3bdMkk3NPCgsfyJ, 80 Tgas). Fixed by web REFGAS1 (per-method relay gas table); web bundle index-DqqsMTS0.js confirmed live. The resume path skips open/take (evidence in run/results.json) and drives only the ruling.
Escrow praetorial-frz2-2611091914.praetorial-dev-1101.testnet. Web referee screen ("You're the referee" banner, YES button, confirm text, result "Done... paid... Your tip of 0.1358 NEAR is on its way"), no challenge button on any screen.

| step | tx |
|---|---|
| take (web, taker) | 6KZcvsssKbFfPWVTW8A9gvNzeeP7fUezX6jkZauBPxCC |
| referee_rule (web -> relayer), **300 Tgas attached** | ARPG1D9TTd1mkfHDJh3dEq8VCzQcJuzbY3KkTvu8QS9n |
| payouts (maker 2 lines, fee 2 lines, referee tip) | drained by the keeper Worker via transfer_with_msg/on_payout_result inside the bet's receipts; is_fully_paid true within the polling window |

Balances (raw, wNEAR in intents) before -> after: maker 94683276553292934782608704 -> 100275667857640760869565226 (+5.5924 NEAR, both stakes minus both side fees minus the tip); referee 0 -> 135869565217391304347826 (tip, ticked by maker); taker 3182840000000000000000000 unchanged; fee account +306059130434782608695652 (two side fees incl. storage); escrow back to its baseline 12068620000000000000000000 (residue 0 for bet 12). Harness checkObserved: no mismatches. Status Settled, outcome YES, is_fully_paid true, pending_payouts [].
Verifier (run/bet12_verify.txt, `verify-bet --offline --expect-escrow-hash caf134a4...`): 6 PASS, 0 FAIL, 4 SKIP. PASS E1,E2,E3,B1,B2,B6. SKIP B3 ("no submitted results in this evidence"), B4 ("judge record (last_resolution_raw) not available"), B5 ("finalize before/after balances not available"), E4 (offline). All allowed by D-DR1c; escrow tx methods include referee_rule and none of request_resolution/submit_outcome (no AI path, 0 NEAR AI calls).
Spec change: the old assertion status == "Finalized" was wrong for a read taken after the payout drain (drain_payouts promotes Finalized -> Settled); corrected to "Settled" (still asserted after is_fully_paid). The live spec then failed only on that line; the post-ruling checks (tx methods, verifier, is_fully_paid, pending_payouts) were run separately against chain (dr5_post), and the UI "no challenge button" was asserted before the ruling and after on the referee/taker screens earlier in the run.
Proves: Human referee path end to end via the real web + relayer (REFGAS1 gas fix works on testnet), tip paid only because ticked, immediate payout, no challenge window, keeper drains payouts. Does not prove: AI judge, challenge/dispute, mainnet, a re-run of the unmodified spec from scratch (open/take were the 23:08 run).

## History (earlier BLOCKED, resolved)
Earlier attempt (local web build): `open-offer-btn` stayed disabled because no testnet sourcecheck endpoint existed (D-FE6B1 attestation), and the UI username claim from a Privy wallet returned 400 bad_key_or_signature. SRCW1/WEBSRC1 deployed the endpoint; the claim finding is unchanged pending re-check.
