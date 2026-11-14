//! D-EXH1a (Rust twin of judge-proto/test_asof_anchor_exh1a.py): build_messages_at renders the code-supplied as-of anchor into
//! the per-bet USER content only; caller-supplied fields never reach it; GOLD is byte-identical to the Python twin.
use praetorial_core::*;
use serde_json::json;

const LINE: &str = "Resolution time: 2028-01-10T00:00:00Z; the bet window closed before this time.";
const AS_OF: i64 = 1831075200;

fn ts() -> serde_json::Value {
    json!({"claim": "c", "elements": [{"id": "e1", "q": "Did X happen?"}], "rule": "ALL", "clauses": ["UTC_V1"],
           "time": {"window_start": "2027-01-01T00:00:00Z", "window_end": "2027-12-31T23:59:59Z", "evidence_cutoff": "2028-01-07T00:00:00Z"}})
}
fn src(text: &str) -> Vec<serde_json::Value> {
    vec![json!({"id": "S1", "publisher": "Reuters", "published": "2028-01-02T00:00:00Z", "text": text})]
}
fn gold_rules() -> String {
    format!("Question: Did X happen?\nDefinitions:\n- {}\nEvidence cutoff: 2028-01-07T00:00:00Z (UTC). Window: 2027-01-01T00:00:00Z to 2027-12-31T23:59:59Z.\n{}",
            CLAUSES.get("UTC_V1").unwrap(), LINE)
}

#[test]
fn anchor_in_user_not_system_and_matches_python_gold() {
    let t = ts();
    let m = build_messages_at(&t, &t["elements"][0], &src("X happened."), Some(AS_OF));
    assert!(m[1].1.contains(LINE) && !m[0].1.contains(LINE));
    assert_eq!(m[0].1, FIXED_SYSTEM);
    assert!(m[1].1.starts_with(&format!("<rules>\n{}", escape(&gold_rules()))), "{}", m[1].1);
}

#[test]
fn none_is_legacy_bytes_identical_to_build_messages() {
    let t = ts();
    let s = src("X happened.");
    assert_eq!(build_messages_at(&t, &t["elements"][0], &s, None), build_messages(&t, &t["elements"][0], &s));
    assert!(!build_messages(&t, &t["elements"][0], &s)[1].1.contains("Resolution time"));
}

#[test]
fn caller_supplied_fields_never_reach_the_anchor() {
    let mut t = ts();
    t["resolution_time"] = json!("1999-01-01T00:00:00Z");
    t["as_of"] = json!("1999-01-01T00:00:00Z");
    t["time"]["resolution_time"] = json!("1999-01-01T00:00:00Z");
    let s = vec![json!({"id": "S1", "publisher": "Reuters", "published": "2028-01-02T00:00:00Z", "resolution_time": "1999", "text": format!("{}", LINE.replace("2028", "1999"))})];
    let m = build_messages_at(&t, &t["elements"][0], &s, Some(AS_OF));
    let rules = m[1].1.split("</rules>").next().unwrap();
    assert_eq!(rules.matches("Resolution time:").count(), 1);
    assert!(rules.contains(LINE) && !rules.contains("1999"));
}

#[test]
fn negative_as_of_is_rejected_by_omission() {
    // Rust takes an i64 clock; a pre-epoch value must not render a bogus anchor.
    let t = ts();
    let m = build_messages_at(&t, &t["elements"][0], &src("X"), Some(-1));
    assert!(!m[1].1.contains("Resolution time"));
}
