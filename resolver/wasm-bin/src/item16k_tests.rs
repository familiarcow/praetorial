//! Item 16k (D-RESOLVE8): bounded venue-gap tolerance with a fail-closed guard.
use super::item16e2_tests::Sim;
use super::item16e_tests::*;
use super::*;
use std::cell::RefCell;

const GAP_FIRST: i64 = 1_761_408_000; // 2025-10-25T16:00Z
const GAP_LAST: i64 = 1_761_422_400; // 2025-10-25T20:00Z
const GAP_TS: [i64; 5] = [1_761_408_000, 1_761_411_600, 1_761_415_200, 1_761_418_800, 1_761_422_400];

fn cb_missing(from: i64, hours: i64) -> Box<dyn Fn(&str, i64) -> bool> {
    Box::new(move |v, ts| v == "kr" || (v == "cb" && ts >= from && ts < from + hours * 3600))
}
fn run(f: &Sim) -> (SubmittedResult, Vec<String>, Rec) {
    let rec = Rec(RefCell::new(vec![]), String::new());
    let (r, n) = build_submission(&jason_job(), &rec, f);
    (r, n, rec)
}
fn prompt(rec: &Rec) -> String { rec.0.borrow().first().cloned().unwrap_or_default() }

#[test]
fn d_resolve8_recorded_coinbase_five_hour_gap_is_complete_with_gaps_and_judge_is_reached() {
    let f = Sim::jason().with_gap(Box::new(|v, ts| v == "kr" || (v == "cb" && GAP_TS.contains(&ts))));
    let (_r, n, rec) = run(&f);
    assert!(n.iter().any(|x| x.contains("COMPLETE_WITH_GAPS") && x.contains("S_CB")), "{:?}", n);
    assert!(!n.iter().any(|x| x.contains("only") && x.contains("price venues have complete coverage")), "2 venues must count: {:?}", n);
    let p = prompt(&rec);
    assert!(!p.is_empty(), "judge (model) must be reached: {:?}", n);
    assert!(p.contains("VENUE GAPS (D-RESOLVE8)") && p.contains("Coinbase") && p.contains("no candles 2025-10-25T16:00Z..2025-10-25T20:00Z"), "{}", &p[..p.len().min(2500)]);
}

#[test]
fn d_resolve8_no_interpolation_gap_timestamps_never_appear_as_candles() {
    let f = Sim::jason().with_gap(Box::new(|v, ts| v == "kr" || (v == "cb" && GAP_TS.contains(&ts))));
    let (_r, _n, rec) = run(&f);
    let p = prompt(&rec);
    let a = p.find("<source id=\"S_CB\"").expect("S_CB block present");
    let blk = &p[a..a + p[a..].find("</source>").unwrap()];
    for ts in GAP_TS {
        assert!(!blk.contains(&format!("\n{},", ts)), "synthetic candle for gap ts {}", ts);
    }
    assert!(blk.contains(&format!("\n{},", GAP_FIRST - 3600)) && blk.contains(&format!("\n{},", GAP_LAST + 3600)), "neighbours must stay");
}

#[test]
fn d_resolve8_seven_consecutive_missing_hours_is_incomplete_and_void_before_the_model() {
    let f = Sim::jason().with_gap(cb_missing(GAP_FIRST, 7));
    let (r, n, rec) = run(&f);
    assert_eq!(r.outcome, "VOID", "{:?}", n);
    assert!(rec.0.borrow().is_empty(), "model must not be reached");
    assert!(n.iter().any(|x| x.contains("INCOMPLETE") && x.contains("S_CB")), "{:?}", n);
}

#[test]
fn d_resolve8_six_consecutive_missing_hours_is_still_tolerated() {
    let f = Sim::jason().with_gap(cb_missing(GAP_FIRST, 6));
    let (_r, n, rec) = run(&f);
    assert!(!prompt(&rec).is_empty(), "6h run is within the bound: {:?}", n);
}

#[test]
fn d_resolve8_scattered_gaps_over_two_percent_are_incomplete_and_void() {
    // 15 isolated missing hours of 667 candles = 2.25% > 2%
    let f = Sim::jason().with_gap(Box::new(|v, ts| v == "kr" || (v == "cb" && ts >= WIN_START && ts < WIN_END && ((ts - WIN_START) / 3600) % 44 == 20)));
    let (r, n, rec) = run(&f);
    assert_eq!(r.outcome, "VOID", "{:?}", n);
    assert!(rec.0.borrow().is_empty());
}

#[test]
fn d_resolve8_scattered_gaps_at_or_under_two_percent_are_tolerated() {
    // 13 isolated missing hours of 667 = 1.95%
    let f = Sim::jason().with_gap(Box::new(|v, ts| v == "kr" || (v == "cb" && ts >= WIN_START && ts < WIN_END && ((ts - WIN_START) / 3600) % 50 == 20)));
    let (_r, n, rec) = run(&f);
    assert!(!prompt(&rec).is_empty(), "{:?}", n);
}

#[test]
fn d_resolve8_http_error_on_a_page_still_makes_the_venue_incomplete() {
    let f = Sim::jason().with_gap(Box::new(|v, _| v == "kr")).with_fail(Box::new(|u| u.contains("coinbase") && u.contains("start=2025-10-2")));
    let (r, n, rec) = run(&f);
    assert_eq!(r.outcome, "VOID", "{:?}", n);
    assert!(rec.0.borrow().is_empty());
    assert!(n.iter().any(|x| x.contains("INCOMPLETE") && x.contains("S_CB") && x.contains("page failed")), "{:?}", n);
}

#[test]
fn d_resolve8_missing_or_truncated_page_still_makes_the_venue_incomplete() {
    // whole middle page absent (~300 candles) -> far beyond the bounds -> INCOMPLETE
    let f = Sim::jason().with_gap(Box::new(|v, ts| v == "kr" || (v == "cb" && ts >= WIN_START + 12 * 86_400 && ts < WIN_START + 24 * 86_400)));
    let (r, n, rec) = run(&f);
    assert_eq!(r.outcome, "VOID", "{:?}", n);
    assert!(rec.0.borrow().is_empty());
    // truncated tail of the window (edge, not an in-page interior gap) -> INCOMPLETE
    let f = Sim::jason().with_gap(Box::new(|v, ts| v == "kr" || (v == "cb" && ts >= WIN_END - 3 * 3600)));
    let (r, n, _) = run(&f);
    assert_eq!(r.outcome, "VOID", "{:?}", n);
}

#[test]
fn d_resolve8_other_venue_high_at_threshold_inside_a_gap_is_couldnt_check_void_model_ignored() {
    struct Yes;
    impl ModelCaller for Yes {
        fn call(&self, _m: &str, _msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) {
            (r#"{"answer":"insufficient","reason":"x"}"#.to_string(), None, None)
        }
    }
    let hot = GAP_TS[2];
    let mk = || Sim::jason()
        .with_gap(Box::new(|v, ts| v == "kr" || (v == "cb" && GAP_TS.contains(&ts))))
        .with_high(Box::new(move |v, ts| {
            if ts < WIN_START { 188_888.5 } else if ts >= WIN_END { 90_000.5 }
            else if v == "bs" && ts == hot { 126_210.5 } else { 100_000.5 + ((ts / 3600) % 100) as f64 }
        }));
    let (r, n, _) = run(&mk());
    assert_eq!(r.outcome, "VOID", "{:?}", n);
    assert!(n.iter().any(|x| x.contains("COULDNT_CHECK") && x.contains("D-RESOLVE8")), "{:?}", n);
    let (r, n) = build_submission(&jason_job(), &Yes, &mk());
    assert_eq!(r.outcome, "VOID", "model output must be ignored: {:?}", n);
    // control: the same shape with the other venue's high just below the threshold is not blocked
    let ok = Sim::jason().with_gap(Box::new(|v, ts| v == "kr" || (v == "cb" && GAP_TS.contains(&ts))));
    let (_r, _n, rec) = run(&ok);
    assert!(!prompt(&rec).is_empty());
}

#[test]
fn d_resolve8_guard_fails_closed_when_the_threshold_cannot_be_parsed() {
    let mut t: Value = serde_json::from_str(JASON_16C_TERMS).unwrap();
    t["claim"] = json!("BTC prices moved sharply");
    for el in t["elements"].as_array_mut().unwrap() { el["q"] = json!("Did BTC move sharply?"); }
    let terms = t.to_string();
    let job = json!({"contract": "escrow.testnet", "bet_id": 2, "run_no": 2, "checked_until": 0, "round": 0,
        "envelope": {"terms_hash": praetorial_core::sha_hex(&terms)}, "terms": terms});
    let f = Sim::jason().with_gap(Box::new(|v, ts| v == "kr" || (v == "cb" && GAP_TS.contains(&ts))));
    let rec = Rec(RefCell::new(vec![]), String::new());
    let (r, n) = build_submission(&job, &rec, &f);
    assert_eq!(r.outcome, "VOID", "{:?}", n);
    assert!(n.iter().any(|x| x.contains("COULDNT_CHECK") && x.contains("D-RESOLVE8")), "{:?}", n);
}

#[test]
fn d_resolve8_pure_helpers_classify_gaps() {
    let rows: Vec<(i64, f64)> = (0..10).filter(|i| ![4, 5].contains(i)).map(|i| (i * 3600, 1.0)).collect();
    assert_eq!(interior_gaps(&rows, 3600), vec![(4 * 3600, 5 * 3600)]);
    assert!(gaps_within_bounds(&[(4 * 3600, 5 * 3600)], 3600, 670));
    assert!(!gaps_within_bounds(&[(0, 6 * 3600)], 3600, 670));
    assert!(!gaps_within_bounds(&[(0, 0), (7200, 7200)], 3600, 50));
}
