# DR3: rehearsal-nws-daily-high-ai (testnet, AI judge, deployed web)

Status: **WAITING** (phase 1 done, phase 2 = finish pending). Bet 33 is opened and taken through the deployed web. The CLI product for its climate day is not out yet.

## Scenario
- Escrow `praetorial-frz3-2611100414.praetorial-dev-1101.testnet` (the escrow the deployed web bundle targets; `apps/web/lib/network.ts`). Web: https://praetorial-web-testnet.familiarcow.workers.dev
- nws_daily_high, station **KNYC**, climate day **2026-11-11** (local standard-time day 05:00Z Nov 11 -> 05:00Z Nov 12), "at or above **61 F**" (NWS hourly forecast max for Nov 11 was 61 F on 2026-11-10 ~21:00Z, so the real reading decides), 3 wNEAR per side, odds 1:1, settlement window 1h, invite-by-link.
- Maker: real Privy test login (OTP never logged), account `8941e607...81c7`. Taker: **fresh per-run** implicit account `e1a903aa...f21f` (balance 0 before minting, asserted), key persisted 0600 outside the repo.
- Bet **33**. Sourcecheck: "The AI can read these sources. Checked at 21:08 UTC." Open and take are web steps; mint/tNEAR funding is harness.
- Funding window: until 2026-11-11 05:00Z (the day start). request_resolution is allowed after that, but the keeper's liveness (`services/keeper/src/liveness.ts`) only requests at day end (2026-11-12 05:00Z) for nws_daily_high, so nothing asks the judge before the harness does.

## Resume (finish phase)
CLI products: NWS issues a preliminary "VALID TODAY AS OF 0400 PM LOCAL TIME" CLI at ~4:32 PM EST (= **~21:32Z on 2026-11-11**), the final at ~1:27 AM EST next day (~06:27Z on 2026-11-12, AFTER the keeper's day-end request, so prefer the preliminary).
```
cd ~/praetorial/apps/web; set -a; . $PRAETORIAL_SECRETS_DIR/praetorial-privy.env; set +a
DR3_PHASE=finish DR3_STATION=KNYC DR3_DATE=2026-11-11 DR3_OP='>=' DR3_X=61 PLAYWRIGHT_BASE_URL=https://praetorial-web-testnet.familiarcow.workers.dev npx playwright test -c ../../services/e2e/live-DR/harness/playwright.live.config.ts --project=maker DR3.live
```
The finish phase polls the IEM copy until a product for 2026-11-11 exists, writes `run/ground_truth.json` (fetched_at, raw text, sha256, parsed high, issue time) BEFORE request_resolution, clicks request_resolution in the web (taker), polls for the judge result, asserts outcome == ground truth, finalizes (web button once the 1h window is over, else keeper), checks money, `is_fully_paid`, no pending payouts, escrow method allow-list. Then: `npx tsx DR3/money.ts`-style receipt check (use DR1/money.ts with the finalize tx), `services/verifier/final_step.sh <run-dir> <escrow-hash>` (0 FAIL, SKIP only E4 offline; B4 asserted PASS), complete this README, vault addendum, ./test.sh fast, merge under MERGE.lock.

Caveat to check at finish: if the preliminary 4 PM product is used, the template wording "published for the climate day" must accept it; the judge's raw answer decides. If the final differs from the preliminary max, the LATEST issuance is the ground truth (unit-tested).

## Tx table (who did what)
| Step | By | Tx / note |
|---|---|---|
| mint wNEAR to maker | harness (keeper key mints on the mock intents) | `C5vUTWV4YDgY7PuwWqucZsHazThNu4wC5MUV5mCNM5vw` |
| mint wNEAR to taker | harness | `AKKTULtKY8AwcSkojoKnqX6bPboeUAEjYeZMnuTURWho` |
| tNEAR to taker | harness (dev funder) | `A2rarFy9mAHtbdDJHAQbtEEBcGTeXVBwVg9iYiRpfGj9` |
| cancel orphan bet 32 | web (maker) | escrow `cancel` `DZ5CkqEUxew9f3YuFfEAkSHU1M23UB8A5wDyotLu2cwW` |
| open bet 33 | web (maker) | the web UI shows no tx hash (`open-tx` absent); an escrow `mt_transfer_call` of ~21:08Z in `run/results_open_bet33.json` / `npx tsx DR3/txs.ts` |
| take bet 33 | web (taker, `__drSign`) | `4ybG5eGq8GXRwP9nLQQuceeyThnwddGjJmvNC6Y3hMrn` |
| request_resolution, judge, finalize, payouts | PENDING | to be filled by the finish phase (who did each) |

## Attempts before bet 33 (all web steps; none touched NEAR AI except the web's own sourcecheck)
Bets 25, 27, 28, 29 (climate day 2026-11-10, ground-truth CLI product out ~21:32Z same day) and 31, 32 (day 2026-11-11 with plain share link) are NOT the run; each is Cancelled (25, 32, web) or Expired (27, 28, 29, keeper refund). Raw step logs: `run/results_attempt*.json`, `run/results_open_*.json`.

## Findings (web/harness; no wrong winner, no stuck funds)
1. **F1 (web, TRACK: web candidate): an offer for a climate day that already started cannot be taken in practice.** `deriveDeadlines` -> `fundingDeadlineSecs` floors the funding deadline at now+60 s (`apps/web/lib/offerExpiry.ts`, `templates.ts eventTimes`), computed at review time; the mandatory sourcecheck alone takes 30-60 s, so the offer expired before the taker could act (bets 25, 27, 28, 29). Today's-product DR3 was therefore impossible through the web; the run moved to tomorrow's day. Suggest: a longer minimum funding window for in-progress days, or the day start should not close funding for a bet whose decision is the day END.
2. **F2 (web): a fresh account is gated on a username** before the bet page renders; "Skip for now" is only offered when the registry is down. The spec claims a username through the dialog (works). Not a bug, but a first-time taker cannot take from a link without first choosing a name.
3. **F3 (web): a taker on a plain `/bet/N` URL sees "Terms not available"** in the take dialog (the terms live in the invite link / maker's browser). The invite-by-link flow shows the terms. A taker taking blind from a plain bet URL would not see the claim.
4. **F4 (harness, fixed):** DR1's spec used one dialog step (`take-confirm`); the take dialog has 2 steps (`take-next` then `take-confirm`); added.
5. B4 (known open PM question, DR1b): the resolver records no raw NEAR AI stream, so verify-bet B4 is expected PARTIAL/SKIP on live runs. The test asserts B4 PASS; it stays red if PARTIAL. Not re-litigated here.

## Proves / does not (so far)
Proves: the web builds, sourcechecks and opens an AI nws_daily_high offer; a fresh taker takes it via the invite link. Does NOT yet prove: the AI ending, payouts, verifier.

## Final on-chain state (MISS1 salvage, read-only check 2026-11-13 ~05:51Z)

Salvaged onto main by MISS1 from branch `feat/dr3` (the run never merged). `run/chain_final_miss1.json` = `get_bet` view at that time (`spikes/miss1/chain_final.py`, view calls only).

- The finish phase never ran (status above stayed WAITING). Bet 33 on frz3 is now **Proposed YES** (proposed_at 2026-11-13T05:16:32Z, run 3, judge_backend near-ai): "NWS CLI maximum and IEM high agree: 63 F; 63 >= 61", 17c5 audit agrees. Request, judge and finalize were the keeper's, not the web's.
- No ground_truth.json was written by this harness. Independent check: CS1's NWS case (`spikes/cs1/CASE-STUDIES.md`, Central Park high on 2026-11-11 = 63°F) read the same day's reading, so YES (63 >= 61) is the right side.
- Not proven by DR3: web-driven request/finalize, payouts, verifier. Bet 33 was still in its challenge window at the check.
