//! PT7 (D-LAUNCH1/D-TPL1): table-driven preset replay harness. fixtures/preset_cases/cases.json holds
//! `{name, preset, sheet, now, fixtures[], truth?, expect:{outcome, note_contains?}}`; the runner serves the fixtures to the
//! fetcher, replays `build_submission_judged_at`, and reports per preset. The META tests feed it deliberately wrong
//! expectations and assert the runner FAILS (they are real tests, not skips).
use super::preset_replay::*;
use serde_json::{json, Value};

fn table() -> Vec<Value> {
    // every fixtures/preset_cases/*.json (PT2 adds pt2_btc_edge.json), sorted by file name
    let dir = format!("{}/fixtures/preset_cases", env!("CARGO_MANIFEST_DIR"));
    let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    files.sort();
    files.iter().flat_map(|p| load_cases(p.to_str().unwrap()).unwrap()).collect()
}
fn case(name: &str) -> Value { table().into_iter().find(|c| c["name"] == name).unwrap_or_else(|| panic!("no seeded case {}", name)) }
const YES_CASE: &str = "btc A close > 75900";

#[test]
fn seeded_table_replays_clean_and_covers_every_family() {
    let cases = table();
    let r = run_cases(&cases);
    println!("{}", r.render());
    assert!(r.ok(), "{}", r.render());
    assert_eq!(r.total, cases.len());
    assert!(cases.len() >= 12, "{}", cases.len());
    for p in ["btc_close_at_t", "btc_touch", "nws_daily_high", "game_winner"] {
        assert!(r.rows.get(p).is_some_and(|x| x.decided >= 1), "no decided case for {}: {}", p, r.render());
    }
    assert!(r.rows.values().map(|x| x.expected_void).sum::<usize>() >= 1, "{}", r.render());
    assert!(r.rows.values().map(|x| x.rejected).sum::<usize>() >= 1, "{}", r.render());
    assert_eq!(r.wrong_winners, 0);
    assert_eq!(r.mismatches, 0);
}

#[test]
fn meta_outcome_mismatch_fails_with_a_diff() {
    let mut c = case(YES_CASE);
    c["truth"] = Value::Null;
    c["expect"]["outcome"] = json!("NO");
    let r = run_cases(&[c]);
    assert!(!r.ok());
    assert_eq!(r.mismatches, 1);
    assert_eq!(r.wrong_winners, 0, "an unexpected outcome with no known truth is a mismatch, not a wrong winner");
    let d = r.diffs.join("\n");
    assert!(d.contains(YES_CASE) && d.contains("expected outcome") && d.contains("NO") && d.contains("actual") && d.contains("YES"), "{}", d);
}

#[test]
fn meta_missing_note_fails_with_a_diff() {
    let mut c = case(YES_CASE);
    c["expect"]["note_contains"] = json!("this text is not in any note");
    let r = run_cases(&[c]);
    assert!(!r.ok());
    assert_eq!(r.mismatches, 1);
    let d = r.diffs.join("\n");
    assert!(d.contains("note_contains") && d.contains("this text is not in any note"), "{}", d);
}

#[test]
fn meta_opposite_side_is_a_wrong_winner_counted_separately_and_fails_the_run() {
    let mut c = case(YES_CASE);
    c["truth"] = json!("NO"); // the recorded answer is YES; the table now claims the truth is NO, so YES is the opposite side
    let good = case("btc A close > 75925 (tie decided by op)");
    let r = run_cases(&[good, c]);
    assert!(!r.ok(), "a wrong winner fails the whole run even though the other case passes");
    assert_eq!(r.wrong_winners, 1);
    assert_eq!(r.mismatches, 0, "a wrong winner is not double-counted as an outcome mismatch");
    assert_eq!(r.rows["btc_close_at_t"].wrong_winner, 1);
    assert!(r.render().contains("WRONG WINNER"), "{}", r.render());
    assert!(r.diffs.join("\n").contains(YES_CASE));
}

#[test]
fn meta_wrong_winner_fails_even_when_the_expectation_agrees_with_the_wrong_answer() {
    let mut c = case("nhl 2026020261 COL (loser)");
    c["truth"] = json!("YES");
    c["expect"]["outcome"] = json!("NO"); // expectation matches the resolver, truth does not
    let r = run_cases(&[c]);
    assert_eq!(r.wrong_winners, 1);
    assert!(!r.ok());
}

#[test]
fn meta_void_and_retry_never_count_as_wrong_winner() {
    let mut c = case("btc A close > 75924, two venues straddle");
    c["truth"] = json!("NO"); // a VOID is not the opposite side
    let r = run_cases(&[c]);
    assert_eq!(r.wrong_winners, 0);
    assert_eq!(r.rows["btc_close_at_t"].expected_void, 1);
    assert!(r.ok(), "{}", r.render());
}

#[test]
fn meta_unexpected_void_is_counted_and_fails() {
    let mut c = case("btc A close > 75924, two venues straddle");
    c["expect"] = json!({"outcome": "YES"});
    let r = run_cases(&[c]);
    assert!(!r.ok());
    assert_eq!(r.rows["btc_close_at_t"].unexpected_void, 1);
    assert_eq!(r.rows["btc_close_at_t"].expected_void, 0);
    assert_eq!(r.mismatches, 1);
}

#[test]
fn meta_unserved_fixture_url_is_a_reported_failure_not_a_panic() {
    let mut c = case(YES_CASE);
    c["fixtures"] = json!([]); // nothing to serve: every fetch errors, the resolver cannot decide
    let r = run_cases(&[c]);
    assert!(!r.ok());
    assert_eq!(r.rows["btc_close_at_t"].decided, 0);
}

#[test]
fn report_prints_every_column_per_preset() {
    let r = run_cases(&table());
    let out = r.render();
    for col in ["decided", "expected-VOID", "unexpected-VOID", "rejected", "wrong-winner"] {
        assert!(out.contains(col), "missing column {}: {}", col, out);
    }
    for p in ["btc_close_at_t", "btc_touch", "nws_daily_high", "game_winner"] {
        assert!(out.lines().any(|l| l.trim_start().starts_with(p)), "no row for {}: {}", p, out);
    }
}

#[test]
fn malformed_tables_are_errors_not_panics() {
    assert!(load_cases("/nonexistent/cases.json").is_err());
    let r = run_cases(&[json!({"name": "no fields"})]);
    assert!(!r.ok());
    assert_eq!(r.mismatches, 1);
}
