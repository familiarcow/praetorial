//! LNT1: resolver custom lint vs the web builder gate, from ONE shared table (fixtures/lint_parity/cases.json).
//! Every ambiguous phrasing is refused with the same AMBIGUOUS_* code the web gate reports; every control passes;
//! and EVERY resolver lint problem (custom + typed) carries a non-empty "what to change" hint.
use praetorial_core::*;
use serde_json::Value;

fn load(path: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(format!("{}/{}", env!("CARGO_MANIFEST_DIR"), path)).unwrap()).unwrap()
}
fn table() -> Value {
    load("../../fixtures/lint_parity/cases.json")
}
fn baseline() -> Value {
    load("tests/fixtures/lint.json")["cases"].as_array().unwrap().iter().find(|c| c["name"] == "baseline_passes_lint").unwrap()["ts"].clone()
}
fn sheet(phrasing: &str) -> Value {
    let mut ts = baseline();
    ts["claim"] = Value::String(phrasing.to_string());
    ts["elements"][0]["q"] = Value::String(phrasing.to_string());
    ts
}
fn code(p: &str) -> String {
    let h = p.split(':').next().unwrap_or("");
    if !h.is_empty() && h.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') { h.to_string() } else { "legacy".to_string() }
}
/// The "what to change" hint: the same verb vocabulary the web test (ambiguousReject FIX_HINT) has always required.
fn has_hint(p: &str) -> bool {
    let re = regex::Regex::new(r"(?i)\b(state|write|use|name|replace|remove|add|change|pin|say|pick|specify|give)\b").unwrap();
    re.is_match(p)
}

#[test]
fn every_ambiguous_phrasing_is_refused_with_the_web_gates_code() {
    let t = table();
    let mut n = 0;
    for grp in t["ambiguous"].as_array().unwrap() {
        let want = grp["code"].as_str().unwrap();
        for v in grp["variants"].as_array().unwrap() {
            let ph = v.as_str().unwrap();
            let codes: Vec<String> = lint(&sheet(ph)).iter().map(|p| code(p)).collect();
            assert!(codes.contains(&want.to_string()), "{:?} must be refused with {} (got {:?})", ph, want, codes);
            n += 1;
        }
    }
    assert!(n >= 40, "table too small: {}", n);
}

#[test]
fn clean_controls_still_pass_the_resolver_lint() {
    for c in table()["controls"].as_array().unwrap() {
        let ph = c["phrasing"].as_str().unwrap();
        let bad: Vec<String> = lint(&sheet(ph)).iter().map(|p| code(p)).filter(|k| k.starts_with("AMBIGUOUS_") || k == "CUSTOM_RELATIVE_DATE").collect();
        assert!(bad.is_empty(), "control {} {:?} wrongly refused: {:?}", c["id"], ph, bad);
    }
}

#[test]
fn every_resolver_lint_problem_says_what_to_change() {
    let mut all: Vec<String> = Vec::new();
    for c in load("tests/fixtures/lint.json")["cases"].as_array().unwrap() {
        all.extend(lint(&c["ts"]));
    }
    for c in load("tests/fixtures/template_cases.json").as_array().unwrap() {
        all.extend(lint(&c["ts"]));
    }
    let t = table();
    for grp in t["ambiguous"].as_array().unwrap() {
        for v in grp["variants"].as_array().unwrap() {
            all.extend(lint(&sheet(v.as_str().unwrap())));
        }
    }
    assert!(all.len() >= 100, "expected a broad problem sample, got {}", all.len());
    let missing: std::collections::BTreeSet<&String> = all.iter().filter(|p| !has_hint(p)).collect();
    assert!(missing.is_empty(), "problems with no what-to-change hint: {:#?}", missing);
}

#[test]
fn open_problems_all_returns_the_ambiguous_problems_for_custom_sheets() {
    let now = 1_794_052_800i64;
    let mut n = 0;
    for grp in table()["ambiguous"].as_array().unwrap() {
        let want = grp["code"].as_str().unwrap();
        for v in grp["variants"].as_array().unwrap() {
            let ph = v.as_str().unwrap();
            let codes: Vec<String> = template::open_problems_all(&sheet(ph), now).iter().map(|p| code(p)).collect();
            assert!(codes.contains(&want.to_string()), "open_problems_all must refuse {:?} with {} (got {:?})", ph, want, codes);
            n += 1;
        }
    }
    assert!(n >= 40);
    for c in table()["controls"].as_array().unwrap() {
        let ph = c["phrasing"].as_str().unwrap();
        let bad: Vec<String> = template::open_problems_all(&sheet(ph), now).iter().map(|p| code(p)).filter(|k| k.starts_with("AMBIGUOUS_")).collect();
        assert!(bad.is_empty(), "control {:?} wrongly refused: {:?}", ph, bad);
    }
}
