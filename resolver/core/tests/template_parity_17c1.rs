//! 17c1 parity: Rust lint must produce the same ordered problem-code prefixes as the committed cases that
//! judge-proto/test_template_parity_17c1.py also checks (the Python twin).
use praetorial_core::lint;
use serde_json::Value;

fn code(p: &str) -> String {
    let head = p.split(':').next().unwrap_or("");
    if !head.is_empty() && head.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') { head.to_string() } else { "legacy".to_string() }
}
#[test]
fn rust_lint_matches_the_shared_cases() {
    let fx: Value = serde_json::from_str(include_str!("fixtures/template_cases.json")).unwrap();
    let cases = fx.as_array().unwrap();
    assert!(cases.len() >= 30);
    for c in cases {
        let got: Vec<String> = lint(&c["ts"]).iter().map(|p| code(p)).collect();
        let want: Vec<String> = c["codes"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert_eq!(got, want, "{}", c["name"]);
    }
}
