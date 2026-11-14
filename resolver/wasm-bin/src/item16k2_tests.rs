//! Item 16k2 (D-RESOLVE8a): every gap slot of a counted venue must be covered by another counted venue.
use super::item16e2_tests::Sim;
use super::item16e_tests::*;
use super::*;
use std::cell::RefCell;

const T_1600: i64 = 1_761_408_000; // 2025-10-25T16:00Z
const H: i64 = 3600;

fn run(f: &Sim) -> (SubmittedResult, Vec<String>, Rec) {
    let rec = Rec(RefCell::new(vec![]), String::new());
    let (r, n) = build_submission(&jason_job(), &rec, f);
    (r, n, rec)
}
fn prompt(rec: &Rec) -> String { rec.0.borrow().first().cloned().unwrap_or_default() }

#[test]
fn d_resolve8a_same_one_hour_slot_missing_on_both_venues_is_void_before_the_model() {
    let f = Sim::jason().with_gap(Box::new(|v, ts| v == "kr" || (v != "kr" && ts == T_1600 + 2 * H)));
    let (r, n, rec) = run(&f);
    assert_eq!(r.outcome, "VOID", "{:?}", n);
    assert!(rec.0.borrow().is_empty(), "model must not be reached");
    assert!(n.iter().any(|x| x.contains("COULDNT_CHECK") && x.contains("D-RESOLVE8a")), "{:?}", n);
}

#[test]
fn d_resolve8a_partially_overlapping_gaps_leave_an_unobserved_hour_and_void() {
    // cb missing 16:00-20:00Z, bs missing 19:00-21:00Z -> 19:00 and 20:00 observed by nobody
    let f = Sim::jason().with_gap(Box::new(|v, ts| {
        v == "kr" || (v == "cb" && ts >= T_1600 && ts <= T_1600 + 4 * H) || (v == "bs" && ts >= T_1600 + 3 * H && ts <= T_1600 + 5 * H)
    }));
    let (r, n, rec) = run(&f);
    assert_eq!(r.outcome, "VOID", "{:?}", n);
    assert!(rec.0.borrow().is_empty(), "model must not be reached");
    assert!(n.iter().any(|x| x.contains("D-RESOLVE8a")), "{:?}", n);
}

#[test]
fn d_resolve8a_disjoint_gaps_each_covered_by_the_other_venue_reach_the_judge() {
    // cb missing 16:00-17:00Z, bs missing 19:00-20:00Z, all highs below the threshold
    let f = Sim::jason().with_gap(Box::new(|v, ts| {
        v == "kr" || (v == "cb" && ts >= T_1600 && ts <= T_1600 + H) || (v == "bs" && ts >= T_1600 + 3 * H && ts <= T_1600 + 4 * H)
    }));
    let (_r, n, rec) = run(&f);
    let p = prompt(&rec);
    assert!(!p.is_empty(), "judge must be reached: {:?}", n);
    assert!(p.contains("VENUE GAPS (D-RESOLVE8)"), "{}", &p[..p.len().min(2500)]);
    assert!(p.contains("Coinbase") && p.contains("no candles 2025-10-25T16:00Z..2025-10-25T17:00Z"), "{}", &p[..p.len().min(2500)]);
    assert!(p.contains("Bitstamp") && p.contains("no candles 2025-10-25T19:00Z..2025-10-25T20:00Z"), "{}", &p[..p.len().min(2500)]);
}

#[test]
fn d_resolve8a_gap_on_two_venues_covered_by_a_complete_third_reaches_the_judge() {
    // the original 16e2 fixture (6h gap on cb+bs, Kraken complete): Kraken observed every slot
    let mid = WIN_START + 10 * 86_400;
    let f = Sim::jason().with_gap(Box::new(move |v, ts| v != "kr" && ts >= mid && ts < mid + 6 * 3600));
    let (_r, n, rec) = run(&f);
    assert!(!prompt(&rec).is_empty(), "complete Kraken covers the gap, judge reached: {:?}", n);
}
