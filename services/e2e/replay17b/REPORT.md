# Item 17b: resolvability replay (complete)

Entry point: `build_submission_with` (same path as the TEE judge: lint -> price-window / fetch-admit -> D-RESOLVE6/8/6b gates -> judge -> decide).
Judge = scripted, recorded stand-in (no NEAR AI; $0). Harness: `resolver/wasm-bin/src/item17b_tests.rs` (9 tests, in `cargo test` / `./test.sh fast`).
Fixtures: `resolver/wasm-bin/fixtures/replay17b/` (`manifest.json`: source URL + fetch time per file). Resolver behaviour unchanged (evidence only).
Green tests assert current behaviour only where it equals the design doc; divergences are in `GAPS.md` + `gap_tests_designed.rs.txt` / `gap_test_d_kraken_depth.rs.txt` (text, not compiled).

## Template x event table
"Replayed" = run through the code path; "design" = what the MVP bet design doc (3 types) says should happen.
| Template | Event | Outcome (current) | Design | Reason / code path | Source used |
|---|---|---|---|---|---|
| 1b touch | A near miss X=75,970 | **NO** (green) | NO | all 3 venues complete, no high >= X: D-RESOLVE6b code-NO | CB+BS+KR 1m |
| 1b | A X=75,930 (CB, KR touched; BS 75,925 not) | **YES** (green) | YES (2 of 3) | judge cites CB row | CB+BS+KR |
| 1b | A X=75,931 (only KR touched) | **VOID** with honest judge; **YES** if judge cites the KR row | NO (1 of 3) | code-NO refused (KR high >= X); no code counts venues: quorum lives in prose only. GAP-3 | CB+BS+KR |
| 1b | B all touched X=76,080 | **YES** (green) | YES | judge cites CB row | CB+BS+KR |
| 1b | G real Coinbase gap (2 of 360 candles) X=77,340 | **YES** (green) | YES | CB COMPLETE_WITH_GAPS, BS covers; Kraken INCOMPLETE (8 d old), 2 venues enough | CB+BS |
| 1b | D Kraken beyond 12 h depth | **VOID** | NO | Kraken `since` ignored -> 0 in-window candles -> code-NO needs every listed venue complete. GAP-1 | CB+BS (KR excluded) |
| 1b | A, CB+BS+Gemini (no Kraken) X=75,970 | NO | NO | Gemini is fetched as generic 88 KB text and ignored by the price gates ("all 2 price venues"). GAP-6 | CB+BS (GM ignored) |
| 1a close at T | A (median 75,925.00), B (75,901.36), C (75,691.93) | **not expressible** | YES/NO by median close | evidence rows are candle HIGH only; no close/median/mean-of-2/straddle code. Full-window sheet reaches the judge with 60 HIGH rows per venue and nothing to decide from -> ESCALATE -> VOID; a 1-minute window needs per-minute fetch URLs (none admissible). Closes/medians asserted from fixtures only (green data test). GAP-2 | CB+BS+KR |
| 2 MLB 849799 | MIL 4-1 TB, "MIL wins" | **YES** (green) | YES | both sources fetched (statsapi + ESPN, 20 KB + small), judge cites `"score":4,"isWinner":true` | MLB Stats API + ESPN |
| 2 MLB 849799 | "TB wins" | **NO** (green) | NO | judge `not_met` w/ verified quote | MLB Stats API + ESPN |
| 2 NHL 2026020261 | NSH 3-2 COL, OT, OFF; "NSH wins" | **VOID** | YES | api-web (86 KB) + ESPN (332 KB) together exceed per-element prompt cap -> BUDGET_EXCEEDED, judge never called. GAP-5 | NHL api-web + ESPN |
| 2 NFL 401873026 | BUF 36-10 BAL, STATUS_FINAL; "BUF wins" | **VOID** (INVALID_INPUT) | YES (single-source ESPN launch) | lint "need >= 2 independent origins"; same ESPN URL twice = one origin. Control: a self-declared different `origin` for the same URL passes and resolves YES, i.e. the gate is declaration-based. GAP-5 | ESPN |
| 3 KNYC 2026-11-05 = 72F | NWS CLI product (issued 11-06T06:45Z, `MAXIMUM 72`) + IEM (`high: 72`), ">= 72" | **YES** from IEM alone (control); NWS CLI source **dropped** | YES on agreement of both copies | NWS CLI is `application/ld+json` -> "content-type not allowed" FETCH_FAIL. IEM year file is 389 KB, fits cap (391,615 of 414,464 B) as raw text; no climate-day (LST), no `MM`, no agreement check. GAP-4 | IEM only |

Coinbase gap scan (60 d, 288 requests, 0 errors): only 2 real gap runs (2026-10-02T16:47Z 1 min, 2026-10-30T19:55Z 2 min); no synthetic fixture needed.

## Suspected gaps 2-6: confirmed / refuted by replay
- GAP-2 (1a): **confirmed** by replay.
- GAP-3 (1b >=2-of-3): **confirmed**, and worse than static reading (see wrong-winner risk).
- GAP-4 (NWS/IEM): **confirmed, with a new finding** (NWS CLI dropped on content-type). The "IEM 389 KB exceeds prompt cap" suspicion is **refuted**: it fits, barely.
- GAP-5 (sports): **confirmed** for NFL (lint gate) and NHL (prompt cap, a new cause; ESPN NHL day is 332 KB). MLB works.
- GAP-6 (Gemini): **confirmed**; Gemini is silently ignored as a price venue.

## Open risk observations (not fixed)
- **YES accepted on a single judge-cited Coinbase row; only the NO direction is code-verified.** Code verifies NO (every venue complete, no high >= X); YES needs only one judge quote that exists verbatim in a source. Quote verification checks the text exists, not that it means what the judge says or that a second venue agrees. Replay: X=75,931 with only Kraken touched resolves YES when the judge cites the KR row (design: NO). Wrong-winner path is judge error/compromise, not a deterministic bug.
- Same weakness for sports/weather: any verbatim quote from an admitted source is accepted (e.g. a `"score":4` row), no extraction check.
- `origin` is bettor-declared; the two-origin gate does not prove independence.
