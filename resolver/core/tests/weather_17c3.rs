//! 17c3 (D-TPL1): pure NWS daily-high rules. Two copies (NWS CLI + IEM); code decides; never on one copy alone.
use praetorial_core::weather::*;
use serde_json::json;

fn v(n: i64) -> Copy { Copy::Val(n) }
fn word(op: &str, x: i64, a: &Copy, b: &Copy) -> &'static str { decide(op, x, a, b).word() }

#[test]
fn both_equal_applies_the_op_whole_degrees() {
    assert_eq!(word(">=", 72, &v(72), &v(72)), "YES");
    assert_eq!(word(">=", 73, &v(72), &v(72)), "NO");
    assert_eq!(word("<=", 72, &v(72), &v(72)), "YES"); // tie decided by the op
    assert_eq!(word("<=", 71, &v(72), &v(72)), "NO");
    assert_eq!(word(">=", 72, &v(-3), &v(-3)), "NO");
    assert_eq!(word("<=", -2, &v(-3), &v(-3)), "YES");
}
#[test]
fn copies_disagree_is_void() {
    let d = decide(">=", 72, &v(72), &v(71));
    assert_eq!(d.word(), "VOID");
    assert!(d.why().contains("copies disagree"), "{}", d.why());
}
#[test]
fn mm_in_either_copy_is_void_max_missing() {
    for (a, b) in [(Copy::Mm, v(72)), (v(72), Copy::Mm), (Copy::Mm, Copy::Mm), (Copy::Mm, Copy::Absent)] {
        let d = decide(">=", 72, &a, &b);
        assert_eq!(d.word(), "VOID", "{:?} {:?}", a, b);
        assert!(d.why().contains("max missing"), "{}", d.why());
    }
}
#[test]
fn one_copy_only_is_retry_never_a_decision() {
    for (a, b) in [(v(72), Copy::Absent), (Copy::Absent, v(72)), (Copy::Absent, Copy::Absent)] {
        assert_eq!(word(">=", 70, &a, &b), "RETRY", "{:?} {:?}", a, b);
        assert_eq!(word("<=", 80, &a, &b), "RETRY", "{:?} {:?}", a, b);
    }
}

fn cli(summary: &str, max: &str) -> String {
    format!("\n000\nCDUS41 KOKX 060645\nCLINYC\n\n...THE CENTRAL PARK NY CLIMATE SUMMARY FOR {}...\n\nTEMPERATURE (F)\n YESTERDAY\n  MAXIMUM         {}    615 PM  78    1961  58     14       66\n  MINIMUM         62    149 AM  23    1879  45     17       48\n\nWIND (MPH)\n  HIGHEST WIND SPEED   9\n", summary, max)
}
#[test]
fn parse_cli_max_reads_the_pinned_day_only() {
    assert_eq!(parse_cli_max(&cli("NOVEMBER 5 2026", "72"), "2026-11-05"), v(72));
    assert_eq!(parse_cli_max(&cli("NOVEMBER 5 2026", "-4"), "2026-11-05"), v(-4));
    assert_eq!(parse_cli_max(&cli("NOVEMBER 5 2026", "MM"), "2026-11-05"), Copy::Mm);
    assert_eq!(parse_cli_max(&cli("NOVEMBER 4 2026", "72"), "2026-11-05"), Copy::Absent, "a report for another day is not this day's copy");
    assert_eq!(parse_cli_max(&cli("JULY 4 2026", "88"), "2026-07-04"), v(88));
    assert_eq!(parse_cli_max("no temperature table here", "2026-11-05"), Copy::Absent);
}
#[test]
fn iem_high_selects_the_row_for_the_date() {
    let b = json!({"results": [{"valid": "2026-11-04", "high": 72}, {"valid": "2026-11-05", "high": 70}, {"valid": "2026-11-06", "high": "M"}]});
    assert_eq!(iem_high(&b, "2026-11-05"), v(70));
    assert_eq!(iem_high(&b, "2026-11-06"), Copy::Mm);
    assert_eq!(iem_high(&b, "2026-11-07"), Copy::Absent);
    assert_eq!(iem_high(&json!({"results": [{"valid": "2026-11-05", "high": null}]}), "2026-11-05"), Copy::Mm);
    assert_eq!(iem_high(&json!({"nope": 1}), "2026-11-05"), Copy::Absent);
}
#[test]
fn climate_day_is_local_standard_time_even_in_dst_season() {
    // KNYC LST = UTC-5 all year: day 2026-07-04 runs 05:00Z..05:00Z (01:00..01:00 EDT), NOT 00:00Z..00:00Z.
    let jul = climate_day_end_unix("KNYC", "2026-07-04").unwrap();
    assert_eq!(praetorial_core::format_ts(jul), "2026-07-05T05:00:00Z");
    assert_eq!(praetorial_core::format_ts(climate_day_end_unix("KNYC", "2026-11-05").unwrap()), "2026-11-06T05:00:00Z");
    assert_eq!(praetorial_core::format_ts(climate_day_end_unix("KLAX", "2026-07-04").unwrap()), "2026-07-05T08:00:00Z");
    assert!(climate_day_end_unix("KXXX", "2026-07-04").is_none());
}
#[test]
fn first_product_issued_after_the_climate_day() {
    let l = json!({"@graph": [
        {"id": "late", "issuanceTime": "2026-11-06T21:36:00+00:00"},
        {"id": "first", "issuanceTime": "2026-11-06T06:45:00+00:00"},
        {"id": "prelim", "issuanceTime": "2026-11-05T21:35:00+00:00"},
        {"id": "older", "issuanceTime": "2026-11-05T06:33:00+00:00"}]});
    let end = climate_day_end_unix("KNYC", "2026-11-05").unwrap();
    assert_eq!(pick_cli_product_id(&l, end).as_deref(), Some("first"));
    let end6 = climate_day_end_unix("KNYC", "2026-11-06").unwrap();
    assert_eq!(pick_cli_product_id(&l, end6), None, "not published yet: the 11-06T21:36Z preliminary is inside the day");
    assert_eq!(parse_issuance("2026-11-06T06:45:00+00:00"), praetorial_core::template::parse_iso("2026-11-06T06:45:00Z"));
}

// ---- WX1 (D-WX1): NWS CLI appends `R` to a value that ties/sets the record (`88R 12:39 PM  88    2016`).
#[test]
fn wx1_parse_cli_max_accepts_the_record_flag() {
    assert_eq!(parse_cli_max(&cli("NOVEMBER 5 2026", "88R"), "2026-11-05"), v(88));
    assert_eq!(parse_cli_max(&cli("NOVEMBER 5 2026", "-4R"), "2026-11-05"), v(-4));
    assert_eq!(parse_cli_max(&cli("NOVEMBER 5 2026", "88 R"), "2026-11-05"), v(88));
    assert_eq!(parse_cli_max(&cli("NOVEMBER 5 2026", "MM"), "2026-11-05"), Copy::Mm, "MM unchanged (D-TPL1)");
    assert_eq!(parse_cli_max(&cli("NOVEMBER 5 2026", "72"), "2026-11-05"), v(72));
}
#[test]
fn wx1_record_flag_does_not_loosen_the_number_match() {
    // nonsense after the digits stays unreadable (Absent -> RETRY), never a wrong number
    for bad in ["88RAIN", "88RR", "8R8", "88X"] {
        assert_eq!(parse_cli_max(&cli("NOVEMBER 5 2026", bad), "2026-11-05"), Copy::Absent, "{}", bad);
    }
    // a non-record line is read as before; the record-year/record-value columns are never taken as the max
    assert_eq!(parse_cli_max(&cli("NOVEMBER 5 2026", "72"), "2026-11-05"), v(72));
    // `MM` followed by an R is not a value
    assert_ne!(parse_cli_max(&cli("NOVEMBER 5 2026", "MMR"), "2026-11-05"), v(0));
}
