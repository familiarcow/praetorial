//! R3 (D-JUDGE4): insufficient is never NO; labelled short quotes; JSON-lane field+value citation.
use praetorial_core::*;
use serde_json::json;

fn ts(rule: &str) -> serde_json::Value { json!({"rule": rule}) }

#[test]
fn element_verdict_keeps_insufficient_distinct_from_not_met() {
    let src = vec![json!({"id":"S1","text":"x"})];
    let r = element_verdict(&[("insufficient".into(), None)], &ts("ALL"), &src);
    assert_eq!(r, "insufficient");
    let r = element_verdict(&[("not_met".into(), Some("S1".into()))], &ts("ALL"), &src);
    assert_eq!(r, "not_proven");
}

#[test]
fn decide_all_with_insufficient_is_never_no() {
    let (o, _) = decide(&ts("ALL"), &["met".into(), "insufficient".into()]);
    assert_ne!(o, "NO");
    assert_eq!(o, "ESCALATE");
    let (o, _) = decide(&ts("ANY"), &["insufficient".into()]);
    assert_ne!(o, "NO");
}

#[test]
fn decide_definite_not_met_still_beats_insufficient_for_all() {
    let (o, _) = decide(&ts("ALL"), &["not_proven".into(), "insufficient".into()]);
    assert_eq!(o, "NO");
}

#[test]
fn decide_any_met_wins_over_insufficient() {
    let (o, _) = decide(&ts("ANY"), &["met".into(), "insufficient".into()]);
    assert_eq!(o, "YES");
}

#[test]
fn short_labelled_quote_is_allowed() {
    let srcs = vec![json!({"id":"S1","text":"Daily climate. MAXIMUM 72 at 3:51 PM. MINIMUM 51"})];
    let raw = r#"{"answer":"met","source_id":"S1","quote":"MAXIMUM 72"}"#;
    assert_eq!(verify(raw, &srcs, "Question: was it 70 or above"), ("met".into(), Some("S1".into())));
}

#[test]
fn short_unlabelled_quote_still_rejected() {
    let srcs = vec![json!({"id":"S1","text":"Daily climate. MAXIMUM 72 at 3:51 PM"})];
    let raw = r#"{"answer":"met","source_id":"S1","quote":"Daily"}"#;
    assert_eq!(verify(raw, &srcs, "").0, "invalid");
}

#[test]
fn json_lane_field_and_value_checked_by_code() {
    let srcs = vec![json!({"id":"S1","text":"{\"high\": 72, \"low\": 51, \"station\": \"KNYC\"}"})];
    let ok = r#"{"answer":"met","source_id":"S1","field":"high","value":"72"}"#;
    assert_eq!(verify(ok, &srcs, "").0, "met");
    let wrong = r#"{"answer":"met","source_id":"S1","field":"high","value":"99"}"#;
    assert_eq!(verify(wrong, &srcs, "").0, "invalid");
    let missing = r#"{"answer":"met","source_id":"S1","field":"nope","value":"1"}"#;
    assert_eq!(verify(missing, &srcs, "").0, "invalid");
}

#[test]
fn lint_text_no_longer_tells_the_model_couldnt_check() {
    assert!(!FIXED_SYSTEM.contains("COULDNT_CHECK"));
    for c in CLAUSES.values() { assert!(!c.contains("COULDNT_CHECK")); }
}
