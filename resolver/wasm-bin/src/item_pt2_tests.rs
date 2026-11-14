//! PT2 (btc-edge-replay; D-TPL1/D-VENUE2): offline replay of recorded BTC venue payloads through the PT7 harness, resolver only.
//! Cases: fixtures/preset_cases/pt2_btc_edge.json. Payloads: fixtures/pt2/ with manifest.json (file, source_url, fetched_at, sha256,
//! kind real|synthetic). Synthetic = hand-built (tie, outage); everything else is a plain public GET saved verbatim.
//! Tests state the product we want: a wrong winner or wrong outcome on any case is a resolver bug and stays RED.
use super::preset_replay::*;
use serde_json::Value;

const PT2: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/preset_cases/pt2_btc_edge.json");
const FX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/pt2");

fn cases() -> Vec<Value> { load_cases(PT2).unwrap() }
fn run_one(prefix: &str) -> Report {
    let c: Vec<Value> = cases().into_iter().filter(|c| c["name"].as_str().is_some_and(|n| n.starts_with(prefix))).collect();
    assert_eq!(c.len(), 1, "case {:?} must exist exactly once", prefix);
    let r = run_cases(&c);
    println!("{}", r.render());
    assert_eq!(r.wrong_winners, 0, "POSSIBLE WRONG WINNER: {}", r.render());
    assert!(r.ok(), "{}", r.render());
    r
}

#[test]
fn one_venue_wick_touch_is_void_disagree() {
    let r = run_one("pt2 wick: only Kraken");
    assert_eq!(r.rows["btc_touch"].expected_void, 1);
}
#[test]
fn venues_in_agreement_on_the_wick_touch_is_yes() {
    let r = run_one("pt2 wick: all three");
    assert_eq!(r.rows["btc_touch"].decided, 1);
}
#[test]
fn two_venues_down_is_void_fewer_than_2() {
    let r = run_one("pt2 synthetic: Coinbase+Bitstamp down");
    assert_eq!(r.rows["btc_touch"].expected_void, 1);
}
#[test]
fn tie_close_with_gte_is_yes() {
    let r = run_one("pt2 synthetic tie");
    assert_eq!(r.rows["btc_close_at_t"].decided, 1);
}
#[test]
fn request_at_t_plus_7h_is_signed_void_req_t_older_than_6h() {
    let r = run_one("pt2 request at T+7h");
    assert_eq!(r.rows["btc_close_at_t"].expected_void, 1);
}
#[test]
fn request_at_t_plus_3min_has_no_signed_outcome() {
    let r = run_one("pt2 request at T+3min");
    assert_eq!(r.rows["btc_close_at_t"].rejected, 1);
}
#[test]
fn coinbase_empty_minute_is_replayed_from_the_real_payload() {
    let r = run_one("pt2 coinbase empty minute");
    assert_eq!(r.rows["btc_close_at_t"].decided, 1);
}
#[test]
fn all_pt2_cases_wrong_winner_is_zero_and_report_counts_them() {
    let r = run_cases(&cases());
    println!("{}", r.render());
    assert_eq!(r.total, 7);
    assert_eq!(r.wrong_winners, 0, "{}", r.render());
    assert!(r.ok(), "{}", r.render());
    // the PT7 table (all preset_cases/*.json) includes them
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/preset_cases");
    let n: usize = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).map(|p| load_cases(p.to_str().unwrap()).unwrap().len()).sum();
    assert_eq!(n, 14 + 7 + 13 + 15, "PT7 seeded 14 cases + 7 PT2 cases + 13 PT3 cases + 15 PT4 cases");
}

#[test]
fn manifest_sha256s_verify_and_every_fixture_is_listed() {
    let m: Value = serde_json::from_slice(&std::fs::read(format!("{}/manifest.json", FX)).expect("fixtures/pt2/manifest.json")).unwrap();
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
        if kind == "real" { assert!(e["source_url"].as_str().is_some_and(|u| u.starts_with("https://")), "{}", f); }
        else { assert!(f.starts_with("synth_") && e["note"].as_str().is_some_and(|n| n.to_lowercase().contains("synthetic")), "{} must be labelled synthetic", f); }
        listed.push(f.to_string());
    }
    let mut on_disk: Vec<String> = std::fs::read_dir(FX).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n != "manifest.json").collect();
    on_disk.sort(); listed.sort();
    assert_eq!(on_disk, listed, "fixtures dir and manifest must list the same files");
    let real = |p: &str| m.iter().any(|e| e["kind"] == "real" && e["file"].as_str().unwrap().starts_with(p));
    for p in ["wick_cb", "wick_bs", "wick_kr", "gap_cb"] { assert!(real(p), "need a real {} payload", p); }
    assert!(m.iter().any(|e| e["kind"] == "synthetic" && e["file"].as_str().unwrap().starts_with("synth_tie")));
}
