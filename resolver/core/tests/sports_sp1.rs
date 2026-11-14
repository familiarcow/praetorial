//! SP1 (D-TPL1, D-SPORTS2): MLB marks Postponed (codedGameState D) and Cancelled (C) games abstractGameState "Final" with no
//! scores, and replays a postponed game under the SAME gamePk on the make-up date. A game is final only when
//! abstractGameState == Final AND codedGameState == F. Real payloads are under fixtures/sports (see its README.md).
use praetorial_core::sports::*;
use serde_json::{json, Value};

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/sports");
const LATE: i64 = 1_800_000_000;
const NOTE: &str = "MLB shows the game postponed/cancelled on the pinned date";
fn fx(f: &str) -> Value { serde_json::from_slice(&std::fs::read(format!("{}/{}", DIR, f)).unwrap()).unwrap() }
fn lg(league: &str, file: &str, id: &str) -> Value { league_event(league, &fx(file), id).unwrap_or_else(|| panic!("{} {} not in {}", league, id, file)) }
fn espn(file: &str, id: &str) -> Src { parse_espn(&espn_event_by_id(&fx(file), id).unwrap_or_else(|| panic!("ESPN {} not in {}", id, file))).unwrap() }
fn run(l: &Value, league: &str, e: &Src, pick_home: bool) -> Decision {
    let l = parse_league(league, l).unwrap();
    let pick = if pick_home { l.home.id.clone() } else { l.away.id.clone() };
    decide(false, &pick, LATE, Some(&l), Some(e))
}
/// synthetic variant (derived from the real payload `ev`): the same game but carrying 0-0 scores.
fn zero_zero(mut ev: Value) -> Value {
    ev["teams"]["home"]["score"] = json!(0);
    ev["teams"]["away"]["score"] = json!(0);
    ev
}
fn espn_zero_final(mut s: Src) -> Src {
    s.is_final = true;
    s.home.score = Some(0);
    s.away.score = Some(0);
    s
}
fn assert_retry_note(d: &Decision) {
    assert_eq!(d.word(), "RETRY", "{:?}", d);
    assert!(d.why().contains(NOTE), "missing named note: {}", d.why());
}

#[test]
fn real_postponed_game_is_retry_with_named_note() {
    let l = lg("MLB", "mlb_schedule_20260402.json", "824621");
    assert_eq!(l["status"]["codedGameState"], "D");
    assert_retry_note(&run(&l, "MLB", &espn("espn_mlb_scoreboard_20260402.json", "401814780"), true));
}
#[test]
fn real_cancelled_game_is_retry_with_named_note() {
    let l = lg("MLB", "mlb_schedule_20260927.json", "823490");
    assert_eq!(l["status"]["codedGameState"], "C");
    assert_retry_note(&run(&l, "MLB", &espn("espn_mlb_scoreboard_20260927.json", "401817103"), true));
}
#[test]
fn synthetic_postponed_with_0_0_scores_never_a_tie_void_or_decision() {
    // SYNTHETIC: real 824621 postponed object + 0-0 scores, and an ESPN that (wrongly) says Final 0-0.
    let l = zero_zero(lg("MLB", "mlb_schedule_20260402.json", "824621"));
    let e = espn_zero_final(espn("espn_mlb_scoreboard_20260402.json", "401814780"));
    assert_retry_note(&run(&l, "MLB", &e, true));
    assert_retry_note(&run(&l, "MLB", &e, false));
}
#[test]
fn synthetic_postponed_0_0_against_the_real_makeup_final_is_still_retry() {
    // SYNTHETIC league object (postponed, 0-0) vs the REAL ESPN final 5-4 of the make-up game: never decided from it.
    let l = zero_zero(lg("MLB", "mlb_schedule_20260402.json", "824621"));
    assert_retry_note(&run(&l, "MLB", &espn("espn_mlb_scoreboard_20260403.json", "401867263"), true));
}
#[test]
fn synthetic_cancelled_with_0_0_scores_never_a_tie_void_or_decision() {
    let l = zero_zero(lg("MLB", "mlb_schedule_20260927.json", "823490"));
    let e = espn_zero_final(espn("espn_mlb_scoreboard_20260927.json", "401817103"));
    assert_retry_note(&run(&l, "MLB", &e, true));
}
#[test]
fn postponed_status_is_not_final_even_when_abstract_state_is_final() {
    let s = parse_league("MLB", &lg("MLB", "mlb_schedule_20260402.json", "824621")).unwrap();
    assert!(!s.is_final);
    let s = parse_league("MLB", &lg("MLB", "mlb_schedule_20260927.json", "823490")).unwrap();
    assert!(!s.is_final);
}
#[test]
fn makeup_game_final_on_the_makeup_date_decides_normally() {
    // the same gamePk on 04-03 is a normal final (CHW 5 - TOR 4, ESPN Final/10)
    let l = lg("MLB", "mlb_schedule_20260403.json", "824621");
    assert_eq!(l["status"]["codedGameState"], "F");
    let e = espn("espn_mlb_scoreboard_20260403.json", "401867263");
    assert_eq!(run(&l, "MLB", &e, true).word(), "YES"); // home CHW won
    assert_eq!(run(&l, "MLB", &e, false).word(), "NO");
}
#[test]
fn completed_early_coded_f_is_a_valid_final() {
    let l = lg("MLB", "mlb_schedule_20260404.json", "824295");
    assert_eq!(l["status"]["detailedState"], "Completed Early");
    let e = espn("espn_mlb_scoreboard_20260404.json", "401814802");
    let d = run(&l, "MLB", &e, true);
    assert_eq!(d.word(), "YES", "{:?}", d); // DET 11 - STL 6
    assert_eq!(run(&l, "MLB", &e, false).word(), "NO");
}
#[test]
fn nhl_overtime_and_shootout_decide_normally() {
    let l = lg("NHL", "nhl_score_20261105.json", "2026020251"); // MTL 5 UTA 4 OT
    let d = run(&l, "NHL", &espn("espn_nhl_scoreboard_20261105.json", "401892648"), true);
    assert_eq!(d.word(), "YES", "{:?}", d);
    let l = lg("NHL", "nhl_score_20261105.json", "2026020258"); // CBJ 2 DAL 1 SO
    let d = run(&l, "NHL", &espn("espn_nhl_scoreboard_20261105.json", "401892655"), true);
    assert_eq!(d.word(), "YES", "{:?}", d);
    assert_eq!(run(&l, "NHL", &espn("espn_nhl_scoreboard_20261105.json", "401892655"), false).word(), "NO");
}
#[test]
fn espn_final_ot_so_and_extra_innings_parse_as_final() {
    for (f, id) in [("espn_nhl_scoreboard_20261105.json", "401892648"), ("espn_nhl_scoreboard_20261105.json", "401892655"), ("espn_mlb_scoreboard_20260403.json", "401867263")] {
        assert!(espn(f, id).is_final, "{}", id);
    }
    assert!(!espn("espn_mlb_scoreboard_20260402.json", "401814780").is_final);
}
