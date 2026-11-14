//! LNT1b (D-LNT1): the open-time sourcecheck refuses every ambiguous custom sheet from the shared table
//! (fixtures/lint_parity/cases.json) with the same AMBIGUOUS_* code the web form reports; clean controls are never
//! refused for an AMBIGUOUS_* reason. lint_runtime still ignores AMBIGUOUS_* (an open bet is never re-refused).
use super::*;
use serde_json::json;

struct Clk;
impl Clock for Clk {
    fn now_ns(&self) -> u64 { 1_794_052_800_000_000_000 }
}
struct Page;
impl HttpFetcher for Page {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        Ok(RawFetchResponse {
            final_url: url.into(),
            redirect_chain: vec![],
            content_type: "text/html".into(),
            body: b"<html><body><p>BTC-USD candle data page with enough visible text to be readable, 75900.00 USD.</p></body></html>".to_vec(),
            status_code: 200,
        })
    }
}
fn load(rel: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(format!("{}/{}", env!("CARGO_MANIFEST_DIR"), rel)).unwrap()).unwrap()
}
fn sheet(phrasing: &str) -> Value {
    let mut ts = load("../core/tests/fixtures/lint.json")["cases"].as_array().unwrap().iter().find(|c| c["name"] == "baseline_passes_lint").unwrap()["ts"].clone();
    ts["claim"] = Value::String(phrasing.to_string());
    ts["elements"][0]["q"] = Value::String(phrasing.to_string());
    ts
}
fn open(ph: &str) -> SourceCheckOutcome {
    run_sourcecheck_with_clock(&json!({"mode": "sourcecheck", "terms": sheet(ph).to_string()}), &Page, &Clk)
}

#[test]
fn sourcecheck_refuses_every_ambiguous_case_with_the_tables_code() {
    let t = load("../../fixtures/lint_parity/cases.json");
    let mut n = 0;
    for grp in t["ambiguous"].as_array().unwrap() {
        let want = grp["code"].as_str().unwrap();
        for v in grp["variants"].as_array().unwrap() {
            let ph = v.as_str().unwrap();
            let out = open(ph);
            assert!(!out.ok, "{:?} must be refused at open", ph);
            assert!(out.unreachable.iter().all(|(id, _)| id == "<terms>"), "{:?}: {:?}", ph, out.unreachable);
            assert!(out.unreachable.iter().any(|(_, r)| r.starts_with(want)), "{:?} must carry a <terms> reason starting {} (got {:?})", ph, want, out.unreachable);
            n += 1;
        }
    }
    assert!(n >= 40, "table too small: {}", n);
}

#[test]
fn sourcecheck_never_refuses_a_clean_control_for_wording() {
    let t = load("../../fixtures/lint_parity/cases.json");
    for c in t["controls"].as_array().unwrap() {
        let ph = c["phrasing"].as_str().unwrap();
        let out = open(ph);
        let bad: Vec<&String> = out.unreachable.iter().map(|(_, r)| r).filter(|r| r.starts_with("AMBIGUOUS_")).collect();
        assert!(bad.is_empty(), "control {} {:?} wrongly refused: {:?}", c["id"], ph, bad);
    }
}

#[test]
fn lint_runtime_still_ignores_ambiguous_rules() {
    let t = load("../../fixtures/lint_parity/cases.json");
    let ph = t["ambiguous"][0]["variants"][0].as_str().unwrap();
    assert!(lint(&sheet(ph)).iter().any(|p| p.starts_with("AMBIGUOUS_")));
    assert!(lint_runtime(&sheet(ph)).iter().all(|p| !p.starts_with("AMBIGUOUS_")));
}
