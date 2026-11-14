//! L1c (D-L1GATE1 option A): a custom price sheet that pins a threshold + named venues (+ a 5-minute coincidence bucket)
//! is signed YES/NO only when the CODE-computed condition (from the candles the resolver already fetched) agrees with
//! the judge; on disagreement the resolver signs VOID. Replays the L1a recorded candles with per-test recorded judge replies.
use super::item_l1a_tests::{run_one, run_one_audit, L1};
use serde_json::{json, Value};

fn example(id: &str) -> Value {
    let doc: Value = serde_json::from_slice(&std::fs::read(format!("{}/examples.json", L1)).unwrap()).unwrap();
    doc["examples"].as_array().unwrap().iter().find(|e| e["id"] == id).unwrap_or_else(|| panic!("no example {}", id)).clone()
}
fn with_judge(id: &str, answer: &str, quote: &str, sid: &str) -> (String, String, Vec<String>) {
    let mut e = example(id);
    e["judge"] = json!(json!({"answer": answer, "quote": quote, "source_id": sid, "reason": "l1c recorded"}).to_string());
    run_one(&e)
}
/// D-JUDGETIME1b (b): on a gate-decided sheet the judge's recorded reply is what the AUDIT prompt receives. A non-agree is VOID.
fn with_audit_reply(id: &str, reply_answer: &str, quote: &str, sid: &str) -> (String, String, Vec<String>) {
    let e = example(id);
    let reply = json!({"answer": reply_answer, "quote": quote, "source_id": sid, "reason": "l1c recorded"}).to_string();
    run_one_audit(&e, Some(&reply))
}
/// D-JUDGETIME1b (c): the same sheet with the Coinbase 12-minute-gap fixture: the gate cannot fully decide it, so the FULL judge path runs.
fn with_judge_gap(id: &str, answer: &str, quote: &str, sid: &str) -> (String, String, Vec<String>) {
    let mut e = example(id);
    e["cb_file"] = json!("SYNTHETIC_cb_BTC_1m_gap12.json");
    e["judge"] = json!(json!({"answer": answer, "quote": quote, "source_id": sid, "reason": "l1c recorded"}).to_string());
    run_one(&e)
}
const BS_ROW: (&str, &str) = ("1794029880,75952.18", "S_BS"); // a real Bitstamp row
const CB_ROW: (&str, &str) = ("1794029820,75948.99", "S_CB"); // a real Coinbase row

#[test]
fn l1c_judge_met_on_one_venue_only_is_not_yes() {
    // D-JUDGETIME1b (b): the L1a probe is gate-decided (code NO). The adversarial judge reply "met" reaches the AUDIT prompt: audit
    // non-agree -> VOID, never YES.
    let (out, path, notes) = with_audit_reply("jason_bitstamp_only_no", "met", BS_ROW.0, BS_ROW.1);
    assert_ne!(out, "YES", "{:?}", notes);
    assert_eq!(out, "VOID", "{:?}", notes);
    assert_eq!(path, "AI");
    assert!(notes.iter().any(|n| n.contains("audit disagreed")), "{:?}", notes);
}
// D-JUDGETIME1b (c): the original D-L1GATE1 judge-vs-code assertion, on a sheet the gate cannot fully decide (Coinbase gap): full judge.
#[test]
fn l1c_gap_sheet_judge_met_on_one_venue_only_is_not_yes() {
    let (out, _, notes) = with_judge_gap("jason_bitstamp_only_no", "met", BS_ROW.0, BS_ROW.1);
    assert_eq!(out, "VOID", "{:?}", notes);
    assert!(notes.iter().any(|n| n.contains("D-L1GATE1")), "{:?}", notes);
}

#[test]
fn l1c_judge_not_met_while_code_says_crossed_is_void() {
    // D-JUDGETIME1b (b): gate-decided YES; a non-agree audit (the recorded not_met reply) -> VOID, the model never flips.
    let (out, _, notes) = with_audit_reply("jason_same_bucket_yes", "not_met", CB_ROW.0, CB_ROW.1);
    assert_eq!(out, "VOID", "{:?}", notes);
    assert!(notes.iter().any(|n| n.contains("audit disagreed")), "{:?}", notes);
}
// D-JUDGETIME1b (c): full-judge copy: Coinbase gap -> Bitstamp+Kraken pair decides (the l1c kraken-fallback sheet shape); not_met vs code YES.
#[test]
fn l1c_gap_sheet_judge_not_met_while_code_says_crossed_is_void() {
    let (out, _, notes) = with_judge_gap("jason_coinbase_gap_kraken_fallback_yes", "not_met", "1794029820,75949.72", "S_BS");
    assert_eq!(out, "VOID", "{:?}", notes);
    assert!(notes.iter().any(|n| n.contains("D-L1GATE1")), "{:?}", notes);
}

#[test]
fn l1c_bucket_mismatch_with_judge_met_is_not_yes() {
    // D-JUDGETIME1b (b): both venues cross in disjoint buckets (gate-decided NO); a "met" reply to the audit -> VOID, never YES.
    let (out, _, notes) = with_audit_reply("jason_both_venues_different_buckets_no", "met", BS_ROW.0, BS_ROW.1);
    assert_ne!(out, "YES", "{:?}", notes);
    assert_eq!(out, "VOID", "{:?}", notes);
    assert!(notes.iter().any(|n| n.contains("audit disagreed")), "{:?}", notes);
}
// D-JUDGETIME1b (c): full-judge copy: same sheet with the Coinbase gap (cannot be fully decided), judge claims met.
#[test]
fn l1c_gap_sheet_bucket_mismatch_with_judge_met_is_not_yes() {
    let (out, _, notes) = with_judge_gap("jason_both_venues_different_buckets_no", "met", BS_ROW.0, BS_ROW.1);
    assert_ne!(out, "YES", "{:?}", notes);
    assert_eq!(out, "VOID", "{:?}", notes);
}

#[test]
fn l1c_agreeing_cases_still_sign() {
    assert_eq!(with_judge("jason_same_bucket_yes", "met", CB_ROW.0, CB_ROW.1).0, "YES");
    assert_eq!(with_judge("jason_bitstamp_only_no", "not_met", "1794029220,75950", "S_CB").0, "NO");
    assert_eq!(with_judge("jason_both_venues_different_buckets_no", "not_met", "1794029880,75952.18", "S_BS").0, "NO");
    assert_eq!(with_judge("jason_coinbase_only_no", "not_met", "1794033120,75966.49", "S_BS").0, "NO");
}

#[test]
fn l1c_kraken_fallback_still_works_and_is_gated() {
    // Coinbase INCOMPLETE (12-min gap): Bitstamp + Kraken pair decides.
    assert_eq!(with_judge("jason_coinbase_gap_kraken_fallback_yes", "met", "1794029820,75949.72", "S_BS").0, "YES");
    assert_eq!(with_judge("jason_coinbase_small_gap_yes", "met", CB_ROW.0, CB_ROW.1).0, "YES");
    let (out, _, notes) = with_judge("jason_coinbase_gap_kraken_fallback_yes", "not_met", "1794029820,75949.72", "S_BS");
    assert_eq!(out, "VOID", "judge not_met vs code true: {:?}", notes);
}

#[test]
fn l1c_non_price_condition_sheets_unchanged() {
    // range / pct sheets are not recognisable high-threshold-with-coincidence sheets: L1a expectations stand.
    for id in ["range_breakout_no", "range_all_session_stays_within_void", "pct_up_day_custom_void", "flips_100k_messy"] {
        let e = example(id);
        let (out, _, notes) = run_one(&e);
        assert_eq!(out, e["expected"].as_str().unwrap(), "{} {:?}", id, notes);
    }
}

// L1b2: replay the EXACT live term sheet (bets 2/4) natively; must produce a signed result, never panic.
#[test]
fn l1b2_live_one_venue_no_sheet_yields_outcome() {
    let raw = String::from_utf8(std::fs::read(format!("{}/live/terms_jason_bitstamp_only_no.json", L1)).unwrap()).unwrap();
    let e = json!({"kind":"custom","now":1794065826,"sheet":serde_json::from_str::<Value>(&raw).unwrap(),
        "judge": json!({"answer":"not_met","quote":"1794029220,75950","source_id":"S_CB","reason":"l1b2"}).to_string()});
    let r = std::panic::catch_unwind(|| run_one(&e));
    let (out, _, notes) = r.expect("resolver panicked on the live one-venue sheet");
    assert_eq!(out, "NO", "{:?}", notes);
}
