//! R3 (D-JUDGE4) RED tests: verified stream call, two-model agreement, preflight, lane audit, constants.
use super::*;
use std::cell::RefCell;

fn sse(id: &str, content: &str) -> Vec<u8> {
    format!("data: {{\"id\":\"{id}\",\"model\":\"m\",\"choices\":[{{\"delta\":{{\"content\":{c}}},\"finish_reason\":null}}]}}\n\ndata: {{\"id\":\"{id}\",\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"total_tokens\":9}}}}\n\ndata: [DONE]\n\n",
        id = id, c = serde_json::to_string(content).unwrap()).into_bytes()
}

struct Seq { replies: RefCell<Vec<Result<StreamResp, String>>>, bodies: RefCell<Vec<Vec<u8>>>, limits: RefCell<Vec<(u64, u64)>> }
impl StreamPoster for Seq {
    fn post_stream(&self, _u: &str, _h: &[(&str, &str)], body: &[u8], l: &StreamLimits) -> Result<StreamResp, String> {
        self.bodies.borrow_mut().push(body.to_vec());
        self.limits.borrow_mut().push((l.idle_ms, l.total_ms));
        self.replies.borrow_mut().remove(0)
    }
}
fn seq(r: Vec<Result<StreamResp, String>>) -> Seq { Seq { replies: RefCell::new(r), bodies: RefCell::new(vec![]), limits: RefCell::new(vec![]) } }
fn ok(b: Vec<u8>) -> Result<StreamResp, String> { Ok(StreamResp { status: 200, bytes: b, stalled: false, ..Default::default() }) }
fn stall() -> Result<StreamResp, String> { Ok(StreamResp { status: 200, bytes: b"data: {\"id\":\"c1\"".to_vec(), stalled: true, ..Default::default() }) }

struct G { codes: RefCell<Vec<u16>>, text: String, calls: RefCell<u32> }
impl SigGetter for G {
    fn get(&self, _u: &str, _h: &[(&str, &str)]) -> Result<(u16, String), String> {
        *self.calls.borrow_mut() += 1;
        let c = if self.codes.borrow().len() > 1 { self.codes.borrow_mut().remove(0) } else { self.codes.borrow()[0] };
        if c == 200 { Ok((200, format!("{{\"signing_address\":\"aa\",\"signature\":\"bb\",\"text\":\"{}\"}}", self.text))) } else { Ok((c, "{}".into())) }
    }
}
fn fake_sha(b: &[u8]) -> String { format!("H{}", b.len()) }
fn msgs() -> Vec<(String, String)> { vec![("user".into(), "hi".into())] }
fn clock() -> impl Fn() -> u128 { let t = RefCell::new(0u128); move || { *t.borrow_mut() += 1000; *t.borrow() } }

fn call(p: &Seq, g: &G, verify: bool) -> StreamCall {
    verified_stream_call("DeepSeek", &msgs(), "https://x", "key", p, g, &|_| {}, &clock(), &fake_sha, &move |_, _, _| verify)
}

#[test]
fn r3_stream_call_requests_stream_and_include_usage() {
    let b = sse("c1", "{\"answer\":\"met\"}");
    let g = G { codes: RefCell::new(vec![200]), text: format!("m:{}:{}", fake_sha(b"x"), fake_sha(&b)), calls: RefCell::new(0) };
    let p = seq(vec![ok(b)]);
    let _ = call(&p, &g, true);
    let sent: Value = serde_json::from_slice(&p.bodies.borrow()[0]).unwrap();
    assert_eq!(sent["stream"], json!(true));
    assert_eq!(sent["stream_options"]["include_usage"], json!(true));
    let l = p.limits.borrow()[0];
    assert_eq!((l.0, l.1), (STREAM_IDLE_TIMEOUT_MS, STREAM_TOTAL_TIMEOUT_MS));
}

#[test]
fn r3_stream_call_hashes_raw_sse_bytes_for_signature() {
    let b = sse("c1", "{\"answer\":\"met\"}");
    let good = G { codes: RefCell::new(vec![200]), text: format!("m:rq:{}", fake_sha(&b)), calls: RefCell::new(0) };
    let r = call(&seq(vec![ok(b.clone())]), &good, true);
    assert!(r.sig_verified && r.void_reason.is_none());
    assert_eq!(r.content, "{\"answer\":\"met\"}");
    assert_eq!(r.chat_id.as_deref(), Some("c1"));
    let bad = G { codes: RefCell::new(vec![200]), text: "m:rq:Hdifferent".into(), calls: RefCell::new(0) };
    let r = call(&seq(vec![ok(b)]), &bad, true);
    assert!(!r.sig_verified);
}

#[test]
fn r3_stream_call_signature_retries_for_about_10s_then_gives_up() {
    let b = sse("c1", "x");
    let g = G { codes: RefCell::new(vec![404]), text: String::new(), calls: RefCell::new(0) };
    let r = call(&seq(vec![ok(b)]), &g, true);
    assert!(!r.sig_verified);
    assert!(*g.calls.borrow() >= 10, "calls {}", g.calls.borrow());
}

#[test]
fn r3_stream_stall_retries_once_then_succeeds() {
    let b = sse("c1", "{\"answer\":\"met\"}");
    let g = G { codes: RefCell::new(vec![200]), text: format!("m:rq:{}", fake_sha(&b)), calls: RefCell::new(0) };
    let p = seq(vec![stall(), ok(b)]);
    let r = call(&p, &g, true);
    assert_eq!(r.attempts, 2);
    assert!(r.void_reason.is_none());
    assert_eq!(r.content, "{\"answer\":\"met\"}");
}

#[test]
fn r3_stream_persistent_stall_yields_void_reason_not_a_hang_or_panic() {
    let g = G { codes: RefCell::new(vec![200]), text: String::new(), calls: RefCell::new(0) };
    let p = seq((0..STREAM_MAX_ATTEMPTS).map(|_| stall()).collect());
    let r = call(&p, &g, true);
    assert_eq!(r.attempts, STREAM_MAX_ATTEMPTS);
    assert!(r.void_reason.as_deref().unwrap().contains("stall"));
    assert!(r.content.is_empty() && !r.sig_verified);
    assert_eq!(*g.calls.borrow(), 0, "no signature fetch for a stalled stream");
}

#[test]
fn r3_stream_transport_error_retries_then_voids() {
    let g = G { codes: RefCell::new(vec![200]), text: String::new(), calls: RefCell::new(0) };
    let p = seq((0..STREAM_MAX_ATTEMPTS).map(|_| Err("boom key".to_string())).collect());
    let r = call(&p, &g, true);
    assert!(r.void_reason.is_some());
    assert!(!r.void_reason.unwrap().contains("key\u{0}"));
}

// ---- two-model agreement
#[test]
fn r3_models_are_named_constants() {
    // R3d: exact NEAR AI model id per fixture
    assert_eq!(PRIMARY_JUDGE_MODEL, "deepseek-ai/DeepSeek-V4.1-Flash-1017");
    assert_eq!(SECOND_JUDGE_MODEL, "z-ai/glm-5.3-flash");
}

#[test]
fn r3_two_models_agree_no_rerun() {
    let n = RefCell::new(0);
    let r = two_model_agree("met", "met", &|| { *n.borrow_mut() += 1; ("met".into(), "met".into()) });
    assert_eq!(r, "met");
    assert_eq!(*n.borrow(), 0);
}

#[test]
fn r3_two_models_disagree_one_rerun_then_agree() {
    let n = RefCell::new(0);
    let r = two_model_agree("met", "not_met", &|| { *n.borrow_mut() += 1; ("not_met".into(), "not_met".into()) });
    assert_eq!(r, "not_met");
    assert_eq!(*n.borrow(), 1);
}

#[test]
fn r3_two_models_disagree_twice_is_void_after_exactly_one_rerun() {
    let n = RefCell::new(0);
    let r = two_model_agree("met", "not_met", &|| { *n.borrow_mut() += 1; ("met".into(), "not_met".into()) });
    assert_eq!(r, "VOID");
    assert_eq!(*n.borrow(), 1);
}

#[test]
fn r3_invalid_or_empty_from_either_model_counts_as_disagreement() {
    let r = two_model_agree("met", "invalid", &|| ("met".into(), "empty".into()));
    assert_eq!(r, "VOID");
}

// ---- preflight
#[test]
fn r3_preflight_passes_when_fetched_extractable_and_fast() {
    let r = preflight_check(&PreflightFacts { fetched: true, extractable: true, elapsed_ms: 40_000, run_limit_ms: 100_000, judge_dry_run_ok: Some(true) });
    assert!(r.ok, "{:?}", r.failures);
}

#[test]
fn r3_preflight_fails_each_condition() {
    let base = PreflightFacts { fetched: true, extractable: true, elapsed_ms: 40_000, run_limit_ms: 100_000, judge_dry_run_ok: Some(true) };
    assert!(!preflight_check(&PreflightFacts { fetched: false, ..base.clone() }).ok);
    assert!(!preflight_check(&PreflightFacts { extractable: false, ..base.clone() }).ok);
    assert!(!preflight_check(&PreflightFacts { elapsed_ms: 50_001, ..base.clone() }).ok);
    assert!(preflight_check(&PreflightFacts { elapsed_ms: 50_000, ..base.clone() }).ok);
    assert!(!preflight_check(&PreflightFacts { judge_dry_run_ok: Some(false), ..base.clone() }).ok);
    assert!(preflight_check(&PreflightFacts { judge_dry_run_ok: None, ..base.clone() }).ok); // lane A/B: no judge
}

#[test]
fn r3_preflight_mode_is_non_signing_dispatch_in_main() {
    let src = include_str!("main.rs");
    let body = &src[src.find("fn main()").unwrap()..];
    assert!(body.contains("\"preflight\""), "main() must dispatch mode preflight");
    let i = body.find("\"preflight\"").unwrap();
    let j = body.find("sign_and_emit").or_else(|| body.find("sign(")).unwrap_or(usize::MAX);
    assert!(i < j, "preflight dispatch must come before any signing path");
}

// ---- lane A/B: code proposes, model audits
#[test]
fn r3_lane_ab_audit_agree_keeps_code_proposal() {
    assert_eq!(lane_ab_audit("YES", "agree"), "YES");
    assert_eq!(lane_ab_audit("NO", "agree"), "NO");
}
#[test]
fn r3_lane_ab_audit_flag_or_garbage_is_void_never_a_flip() {
    assert_eq!(lane_ab_audit("YES", "flag"), "VOID");
    assert_eq!(lane_ab_audit("NO", "flag"), "VOID");
    assert_eq!(lane_ab_audit("YES", ""), "VOID");
    assert_eq!(lane_ab_audit("YES", "NO"), "VOID");
}

// ---- constants / budget / COULDNT_CHECK
#[test]
fn r3_prompt_text_budget_thinking_are_named_constants() {
    assert!(!JUDGE_SYSTEM_PROMPT.is_empty());
    assert!(JUDGE_ANSWER_MAX_TOKENS >= 2048);
    let b = chat_body("m", &msgs());
    assert_eq!(b["max_tokens"], json!(JUDGE_ANSWER_MAX_TOKENS));
    assert_eq!(b.get("thinking").cloned().unwrap_or(Value::Null), judge_thinking_settings());
}
#[test]
fn r3_granularity_caveat_no_longer_instructs_couldnt_check() {
    assert!(!granularity_caveat(300, 60, Some(100.0)).contains("COULDNT_CHECK"));
}
#[test]
fn r3_prompt_budget_ok_is_input_bounded_and_reserves_answer_budget() {
    let at = vec![("user".to_string(), "x".repeat(MAX_PROMPT_BYTES_PER_ELEMENT))];
    assert!(prompt_budget_ok(&at));
    let over = vec![("user".to_string(), "x".repeat(MAX_PROMPT_BYTES_PER_ELEMENT + 1))];
    assert!(!prompt_budget_ok(&over));
    // Counts all messages (system + user), and context window includes the answer budget.
    let two = vec![("system".to_string(), "x".repeat(MAX_PROMPT_BYTES_PER_ELEMENT)), ("user".to_string(), "y".into())];
    assert!(!prompt_budget_ok(&two));
    assert!(MAX_PROMPT_TOKENS_PER_ELEMENT + JUDGE_ANSWER_MAX_TOKENS <= JUDGE_CONTEXT_TOKENS);
}
#[test]
fn r3_prompt_cap_admits_a_full_page() {
    assert!(MAX_PROMPT_TOKENS_PER_ELEMENT >= 64_000, "D-JUDGE4: full page, limits for correctness not cost");
}
