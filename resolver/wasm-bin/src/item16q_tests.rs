//! Item 16q (D-JUDGE2): robust handling of real NEAR AI judge answers + per-run diagnostics.
use super::*;

const MET: &str = r#"{"answer":"met","source_id":"S1","quote":"something ambiguous"}"#;

/// Caller returning a fixed reply incl. finish_reason.
struct Fx { content: String, finish: Option<String> }
impl Fx {
    fn new(content: &str, finish: Option<&str>) -> Self { Fx { content: content.to_string(), finish: finish.map(|s| s.to_string()) } }
}
impl ModelCaller for Fx {
    fn call(&self, model: &str, m: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        let r = self.call_full(model, m);
        (r.content, r.chat_id, r.model_echoed)
    }
    fn call_full(&self, model: &str, _m: &[(String, String)]) -> ModelReply {
        ModelReply { content: self.content.clone(), chat_id: None, model_echoed: Some(model.to_string()), finish_reason: self.finish.clone(), ..Default::default() }
    }
}

fn direct_job() -> Value {
    let term = json!({
        "claim": "x", "rule": "ALL",
        "elements": [{"id": "e1", "q": "did it happen?"}],
        "clauses": ["AVAILABLE_V1"], "sources": true,
        "custom_definitions": ["fallback: no fallback source applies to this test. early: early resolution not applicable to this test."],
        "time": {"window_start": "2027-01-01T00:00:00Z", "window_end": "2027-12-31T23:59:59Z", "evidence_cutoff": "2028-01-01T00:00:00Z"},
        "sources_allowed": [{"id": "S1", "publisher": "A"}, {"id": "S2", "publisher": "B"}],
    });
    json!({"bet_id": "t-16q", "term": term,
           "sources": [{"id": "S1", "published": "2027-06-01T00:00:00Z", "text": "something ambiguous"}], "runs": 1})
}
fn run(c: &dyn ModelCaller) -> Value { resolve_direct_with(&direct_job(), c, &NullFetcher, true) }
fn verdict(out: &Value) -> Value { out["judge"]["elements"][0]["verdict"].clone() }
fn diag(out: &Value) -> Value { out["judge"]["run_diagnostics"][0].clone() }

// ---- request body
#[test]
fn d_judge2_body_has_max_tokens_2048_and_no_thinking_params() {
    let b = chat_body("Qwen/Qwen3.8-27B", &[("user".to_string(), "hi".to_string())]);
    // D-JUDGE4a: was max_tokens 2048, now JUDGE_ANSWER_MAX_TOKENS (16384) because D-JUDGE4 (i) 'large answer budget with thinking'
    assert_eq!(b["max_tokens"], json!(JUDGE_ANSWER_MAX_TOKENS));
    assert_eq!(b["response_format"], json!({"type": "json_object"}));
    assert_eq!(b["temperature"], json!(0));
    let s = b.to_string();
    // D-JUDGE4a: was 'no thinking params at all', now thinking params are exactly the named judge_thinking_settings() (none sent while it is Null) because D-JUDGE4 (i) 'large answer budget with thinking'
    assert!(!s.contains("enable_thinking") && !s.contains("chat_template_kwargs"), "{}", s);
    assert_eq!(b.get("thinking").cloned().unwrap_or(Value::Null), judge_thinking_settings());
    let keys: Vec<&String> = b.as_object().unwrap().keys().collect();
    let expected_keys = if judge_thinking_settings().is_null() { 5 } else { 6 };
    assert_eq!(keys.len(), expected_keys, "no new request params: {:?}", keys);
}

// ---- response parsing
#[test]
fn d_judge2_parse_reads_finish_reason() {
    let r = parse_chat_response(r#"{"id":"c1","model":"Q","choices":[{"finish_reason":"length","message":{"content":"{\"a\""}}]}"#);
    assert_eq!(r.finish_reason.as_deref(), Some("length"));
    assert_eq!(r.content, "{\"a\"");
    assert_eq!(r.chat_id.as_deref(), Some("c1"));
    assert_eq!(r.model_echoed.as_deref(), Some("Q"));
}
#[test]
fn d_judge2_parse_never_falls_back_to_reasoning_content() {
    let r = parse_chat_response(r#"{"choices":[{"finish_reason":"stop","message":{"content":null,"reasoning_content":"{\"answer\":\"insufficient\"}"}}]}"#);
    assert_eq!(r.content, "");
}

// ---- end-to-end through the direct path (real_http = true)
#[test]
fn d_judge2_plain_json_regression() {
    let out = run(&Fx::new(MET, Some("stop")));
    assert_eq!(out["judge"]["judge_ran"], json!(true), "{}", out);
    assert_eq!(verdict(&out), json!("met"), "{}", out);
    assert_eq!(diag(&out)["verify_result"], json!("answer"), "{}", out);
}
#[test]
fn d_judge2_think_with_braces_then_json_same_answer() {
    let raw = format!("<think>\nformat is {{\"answer\": x}} {{\n</think>\n{}", MET);
    let out = run(&Fx::new(&raw, Some("stop")));
    assert_eq!(out["judge"]["judge_ran"], json!(true), "{}", out);
    assert_eq!(verdict(&out), json!("met"), "{}", out);
}
#[test]
fn d_judge2_finish_reason_length_with_valid_json_is_invalid() {
    let out = run(&Fx::new(MET, Some("length")));
    assert_eq!(out["judge"]["judge_ran"], json!(false), "{}", out);
    assert_eq!(verdict(&out), json!("unresolved"), "{}", out);
    let d = diag(&out);
    assert_eq!(d["verify_result"], json!("invalid"), "{}", out);
    assert_eq!(d["verify_reason"], json!("truncated (finish_reason length)"), "{}", out);
    assert_eq!(d["finish_reason"], json!("length"));
}
#[test]
fn d_judge2_unterminated_think_is_invalid() {
    let out = run(&Fx::new(&format!("<think>never closed {}", MET), Some("stop")));
    assert_eq!(diag(&out)["verify_result"], json!("invalid"), "{}", out);
    assert_eq!(out["judge"]["judge_ran"], json!(false), "{}", out);
}
#[test]
fn d_judge2_empty_content_is_empty() {
    let out = run(&Fx::new("", Some("stop")));
    assert_eq!(diag(&out)["verify_result"], json!("empty"), "{}", out);
    assert_eq!(diag(&out)["content_len"], json!(0));
}
#[test]
fn d_judge2_last_object_failing_citation_is_invalid() {
    let bad = r#"{"answer":"met","source_id":"S1","quote":"text that is nowhere in the source"}"#;
    let out = run(&Fx::new(&format!("{} {}", MET, bad), Some("stop")));
    assert_eq!(diag(&out)["verify_result"], json!("invalid"), "{}", out);
    assert_eq!(verdict(&out), json!("unresolved"), "{}", out);
}

// ---- diagnostics content
#[test]
fn d_judge2_diagnostics_have_correct_len_sha_head() {
    let content = format!("<think>{}</think>{}", "é".repeat(400), MET);
    let out = run(&Fx::new(&content, Some("stop")));
    let d = diag(&out);
    assert_eq!(d["verify_result"], json!("answer"), "{}", out);
    assert_eq!(d["finish_reason"], json!("stop"));
    assert_eq!(d["content_len"], json!(content.len()));
    assert_eq!(d["content_sha256"], json!(praetorial_core::sha_hex(&content)));
    let head: String = content.chars().take(300).collect();
    assert_eq!(d["content_head"], json!(head));
    assert_eq!(d["content_head"].as_str().unwrap().chars().count(), 300);
    assert!(d["verify_reason"].is_string() || d["verify_reason"].is_null());
    // existing judge-block fields keep their meaning
    // D-JUDGE4a: was models_requested == ["Qwen/Qwen3.8-27B"], now [PRIMARY, SECOND] because D-JUDGE4 (two-model agreement is the default judge)
    assert_eq!(out["judge"]["models_requested"], json!([PRIMARY_JUDGE_MODEL, SECOND_JUDGE_MODEL]));
    assert_eq!(out["judge"]["runs"], json!(1));
    assert!(out["judge"]["models_echoed"].is_array());
}
#[test]
fn d_judge2_diagnostics_contain_no_secrets_keys() {
    let out = run(&Fx::new(MET, Some("stop")));
    assert!(diag(&out).is_object(), "{}", out);
    let s = diag(&out).to_string().to_lowercase();
    assert!(!s.contains("authorization") && !s.contains("bearer") && !s.contains("api_key"), "{}", s);
}
