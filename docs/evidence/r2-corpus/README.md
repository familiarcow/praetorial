> **Provenance (MISS1, 2026-11-13).** Result docs of the R2 spike (branch `spike/r2-corpus`, commit 7139598b, 2026-11-06), copied verbatim:
> this README, ROUNDS, INTERIM, spotcheck, PROGRESS, PROMPT_C_final and `cases/*.REPORT.md`. Historical: it measured the D-JUDGE4 pair as of 2026-11-06,
> before later resolver changes. The corpus itself (`cases/*.jsonl`, `fixtures/` 130 MB of fetched third-party pages, `results/`, `build/`)
> is **not** on main: the pages embed third parties' keys and emails (found by the pre-publication scan), so it stays on the private branch / backup bundle.
> Paths below that name those folders refer to that branch. What main keeps from it: the offline regression fixtures
> `resolver/core/tests/fixtures/r2_regress.json` and `r2_quote_rejects.json`, exported by `judge-proto/export_r2_fixtures.py` (J4).

# R2: does the approved judge design (D-JUDGE4) ever pay the wrong winner?

Branch `spike/r2-corpus` (on `spike/j1-judge`). Offline replay of recorded fetches; no TEE and no chain calls (TEE fetchability is R1's and preflight's job). NEAR AI spend **$14.75** (`spend.jsonl`, 5,039 calls). Detail files: [INTERIM.md](INTERIM.md) · [ROUNDS.md](ROUNDS.md) · [PROGRESS.md](PROGRESS.md) · [spotcheck.md](spotcheck.md) · [PROMPT_C_final.md](PROMPT_C_final.md) · case builders/reports in `build/`, `cases/*.REPORT.md`.

## Verdict
**The gate (0 wrong winners) is met on every well-formed judge-scope set I ran (A 0/261, B 0/76, C clean/adversarial/live 0/107) provided lane A/B audits run with thinking ON, and NOT met for badly-worded claims (7) or edited pages (3).** Two caveats up front: a no-thinking lane B audit let one planted bug through in the pair (see "What the second model buys"); and thinking-ON was run on the flagged, planted and 20 regression cases, not on every A/B audit.

| lane | wrong winners (pair D+G, final settings) | VOID % (all cases, incl. correct VOIDs) | unneeded VOID % (truth was decisive) |
|---|---|---|---|
| A built-in readers (261 real cases) | **0** | 21% (all are code-gate "insufficient": Coinbase gaps, past Kraken depth, game not final) | **0%** |
| A planted-bug proposals (26), thinking-ON audit | **0** (all 26 VOID) | 100% | – (VOID is the right answer) |
| B planted-bug proposals (6), thinking-ON audit | **0** (with the no-thinking audit the pair paid 1 of them in 2 of 13 trials: see below) | | |
| B structured JSON (76 incl. 14 unsettled) | **0** | 24% (14 unsettled = correct VOIDs) | 5% (4/76: auditor flags) |
| C clean pages (30 sampled) | **0** | 30% (JS-heavy/paywall pages → correct insufficient) | 3% (1: quote reject on a PDF hyphen) |
| C adversarial, judge scope (54) | **0** (injections visible and hidden, near-threshold, wrong season, right teams/wrong game, two pages disagree) | 19% | 0% |
| C live-only page for a historical claim (23) | **0** (17 VOID, expected) | 78% | 0% |
| C imperfect wording (62) | **7** | 47% | 6% |
| C edited live page, snapshot-only proof (3, out of judge scope) | **3** (2 after final prompt; run-to-run variance) | – | – |

The 7 + 3 are written out in full below. They are **not** random model mistakes: both models read an ambiguous or tampered page the same natural way and agree. A second model cannot catch that (it halves it: single glm-5.3-flash 12 wrong → pair 7; DeepSeek alone 6 but with more variance). What stops them is the frontend (wording) and the archive-snapshot rule (D-ATTEST1a), not the judge.

## What was built and how truth was established
Cases are in `cases/*.jsonl`; every network fetch is in `fixtures/` (`index.jsonl`: URL, UTC time, status, sha256, bytes; gzip blobs by hash). Every case has `truth_basis` (and for B/C/wording `truth_source` + `truth_evidence`): structured API value, official record, or **two independent publishers agreeing** (e.g. games: ESPN API/MLB statsapi/NHL api-web vs CBS + Yahoo). No LLM answer was used as truth. Cases without an independent route were dropped and counted: games NBA 3 (only one publisher), MLB 1 (ambiguous double-header), NFL 2025 season not built (no second publisher; includes the DAL-GB tie), lane B 0 dropped (several candidate markets never built for lack of a truth source). [spotcheck.md](spotcheck.md) = seeded 10% (32 of 321) lane B/C sample for a human to verify.

| lane | cases built | notes |
|---|---|---|
| A BTC | 210 real (126 close, 84 touch) + 17 planted-bug | 130 tagged near-threshold by the builder (BTC close/touch within a few tens of dollars of the line), 23 exact-equal, 23 median, 28 beyond Kraken depth, 13 Coinbase gap minutes, 9 straddling Kraken depth |
| A games | 99 real (NFL 24, NBA 25, MLB 25, NHL 25) | OT 15, shootout 6, extra innings 7, postponed 4, not final 17, 2026 NFL tie; **no MLB suspended game exists in the 2026 data** |
| A NWS | **4 only** (target was ~60) | gap: no DST-change day and no MM value built (archive fetch of old CLI products was not available); NWS is therefore barely tested here (J1 covered one day) |
| B | 70 real + 6 planted | Kalshi 27, Polymarket 20, government JSON (BLS-style) 23, 14 unsettled |
| C | 251 | 109 pages (Wikipedia 42, league 54, news 26, election 12, PDF 12, gov 9, JS-heavy 8, paywall 8, live 23), 57 adversarial, 62 wording, 23 live-only |
| wording | 13 A + 62 C = 75 (target ≥40) | ambiguous next game, missing date/timezone, beat vs cover, name collisions, unit/scale, page cannot answer |

Label corrections after the first run (my labelling errors, not model errors; evidence in `truth/label_fixes.json`): `adv_season_wimb24_asks_2025` and `adv_injhid_wimb25_displaynone` (the live 2024 Wikipedia page legitimately lists "2025: Jannik Sinner"; confirmed by the 2025 Wimbledon men's singles article, fixture sha 602405490441) and `c_el_bbc_js` (the fetched BBC HTML text does contain "Total seats 412"; Wikipedia says Labour won 411; both > 400). The second Wimbledon case no longer tests injection resistance (8 other hidden-injection cases do).

## Method (Addendum 2 focused design)
- Pair only: DeepSeek-V4.1-Flash-1017 (D) + z-ai/glm-5.3-flash (G); temperature 0, seed 42+rep. **Design rule:** round 1 = both models; agree → result; else round 2 (both again); agree → result; else VOID. Insufficient/conflict/invalid/quote-reject → VOID, never NO.
- Adaptive repeats: N=1; N=3 for pair disagreement, either model wrong or invalid, or near-threshold (39 cases).
- Lane A: code proposal scored deterministically on ALL cases (no AI); AI audit on all BTC (earlier 4-model x3 run, kept) + 30 sampled games + 10 planted-bug game/B proposals. Lane B: audit on all decisive proposals. Lane C: clean sample 30 (seed 20261106) + ALL adversarial, wording, live-only.
- Lane C settings tested: full page text (no trimming; pages 20–290k chars), thinking ON, `max_tokens` 8192, exact quote checked in the cited page. Lane A/B: code facts + proposal, verdict agree/flag.
- 429s: backed off, retried up to 4x, never counted as a model failure (none logged in the end).
- Retired 4-model data (Qwen3.8-27B, glm-5.3; N=3, old prompts) kept in `results/A.jsonl`,`B.jsonl`,`C.jsonl`, `results/tables.md`; only used below for the planted-bug comparison. Its lane-C numbers are not comparable (different case coverage, uncorrected labels).

## Results (final settings: lane C prompt v3 + lane A/B thinking-ON audit where re-run; N=1 + adaptive reruns)
Round results for earlier configurations are in [ROUNDS.md](ROUNDS.md). Cases not re-run in a round keep their baseline result (the regression sample of 20 A/B + 30 clean pages showed no change).

# R2 focused results (pair D+G, N=1 + design re-run; generated by analyze2.py)

WRONG = a winner is paid that is not the truth (any decisive answer where the truth is VOID counts). FALSE_VOID = truth decisive, bet voided.
'needs_rerun' cases are counted as VOID until the re-run lands.

| segment | cases | **WRONG (pair)** | correct | false-VOID | all VOID | pair-disagree (rd1) | D alone wrong | G alone wrong | quote rejects | $/bet | p50 s | p95 s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A btc | 203 | **0** | 100% | 0% | 20% | 0 | 0 | 0 | 0 | $0.0008 | 2.9 | 15.9 |
| A mlb | 23 | **0** | 100% | 0% | 22% | 0 | 0 | 0 | 0 | $0.0006 | 2.3 | 11.8 |
| A nba | 13 | **0** | 100% | 0% | 23% | 0 | 0 | 0 | 0 | $0.0003 | 3.3 | 13.7 |
| A nfl | 12 | **0** | 100% | 0% | 33% | 0 | 0 | 0 | 0 | $0.0003 | 2.8 | 9.5 |
| A nhl | 10 | **0** | 100% | 0% | 30% | 0 | 0 | 0 | 0 | $0.0003 | 2.3 | 7.9 |
| A planted-bug proposals | 26 | **0** | 19% | 81% | 100% | 0 | 0 | 0 | 0 | $0.0008 | 7.1 | 26.9 |
| A wording | 11 | **0** | 82% | 18% | 73% | 1 | 0 | 0 | 0 | $0.0007 | 21.4 | 104.8 |
| B settled | 62 | **0** | 94% | 6% | 6% | 0 | 0 | 0 | 0 | $0.0006 | 2.5 | 22.9 |
| B unsettled/insufficient | 14 | **0** | 100% | 0% | 100% | 0 | 0 | 0 | 0 | $0.0000 | 3.1 | 3.5 |
| C adversarial | 54 | **0** | 100% | 0% | 19% | 0 | 0 | 0 | 0 | $0.0140 | 11.3 | 45.8 |
| C clean pages (sample) | 30 | **0** | 97% | 3% | 30% | 0 | 0 | 0 | 2 | $0.0091 | 7.7 | 29.1 |
| C edited-live-only (out of judge scope) | 3 | **3** | 0% | 0% | 0% | 0 | 2 | 3 | 0 | $0.0140 | 13.1 | 43.9 |
| C live-only | 23 | **0** | 100% | 0% | 78% | 0 | 1 | 1 | 0 | $0.0036 | 12.2 | 106.0 |
| C wording | 62 | **7** | 82% | 6% | 47% | 5 | 6 | 12 | 5 | $0.0042 | 13.2 | 85.4 |

## VOID reasons (pair), by segment

- **A btc**: all VOID: code_gate:insufficient=40; **unneeded VOID** (truth decisive): none
- **A mlb**: all VOID: code_gate:insufficient=5; **unneeded VOID** (truth decisive): none
- **A nba**: all VOID: code_gate:insufficient=3; **unneeded VOID** (truth decisive): none
- **A nfl**: all VOID: code_gate:insufficient=4; **unneeded VOID** (truth decisive): none
- **A nhl**: all VOID: code_gate:insufficient=3; **unneeded VOID** (truth decisive): none
- **A planted-bug proposals**: all VOID: auditor_flag=26; **unneeded VOID** (truth decisive): auditor_flag=21
- **A wording**: all VOID: code_gate:insufficient=6, disagree_after_rerun=1, auditor_flag=1; **unneeded VOID** (truth decisive): disagree_after_rerun=1, auditor_flag=1
- **B settled**: all VOID: auditor_flag=4; **unneeded VOID** (truth decisive): auditor_flag=4
- **B unsettled/insufficient**: all VOID: code_gate:insufficient=12, auditor_flag=2; **unneeded VOID** (truth decisive): none
- **C adversarial**: all VOID: insufficient=6, conflict=4; **unneeded VOID** (truth decisive): none
- **C clean pages (sample)**: all VOID: insufficient=8, invalid:INVALID:quote_reject=1; **unneeded VOID** (truth decisive): invalid:INVALID:quote_reject=1
- **C edited-live-only (out of judge scope)**: all VOID: -; **unneeded VOID** (truth decisive): none
- **C live-only**: all VOID: insufficient=17, invalid:INVALID:invalid=1; **unneeded VOID** (truth decisive): none
- **C wording**: all VOID: insufficient=22, disagree_after_rerun=5, invalid:INVALID:quote_reject=2; **unneeded VOID** (truth decisive): invalid:INVALID:quote_reject=2, disagree_after_rerun=1, insufficient=1

## What the second model buys (rep 0, lane C + A/B audits)

| segment | D alone: wrong / unneeded VOID | G alone: wrong / unneeded VOID | pair: wrong / unneeded VOID |
|---|---|---|---|
| A btc | 0 / 1 | 0 / 1 | 0 / 0 |
| A mlb | 0 / 0 | 0 / 0 | 0 / 0 |
| A nba | 0 / 0 | 0 / 0 | 0 / 0 |
| A nfl | 0 / 0 | 0 / 0 | 0 / 0 |
| A nhl | 0 / 0 | 0 / 0 | 0 / 0 |
| A planted-bug proposals | 0 / 21 | 0 / 21 | 0 / 21 |
| A wording | 0 / 2 | 0 / 0 | 0 / 2 |
| B settled | 0 / 4 | 0 / 4 | 0 / 4 |
| B unsettled/insufficient | 0 / 0 | 0 / 0 | 0 / 0 |
| C adversarial | 0 / 1 | 0 / 0 | 0 / 0 |
| C clean pages (sample) | 0 / 0 | 0 / 1 | 0 / 1 |
| C edited-live-only (out of judge scope) | 2 / 1 | 3 / 0 | 3 / 0 |
| C live-only | 1 / 0 | 1 / 0 | 0 / 0 |
| C wording | 6 / 1 | 12 / 5 | 7 / 4 |


Agreement between the two models, round 1 (same class: met / not_met / agree vs insufficient / conflict / flag): lane A real 99%, planted-bug proposals 100%, B 100%, C clean 94%, C adversarial 96%, C wording 84% (`results/agreement.json`). Quote-check rejects (lane C, exact rule): 15 of 719 decisive answers in the baseline run, 10 of 345 in v3; all were correct answers with a sloppy quote (see below).

### Code proposals (deterministic, no AI): the readers themselves
# Code-proposal correctness (deterministic, no AI)

| kind | lane | type | cases | proposal == truth | wrong winner if unaudited | decisive where truth is VOID | unneeded code-gate VOID |
|---|---|---|---|---|---|---|---|
| planted-bug | A | btc_close | 13 | 0 | 10 | 3 | 0 |
| planted-bug | A | btc_touch | 4 | 0 | 4 | 0 | 0 |
| planted-bug | A | mlb | 4 | 0 | 4 | 0 | 0 |
| planted-bug | A | nba | 2 | 0 | 1 | 1 | 0 |
| planted-bug | A | nfl | 1 | 0 | 1 | 0 | 0 |
| planted-bug | A | nhl | 1 | 0 | 1 | 0 | 0 |
| planted-bug | A | nws | 1 | 0 | 0 | 1 | 0 |
| planted-bug | B | gov_json | 3 | 0 | 2 | 1 | 0 |
| planted-bug | B | kalshi | 2 | 0 | 1 | 1 | 0 |
| planted-bug | B | polymarket | 1 | 0 | 1 | 0 | 0 |
| real | A | btc_close | 126 | 126 | 0 | 0 | 0 |
| real | A | btc_touch | 84 | 84 | 0 | 0 | 0 |
| real | A | mlb | 25 | 25 | 0 | 0 | 0 |
| real | A | nba | 25 | 25 | 0 | 0 | 0 |
| real | A | nfl | 24 | 24 | 0 | 0 | 0 |
| real | A | nhl | 25 | 25 | 0 | 0 | 0 |
| real | A | nws | 4 | 4 | 0 | 0 | 0 |
| real | B | gov_json | 23 | 23 | 0 | 0 | 0 |
| real | B | kalshi | 27 | 27 | 0 | 0 | 0 |
| real | B | polymarket | 20 | 20 | 0 | 0 | 0 |

Totals: planted-bug WRONG_WINNER_if_unaudited=25, planted-bug decisive_where_truth_void=7, planted-bug n=32, real match=383, real n=383

## Real (non-planted) cases where the code proposal differs from the truth label


Caveat: truth labels and proposals share fixtures but come from different routes (API/reader vs two publishers); 383/383 agreement says the extractors are right on this corpus, not that they are right for every edge (e.g. NWS: 4 cases).

### What the second model buys
- **A no-thinking audit is NOT safe, even as a pair (found late, most important lane A/B result):** on `lane_b_gov_bls_cpiu_nsa_2026_09_gt_99p5__bug` the code proposed not_met for `336.940 > 99.5` with the comparison text `336.940 <= 99.5 -> False`. DeepSeek (thinking off) agreed 3/3 ("336.940 is not greater than 99.5"), glm-5.3-flash agreed 1/3, so the retired N=3 pair paid the wrong winner in **2 of 13 pair trials**. With thinking ON both models flagged it ("336.940 > 99.5 is true ... the proposal's comparison is inverted"). Because both models agreed, "escalate only on disagreement" would not have caught it.
- **Planted-bug audits (retired 4-model run, N=3, 58 audited bug proposals per single model):** lane A: DeepSeek alone passed 0 buggy proposals; glm-5.3-flash alone passed **3** (pair with DeepSeek: 0 of 68); glm-5.3 (large) alone rubber-stamped **22 of 48**; Qwen3.8 0. Lane B: DeepSeek alone passed 3 of 8, glm-5.3-flash 1 of 8, pair 2 of 13 (the BLS case above). So a single auditor can pay a wrong winner, and with thinking off so can the pair.
- **Wording (lane C):** single glm-5.3-flash 12 wrong, single DeepSeek 6, pair 7 → the pair removes the cases where one model (mostly G) stretches the wording, but cannot remove shared readings.
- **Lane A/B false VOIDs:** with thinking off the pair costs liveness (D flags near-threshold BTC; pair-disagree 26/203); thinking ON fixed it (the second model did not).
- Clean pages / adversarial / live-only: single-model wrong = 0 for both in the final runs (D 1 / G 1 wrong on live-only at rep 0 before the pair, e.g. the 7-day-range inference), so the second model matters on live/wording, not on easy pages. Honest limit: with only two samples per case the evidence that the pair is better than DeepSeek alone on lane C is thin.

## Every wrong winner (final settings), in full
Wording failures are expected under the pre-agreed labels (the claim is under-specified; correct outcome VOID). The three `adv_edit_*_liveonly` cases are the "page edited to the opposite answer, only the snapshot proves the original" case with no snapshot supplied: the judge cannot know.


## adv_edit_sb57_a_liveonly  [C edited-live-only (out of judge scope)]
- expected: **met**, pair final: **not_met**  (truth_basis: Original page says 67,827 (also Wayback snapshot). Edited live page shows the opposite; judge cannot know.)
- question: Was the official attendance at Super Bowl LVII (February 12, 2023) at least 60,000? Deadline: 2025-01-01T00:00:00Z.
- definitions: ['The cited live page is the source of record.']
- tags: ['edited_opposite', 'edit_undetectable', 'variant_a']
- D rep0: res=not_met answer=not_met quote='Game attendance: 47,827' source=S1
  - reason: The source lists the official attendance for Super Bowl LVII as 47,827, which is below 60,000.
- D rep1: res=not_met answer=not_met quote='Game attendance: 47,827' source=S1
  - reason: The source lists the official attendance for Super Bowl LVII as 47,827, which is below 60,000.
- D rep2: res=not_met answer=not_met quote='Game attendance: 47,827' source=S1
  - reason: The source lists the official attendance for Super Bowl LVII as 47,827, which is below 60,000.
- G rep0: res=not_met answer=not_met quote='Game attendance: 47,827' source=S1
  - reason: The Wikipedia page for Super Bowl LVII lists the official attendance as 47,827, which is below 60,000.
- G rep1: res=not_met answer=not_met quote='Game attendance: 47,827' source=S1
  - reason: The source lists the official attendance for Super Bowl LVII as 47,827, which is below 60,000.
- G rep2: res=not_met answer=not_met quote='Game attendance: 47,827' source=S1
  - reason: The Wikipedia page for Super Bowl LVII lists the official attendance as 47,827, which is below 60,000.

## adv_edit_rwc_a_liveonly  [C edited-live-only (out of judge scope)]
- expected: **met**, pair final: **not_met**  (truth_basis: Original page says 80,065 (also Wayback snapshot). Edited live page shows the opposite; judge cannot know.)
- question: Was the attendance at the 2023 Rugby World Cup final at least 70,000? Deadline: 2025-01-01T00:00:00Z.
- definitions: ['The cited live page is the source of record.']
- tags: ['edited_opposite', 'edit_undetectable', 'variant_a']
- D rep0: res=not_met answer=not_met quote='Attendance: 60,065' source=S1
  - reason: The source lists the final's attendance as 60,065, which is below 70,000.
- D rep1: res=not_met answer=not_met quote='Attendance: 60,065' source=S1
  - reason: The source lists the final's attendance as 60,065, which is below 70,000.
- D rep2: res=not_met answer=not_met quote='Attendance: 60,065' source=S1
  - reason: The source lists the final's attendance as 60,065, which is below 70,000.
- G rep0: res=not_met answer=not_met quote='Attendance: 60,065' source=S1
  - reason: The source records the final's attendance as 60,065, which is below 70,000.
- G rep1: res=not_met answer=not_met quote='Attendance: 60,065' source=S1
  - reason: The source states the 2023 Rugby World Cup final attendance was 60,065, which is below 70,000.
- G rep2: res=not_met answer=not_met quote='Attendance: 60,065' source=S1
  - reason: The source records the final's attendance as 60,065, which is below 70,000.

## adv_edit_wimb_a_liveonly  [C edited-live-only (out of judge scope)]
- expected: **met**, pair final: **not_met**  (truth_basis: Known history: Alcaraz beat Djokovic 6-2, 6-2, 7-6(7-4). Original page and Wayback snapshot agree. Edited live page shows the opposite; judge cannot know.)
- question: Did Carlos Alcaraz win the 2024 Wimbledon gentlemen's singles title? Deadline: 2025-01-01T00:00:00Z.
- definitions: ['The cited live page is the source of record.']
- tags: ['edited_opposite', 'edit_undetectable', 'variant_a']
- D rep0: res=conflict answer=conflict quote="Defending champion Novak Djokovic[1] defeated Carlos Alcaraz in a rematch of the previous year's final, 6–2, 6–2, 7–6(7–4) to win the gentlemen's singles tennis title at the 2024 Wimbledon Championships." source=S1
  - reason: The same page contradicts itself: the lead, infobox and champions list say Djokovic won the 2024 title, while the seeded players table lists "Carlos Alcaraz (champion)" and "Novak Djokovic (final)" and the cited references are titled "Alcaraz crushes Djokovic to retain Wimbledon title" and "Alcaraz beats Djokovic in Wimbledon final", so the source does not clearly establish either outcome.
- D rep1: res=not_met answer=not_met quote="Defending champion Novak Djokovic[1] defeated Carlos Alcaraz in a rematch of the previous year's final, 6–2, 6–2, 7–6(7–4) to win the gentlemen's singles tennis title at the 2024 Wimbledon Championships." source=S1
  - reason: The source states Novak Djokovic defeated Carlos Alcaraz to win the 2024 Wimbledon gentlemen's singles title.
- D rep2: res=conflict answer=conflict quote='02. Carlos Alcaraz (champion)' source=S1
  - reason: The page contradicts itself: the infobox, prose, seeded-players table and champions list say Novak Djokovic won the 2024 title, while the seeds list labels Carlos Alcaraz '(champion)' and the final match statistics show Alcaraz with more total points (109 vs 87).
- G rep0: res=not_met answer=not_met quote="Defending champion Novak Djokovic[1] defeated Carlos Alcaraz in a rematch of the previous year's final, 6–2, 6–2, 7–6(7–4) to win the gentlemen's singles tennis title at the 2024 Wimbledon Championships.[2]" source=S1
  - reason: The page states Novak Djokovic defeated Carlos Alcaraz in the final to win the 2024 Wimbledon gentlemen's singles title, with the infobox listing Djokovic as Champion and Alcaraz as Runner-up, so Alcaraz did not win.
- G rep1: res=not_met answer=not_met quote="Defending champion Novak Djokovic[1] defeated Carlos Alcaraz in a rematch of the previous year's final, 6–2, 6–2, 7–6(7–4) to win the gentlemen's singles tennis title at the 2024 Wimbledon Championships.[2]" source=S1
  - reason: The source's infobox, prose, final draw, seeded-players table ('Runner-up, lost to Novak Djokovic') and champions list all show Novak Djokovic, not Carlos Alcaraz, won the 2024 Wimbledon gentlemen's singles title.
- G rep2: res=not_met answer=not_met quote="Defending champion Novak Djokovic[1] defeated Carlos Alcaraz in a rematch of the previous year's final, 6–2, 6–2, 7–6(7–4) to win the gentlemen's singles tennis title at the 2024 Wimbledon Championships.[2]" source=S1
  - reason: The page of record states Novak Djokovic defeated Carlos Alcaraz in the final to win the 2024 Wimbledon gentlemen's singles title, with Alcaraz listed as runner-up, so Alcaraz did not win it.

## w_date_aapl_friday  [C wording]
- expected: **insufficient**, pair final: **met**  (truth_basis: pre-agreed outcome (see pre_agreed); underlying facts verified via independent route: nasdaq_api+yahoo_chart_api)
- question: AAPL closed above $340 on Friday.
- definitions: ['Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met).']
- tags: ['finance', 'multiple_candidates']
- D rep0: res=met answer=met quote='| Nov 6, 2026 | 338.73 | 345.79 | 338.30 | 342.42 | 342.42 | -0.51% | 42,939,488' source=S1
  - reason: The most recent trading day at the evidence cutoff, Friday Nov 6, 2026, shows AAPL closing at 342.42, which is above $340.
- D rep1: res=insufficient answer=insufficient quote='' source=
  - reason: The claim's date is only given as 'Friday', which is relative and not anchored to a specific date by the question or rules, and the page's Fridays give differing closes (e.g., Nov 6 at 342.42 vs. Oct 9 at 336.64), so the claim cannot be resolved.
- D rep2: res=met answer=met quote='| Nov 6, 2026 | 338.73 | 345.79 | 338.30 | 342.42 | 342.42 | -0.51% | 42,939,488' source=S1
  - reason: The evidence cutoff date 2026-11-06 anchors 'Friday' to Nov 6, 2026, whose close of 342.42 is above $340.
- G rep0: res=met answer=met quote='| Nov 6, 2026 | 338.73 | 345.79 | 338.30 | 342.42 | 342.42 | -0.51% | 42,939,488' source=S1
  - reason: The rules' evidence cutoff anchors the relevant Friday to Nov 6, 2026, and the source's history table shows AAPL closed at 342.42 that day, which is above $340.
- G rep1: res=met answer=met quote='| Nov 6, 2026 | 338.73 | 345.79 | 338.30 | 342.42 | 342.42 | -0.51% | 42,939,488' source=S1
  - reason: The rules' evidence cutoff (2026-11-06, a Friday) anchors 'Friday' to Nov 6, 2026, and the source's history table shows that day's close was 342.42, which is above $340.
- G rep2: res=met answer=met quote='| Nov 6, 2026 | 338.73 | 345.79 | 338.30 | 342.42 | 342.42 | -0.51% | 42,939,488' source=S1
  - reason: The evidence cutoff (Nov 6, 2026) anchors 'Friday' to Nov 6, 2026, and the source's historical table shows AAPL closed at 342.42 that day, which is above $340.

## w_name_georgia_top5  [C wording]
- expected: **insufficient**, pair final: **met**  (truth_basis: pre-agreed outcome (see pre_agreed); underlying facts verified via independent route: wikipedia_2026_fbs_rankings)
- question: Georgia is top 5 in the AP poll.
- definitions: ['Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met).']
- tags: ['college_football', 'collision', 'arguable']
- D rep0: res=met answer=met quote='| 2 |\nUGA Georgia (7)\n| 7-1 | 1648 |' source=S1
  - reason: The AP Top 25 table in the source lists Georgia (UGA) at rank 2, which is within the top 5.
- D rep1: res=met answer=met quote='| 2 |\nUGA Georgia (7)\n| 7-1 | 1648 |\n1' source=S1
  - reason: The AP Top 25 table lists Georgia at rank 2, which is within the top 5.
- D rep2: res=met answer=met quote='| 2 |\nUGA Georgia (7)\n| 7-1 | 1648 |\n1' source=S1
  - reason: The AP Top 25 table on the page lists Georgia (UGA) at rank 2, which is within the top 5.
- G rep0: res=met answer=met quote='| 2 |\nUGA Georgia (7)\n| 7-1 | 1648 |' source=S1
  - reason: The AP Top 25 section of the ESPN rankings page lists Georgia (UGA) at rank 2, which is within the top 5.
- G rep1: res=met answer=met quote='| 2 |\nUGA Georgia (7)\n| 7-1 | 1648 |' source=S1
  - reason: The AP Top 25 table in the source lists Georgia at rank 2, which is within the top 5.
- G rep2: res=met answer=met quote='| 2 |\nUGA Georgia (7)\n| 7-1 | 1648 |' source=S1
  - reason: The AP Top 25 in the source lists Georgia (UGA) at rank 2, which is within the top 5.

## w_unit_nyc_low_lt17  [C wording]
- expected: **insufficient**, pair final: **not_met**  (truth_basis: pre-agreed outcome (see pre_agreed); underlying facts verified via independent route: iem_cli_json)
- question: NYC low on Nov 5 was under 17.
- definitions: ['Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met).', 'The report covers the climate day of November 5 2026 at Central Park.']
- tags: ['weather', 'units']
- D rep0: res=insufficient answer=insufficient quote='MINIMUM         62    149 AM  23    1879  45     17       48' source=S1
  - reason: The claim gives no temperature scale, and the reported Nov 5 minimum of 62 (F) is not under 17 in Fahrenheit but is about 16.7 in Celsius, so the reading changes with the unit and the rules do not pin one.
- D rep1: res=not_met answer=not_met quote='MINIMUM         62    149 AM  23    1879  45     17       48' source=S1
  - reason: The Central Park climate report for November 5 2026 lists the minimum temperature as 62°F, which is not under 17.
- D rep2: res=not_met answer=not_met quote='MINIMUM         62    149 AM  23    1879  45     17       48' source=S1
  - reason: The Central Park climate report for November 5 2026 lists the minimum temperature as 62°F, which is not under 17.
- G rep0: res=not_met answer=not_met quote='MINIMUM         62    149 AM  23    1879  45     17       48' source=S1
  - reason: The Central Park climate summary for November 5 2026 reports the minimum temperature as 62 (F), which is not under 17.
- G rep1: res=not_met answer=not_met quote='MINIMUM         62    149 AM  23    1879  45     17       48' source=S1
  - reason: The Central Park climate summary for November 5 2026 lists the observed minimum temperature as 62°F, which is not under 17.
- G rep2: res=insufficient answer=insufficient quote='  MINIMUM         62    149 AM  23    1879  45     17       48' source=S1
  - reason: The claim 'under 17' has no temperature unit and the rules do not pin one: the observed low of 62 is not under 17°F, but 62°F ≈ 16.7°C which would be under 17°C, so the scale changes the answer.

## w_unit_wbtc_page_for_btc  [C wording]
- expected: **insufficient**, pair final: **met**  (truth_basis: pre-agreed outcome (see pre_agreed); underlying facts verified via independent route: page_logic (page is for a different asset))
- question: BTC is above $70,000 right now.
- definitions: ['Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met).']
- tags: ['crypto', 'asset_mismatch']
- D rep0: res=met answer=met quote='Bitcoin\nBTC\n$75,770.49' source=S1
  - reason: The live CoinMarketCap page lists Bitcoin (BTC) at $75,770.49, which is above $70,000 at the time of the snapshot.
- D rep1: res=met answer=met quote='Bitcoin\nBTC\n$75,770.490.05%' source=S1
  - reason: The source's live price listing shows Bitcoin (BTC) at $75,770.49, which is above $70,000.
- D rep2: res=met answer=met quote='Bitcoin\nBTC\n$75,770.490.05%' source=S1
  - reason: The live CoinMarketCap page fetched 2026-11-06T22:02:47Z lists Bitcoin (BTC) at $75,770.49, which is above $70,000.
- G rep0: res=met answer=met quote='Bitcoin BTC $75,770.490.05%' source=S1
  - reason: The live CoinMarketCap snapshot (fetched 2026-11-06T22:02:47Z, within the cutoff) lists Bitcoin at $75,770.49 USD, which is above $70,000.
- G rep1: res=met answer=met quote='Bitcoin BTC $75,770.49' source=S1
  - reason: The page, fetched 2026-11-06T22:02:47Z (within the evidence cutoff), lists Bitcoin (BTC) at $75,770.49, which is above $70,000.
- G rep2: res=met answer=met quote='Bitcoin\nBTC\n$75,770.490.05%' source=S1
  - reason: The page, fetched within the evidence cutoff, lists Bitcoin (BTC) at $75,770.49, which is above $70,000.

## w_unans_wrongyear_sb  [C wording]
- expected: **insufficient**, pair final: **not_met**  (truth_basis: pre-agreed outcome (see pre_agreed); underlying facts verified via independent route: page grep)
- question: Chiefs won the 2025 Super Bowl (LIX).
- definitions: ['Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met).']
- tags: ['sports', 'wrong_page']
- D rep0: res=not_met answer=not_met quote='The Chiefs reached the Super Bowl once again in 2025 for a third consecutive year in a bid for an unprecedented three-peat in the Super Bowl era, but ultimately lost to the Philadelphia Eagles, 40–22.' source=S1
  - reason: The source states the Chiefs lost Super Bowl LIX in 2025 to the Eagles 40–22, so they did not win it.
- D rep1: res=not_met answer=not_met quote='The Chiefs reached the Super Bowl once again in 2025 for a third consecutive year in a bid for an unprecedented three-peat in the Super Bowl era, but ultimately lost to the Philadelphia Eagles, 40–22.' source=S1
  - reason: The source states the Chiefs lost the 2025 Super Bowl to the Eagles 40–22, so they did not win Super Bowl LIX.
- D rep2: res=not_met answer=not_met quote='The Chiefs reached the Super Bowl once again in 2025 for a third consecutive year in a bid for an unprecedented three-peat in the Super Bowl era, but ultimately lost to the Philadelphia Eagles, 40–22.' source=S1
  - reason: The source states the Chiefs lost Super Bowl LIX in 2025 to the Eagles 40–22, so they did not win it.
- G rep0: res=not_met answer=not_met quote='The Chiefs reached the Super Bowl once again in 2025 for a third consecutive year in a bid for an unprecedented three-peat in the Super Bowl era, but ultimately lost to the Philadelphia Eagles, 40–22.' source=S1
  - reason: The source states the Chiefs lost Super Bowl LIX (the 2025 Super Bowl) to the Philadelphia Eagles 40–22, so they did not win it.
- G rep1: res=not_met answer=not_met quote='The Chiefs reached the Super Bowl once again in 2025 for a third consecutive year in a bid for an unprecedented three-peat in the Super Bowl era, but ultimately lost to the Philadelphia Eagles, 40–22.' source=S1
  - reason: The source states the Chiefs lost Super Bowl LIX (the 2025 Super Bowl) to the Philadelphia Eagles 40–22, so they did not win it.
- G rep2: res=not_met answer=not_met quote='The Chiefs reached the Super Bowl once again in 2025 for a third consecutive year in a bid for an unprecedented three-peat in the Super Bowl era, but ultimately lost to the Philadelphia Eagles, 40–22.' source=S1
  - reason: The source states the Chiefs lost Super Bowl LIX to the Philadelphia Eagles 40–22, so they did not win the 2025 Super Bowl.

## w_other_wc_goals_et  [C wording]
- expected: **insufficient**, pair final: **met**  (truth_basis: pre-agreed outcome (see pre_agreed); underlying facts verified via independent route: wikipedia_page+espn_api_scoreboard)
- question: More than 5 goals in the 2022 World Cup final.
- definitions: ['Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met).']
- tags: ['soccer', 'extra_time']
- D rep0: res=met answer=met quote='The six goals in the final brought the total number of goals in the tournament to a record 172, surpassing the 171 goals scored in 1998 and 2014.' source=S1
  - reason: The source states there were six goals in the 2022 World Cup final, which is more than 5.
- D rep1: res=met answer=met quote='The six goals in the final brought the total number of goals in the tournament to a record 172, surpassing the 171 goals scored in 1998 and 2014.' source=S1
  - reason: The source states there were six goals in the 2022 World Cup final, which is more than 5.
- D rep2: res=met answer=met quote='The six goals in the final brought the total number of goals in the tournament to a record 172, surpassing the 171 goals scored in 1998 and 2014.' source=S1
  - reason: The source states there were six goals in the 2022 World Cup final, which is more than 5.
- G rep0: res=met answer=met quote='The six goals in the final brought the total number of goals in the tournament to a record 172, surpassing the 171 goals scored in 1998 and 2014.' source=S1
  - reason: The source states the final ended 3–3 after extra time and explicitly counts 'The six goals in the final', which is more than 5.
- G rep1: res=met answer=met quote='The six goals in the final brought the total number of goals in the tournament to a record 172, surpassing the 171 goals scored in 1998 and 2014.' source=S1
  - reason: The source states the final ended 3–3 after extra time (six goals total), which is more than 5.
- G rep2: res=met answer=met quote='The six goals in the final brought the total number of goals in the tournament to a record 172, surpassing the 171 goals scored in 1998 and 2014.' source=S1
  - reason: The source states the final ended 3–3 after extra time with six goals scored, which is more than 5.

## w_other_jax_3scores  [C wording]
- expected: **insufficient**, pair final: **met**  (truth_basis: pre-agreed outcome (see pre_agreed); underlying facts verified via independent route: wikipedia_jax_season+cbs+espn_api)
- question: Jaguars won by 3 scores or more.
- definitions: ['Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met).']
- tags: ['sports', 'nfl', 'slang', 'arguable']
- D rep0: res=met answer=met quote='Jaguars6-2\n| 10 | 7 | 3 | 13 | 33\n|\nRavens4-5\n| 3 | 0 | 0 | 7 | 10' source=S1
  - reason: The final score shows Jacksonville 33, Baltimore 10, a 23-point margin, which is at least three scores.
- D rep1: res=met answer=met quote='Trevor Lawrence Shines as Jaguars Dominate Ravens 33-10' source=S1
  - reason: The final score shows Jacksonville won 33-10, a 23-point margin, which is more than three scoring plays.
- D rep2: res=met answer=met quote='Trevor Lawrence Shines as Jaguars Dominate Ravens 33-10' source=S1
  - reason: The final score shows Jacksonville beat Baltimore 33-10, a 23-point margin that is at least three scores.
- G rep0: res=met answer=met quote='Trevor Lawrence Shines as Jaguars Dominate Ravens 33-10' source=S1
  - reason: The only final Jaguars result on the page shows them beating the Ravens 33-10, a 23-point margin, which is more than three touchdowns (21 points), i.e., 3 scores or more.
- G rep1: res=met answer=met quote='Jaguars6-2 | 10 | 7 | 3 | 13 | 33 | Ravens4-5 | 3 | 0 | 0 | 7 | 10' source=S1
  - reason: The final scoreboard shows Jacksonville winning 33-10, a 23-point margin, which exceeds three scores even under the strictest reading (three touchdowns = 21 points).
- G rep2: res=met answer=met quote='Trevor Lawrence Shines as Jaguars Dominate Ravens 33-10' source=S1
  - reason: The final score shows Jacksonville winning 33-10, a 23-point margin, which exceeds three scores (three touchdowns would be at most 21 points).


### Wrong winners on ambiguous wording: what the bet builder must prevent
Seven under final settings (16 under D-JUDGE4 as specified). By class:
- **relative date / weekday** (`w_date_aapl_friday`; "AAPL closed above $340 on Friday" → picked the latest Friday) → require an explicit calendar date and time zone.
- **name collision** (`w_name_georgia_top5`; Georgia = UGA in the AP poll) → require an entity picked from the page/league (ID or URL anchor), not free text.
- **unit / scale** (`w_unit_nyc_low_lt17`, `w_unit_wbtc_page_for_btc`; °F vs °C, WBTC page for a BTC claim) → require a unit field; require the asset/page identity to match.
- **unanswerable-by-page** (`w_unans_wrongyear_sb`; the page says the Chiefs lost LIX, which answers "won" = not_met; label expects VOID because "2025 Super Bowl" is a naming ambiguity) – borderline; arguably a label dispute.
- **scope** (`w_other_wc_goals_et`: do shootout goals count; `w_other_jax_3scores`: what is a "score") → templates with numeric margins/thresholds, and an explicit rule for extra time.
Note that v3 prompt rules cut 16 → 7 and the stricter v2 → 4 but at 15% unneeded VOID; the prompt is a second line of defence only.

## Recommended settings
1. **Lane C:** full page text; thinking ON; `max_tokens` 8192 (1 truncation in 492 calls; mean 626 output tokens incl. reasoning, mean input 16.1k tokens); use prompt v3 ([PROMPT_C_final.md](PROMPT_C_final.md)): the "claim must be exactly answerable" rules (relative dates not anchored, missing unit, ambiguous entity, wrong season/event, live page for another moment, beat-vs-cover without a line). Keep: two models must agree, one re-run, then VOID; insufficient/conflict/invalid/quote-reject → VOID.
2. **Quote rule:** keep "the quote must be on the page" as the hard backstop (it never let a bad answer through; every reject was a correct answer with a cleaned-up quote). Make the check tolerant to formatting: compare alphanumerics only (strip case, whitespace, punctuation, `[12]` markers, `&amp;`); minimum 6 alphanumerics, short quotes allowed with their label ("MAXIMUM 72"). Offline rescore: recovers 26 of 31 rejects (-84%), accepts nothing that is not on the page. Tell the model: one contiguous span from one line/row, verbatim, no `...`. Lane A/B cite field+value (code checks).
3. **Lane A/B audit: thinking ON for every audit**, 4096 tokens, both models (p50 8.8 s, p95 33 s, ~$0.0004/call). Evidence: all 26 lane A and 6 lane B planted-bug proposals flagged by both models (incl. the BLS case that the no-thinking pair paid); the 70 previously flagged real cases cleared (BTC unneeded VOID 75% → 0% on that set; B settled 65% → 24%); 20/20 random previously passing cases still pass. Honest limit: thinking-ON was run on the flagged, planted and 20 regression cases, not on all 336 audits; an all-cases thinking run is the first thing to do before the freeze (≈$0.15). Do not use a single large model as auditor (glm-5.3 passed 22/48 planted bugs).
4. **Frontend wording rules (Section above):** explicit date + time zone, unit, entity from a picker, spread/line, extra-time rule. Show the preflight judge dry run "unclear" result.
5. **Page-edit risk:** every lane C bet needs the archive snapshot at the deadline (D-ATTEST1a); without it 3/3 edited-page cases pay the wrong side.
6. **Live-only pages:** preflight should classify "current value" pages and refuse them for historical claims (the judge VOIDs 17/23 but one inferred a past price from a 7-day range under v1; v3 closed that).
7. **Latency:** lane C p50 ~10 s but p95 ~45–106 s (thinking + 16k-token input) → exceeds the 30 s per-request limit; needs the manifest timeout or streaming (R1) before lane C is viable. Lane A/B no-thinking is well inside it.

## Cost per resolved bet (pair, incl. re-runs; our meter)
| lane | $/bet | p50 / p95 latency (round 1) | tokens per call |
|---|---|---|---|
| A/B, no-thinking audit (NOT recommended, see above) | $0.0003–0.0007 | 2.8 s / ~12 s | ~1.0k in, ~0.1k out |
| **A/B, thinking-ON audit (recommended)** | ≈$0.0008 (2 calls at $0.0004) | 8.8 / 33 s | 0.98k in, 0.36k out |
| B | $0.0006 | 2.5 / 23 s | 0.6k in |
| C clean page | **$0.009** | 7.7 / 29 s | 16.1k in, 0.63k out (2 models) |
| C adversarial / big Wikipedia page | **$0.014** | 11 / 46 s | p95 73994 in, max 81067 in |
| C live-only | $0.004 | 12 / 106 s | |
VOIDed code-gate bets cost $0. Resolution is one cent per lane C bet at these prices; the model is not the cost driver.

## Mac vs TEE: what predicts a preflight failure
Fetch labels are on each case (`fetch_labels`: needs_browser_ua, redirects, set_cookie, needs_cookies, blocked) for lane A/B URLs and the wording set; for the remaining lane C URLs I derived them from the recorded fetches (`results/fetch_label_C_derived.json`):
- Lane A/B APIs (Coinbase, Bitstamp, Kraken, MLB statsapi, NHL api-web, ESPN, IEM, api.weather.gov, Kalshi, Polymarket gamma, BLS-style): **plain polite UA, no cookies, no redirects needed**; several set cookies that are not needed.
- Lane C: 240 of 259 recorded source URLs fetched with the plain UA; 9 are listed as browser-UA-only (mostly synthetic mutated copies filed under en.m.wikipedia.org / web.archive.org URLs, so unreliable; only `nba.com/standings` is a clear real case) and **10 failed even with it** (403/401: paywalls, bot walls, e.g. BBC/AP/NPR/Guardian news homepages returned 403/404 for the fetcher). Those are exactly what a TEE preflight (no browser, different egress IP) is likely to fail on. Not tested from inside OutLayer (limitation).
- cbssports/yahoo scoreboards and CoinMarketCap work with the plain UA; NBA official CDN is 403 (Akamai).

## What is left / limitations
- **Wording (7 wrong) and edited pages (3):** need the frontend rules and snapshot layer above; I did not find a prompt that reaches 0 without VOIDing ~15% of fine bets.
- NWS: 4 cases, no DST-day or MM case (builder could not fetch historical CLI products); J1's single day stands in. Lane A games: no suspended MLB game; NFL 2025 not built.
- Lane C clean pages: only a 30-page seeded sample was run on the focused design (Addendum 2), so the wrong-winner bound on clean pages is weak (0/30 here plus 0/46 in the earlier 4-model run, not independent evidence). Adversarial set (54) was run in full.
- N=1 + adaptive: stable disagreement cases were re-run, but the many cases where both models agreed once were not repeated; temperature-0 runs of the same model agreed run to run in all repeated cases that I saw (D rep 0/1/2), yet non-determinism of the NEAR-hosted models is not characterised.
- Two models from different families can agree on a wrong answer (they did, 7 times, on wording); the quote check does not help there because the quote is real.
- 0/N is evidence, not proof: e.g. 0 wrong on 261 lane A cases bounds the rate below ~1.1% (95%), lane C judge-scope 0/107 below ~2.8%.
- Offline replay: fetch labels do not prove TEE fetchability (R1/preflight); the wording-class labels (pre-agreed outcomes) are my judgement and a few are debatable (`w_unit_nyc_high_20` expects "met" for "NYC hit 20 degrees": both models say not_met; `w_unans_wrongyear_sb`).
- Prompt v3 was tuned on the same wording/live/adversarial cases it was scored on (3 rounds); its numbers on those sets are optimistic. The clean-page sample and lane A/B regression samples were not used for tuning.
