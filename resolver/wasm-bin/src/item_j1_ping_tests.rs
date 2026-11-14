//! Spike J1 S1(b): `mode: "judge-ping"` -- one NEAR AI chat call, reports transport facts,
//! signs nothing. Written before the implementation (RED first).
use super::*;
use std::cell::RefCell;

const KEY: &str = "sk-test-0123456789abcdefghijklmnopqrstuvwxyz";

struct FakePoster {
    reply: Result<(u16, Vec<u8>), String>,
    seen: RefCell<Vec<(String, Vec<(String, String)>, Vec<u8>)>>,
}
impl FakePoster {
    fn ok(status: u16, body: &str) -> Self {
        FakePoster { reply: Ok((status, body.as_bytes().to_vec())), seen: RefCell::new(vec![]) }
    }
    fn err(e: &str) -> Self {
        FakePoster { reply: Err(e.to_string()), seen: RefCell::new(vec![]) }
    }
}
impl ChatPoster for FakePoster {
    fn post(&self, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<(u16, Vec<u8>), String> {
        self.seen.borrow_mut().push((
            url.to_string(),
            headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            body.to_vec(),
        ));
        self.reply.clone()
    }
}

/// Clock returning 1000 then 31000 (30 s elapsed).
fn clock() -> impl Fn() -> u128 {
    let t = RefCell::new(0u128);
    move || {
        let mut t = t.borrow_mut();
        *t += if *t == 0 { 1000 } else { 30_000 };
        *t
    }
}

const OK_BODY: &str = r#"{"id":"chatcmpl-1","model":"Qwen/Qwen3.8-27B","choices":[{"finish_reason":"stop","message":{"content":"{\"answer\":\"insufficient\"}"}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}"#;

#[test]
fn j1_ping_posts_job_body_verbatim_to_chat_completions() {
    let body = json!({"model": "Qwen/Qwen3.8-27B", "max_tokens": 7, "messages": [{"role": "user", "content": "hi"}]});
    let job = json!({"mode": "judge-ping", "body": body});
    let p = FakePoster::ok(200, OK_BODY);
    let out = judge_ping(&job, "https://cloud-api.near.ai", Some(KEY), &p, &clock());
    let seen = p.seen.borrow();
    assert_eq!(seen.len(), 1, "exactly one chat call");
    assert_eq!(seen[0].0, "https://cloud-api.near.ai/v1/chat/completions");
    assert_eq!(seen[0].2, body.to_string().into_bytes());
    assert!(seen[0].1.iter().any(|(k, v)| k == "Authorization" && v == &format!("Bearer {}", KEY)));
    assert_eq!(out["request_bytes"], json!(body.to_string().len()));
}

#[test]
fn j1_ping_without_body_uses_resolver_chat_body_for_model() {
    let job = json!({"mode": "judge-ping", "model": "z-ai/glm-5.3-flash"});
    let p = FakePoster::ok(200, OK_BODY);
    judge_ping(&job, "https://cloud-api.near.ai", Some(KEY), &p, &clock());
    let sent: Value = serde_json::from_slice(&p.seen.borrow()[0].2).unwrap();
    assert_eq!(sent["model"], json!("z-ai/glm-5.3-flash"));
    // D-JUDGE4a: was max_tokens 2048, now JUDGE_ANSWER_MAX_TOKENS because D-JUDGE4 (i) 'large answer budget with thinking'
    assert_eq!(sent["max_tokens"], json!(JUDGE_ANSWER_MAX_TOKENS), "same request shape as the resolver's chat_body");
}

#[test]
fn j1_ping_success_reports_status_bytes_elapsed_and_finish_reason() {
    let p = FakePoster::ok(200, OK_BODY);
    let out = judge_ping(&json!({"mode": "judge-ping"}), "https://cloud-api.near.ai", Some(KEY), &p, &clock());
    assert_eq!(out["mode"], json!("judge-ping"));
    assert_eq!(out["ok"], json!(true));
    assert_eq!(out["http_status"], json!(200));
    assert_eq!(out["response_bytes"], json!(OK_BODY.len()));
    assert_eq!(out["elapsed_ms"], json!(30_000));
    assert_eq!(out["finish_reason"], json!("stop"));
    assert_eq!(out["model_echoed"], json!("Qwen/Qwen3.8-27B"));
    assert_eq!(out["usage"]["completion_tokens"], json!(5));
    assert_eq!(out["error"], Value::Null);
}

#[test]
fn j1_ping_transport_error_is_reported_not_swallowed() {
    let p = FakePoster::err("request failed: ConnectionTimeout");
    let out = judge_ping(&json!({"mode": "judge-ping"}), "https://cloud-api.near.ai", Some(KEY), &p, &clock());
    assert_eq!(out["ok"], json!(false));
    assert_eq!(out["http_status"], Value::Null);
    assert_eq!(out["error"], json!("request failed: ConnectionTimeout"));
    assert_eq!(out["elapsed_ms"], json!(30_000));
    assert_eq!(out["response_bytes"], json!(0));
}

#[test]
fn j1_ping_non_2xx_is_not_ok_and_carries_sanitised_body_head() {
    let body = format!(r#"{{"error":{{"message":"invalid key {}"}}}}"#, KEY);
    let p = FakePoster::ok(401, &body);
    let out = judge_ping(&json!({"mode": "judge-ping"}), "https://cloud-api.near.ai", Some(KEY), &p, &clock());
    assert_eq!(out["ok"], json!(false));
    assert_eq!(out["http_status"], json!(401));
    let e = out["error"].as_str().unwrap();
    assert!(e.contains("http 401"), "{}", e);
    assert!(!e.contains(KEY), "key leaked: {}", e);
}

#[test]
fn j1_ping_sanitise_redacts_key_and_long_tokens_and_caps_length() {
    let raw = format!("boom {} and Bearer abcdefghijklmnopqrstuvwxyz0123456789 {}", KEY, "x".repeat(1000));
    let s = sanitise_error(&raw, Some(KEY));
    assert!(!s.contains(KEY));
    assert!(!s.contains("abcdefghijklmnopqrstuvwxyz0123456789"));
    assert!(s.chars().count() <= 300, "{}", s.len());
    assert!(s.starts_with("boom "));
}

#[test]
fn j1_ping_missing_key_makes_no_call() {
    let p = FakePoster::ok(200, OK_BODY);
    let out = judge_ping(&json!({"mode": "judge-ping"}), "https://cloud-api.near.ai", None, &p, &clock());
    assert_eq!(p.seen.borrow().len(), 0);
    assert_eq!(out["ok"], json!(false));
    assert_eq!(out["error"], json!("NEAR_AI_API_KEY not set"));
}

#[test]
fn j1_ping_output_signs_nothing_and_never_echoes_the_key() {
    for p in [FakePoster::ok(200, OK_BODY), FakePoster::err(&format!("tls {}", KEY))] {
        let out = judge_ping(&json!({"mode": "judge-ping"}), "https://cloud-api.near.ai", Some(KEY), &p, &clock());
        let s = out.to_string();
        assert!(out.get("signing").is_none() && out.get("signing_error").is_none(), "{}", s);
        assert!(!s.contains("signature"), "{}", s);
        assert!(!s.contains(KEY), "{}", s);
    }
}

#[test]
fn j1_ping_content_head_is_capped() {
    let long = format!(r#"{{"choices":[{{"finish_reason":"stop","message":{{"content":"{}"}}}}]}}"#, "a".repeat(5000));
    let p = FakePoster::ok(200, &long);
    let out = judge_ping(&json!({"mode": "judge-ping"}), "https://cloud-api.near.ai", Some(KEY), &p, &clock());
    assert_eq!(out["content_len"], json!(5000));
    assert_eq!(out["content_head"].as_str().unwrap().chars().count(), 300);
}

#[test]
fn j1_ping_is_dispatched_in_main_before_any_signing_path() {
    let src = include_str!("main.rs");
    let main_start = src.find("fn main()").expect("fn main present");
    let body = &src[main_start..];
    let ping = body.find("\"judge-ping\"").expect("main dispatches judge-ping");
    let report = body.find("\"report-pubkey\"").expect("report-pubkey dispatch present");
    let envelope = body.find("job.get(\"envelope\")").expect("envelope path present");
    assert!(ping < report && ping < envelope, "judge-ping must be dispatched first");
}
