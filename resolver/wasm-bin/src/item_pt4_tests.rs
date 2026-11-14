//! PT4 (nws-edge-replay; D-WX1/D-TPL1): offline replay of recorded NWS CLI / IEM payloads through the PT7 harness, resolver only.
//! Cases: fixtures/preset_cases/pt4_nws_edge.json. Payloads: fixtures/pt4/ with manifest.json (file, source_url, fetched_at, sha256,
//! kind real|synthetic). Synthetic fixtures are named synth_* and say SYNTHETIC in the manifest note.
//! Tests state the product we want: a wrong winner or wrong outcome on any case is a resolver bug and stays RED.
use super::preset_replay::*;
use serde_json::Value;

const PT4: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/preset_cases/pt4_nws_edge.json");
const FX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/pt4");

fn cases() -> Vec<Value> { load_cases(PT4).unwrap() }
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
fn minimum_record_flag_line_does_not_disturb_the_max() {
    let r = run_prefix("pt4 REAL-text MINIMUM 5R", 2);
    assert_eq!(r.rows["nws_daily_high"].decided, 2);
}
#[test]
fn missing_max_mm_is_void() {
    let r = run_prefix("pt4 REAL-text MAXIMUM MM", 1);
    assert_eq!(r.rows["nws_daily_high"].expected_void, 1);
}
#[test]
fn dst_day_at_knyc_reads_the_standard_time_day() {
    let r = run_prefix("pt4 REAL KNYC 2026-11-01 DST", 2);
    assert_eq!(r.rows["nws_daily_high"].decided, 2);
}
#[test]
fn nws_vs_iem_disagree_by_one_is_void() {
    let r = run_prefix("pt4 SYNTHETIC IEM 60 vs REAL NWS 59", 2);
    assert_eq!(r.rows["nws_daily_high"].expected_void, 2);
}
#[test]
fn one_copy_retries_at_day_3_and_voids_at_day_8() {
    assert_eq!(run_prefix("pt4 one copy (IEM down), day 3", 1).rows["nws_daily_high"].rejected, 1);
    assert_eq!(run_prefix("pt4 one copy (IEM down), day 8", 1).rows["nws_daily_high"].expected_void, 1);
}
#[test]
fn product_rolled_off_the_list_retries_then_voids() {
    assert_eq!(run_prefix("pt4 REAL list no longer lists the >7-day-old KNYC 2026-10-28 product (IEM 61 only), day 3", 1).rows["nws_daily_high"].rejected, 1);
    assert_eq!(run_prefix("pt4 REAL list no longer lists the >7-day-old KNYC 2026-10-28 product (IEM 61 only), day 8+", 1).rows["nws_daily_high"].expected_void, 1);
}
#[test]
fn kmia_no_outcome_before_publication_decides_after() {
    assert_eq!(run_prefix("pt4 KMIA before the report", 1).rows["nws_daily_high"].rejected, 1);
    assert_eq!(run_prefix("pt4 REAL KMIA after publication", 2).rows["nws_daily_high"].decided, 2);
}
#[test]
fn product_for_another_day_is_absent_never_the_right_day() {
    assert_eq!(run_prefix("pt4 SYNTHETIC mapping", 1).rows["nws_daily_high"].rejected, 1);
}
#[test]
fn all_pt4_cases_wrong_winner_is_zero_and_report_counts_them() {
    let r = run_cases(&cases());
    println!("{}", r.render());
    assert_eq!(r.total, 15);
    assert_eq!(r.wrong_winners, 0, "{}", r.render());
    assert!(r.ok(), "{}", r.render());
}

#[test]
fn manifest_sha256s_verify_and_every_fixture_is_listed() {
    let m: Value = serde_json::from_slice(&std::fs::read(format!("{}/manifest.json", FX)).expect("fixtures/pt4/manifest.json")).unwrap();
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
        if kind == "synthetic" { assert!(f.starts_with("synth_") && e["note"].as_str().is_some_and(|n| n.contains("SYNTHETIC") || n.contains("DERIVED")), "{} must be labelled", f); }
        else { assert!(!f.starts_with("synth_"), "{}", f); }
        listed.push(f.to_string());
    }
    let mut on_disk: Vec<String> = std::fs::read_dir(FX).unwrap().filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).filter(|n| n != "manifest.json").collect();
    on_disk.sort(); listed.sort();
    assert_eq!(on_disk, listed, "fixtures dir and manifest must list the same files");
}
