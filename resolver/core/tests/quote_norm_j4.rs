//! J4 (D-JUDGE5): token-aware quote normalisation, Rust twin of judge.py `quote_key` / `quote_in`.
//! Parity cases: fixtures/quote_key.json (exported from judge-proto/test_quote_norm_j4.py).
//! Numeric guard: dropping case/whitespace/punctuation must never change what a NUMBER means.
use praetorial_core::*;
use serde_json::{json, Value};

const NEG: &[(&str, &str)] = &[
    ("The rate is 3.5 percent", "The rate is 35 percent"),
    ("The rate is 35 percent", "The rate is 3.5 percent"),
    ("The low was -5 degrees", "The low was 5 degrees"),
    ("The low was 5 degrees", "The low was -5 degrees"),
    ("There were 1,000 votes", "There were 1.000 votes"),
    ("There were 1.000 votes", "There were 1,000 votes"),
    ("There were 1,000 votes", "There were 1000 votes"),
    ("Kickoff is at 10:30 sharp", "Kickoff is at 1030 sharp"),
    ("Kickoff is at 1030 sharp", "Kickoff is at 10:30 sharp"),
    ("Change was +0.5 points", "Change was 05 points"),
    ("Change was 05 points", "Change was +0.5 points"),
    ("Change was +0.5 points", "Change was 0.5 points"),
    ("Attendance: 60,06 people", "Attendance: 60,065 people"),
    ("Attendance: 770.49 dollars", "Attendance: 75,770.49 dollars"),
    ("Total was 3 5 units", "Total was 35 units"),
    ("Final 25 -22 sets", "Final 25 22 sets"),
];
const POS: &[(&str, &str)] = &[
    ("THE RATE IS 3.5 PERCENT", "the rate is 3.5 percent"),
    ("The rate   is\n3.5 percent!", "The rate is 3.5 percent."),
    ("The low was -5 degrees", "The low was -5  degrees."),
    ("There were 1,000 votes", "There were 1,000 votes."),
    ("Kickoff is at 10:30 AM", "Kickoff is at 10:30 am"),
    ("Change was +0.5 points", "Change was +0.5 points"),
    ("Final: Chiefs 25-22 49ers", "Final Chiefs 25 22 49ers"),
    ("Alcaraz won the final.[12]", "Alcaraz won the final"),
    ("Tom & Jerry won 4 games", "Tom &amp; Jerry won 4 games"),
    ("\u{201c}He won 4 games\u{201d}, said Ann", "\"He won 4 games\" said Ann"),
    ("He won 4 games \u{2014} easily", "He won 4 games easily"),
    ("Value was \u{2212}5 units", "Value was -5 units"),
];

#[test]
fn numeric_guard_never_cross_matches() {
    for (q, page) in NEG {
        assert!(!quote_in(q, page), "{:?} must not match {:?}", q, page);
    }
}

#[test]
fn formatting_only_differences_match() {
    for (q, page) in POS {
        assert!(quote_in(q, page), "{:?} must match {:?}", q, page);
    }
}

#[test]
fn verify_rejects_number_mangled_quote_and_also_quote() {
    let srcs = vec![json!({"id":"S1","text":"Temperature was -5 degrees at noon in Oslo","party_controlled":false}),
                    json!({"id":"S2","text":"Oslo reported -5 degrees at noon on Friday","party_controlled":false})];
    let ok = json!({"answer":"met","source_id":"S1","quote":"temperature was -5 degrees at noon","also":[{"source_id":"S2","quote":"Oslo reported -5 degrees at noon"}]}).to_string();
    assert_eq!(verify(&ok, &srcs, "Question: cold?").0, "met");
    let bad = json!({"answer":"met","source_id":"S1","quote":"Temperature was 5 degrees at noon"}).to_string();
    assert_eq!(verify(&bad, &srcs, "Question: cold?").0, "invalid");
    let bad_also = json!({"answer":"met","source_id":"S1","quote":"temperature was -5 degrees at noon","also":[{"source_id":"S2","quote":"Oslo reported 5 degrees at noon"}]}).to_string();
    assert_eq!(verify(&bad_also, &srcs, "Question: cold?").0, "invalid");
    let sloppy = json!({"answer":"met","source_id":"S1","quote":"Temperature was -5 degrees at noon.","also":[{"source_id":"S2","quote":"OSLO reported -5 degrees at noon"}]}).to_string();
    assert_eq!(verify(&sloppy, &srcs, "Question: cold?").0, "met");
}

fn rejects() -> Vec<Value> {
    let fx: Value = serde_json::from_str(include_str!("fixtures/r2_quote_rejects.json")).unwrap();
    fx["rejects"].as_array().unwrap().clone()
}

#[test]
fn r2_recovered_false_rejects_are_recovered() {
    let rs: Vec<Value> = rejects().into_iter().filter(|r| r["r2_alnum_recovers"] == json!(true)).collect();
    assert_eq!(rs.len(), 26);
    let missed: Vec<String> = rs.iter().filter(|r| !quote_in(r["quote"].as_str().unwrap(), r["page_window"].as_str().unwrap())).map(|r| r["case"].to_string()).collect();
    assert!(missed.is_empty(), "{:?}", missed);
}

#[test]
fn r2_not_on_page_quotes_stay_rejected() {
    let rs: Vec<Value> = rejects().into_iter().filter(|r| r["r2_alnum_recovers"] != json!(true)).collect();
    assert_eq!(rs.len(), 5);
    for r in rs {
        assert!(!quote_in(r["quote"].as_str().unwrap(), r["page_window"].as_str().unwrap_or("")), "{}", r["case"]);
    }
}

#[test]
fn quote_key_matches_python() {
    let fx: Value = serde_json::from_str(include_str!("fixtures/quote_key.json")).unwrap();
    let keys = fx["keys"].as_array().unwrap();
    assert!(keys.len() > 40, "fixture must carry the parity cases");
    for k in keys {
        assert_eq!(quote_key(k["input"].as_str().unwrap()), k["key"].as_str().unwrap(), "input {:?}", k["input"]);
    }
}
