//! PT3 (game-edge-replay; D-SPORTS2/D-SPORTS3/D-TPL1): offline replay of recorded game_winner payloads through the PT7 harness, resolver only.
//! Cases: fixtures/preset_cases/pt3_game_edge.json. Payloads: fixtures/pt3/ with manifest.json (file, source_url, fetched_at, sha256,
//! kind real|synthetic). Synthetic fixtures (ESPN flipped score, ESPN STATUS_SUSPENDED) are edited copies of real payloads, named synth_*.
//! Tests state the product we want: a wrong winner or wrong outcome on any case is a resolver bug and stays RED.
use super::preset_replay::*;
use serde_json::Value;

const PT3: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/preset_cases/pt3_game_edge.json");
const FX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/pt3");

fn cases() -> Vec<Value> { load_cases(PT3).unwrap() }
fn run_prefix(prefix: &str, n: usize) -> Report {
    let c: Vec<Value> = cases().into_iter().filter(|c| c["name"].as_str().is_some_and(|x| x.starts_with(prefix))).collect();
    assert_eq!(c.len(), n, "expected {} case(s) starting {:?}", n, prefix);
    let r = run_cases(&c);
    println!("{}", r.render());
    assert_eq!(r.wrong_winners, 0, "POSSIBLE WRONG WINNER: {}", r.render());
    assert!(r.ok(), "{}", r.render());
    r
}

#[test]
fn nfl_tie_is_void() {
    let r = run_prefix("pt3 nfl tie", 2);
    assert_eq!(r.rows["game_winner"].expected_void, 2);
}
#[test]
fn nba_decisive_single_source_game_decides_and_says_single_source() {
    let r = run_prefix("pt3 nba single source", 2);
    assert_eq!(r.rows["game_winner"].decided, 2);
}
#[test]
fn doubleheader_decides_the_pinned_gamepk() {
    let r = run_prefix("pt3 doubleheader", 4);
    assert_eq!(r.rows["game_winner"].decided, 4);
}
#[test]
fn league_vs_espn_winner_mismatch_can_only_void() {
    let r = run_prefix("pt3 SYNTHETIC league says Cubs", 1);
    assert_eq!(r.rows["game_winner"].expected_void, 1);
    let r = run_prefix("pt3 SYNTHETIC same mismatch", 1);
    assert_eq!(r.rows["game_winner"].expected_void, 1);
}
#[test]
fn suspended_espn_status_retries_then_voids_after_7_days() {
    let r = run_prefix("pt3 SYNTHETIC ESPN STATUS_SUSPENDED", 1);
    assert_eq!(r.rows["game_winner"].rejected, 1);
    let r = run_prefix("pt3 SYNTHETIC suspended 3 days", 1);
    assert_eq!(r.rows["game_winner"].rejected, 1);
    let r = run_prefix("pt3 SYNTHETIC suspended 8 days", 1);
    assert_eq!(r.rows["game_winner"].expected_void, 1);
}
#[test]
fn all_pt3_cases_wrong_winner_is_zero_and_report_counts_them() {
    let r = run_cases(&cases());
    println!("{}", r.render());
    assert_eq!(r.total, 13);
    assert_eq!(r.wrong_winners, 0, "{}", r.render());
    assert!(r.ok(), "{}", r.render());
}

#[test]
fn manifest_sha256s_verify_and_every_fixture_is_listed() {
    let m: Value = serde_json::from_slice(&std::fs::read(format!("{}/manifest.json", FX)).expect("fixtures/pt3/manifest.json")).unwrap();
    let m = m.as_array().unwrap();
    let mut listed = vec![];
    for e in m {
        let f = e["file"].as_str().unwrap();
        let body = std::fs::read(format!("{}/{}", FX, f)).unwrap_or_else(|_| panic!("manifest lists missing file {}", f));
        let sha = praetorial_core::sha_hex(&String::from_utf8(body).unwrap());
        assert_eq!(e["sha256"].as_str().unwrap(), sha, "sha256 mismatch for {}", f);
        let kind = e["kind"].as_str().unwrap();
        assert!(kind == "real" || kind == "synthetic", "{}: kind {}", f, kind);
        assert!(e["fetched_at"].as_str().is_some_and(|s| !s.is_empty()), "{}", f);
        assert!(e["source_url"].as_str().is_some_and(|u| u.starts_with("https://")), "{}", f);
        if kind == "synthetic" { assert!(f.starts_with("synth_") && e["note"].as_str().is_some_and(|n| n.contains("SYNTHETIC")), "{} must be labelled SYNTHETIC", f); }
        listed.push(f.to_string());
    }
    let mut on_disk: Vec<String> = std::fs::read_dir(FX).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n != "manifest.json").collect();
    on_disk.sort(); listed.sort();
    assert_eq!(on_disk, listed, "fixtures dir and manifest must list the same files");
    for p in ["nfl_", "nba_", "mlb_", "espn_mlb_"] { assert!(m.iter().any(|e| e["kind"] == "real" && e["file"].as_str().unwrap().starts_with(p)), "need a real {} payload", p); }
    assert_eq!(m.iter().filter(|e| e["kind"] == "synthetic").count(), 2, "exactly the flipped-score and suspended fixtures are synthetic");
}
