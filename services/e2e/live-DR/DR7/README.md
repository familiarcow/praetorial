# DR7 (rehearsal-human-referee-silent-deadline-refund): STATUS WAITING-DEADLINE 2026-11-12T00:00:00Z

Phase 1 (open + take through the DEPLOYED web, ground truth) is done and green; bet 16 is `Taken` with 2 x 3 NEAR (wNEAR) + storage locked until `resolve_deadline`. Nothing merged.

Target: https://praetorial-web-testnet.familiarcow.workers.dev, escrow `praetorial-frz2-2611091914.praetorial-dev-1101.testnet` (relayer + sourcecheck /health name it; `git diff 6e33faa HEAD -- contracts/escrow/src` empty).
git_sha at start: relayer 6984faf74f8c, sourcecheck ea9689f95c4a (end of phase 1: unchanged). NEAR AI calls: 0. Sourcechecks used: 1 passing (+0 failed passes; two earlier passes stopped before the review card). Stake: wNEAR 3 NEAR/side (harness faucet mint, not the UI Move-NEAR flow).

## Minimum resolve_deadline (recorded, not changed)
- Contract (`contracts/escrow/src/lib.rs`): `resolve_deadline > funding_deadline` (line 762), funding_deadline >= now+60s (builder), max 1461 days (D-HORIZON1a). Contract minimum is therefore about 1-2 minutes after open.
- Web builder (`apps/web/lib/stakeDeadlines.ts`, `offerExpiry.ts`, `components/CreateOffer.tsx`): "Referee deadline" is an `<input type=date>` (00:00 UTC, day granular); it must be after the event time (`resolveProblem`) AND after the offer expiry (`expiryProblem`, "The offer has to expire before the resolve deadline"); shortest offer expiry option is 1d. So the shortest the UI accepts = the first UTC midnight after now + 24h. This run (opened 2026-11-10 04:32 UTC): 2026-11-12 00:00 UTC (~43.5 h). The first live attempt with the default 7d expiry showed that validation message and no review card.
- That is longer than one build session, so the run is split: phase 1 now, phase 2 after the deadline.

## Phase 1 evidence
Bet 16, maker (Privy login) `8941e607...81c7`, taker `dfb218d3...32ba` (Node-side `__drSign`, took by the maker's invite link), referee `83bc3bfb...6037` picked by username `dr7refmwa7088e` (claimed from Node against registry id `registry.praetorial.testnet`, the Worker's /health value; set `DR7_REGISTRY_ID` for it). Review card (Human) -> Open -> share -> invite link -> take; both waiting views show no challenge button; the referee never opens a ruling.
| step | tx |
|---|---|
| mint wNEAR to maker | 8GMxojbUkpbdFzkSLYcr99M2DM6ywYQ6S5eZvRzRpKG |
| mint wNEAR to taker | 6Gvjgw1yeL6aHCQYwFMcFjui1XDk23d874mtD8gvZV8y |
| open (web, relayed; hash not captured by the spec, bet 16 status Open verified from get_bet) | n/a |
| take (web, taker) | 3fCpmR6kXB1NNdqWsxh2LijipP7crsjVf5iMhSVmwFs1 |
Balances (wNEAR raw, run/results.json): maker 83378122191442934782608700 -> 80360962191442934782608700 after open; taker 6200000000000000000000000 -> 3182840000000000000000000 after take; fee 1546885652173913043478260 unchanged; escrow +12068640000000000000000000 total over both deposits (stake + storage).
ground_truth.json written 2026-11-10T04:32:18Z before any outcome read (status Taken, outcome null).
Tests: `services npx tsc --noEmit` clean; DR7 unit test 7/7 (`node --import tsx --test e2e/live-DR/DR7/test/dr7.test.ts`), wired into services `npm test`.

## Expected ending (computed in expected.ts from the contract's rule, lib.rs void_after_deadline)
Status Voided / outcome VOID; `pay_tips` (none ticked => 0); each side refunded stake + its OWN storage charge (keep_terms false); NO protocol fee on this path; fee account and referee +0; escrow residue 0; is_fully_paid true; pending_payouts [].
Void path: the web has no void_after_deadline control (verify at finish time: bet page after the deadline), so the keeper Worker is expected to void (~4 payouts/min drain; >10 min late = finding). If a web control exists at that time, use it and record; a REFGAS1-style gas failure there is a finding, not to be hand-crafted around.

## Resume (after 2026-11-12T00:00:00Z)
```
cd ~/praetorial-wt/overnight/apps/web && source $PRAETORIAL_SECRETS_DIR/praetorial-privy.env  # not needed for finish but harmless
DR7_PHASE=finish PLAYWRIGHT_BASE_URL=https://praetorial-web-testnet.familiarcow.workers.dev npx playwright test -c ../../services/e2e/live-DR/harness/playwright.live.config.ts --project=maker DR7.live
```
(`services/e2e/live-DR/node_modules` -> apps/web/node_modules symlink must exist; state in run/state.json + run/bet_taken.json; the spec waits for the deadline, waits for the keeper void, asserts money from chain views, the tx list (no submit_outcome/request_resolution/referee_rule/finalize), is_fully_paid, pending_payouts, residue.) Then: `verify-bet --network testnet --escrow praetorial-frz2-2611091914.praetorial-dev-1101.testnet --bet 16 --offline` (D-DR1c: only B3,B4,B5,B6,E4 SKIPs), fill the finish section of this README, append the case-study addendum, `./test.sh fast`, merge under MERGE.lock.

## Not yet proven
The void, the refund amounts, drain and the verifier run. Phase 1 proves only: web open + take through Human mode with a username-picked referee and the shortest accepted deadline.

## Final on-chain state (MISS1 salvage, read-only check 2026-11-13 ~05:51Z)

Salvaged onto main by MISS1 from branch `feat/dr7` (the run never merged). `run/chain_final_miss1.json` = `get_bet` view at that time (`spikes/miss1/chain_final.py`, view calls only).

- Bet 16 on frz2 is **Voided / VOID**, no runs, no submit_outcome: the expected ending (void after the referee deadline) was reached, by the keeper.
- The finish phase (refund amounts, drain, verifier) never ran, so the refund amounts in `expected.ts` were **not** checked against chain by this harness.
- The offline test now pins frz3 (the web's current testnet escrow) like DR6's 84f23c84; bet 16 itself is on frz2, so a finish re-run would have to pin frz2 explicitly (as DR1's `BET_ESCROW` does).
