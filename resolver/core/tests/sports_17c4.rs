//! 17c4 (D-TPL1, D-SPORTS1): pure game_winner rules. The pinned event's object is extracted in code (GAP-5a); final-only;
//! winner by score; tie -> VOID; MLB/NHL need league + ESPN to agree; NFL/NBA ESPN alone.
use praetorial_core::sports::*;
use serde_json::{json, Value};

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../wasm-bin/fixtures/replay17b");
fn fx(f: &str) -> Value { serde_json::from_slice(&std::fs::read(format!("{}/{}", DIR, f)).unwrap()).unwrap() }
const LATE: i64 = 1_800_000_000; // far after every recorded game

// ---------------------------------------------------------------- GAP-5a extraction
#[test]
fn extraction_returns_only_the_pinned_object_and_is_small() {
    let nhl = fx("nhl_score_20261105.json");
    let whole = serde_json::to_string(&nhl).unwrap().len();
    let g = league_event("NHL", &nhl, "2026020261").expect("pinned NHL game");
    assert_eq!(g["id"], 2026020261);
    let one = serde_json::to_string(&g).unwrap().len();
    assert!(one < 12_000 && one * 8 < whole, "{} of {}", one, whole);

    let espn = fx("espn_nhl_scoreboard_20261105.json");
    let whole = serde_json::to_string(&espn).unwrap().len();
    let e = espn_event_by_id(&espn, "401892658").expect("pinned ESPN event");
    assert_eq!(e["id"], "401892658");
    assert!(serde_json::to_string(&e).unwrap().len() * 5 < whole);

    let mlb = league_event("MLB", &fx("mlb_schedule_20261028.json"), "849799").expect("MLB gamePk");
    assert_eq!(mlb["gamePk"], 849799);
    assert!(league_event("MLB", &fx("mlb_schedule_20261028.json"), "1").is_none());
    assert!(league_event("NHL", &nhl, "2026020262").is_none());
    assert!(league_event("NFL", &nhl, "2026020261").is_none(), "NFL/NBA have no league source");
    assert!(espn_event_by_id(&espn, "1").is_none());
}
#[test]
fn espn_event_for_a_league_game_is_found_by_its_two_teams() {
    let lg = parse_league("NHL", &league_event("NHL", &fx("nhl_score_20261105.json"), "2026020261").unwrap()).unwrap();
    let e = espn_event_for(&lg, &fx("espn_nhl_scoreboard_20261105.json")).unwrap().expect("same two teams");
    assert_eq!(e["id"], "401892658");
    let lg = parse_league("MLB", &league_event("MLB", &fx("mlb_schedule_20261028.json"), "849799").unwrap()).unwrap();
    let e = espn_event_for(&lg, &fx("espn_mlb_scoreboard_20261028.json")).unwrap().expect("MIL @ TB by name");
    assert_eq!(e["id"], "401908046");
    // a payload without that pairing -> None
    let other = fx("espn_nfl_scoreboard_20261101.json");
    assert!(espn_event_for(&lg, &other).unwrap().is_none());
}

// ---------------------------------------------------------------- parsing
#[test]
fn parse_recorded_events() {
    let g = parse_league("NHL", &league_event("NHL", &fx("nhl_score_20261105.json"), "2026020261").unwrap()).unwrap();
    assert!(g.is_final && g.start == Some(1_793_932_200)); // 2026-11-06T02:30Z
    assert_eq!((g.away.id.as_str(), g.away.score, g.home.id.as_str(), g.home.score), ("18", Some(3), "21", Some(2)));
    let m = parse_league("MLB", &league_event("MLB", &fx("mlb_schedule_20261028.json"), "849799").unwrap()).unwrap();
    assert!(m.is_final && (m.away.id.as_str(), m.away.score, m.home.id.as_str(), m.home.score) == ("158", Some(4), "139", Some(1)));
    let e = parse_espn(&espn_event_by_id(&fx("espn_nfl_scoreboard_20261101.json"), "401873026").unwrap()).unwrap();
    assert!(e.is_final && (e.home.id.as_str(), e.home.score, e.away.id.as_str(), e.away.score) == ("2", Some(36), "33", Some(10)));
}

// ---------------------------------------------------------------- decide
fn team(id: &str, ab: &str, score: i64) -> Team { Team { id: id.into(), abbrev: ab.into(), names: vec![format!("Team {}", ab)], score: Some(score) } }
fn src(final_: bool, h: i64, a: i64) -> Src { Src { is_final: final_, called_off: false, start: Some(1_000_000), home: team("1", "HOM", h), away: team("2", "AWY", a) } }
fn espn_src(final_: bool, h: i64, a: i64) -> Src {
    // ESPN uses its own ids but the same teams (abbreviation)
    Src { is_final: final_, called_off: false, start: Some(1_000_000), home: team("91", "HOM", h), away: team("92", "AWY", a) }
}

#[test]
fn both_sources_agree_pick_home_or_away() {
    let (l, e) = (src(true, 3, 2), espn_src(true, 3, 2));
    assert_eq!(decide(false, "1", LATE, Some(&l), Some(&e)).word(), "YES");
    assert_eq!(decide(false, "2", LATE, Some(&l), Some(&e)).word(), "NO");
}
#[test]
fn disagreement_is_void() {
    let (l, e) = (src(true, 3, 2), espn_src(true, 2, 3));
    let d = decide(false, "1", LATE, Some(&l), Some(&e));
    assert_eq!(d.word(), "VOID");
    assert!(d.why().contains("disagree"), "{}", d.why());
}
#[test]
fn tie_is_void_in_either_source() {
    let d = decide(false, "1", LATE, Some(&src(true, 2, 2)), Some(&espn_src(true, 2, 2)));
    assert_eq!(d.word(), "VOID");
    assert!(d.why().contains("tie"));
    assert_eq!(decide(true, "91", LATE, None, Some(&espn_src(true, 5, 5))).word(), "VOID");
}
#[test]
fn not_final_is_retry_when_either_source_is_not_final() {
    assert_eq!(decide(false, "1", LATE, Some(&src(false, 3, 2)), Some(&espn_src(true, 3, 2))).word(), "RETRY");
    assert_eq!(decide(false, "1", LATE, Some(&src(true, 3, 2)), Some(&espn_src(false, 3, 2))).word(), "RETRY");
    assert_eq!(decide(true, "91", LATE, None, Some(&espn_src(false, 3, 2))).word(), "RETRY");
}
#[test]
fn a_missing_source_is_retry_unless_single_source() {
    assert_eq!(decide(false, "1", LATE, Some(&src(true, 3, 2)), None).word(), "RETRY");
    assert_eq!(decide(false, "1", LATE, None, Some(&espn_src(true, 3, 2))).word(), "RETRY");
    assert_eq!(decide(true, "91", LATE, None, None).word(), "RETRY");
}
#[test]
fn single_source_decides_on_espn_team_ids() {
    let e = espn_src(true, 36, 10);
    assert_eq!(decide(true, "91", LATE, None, Some(&e)).word(), "YES");
    assert_eq!(decide(true, "92", LATE, None, Some(&e)).word(), "NO");
    assert_eq!(decide(true, "1", LATE, None, Some(&e)).word(), "VOID", "a league-source id is not an ESPN team id");
}
#[test]
fn earliest_resolve_is_start_plus_4h() {
    let (l, e) = (src(true, 3, 2), espn_src(true, 3, 2));
    assert_eq!(earliest_resolve(Some(&l), Some(&e), false), Some(1_000_000 + 4 * 3600));
    assert_eq!(decide(false, "1", 1_000_000 + 4 * 3600 - 1, Some(&l), Some(&e)).word(), "RETRY");
    assert_eq!(decide(false, "1", 1_000_000 + 4 * 3600, Some(&l), Some(&e)).word(), "YES");
}
