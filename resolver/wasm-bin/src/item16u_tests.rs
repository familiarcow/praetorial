//! Item 16u: judge transport diagnostics (http_status / transport_error / response_bytes).
use super::*;

const KEY: &str = "sk-live-abcdef0123456789SECRETKEY";
const MET: &str = r#"{"answer":"met","source_id":"S1","quote":"something ambiguous"}"#;

struct Rp(ModelReply);
impl ModelCaller for Rp {
    fn call(&self, model: &str, m: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        let r = self.call_full(model, m);
        (r.content, r.chat_id, r.model_echoed)
    }
    fn call_full(&self, model: &str, _m: &[(String, String)]) -> ModelReply {
        let mut r = self.0.clone();
        r.model_echoed = Some(model.to_string());
        r
    }
}
/// Caller driven through the real reply-construction seam.
struct Post(Result<(u16, Vec<u8>), String>);
impl ModelCaller for Post {
    fn call(&self, model: &str, m: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        let r = self.call_full(model, m);
        (r.content, r.chat_id, r.model_echoed)
    }
    fn call_full(&self, model: &str, _m: &[(String, String)]) -> ModelReply {
        let mut r = reply_from_post(self.0.clone(), &[KEY]);
        if r.http_status.is_some() { r.model_echoed = Some(model.to_string()); }
        r
    }
}

fn job() -> Value {
    let term = json!({
        "claim": "x", "rule": "ALL",
        "elements": [{"id": "e1", "q": "did it happen?"}],
        "clauses": ["AVAILABLE_V1"], "sources": true,
        "custom_definitions": ["fallback: no fallback source applies to this test. early: early resolution not applicable to this test."],
        "time": {"window_start": "2027-01-01T00:00:00Z", "window_end": "2027-12-31T23:59:59Z", "evidence_cutoff": "2028-01-01T00:00:00Z"},
        "sources_allowed": [{"id": "S1", "publisher": "A"}, {"id": "S2", "publisher": "B"}],
    });
    json!({"bet_id": "t-16u", "term": term,
           "sources": [{"id": "S1", "published": "2027-06-01T00:00:00Z", "text": "something ambiguous"}], "runs": 1})
}
fn run(c: &dyn ModelCaller) -> Value { resolve_direct_with(&job(), c, &NullFetcher, true) }
fn diag(out: &Value) -> Value { out["judge"]["run_diagnostics"][0].clone() }
fn verdict(out: &Value) -> Value { out["judge"]["elements"][0]["verdict"].clone() }
fn chat_ok() -> Vec<u8> {
    json!({"id":"c1","model":"Q","choices":[{"finish_reason":"stop","message":{"content":MET}}]}).to_string().into_bytes()
}

#[test]
fn j16u_transport_err_records_null_status_and_error() {
    let out = run(&Post(Err("connection reset by peer".to_string())));
    let d = diag(&out);
    assert_eq!(d["http_status"], json!(null), "{}", d);
    assert_eq!(d["transport_error"], json!("connection reset by peer"), "{}", d);
    assert_eq!(d["verify_result"], json!("empty"), "{}", d);
    assert_eq!(d["verify_reason"], json!("no response (transport failure)"), "{}", d);
}
#[test]
fn j16u_transport_err_redacts_bearer_and_key() {
    let msg = format!("send failed: Authorization: Bearer {} rejected; key={} again", KEY, KEY);
    let out = run(&Post(Err(msg)));
    let d = diag(&out);
    let s = d["transport_error"].as_str().unwrap().to_string();
    assert!(!s.contains(KEY) && !s.contains("SECRETKEY") && !s.contains("abcdef0123456789"), "{}", s);
    assert!(s.contains("send failed"), "{}", s);
    assert!(!out.to_string().contains("SECRETKEY"), "secret leaked into output");
}
#[test]
fn j16u_redacts_unknown_token_shaped_strings() {
    let r = reply_from_post(Err("bad header Authorization: Bearer zzzzzzzzzz1234567890ABCDEFGHIJ end token=ghp_abcdefghijklmnopqrstuvwxyz0123456789".to_string()), &[]);
    let s = r.transport_error.unwrap();
    assert!(!s.contains("zzzzzzzzzz") && !s.contains("ghp_abcdef"), "{}", s);
    assert!(s.contains("bad header"), "{}", s);
}
#[test]
fn j16u_long_transport_error_truncated() {
    let long = "x ".repeat(2000);
    let r = reply_from_post(Err(long), &[]);
    let n = r.transport_error.unwrap().chars().count();
    assert!(n > 0 && n <= 300, "len {}", n);
}
#[test]
fn j16u_http_401_429_500_recorded_verdict_unchanged() {
    let baseline = run(&Post(Err("x".to_string())));
    for (code, body) in [(401u16, r#"{"error":"unauthorized"}"#), (429, "rate limited"), (500, "internal error")] {
        let out = run(&Post(Ok((code, body.as_bytes().to_vec()))));
        let d = diag(&out);
        assert_eq!(d["http_status"], json!(code), "{}", d);
        assert_eq!(d["response_bytes"], json!(body.len()), "{}", d);
        assert_eq!(d["transport_error"], json!(null), "{}", d);
        assert_eq!(d["error_body_head"], json!(body), "{}", d);
        assert_eq!(d["verify_result"], json!("empty"), "{}", d);
        assert_eq!(verdict(&out), verdict(&baseline), "verdict unchanged");
        assert_eq!(out["judge"]["judge_ran"], json!(false));
    }
}
#[test]
fn j16u_error_body_head_sanitised_and_bounded() {
    let body = format!("{{\"error\":\"bad Bearer {} {}\"}}", KEY, "y ".repeat(1000));
    let r = reply_from_post(Ok((500, body.clone().into_bytes())), &[KEY]);
    let h = r.error_body_head.unwrap();
    assert!(!h.contains("SECRETKEY") && h.chars().count() <= 300, "{}", h);
    assert_eq!(r.response_bytes, Some(body.len()));
}
#[test]
fn j16u_success_200_records_status_and_body_len() {
    let body = chat_ok();
    let out = run(&Post(Ok((200, body.clone()))));
    let d = diag(&out);
    assert_eq!(d["http_status"], json!(200), "{}", d);
    assert_eq!(d["transport_error"], json!(null), "{}", d);
    assert_eq!(d["response_bytes"], json!(body.len()), "{}", d);
    assert_eq!(d["error_body_head"], json!(null), "{}", d);
    assert_eq!(d["verify_result"], json!("answer"), "{}", d);
    assert_eq!(verdict(&out), json!("met"), "{}", out);
}
#[test]
fn j16u_diagnostics_pass_through_caller_fields() {
    let out = run(&Rp(ModelReply { content: MET.to_string(), http_status: Some(200), response_bytes: Some(77), ..Default::default() }));
    let d = diag(&out);
    assert_eq!(d["http_status"], json!(200));
    assert_eq!(d["response_bytes"], json!(77));
}
#[test]
fn j16u_mock_caller_has_null_transport_fields() {
    let d = diag(&run(&Rp(ModelReply { content: MET.to_string(), ..Default::default() })));
    for k in ["http_status", "transport_error", "response_bytes", "error_body_head"] {
        assert!(d.get(k).is_some() && d[k].is_null(), "{} {}", k, d);
    }
}
