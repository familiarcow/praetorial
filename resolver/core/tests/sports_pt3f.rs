//! PT3F (D-SPORTS3): ESPN pairing for a league game. Nearest start is never the deciding rule; a missing start is never gap 0;
//! two team-pair matches (doubleheader) pair only on an explicit game number, else ESPN is UNAVAILABLE (Ok(None)).
use praetorial_core::sports::*;
use serde_json::{json, Value};

fn mlb(pk: i64, date: Option<&str>, game_no: i64) -> Value {
    let mut g = json!({"gamePk": pk, "gameNumber": game_no, "doubleHeader": if game_no > 0 {"Y"} else {"N"},
        "status": {"abstractGameState": "Final", "codedGameState": "F"},
        "teams": {"home": {"team": {"id": 114, "name": "Cleveland Guardians"}, "score": 3}, "away": {"team": {"id": 112, "name": "Chicago Cubs"}, "score": 2}}});
    if let Some(d) = date { g["gameDate"] = json!(d); }
    g
}
fn espn_ev(id: &str, date: Option<&str>, headline: Option<&str>) -> Value {
    let mut e = json!({"id": id, "status": {"type": {"name": "STATUS_FINAL"}},
        "competitions": [{"notes": [], "competitors": [
            {"homeAway": "home", "score": "3", "team": {"id": "5", "abbreviation": "CLE", "displayName": "Cleveland Guardians", "name": "Guardians", "location": "Cleveland"}},
            {"homeAway": "away", "score": "2", "team": {"id": "103", "abbreviation": "CHC", "displayName": "Chicago Cubs", "name": "Cubs", "location": "Chicago"}}]}]});
    if let Some(d) = date { e["date"] = json!(d); }
    if let Some(h) = headline { e["competitions"][0]["notes"] = json!([{"type": "event", "headline": h}]); }
    e
}
fn lg(date: Option<&str>) -> Src { parse_league("MLB", &mlb(824460, date, 2)).unwrap() }
fn ids(r: Result<Option<Value>, String>) -> Option<String> { r.unwrap().map(|e| e["id"].as_str().unwrap().to_string()) }

#[test]
fn a_single_team_pair_match_is_that_event_whatever_the_start_gap() {
    let body = json!({"events": [espn_ev("1", Some("2026-04-05T17:10Z"), None), {"id": "9", "competitions": [{"competitors": []}]}]});
    assert_eq!(ids(espn_event_for(&lg(Some("2026-04-05T23:55:00Z")), &body)), Some("1".into()));
}
#[test]
fn b_two_matches_with_no_game_number_is_unavailable_not_nearest_start() {
    // league placeholder 17:15Z is nearest ESPN game 1 (17:10Z); the pinned game is game 2. Must NOT pick game 1.
    let body = json!({"events": [espn_ev("1", Some("2026-04-05T17:10Z"), None), espn_ev("2", Some("2026-04-05T20:30Z"), None)]});
    assert_eq!(ids(espn_event_for(&lg(Some("2026-04-05T17:15:00Z")), &body)), None);
}
#[test]
fn c_two_matches_even_with_espn_numbers_but_no_league_number_is_unavailable() {
    // espn_event_for has no league game number: nothing unambiguous links the two sides.
    let body = json!({"events": [espn_ev("1", Some("2026-04-05T17:10Z"), Some("Doubleheader - Game 1")), espn_ev("2", Some("2026-04-05T20:30Z"), Some("Doubleheader - Game 2 - Makeup from April 4"))]});
    assert_eq!(ids(espn_event_for(&lg(Some("2026-04-05T17:15:00Z")), &body)), None);
}
#[test]
fn d_missing_start_on_either_side_is_never_gap_zero() {
    let body = json!({"events": [espn_ev("1", None, None), espn_ev("2", Some("2026-04-05T20:30Z"), None)]});
    assert_eq!(ids(espn_event_for(&lg(Some("2026-04-05T20:30:00Z")), &body)), None, "ESPN game 1 has no start: not gap 0");
    let body = json!({"events": [espn_ev("1", Some("2026-04-05T17:10Z"), None), espn_ev("2", Some("2026-04-05T20:30Z"), None)]});
    assert_eq!(ids(espn_event_for(&lg(None), &body)), None, "league start missing: not gap 0 -> first listed must not win");
}
#[test]
fn e_nearest_start_picking_the_wrong_game_never_decides() {
    let body = json!({"events": [espn_ev("2", Some("2026-04-05T20:30Z"), None), espn_ev("1", Some("2026-04-05T17:10Z"), None)]});
    let got = ids(espn_event_for(&lg(Some("2026-04-05T17:15:00Z")), &body));
    assert!(got.is_none() || got.as_deref() == Some("2"), "nearest start would pick 1: {:?}", got);
}
