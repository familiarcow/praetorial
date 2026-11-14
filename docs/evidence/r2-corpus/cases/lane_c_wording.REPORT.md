# Imperfect-wording corpus (lane_c_wording, lane_c_live, lane_a_wording)

Built by `build/build_wording.py` (+ `wf_lib.py`, `wf_live.py`, `wf_lane_a.py`); reruns from cached fixtures. All fetches via fetchlib, polite UA
(only the Nasdaq historical API needed `ua="browser"`, used as truth, not as a page). Pages saved to `pages/<id>_S1.txt`. No commits.

## Counts
- lane_c_wording.jsonl: 62 cases. By class: ambiguous_next_game 11, missing_tz_or_date 9, beat_vs_cover 9, name_collision 8, unit_mismatch 12, unanswerable_by_page 6, other 7.
  Expected: insufficient 32, met 20, not_met 10. 24 carry `decisive_despite_wording` (sloppy wording, page settles it) to measure over-refusal.
- lane_c_live.jsonl: 23 cases (wording_class live_only_page): 18 insufficient (historical or at-time-T claim on a current-value page), 5 decisive "right now" claims (`decisive_now`: BTC>$10, ETH>$5, Arsenal top, AAPL>$100, NWS Saturday high <90F).
- lane_a_wording.jsonl: 13 cases (10 real + 3 naive-reader planted-bug copies `__bug`): 8 insufficient/3 met/2 not_met. Reader is an honest multi-reading implementation (UTC and US Eastern; F and C; BTC-only feed): it answers only when all readings agree and the data exist. The 3 `__bug` copies silently pick one reading (planted_bug true, expected = true answer).

## Truth method
`expected` is a pre-agreed outcome (`pre_agreed`) whose factual basis comes from a second independent publisher/API (`truth_source`, `truth_evidence` with sha256[:12] and fetch time):
- Lakers games (page: Basketball-Reference): ESPN site API teams/lal/schedule + game summary (attendance). 
- Jaguars-Ravens 33-10 and "no line" (pages: ESPN, CBS): Wikipedia 2026 JAX season + CBS scoreboard + ESPN API (odds absent); KC-Jets unplayed: Wikipedia 2026 KC season.
- League tables (page: BBC): ESPN site API standings (eng.1, fra.1, ita.1), incl. points and goals for. Georgia/Georgia Tech: Wikipedia 2026 FBS rankings (and grep: no Georgia Tech anywhere).
- NYC Nov 5 (page: NWS CLI product from api.weather.gov): IEM cli.py mirror (high 72F, low 62F, 0.09 in); unit conversions are exact arithmetic.
- AAPL daily closes (page: stockanalysis history): Nasdaq historical API and Yahoo chart API, each date used asserted to match to the cent.
- 2022 WC final: Wikipedia (2-2 after 90, 3-3 a.e.t.) + ESPN fifa.world scoreboard (3-3, pens 4-2).
- Live "right now" decisives: Coinbase BTC-USD/ETH-USD/BTC-EUR tickers, ESPN standings API, Yahoo chart, Open-Meteo forecast.
- Lane A: Bitstamp 1m candles (second venue) agree with Coinbase on the per-reading side of each threshold (asserted); NWS facts vs IEM.
- insufficient cases rest on logic (e.g. "no date; several Fridays straddle 340", "game unplayed per ESPN API STATUS_SCHEDULED", "no spread on finished-game block") plus build-time grep of the exact page text (`evidence_check`, `must`/`must_not`). `truth_source` says `page_logic` where no external value is involved.

## Dropped / not built
- 0 cases dropped after final run (earlier drops fixed by redesign: the BTC EUR claim became decisive because the CMC page lists "Bitcoin to Euro"; some `must_not` greps matched unrelated page text and were removed).
- Not built: pounds vs kg (no suitable page with a single unit found in time); million vs billion (only the market-cap "1.6" case, plus a "300 euros" currency case).

## Caveats
- The `pre_agreed` outcomes encode a policy: a claim whose plausible readings give different answers is insufficient; readings that agree give a decisive answer. Arguable ones are tagged `arguable` (w_name_georgia_top5, w_other_jax_3scores). Weekday-only claims (`Friday`) are treated as undated only when the page spans several such weekdays.
- Live pages move: BTC/ETH/quote values are as of each case's `fetched_at`; the page text is frozen in `pages/`. Decisive-now thresholds are far from the value.
- Some stats are single-sourced on the page itself where the claim is arithmetic on it (market cap "1.6"); marked `page_logic`.
- Pages are scoped to the Mac-side polite fetch; none needed a browser UA (no `tee_risk` tag), but ESPN/CBS/CMC pages are large JS-built HTML whose text may differ in the TEE.
- NWS CLI "final" status for lane A follows the J1 file labelling (issued 2026-11-06T06:45Z).
