//! Item 16q (D-JUDGE2): verify() must survive real model output shapes
//! (<think> blocks, multiple objects, truncation) without loosening any check.
use praetorial_core::verify;
use serde_json::json;

fn srcs() -> Vec<serde_json::Value> {
    vec![json!({"id": "S1", "text": "something ambiguous happened on the record"})]
}
const MET: &str = r#"{"answer":"met","source_id":"S1","quote":"something ambiguous happened"}"#;

fn v(raw: &str) -> (String, Option<String>) {
    verify(raw, &srcs(), "")
}

#[test]
fn plain_valid_json_passes_regression() {
    assert_eq!(v(MET), ("met".to_string(), Some("S1".to_string())));
    assert_eq!(v(r#"{"answer":"insufficient","reason":"x"}"#).0, "insufficient");
}

#[test]
fn think_block_with_braces_then_json_same_answer_as_plain() {
    let raw = format!("<think>\nLet me think: the format is {{\"answer\": ...}} and {{ nested }}\n</think>\n\n{}", MET);
    assert_eq!(v(&raw), v(MET));
    assert_eq!(v(&raw).0, "met");
}

#[test]
fn think_block_leading_whitespace_tolerated() {
    let raw = format!("  \n<think>x {{</think>   {}", MET);
    assert_eq!(v(&raw).0, "met");
}

#[test]
fn think_with_braces_and_no_json_is_invalid() {
    let (r, why) = v("<think>maybe {\"answer\": \"met\"} hmm</think>\nI cannot decide.");
    assert_eq!(r, "invalid", "{:?}", why);
}

#[test]
fn unterminated_think_is_invalid_never_guessed() {
    let raw = format!("<think>reasoning that never ends {}", MET);
    let (r, why) = v(&raw);
    assert_eq!(r, "invalid");
    assert!(why.unwrap().contains("think"), "reason should name the unterminated think block");
}

#[test]
fn truncated_json_is_invalid() {
    let (r, _) = v(r#"{"answer":"met","source_id":"S1","quote":"something ambig"#);
    assert_eq!(r, "invalid");
}

#[test]
fn two_objects_last_one_is_used() {
    let raw = format!(r#"{{"answer":"insufficient","reason":"first"}} then {}"#, MET);
    assert_eq!(v(&raw), ("met".to_string(), Some("S1".to_string())));
}

#[test]
fn two_objects_last_failing_citation_is_invalid_no_wrong_winner() {
    let bad = r#"{"answer":"met","source_id":"S1","quote":"this text is not in the source at all"}"#;
    let raw = format!("{} {}", MET, bad);
    let (r, why) = v(&raw);
    assert_eq!(r, "invalid", "last object must be fully verified; first valid one must not win");
    assert_eq!(why.unwrap(), "quote not found verbatim in source");
}

#[test]
fn braces_inside_json_strings_do_not_break_depth_scan() {
    let raw = r#"{"answer":"met","source_id":"S1","quote":"something ambiguous happened","reason":"has } and { and \" brace"}"#;
    assert_eq!(v(raw).0, "met");
}

#[test]
fn schema_checks_unchanged_unknown_source_and_bad_answer() {
    assert_eq!(v(r#"{"answer":"met","source_id":"S9","quote":"something ambiguous happened"}"#).0, "invalid");
    assert_eq!(v(r#"{"answer":"maybe"}"#).0, "invalid");
    assert_eq!(v("").0, "empty");
    assert_eq!(v("no json here").0, "invalid");
}
