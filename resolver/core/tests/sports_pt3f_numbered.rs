//! PT3F (D-SPORTS3): explicit game-number pairing (MLB gameNumber/doubleHeader <-> ESPN notes "Game N").
use praetorial_core::sports::*;
use serde_json::{json, Value};

fn mlb(pk: i64, date: &str, game_no: i64, dh: &str) -> Value {
    json!({"gamePk": pk, "gameNumber": game_no, "doubleHeader": dh, "gameDate": date,
        "status": {"abstractGameState": "Final", "codedGameState": "F"},
        "teams": {"home": {"team": {"id": 114, "name": "Cleveland Guardians"}, "score": 3}, "away": {"team": {"id": 112, "name": "Chicago Cubs"}, "score": 2}}})
}
fn espn_ev(id: &str, date: &str, headline: Option<&str>) -> Value {
    let notes = headline.map(|h| json!([{"type": "event", "headline": h}])).unwrap_or(json!([]));
    json!({"id": id, "date": date, "status": {"type": {"name": "STATUS_FINAL"}},
        "competitions": [{"notes": notes, "competitors": [
            {"homeAway": "home", "score": "3", "team": {"id": "5", "abbreviation": "CLE", "displayName": "Cleveland Guardians", "name": "Guardians", "location": "Cleveland"}},
            {"homeAway": "away", "score": "2", "team": {"id": "103", "abbreviation": "CHC", "displayName": "Chicago Cubs", "name": "Cubs", "location": "Chicago"}}]}]})
}
fn pick(game: &Value, body: &Value) -> Option<String> {
    let l = parse_league("MLB", game).unwrap();
    espn_event_for_game(&l, league_game_number("MLB", game), body).unwrap().map(|e| e["id"].as_str().unwrap().to_string())
}

#[test]
fn game_number_read_from_both_sides() {
    assert_eq!(league_game_number("MLB", &mlb(1, "2026-04-05T17:15:00Z", 2, "Y")), Some(2));
    assert_eq!(league_game_number("MLB", &mlb(1, "2026-04-05T17:15:00Z", 1, "N")), None, "gameNumber 1 of a non-doubleheader is not a pairing key");
    assert_eq!(league_game_number("NHL", &json!({"id": 1})), None);
    assert_eq!(espn_game_number(&espn_ev("x", "2026-04-05T20:30Z", Some("Doubleheader - Game 2 - Makeup from April 4"))), Some(2));
    assert_eq!(espn_game_number(&espn_ev("x", "2026-04-05T20:30Z", Some("Doubleheader - Game 1"))), Some(1));
    assert_eq!(espn_game_number(&espn_ev("x", "2026-04-05T20:30Z", None)), None);
    assert_eq!(espn_game_number(&espn_ev("x", "2026-04-05T20:30Z", Some("Opening Day"))), None);
}
#[test]
fn doubleheader_pairs_by_game_number_even_when_nearest_start_says_otherwise() {
    let body = json!({"events": [espn_ev("1", "2026-04-05T17:10Z", Some("Doubleheader - Game 1")), espn_ev("2", "2026-04-05T20:30Z", Some("Doubleheader - Game 2 - Makeup from April 4"))]});
    assert_eq!(pick(&mlb(824460, "2026-04-05T17:15:00Z", 2, "Y"), &body), Some("2".into()));
    assert_eq!(pick(&mlb(824459, "2026-04-05T17:10:00Z", 1, "Y"), &body), Some("1".into()));
}
#[test]
fn doubleheader_with_missing_espn_number_on_either_game_is_unavailable() {
    let body = json!({"events": [espn_ev("1", "2026-04-05T17:10Z", Some("Doubleheader - Game 1")), espn_ev("2", "2026-04-05T20:30Z", None)]});
    // game 2's number is on no ESPN event -> no unambiguous link
    assert_eq!(pick(&mlb(824460, "2026-04-05T17:15:00Z", 2, "Y"), &body), None);
}
#[test]
fn doubleheader_league_without_number_is_unavailable() {
    let body = json!({"events": [espn_ev("1", "2026-04-05T17:10Z", Some("Doubleheader - Game 1")), espn_ev("2", "2026-04-05T20:30Z", Some("Doubleheader - Game 2"))]});
    let g = mlb(824460, "2026-04-05T17:15:00Z", 2, "N");
    assert_eq!(pick(&g, &body), None);
}
#[test]
fn two_espn_events_claiming_the_same_number_is_unavailable() {
    let body = json!({"events": [espn_ev("1", "2026-04-05T17:10Z", Some("Doubleheader - Game 2")), espn_ev("2", "2026-04-05T20:30Z", Some("Doubleheader - Game 2"))]});
    assert_eq!(pick(&mlb(824460, "2026-04-05T17:15:00Z", 2, "Y"), &body), None);
}
#[test]
fn single_match_with_a_conflicting_explicit_number_is_unavailable() {
    // ESPN lists only game 1; the pinned league game is game 2 -> must not pair
    let body = json!({"events": [espn_ev("1", "2026-04-05T17:10Z", Some("Doubleheader - Game 1"))]});
    assert_eq!(pick(&mlb(824460, "2026-04-05T17:15:00Z", 2, "Y"), &body), None);
}
