//! V1b / D-VER2: parity vectors for the origin-corroboration rules verify-bet B4 re-applies (D-ORIGIN1 / D-EXH1).
//! Same vectors as judge-proto/test_verifier_b4_parity.py and services/verifier/test/b4.test.ts.
use praetorial_core::*;
use serde_json::Value;

#[test]
fn b4_parity_vectors_element_verdict_q() {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../services/verifier/test/fixtures/b4_parity.json")).unwrap()).unwrap();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() >= 6);
    for c in cases {
        let results: Vec<(String, Option<String>)> = c["results"].as_array().unwrap().iter().map(|r| (r[0].as_str().unwrap().to_string(), r[1].as_str().map(|s| s.to_string()))).collect();
        let sources: Vec<Value> = c["sources"].as_array().unwrap().clone();
        let got = element_verdict_q(&results, &sources, c["quorum"].as_bool().unwrap());
        assert_eq!(got, c["expect"].as_str().unwrap(), "{}", c["name"]);
    }
}
