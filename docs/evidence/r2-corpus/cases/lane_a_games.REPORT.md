# lane_a_games.jsonl report (build/build_games2.py; reproducible from fixtures/, `python3 -I build/build_games2.py`)

99 real cases + 8 planted-bug copies (`__bug`, `planted_bug:true`, proposal flipped, expected = true answer; 7 met/not_met flips, 1 insufficient->met).
By type: nfl 24, nba 25, nhl 25, mlb 25. Expected: not_met 43, met 41, insufficient 15. Question forms: beat 60, over/at-least 39 (9 with threshold == total).
Tags: ot 15 (incl. 5 NFL, 5 NBA, 5 NHL), shootout 6, tie 1 (NFL WSH-NYG 27-27 OT, 2026-10-11), extra_innings 6, postponed 4, cancelled 1,
completed_early 2 (rain-shortened, official final), postseason 3 (MLB), scheduled 10 (NFL 4, NBA 3, NHL 3; future games -> insufficient).

## Independent truth
Reader (code under test) = honest reader in build_games.py over ESPN site.api scoreboard (all NFL/NBA; ~half of NHL/MLB), the league-official API
(MLB statsapi gamePk, NHL api-web /score/<date>; tag reader_official) or both (NHL only, reader_both). Truth = >= 2 publishers that are NOT the
reader's source, agreeing on final/not-final and (if final) on both scores:
- NFL, NBA: CBS Sports scoreboard (server-rendered HTML) + Yahoo Sports scoreboard (schema.org SportsEvent JSON-LD). ESPN is the reader.
- NHL: CBS + Yahoo (+ NHL api-web when ESPN is the reader). MLB: CBS + Yahoo + whichever of ESPN/statsapi is not the reader.
- `truth_source` lists the publishers used (e.g. "cbs+yahoo", "official+cbs+yahoo"); `truth_evidence` has per publisher: status string, score, URL, fetch time, sha256[:12],
  plus the reader-side value for comparison. Tag `reader_source_disagrees_with_truth` would mark source errors (none occurred; ESPN/official agreed with CBS+Yahoo on every kept game, so `code_wrong` is also empty).
- Non-final cases (scheduled, postponed, cancelled): all independent publishers say not final (e.g. Yahoo EventPostponed / EventCancelled, statsapi Postponed).

## Dropped (counted)
- NBA 3: CBS had no entry for the game (page/date mismatch) -> only 1 independent publisher.
- MLB 1: ambiguous CBS match (doubleheader, same teams twice on one page).
- Not built at all (no second publisher): NFL 2025 season (incl. the 2025-09-28 DAL-GB 40-40 OT tie): Yahoo only serves the current NFL season by week, nfl.com hides scores
  (blurred), pro-football-reference 403. Only the 2026 NFL tie is in. NBA official cdn.nba.com is 403 (Akamai) for both UAs; nba.com/games works with a browser UA
  (JSON in __NEXT_DATA__) but was not needed. Shortfall: MLB completed_early 2/3 (only 2 exist Mar 25 - Oct 31 2026).

## Not found / caveats
- No MLB `Suspended` game exists in statsapi for 2026-03-25..2026-10-31; no in-progress game existed at build time (Fri 22:00Z, all slates finished/future), so no live cases.
- NFL/NBA truth rests on CBS+Yahoo (two independent publishers) but there is no league-official third source; MLB/NHL also have the official API.
- Yahoo MLB/NFL/NBA/NHL pages and CBS use the polite UA with no cookies (needs_browser_ua false in fetch_labels).
- NHL matching bug fixed: ESPN event id != NHL gameId; match is by ET date + team on api-web /score/<date>, whose teams carry name.default (not placeName/commonName, the cause of the old failure). NHL cases with reader_official/both use the NHL gameId in the question.
- Postponed MLB: CBS shows only a generic pregame/postgame status for them, so CBS is weak evidence there; Yahoo/statsapi/ESPN give explicit Postponed.
- Helper modules: build/cbs_lib.py, build/yahoo_lib.py (parsers), reuses reader/facts/question code from build/build_games.py. The old build_games.py stage-1 /tmp output is unused.
