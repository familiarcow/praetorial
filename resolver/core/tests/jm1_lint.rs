//! JM1 (D-JUDGE6): lint rejects a non-empty `models` field; judge-proto/test_models_pinned_jm1.py asserts the same string.
use praetorial_core::*;
use serde_json::{json, Value};

const PROBLEM: &str = "models: judge models are pinned by the resolver (D-JUDGE6); to fix: remove the models field from the sheet";

fn good() -> Value {
    let fx: Value = serde_json::from_str(&std::fs::read_to_string(format!("{}/tests/fixtures/lint.json", env!("CARGO_MANIFEST_DIR"))).unwrap()).unwrap();
    fx["cases"].as_array().unwrap().iter().find(|c| c["name"] == "baseline_passes_lint").expect("baseline case")["ts"].clone()
}

#[test]
fn lint_baseline_has_no_models_problem() {
    assert!(!lint(&good()).iter().any(|p| p.starts_with("models:")));
}
#[test]
fn lint_rejects_non_empty_models() {
    for m in [json!(["X"]), json!(["A", "B"]), json!(["mock"]), json!("X"), json!({"a": 1})] {
        let mut ts = good();
        ts["models"] = m.clone();
        assert!(lint(&ts).contains(&PROBLEM.to_string()), "models {} -> {:?}", m, lint(&ts));
    }
}
#[test]
fn lint_allows_absent_or_empty_models() {
    let mut ts = good();
    ts["models"] = json!([]);
    assert!(!lint(&ts).iter().any(|p| p.starts_with("models:")), "{:?}", lint(&ts));
    ts.as_object_mut().unwrap().remove("models");
    assert!(!lint(&ts).iter().any(|p| p.starts_with("models:")));
}
