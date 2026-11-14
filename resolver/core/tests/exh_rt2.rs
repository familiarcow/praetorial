//! RT2 / D-EXH1 (Rust twin of judge-proto/test_exhibit_corroboration_rt2.py): a decisive verdict on dispute
//! exhibits needs verified quotes from >= 2 distinct derived origins; one honest exhibit alone is not decisive.
use praetorial_core::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const REUTERS_YES: &str = "Customers lined up outside Apple stores in New York on Tuesday as the iPhone Fold, the company's first foldable phone, went on sale in the United States.";
const OUTLET_YES: &str = "We bought an iPhone Fold at an Apple Store in Chicago today. It is on sale now across the United States.";
const Q1: &str = "Customers lined up outside Apple stores in New York on Tuesday";
const Q2: &str = "We bought an iPhone Fold at an Apple Store in Chicago today";

fn term() -> Value {
    json!({
        "claim": "Apple makes a foldable iPhone available to buy in the US during 2027.",
        "elements": [{"id": "e1", "q": "Did Apple make a foldable-screen iPhone available to purchase by the general public in the United States between 2027-01-01 and 2027-12-31 UTC?"}],
        "rule": "ALL",
        "clauses": ["AVAILABLE_V1", "UTC_V1", "PARTIAL_NONE_V1", "ANNOUNCED_V1"],
        "time": {"window_start": "2027-01-01T00:00:00Z", "window_end": "2027-12-31T23:59:59Z", "evidence_cutoff": "2028-01-07T00:00:00Z"},
        "source_classes": {"apple.com newsroom": "primary", "Reuters": "wire", "AP": "wire", "The Verge": "outlet", "TechDaily": "outlet"},
    })
}

fn ex(id: &str, publisher: &str, text: &str, url: &str) -> Value {
    json!({"id": id, "by": "yes", "publisher": publisher, "published": "2027-12-20T10:00:00Z", "first_capture": "2027-12-20T10:00:00Z",
           "text": text, "submitted": "2028-01-08T12:00:00Z", "onchain_submitted_at": "2028-01-08T12:00:00Z", "url": url})
}

fn admitted(two: bool, same_domain: bool) -> Vec<Value> {
    let mut v = vec![ex("Y1", "Reuters", REUTERS_YES, "https://www.reuters.com/a")];
    if two {
        v.push(ex("Y2", "AP", OUTLET_YES, if same_domain { "https://www.reuters.com/b" } else { "https://apnews.com/b" }));
    }
    let n = v.len();
    let (adm, rej) = admit(&term(), &v, "2028-01-10T00:00:00Z");
    assert_eq!(adm.len(), n, "{:?}", rej);
    adm
}

fn raw(answer: &str, also: bool) -> String {
    let also: Vec<Value> = if also { vec![json!({"source_id": "Y2", "quote": Q2})] } else { vec![] };
    json!({"answer": answer, "quote": Q1, "source_id": "Y1", "also": also}).to_string()
}

fn tiered(adm: &[Value], raws: Vec<String>) -> String {
    let t = term();
    let mut by: BTreeMap<i64, Vec<String>> = BTreeMap::new();
    for a in adm {
        by.insert(a["tier"].as_i64().unwrap(), raws.clone());
    }
    judge_element_tiered_fixed(&t, &t["elements"][0], adm, &[], &by).0
}

#[test]
fn rt2_one_honest_exhibit_alone_is_not_decisive() {
    let adm = admitted(false, false);
    assert_eq!(tiered(&adm, vec![raw("met", false); 2]), "insufficient");
}

#[test]
fn rt2_two_independent_origins_are_decisive() {
    let adm = admitted(true, false);
    assert_eq!(tiered(&adm, vec![raw("met", true); 2]), "met");
}

#[test]
fn rt2_two_exhibits_same_domain_count_once() {
    let adm = admitted(true, true);
    assert_eq!(tiered(&adm, vec![raw("met", true); 2]), "insufficient");
}

#[test]
fn rt2_declared_origin_cannot_split_one_domain() {
    let mut adm = admitted(true, true);
    adm[0]["origin"] = json!("reuters-a");
    adm[1]["origin"] = json!("reuters-b");
    assert_eq!(tiered(&adm, vec![raw("met", true); 2]), "insufficient");
}

#[test]
fn rt2_decisive_no_needs_two_origins() {
    assert_eq!(tiered(&admitted(true, false), vec![raw("not_met", false); 2]), "insufficient");
    assert_eq!(tiered(&admitted(true, false), vec![raw("not_met", true); 2]), "not_proven");
}
