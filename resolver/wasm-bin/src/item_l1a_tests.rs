//! L1a (design decision: "more real examples, especially the Jason example and other ways of expressing similar crypto-price
//! bets"): a crypto-price example set replayed OFFLINE through the CURRENT resolver (`build_submission_judged_at`) over RECORDED
//! Coinbase/Bitstamp/Kraken 1m candles (services/e2e/live-L1/fixtures, sha256 in manifest.json). Typed templates are decided by
//! code (judge only audits); custom/Jason-form sheets use a RECORDED judge reply written per example in examples.json (no model
//! call). Builder-level inputs are replayed through the same materialize/open/relative-date checks the Open path runs.
//! Every example is `expected == actual`; set L1_WRITE=1 to also write services/e2e/live-L1/actual.json (used by REPORT.md).
use super::*;
use serde_json::json;
use std::cell::RefCell;

pub(crate) const L1: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../services/e2e/live-L1");

struct Fx { cb: String }
impl HttpFetcher for Fx {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        let body = if url.contains("coinbase") {
            std::fs::read(format!("{}/fixtures/{}", L1, self.cb)).map_err(|e| e.to_string())?
        } else if url.contains("bitstamp") {
            std::fs::read(format!("{}/fixtures/bs_BTC_1m.json", L1)).unwrap()
        } else if url.contains("kraken") {
            std::fs::read(format!("{}/fixtures/kr_BTC_1m.json", L1)).unwrap()
        } else {
            return Err("no recorded fixture (backup venue not recorded)".into());
        };
        Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: "application/json".into(), body, status_code: 200 })
    }
}
/// Merge the three recorded Coinbase pages into one array (the parser filters to the window; a real API call returns a slice).
fn merged_cb() -> String {
    let name = "cb_BTC_1m_ALL.json";
    let mut all: Vec<Value> = Vec::new();
    for i in 0..3 {
        let v: Value = serde_json::from_slice(&std::fs::read(format!("{}/fixtures/cb_BTC_1m_p{}.json", L1, i)).unwrap()).unwrap();
        all.extend(v.as_array().unwrap().iter().cloned());
    }
    let p = format!("{}/../../cache_l1a_cb_all.json", env!("CARGO_MANIFEST_DIR"));
    let _ = (name, p);
    serde_json::to_string(&all).unwrap()
}
struct FxMerged { cb_all: String, inner: Fx }
impl HttpFetcher for FxMerged {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        if url.contains("coinbase") && self.inner.cb.is_empty() {
            return Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: "application/json".into(), body: self.cb_all.clone().into_bytes(), status_code: 200 });
        }
        self.inner.fetch(url)
    }
}
/// D-JUDGETIME1b (a): a gate-decided custom sheet now sends the SHORT audit prompt (auditor + <proposal>); the mock answers it with
/// `audit` ({"audit":"agree"} by default) and answers full-judge prompts with the recorded verdict `reply`.
pub(crate) fn is_audit_prompt(msgs: &[(String, String)]) -> bool {
    msgs.iter().any(|(_, c)| c.contains("<proposal>")) && msgs.iter().any(|(_, c)| c.contains("auditor")) && !msgs.iter().any(|(_, c)| c.contains("</rules>"))
}
struct J { reply: String, audit: String, calls: RefCell<usize> }
impl ModelCaller for J {
    fn call(&self, _m: &str, msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        *self.calls.borrow_mut() += 1;
        (if is_audit_prompt(msgs) { self.audit.clone() } else { self.reply.clone() }, None, None)
    }
}

pub(crate) fn run_one(e: &Value) -> (String, String, Vec<String>) {
    // D-JUDGETIME1b (b): the adversarial "judge says met" probe is gate-decided NO; its recorded "met" reply, given to the audit
    // prompt, is a non-agree -> "audit non-agree -> VOID, never YES" (previously the D-L1GATE1 disagreement VOID).
    let adversarial = e["id"].as_str().map_or(false, |i| i.starts_with("probe_adversarial"));
    run_one_audit(e, if adversarial { e["judge"].as_str() } else { None })
}
/// `audit_reply`: what the mock answers to an audit prompt (None = agree). D-JUDGETIME1b (b) passes a non-agree reply.
pub(crate) fn run_one_audit(e: &Value, audit_reply: Option<&str>) -> (String, String, Vec<String>) {
    let kind = e["kind"].as_str().unwrap();
    let now = e["now"].as_i64().unwrap();
    let sheet = &e["sheet"];
    match kind {
        "builder" | "custom_open" => {
            let mut p = match praetorial_core::template::materialize(sheet) { Ok(t) => praetorial_core::template::open_problems(&t, now).into_iter().chain(praetorial_core::template::open_problems(sheet, now)).collect(), Err(p) => p };
            if praetorial_core::template::template_id(sheet) == Ok("custom") { p.extend(praetorial_core::template::relative_date_problems(sheet)); p.extend(praetorial_core::template::price_reading_problems(sheet)); }
            let out = if p.is_empty() { "ACCEPTED".to_string() } else { format!("REJECT:{}", p.iter().map(|x| x.split(':').next().unwrap().to_string()).collect::<Vec<_>>().join("+")) };
            (out, "builder-reject".into(), p)
        }
        _ => {
            let raw = sheet.to_string();
            let job = json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 1, "checked_until": 0, "round": 0, "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw});
            let typed = kind == "typed";
            let reply = if typed { r#"{"audit":"agree"}"#.to_string() } else { e["judge"].as_str().unwrap().to_string() };
            let j = J { reply, audit: audit_reply.unwrap_or(r#"{"audit":"agree"}"#).to_string(), calls: RefCell::new(0) };
            let cb = e.get("cb_file").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let fx = FxMerged { cb_all: merged_cb(), inner: Fx { cb } };
            let (r, notes, _) = build_submission_judged_at(&job, &j, &fx, false, now);
            let calls = *j.calls.borrow();
            let path = if typed { "code".to_string() } else if calls > 0 { "AI".to_string() } else { "code (no judge reached)".to_string() };
            (r.outcome, path, notes)
        }
    }
}

#[test]
fn l1a_examples_expected_equals_actual() {
    let doc: Value = serde_json::from_slice(&std::fs::read(format!("{}/examples.json", L1)).unwrap()).unwrap();
    let exs = doc["examples"].as_array().unwrap();
    assert!(exs.len() >= 20, "example set shrank: {}", exs.len());
    let (mut bad, mut actual) = (Vec::new(), Vec::new());
    for e in exs {
        let (out, path, notes) = run_one(e);
        let want = e["expected"].as_str().unwrap();
        let ok_path = path == e["expected_path"].as_str().unwrap();
        let ok = ok_path && if want == "REJECT" { out.starts_with("REJECT:") && out.contains(e["reject_code"].as_str().unwrap()) } else { out == want };
        actual.push(json!({"id": e["id"], "actual": out, "path": path, "pass": ok, "decision_note": notes.iter().rev().find(|n| n.contains("decision") || n.contains("COULDNT") || n.contains("TPL_") || n.contains("CUSTOM_")).cloned().unwrap_or_else(|| notes.last().cloned().unwrap_or_default())}));
        if !ok { bad.push(format!("{}: expected {} got {} ({})\n    notes: {:?}", e["id"], want, out, path, notes)); }
    }
    if std::env::var("L1_WRITE").is_ok() {
        std::fs::write(format!("{}/actual.json", L1), serde_json::to_string_pretty(&actual).unwrap()).unwrap();
    }
    assert!(bad.is_empty(), "{} of {} examples differ from expectation:\n{}", bad.len(), exs.len(), bad.join("\n"));
}

#[test]
fn l1a_fixtures_match_recorded_sha256() {
    let m: Value = serde_json::from_slice(&std::fs::read(format!("{}/fixtures/manifest.json", L1)).unwrap()).unwrap();
    for f in m["files"].as_array().unwrap() {
        let body = std::fs::read(format!("{}/fixtures/{}", L1, f["file"].as_str().unwrap())).unwrap();
        assert_eq!(praetorial_core::sha_hex(&String::from_utf8_lossy(&body)), f["sha256"].as_str().unwrap(), "{}", f["file"]);
    }
}
