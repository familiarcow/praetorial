//! 17d2a: Rust origin derivation must equal judge.py (cases exported by judge-proto/test_origin_parity_17d2a.py).
use praetorial_core::*;
use serde_json::Value;

#[test]
fn origin_derivation_matches_python() {
    let fx: Value = serde_json::from_str(include_str!("fixtures/origin_cases.json")).unwrap();
    for d in fx["domains"].as_array().unwrap() {
        let got = registrable_domain(d[0].as_str().unwrap());
        assert_eq!(got.as_deref(), d[1].as_str(), "domain of {}", d[0]);
    }
    for g in fx["groups"].as_array().unwrap() {
        let src = g["sources"].as_array().unwrap().clone();
        let want: Vec<usize> = g["want"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize).collect();
        assert_eq!(origin_groups(&src), want, "{}", g["sources"]);
    }
}
