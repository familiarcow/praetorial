# Expectations for the live3 escrow (written 2026-11-07 ~20:39Z, BEFORE any request_resolution; first draft lost to a blocked shell command and re-written)
Escrow praetorial-l1b11-11072031.praetorial-dev-1101.testnet; escrow wasm a240f363 (main 79c4bd4); resolver wasm 2576b08e...b773 (record-7683e0f). Spot: Coinbase 75613, Bitstamp 75618.

## Bet A = bet id 1 (jason_bitstamp_only_no, same sheet as live2 bet 3)
Claim: Coinbase AND Bitstamp 1m highs >= 75951 in the same 5-min window before 2026-11-07T06:00Z (window 04:00-06:00Z). Day's high ~76143 was at 09:00Z, outside the window -> claim not met -> expected **Proposed NO**. Capture L1b6/D-BUDGET1 stage timing lines. If no output (~120 s): retry at most 2 more times, record timings/logs, report as open finding (no resolver change here).

## Bet B = bet id 2 (close_above, typed btc_close_at_t, `>` 70000)
open_utc 2026-11-07T20:38:00Z, **T = 2026-11-07T21:39:00Z**. Sourcecheck rejected T=open+15min with `OPEN_T_TOO_SOON: t_utc must be at least 1h after open` (template rule), so the task's 10-15 min plan is impossible; T=21:39Z is beyond this item's 50-min limit (~21:20Z). Request #1/#2 are left as resume steps (`early1`, `late1`, `finalize_b` in resume_resolve_and_finalize.sh).
- Request #1 in [21:39, 21:44): expected signed NO outcome; bet returns to Taken, retry allowed (D-EARLYREQ1 + D-RESOLVE4a).
- Request #2 at/after 21:44: expected Proposed **YES** (BTC ~75.6k >> 70000 on Coinbase/Bitstamp/Kraken).
Verifier V1: run on each bet pre-finalize.

- CORRECTION 2026-11-07 (written before the early request): the request-#1 expectation is NOT a signed NO outcome. Per D-EARLYREQ1 it is: no signed outcome at all; resolver refuses; bet back to Taken; retry allowed.
