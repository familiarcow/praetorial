//! R3d (judge-live-fixes) RED tests: exact NEAR AI model ids, error_body_head on non-2xx streams, stream timings +
//! signature_verified in run_diagnostics, explicit offline-mock backend diagnostics, TESTING.md key-lookup docs.
use super::*;
use std::cell::RefCell;

const MODELS_FIXTURE: &str = include_str!("../fixtures/near_ai_models.json");

fn listed_ids() -> Vec<String> {
    let v: Value = serde_json::from_str(MODELS_FIXTURE).unwrap();
    v["ids"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
}

// ------------------------------------------------------------------ (1) model ids
#[test]
fn r3d_every_named_judge_model_is_in_the_near_ai_model_list_fixture() {
    let ids = listed_ids();
    assert!(ids.len() > 10, "fixture should be the full /v1/models id list");
    for m in [PRIMARY_JUDGE_MODEL, SECOND_JUDGE_MODEL] {
        assert!(ids.iter().any(|i| i == m), "{} is not an id NEAR AI lists", m);
    }
}

#[test]
fn r3d_model_fixture_has_no_secret_shaped_content() {
    assert!(!MODELS_FIXTURE.to_lowercase().contains("bearer"));
    assert!(!MODELS_FIXTURE.contains("sk-"));
}

// ------------------------------------------------------------------ helpers
fn sse_ok(content: &str) -> Vec<u8> {
    format!(
        "data: {{\"id\":\"c1\",\"model\":\"m\",\"choices\":[{{\"delta\":{{\"content\":{c}}},\"finish_reason\":null}}]}}\n\ndata: {{\"id\":\"c1\",\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"total_tokens\":9}}}}\n\ndata: [DONE]\n\n",
        c = serde_json::to_string(content).unwrap()
    )
    .into_bytes()
}
struct Fixed(RefCell<Vec<Result<StreamResp, String>>>);
impl StreamPoster for Fixed {
    fn post_stream(&self, _u: &str, _h: &[(&str, &str)], _b: &[u8], _l: &StreamLimits) -> Result<StreamResp, String> {
        let mut v = self.0.borrow_mut();
        if v.len() > 1 { v.remove(0) } else { v[0].clone() }
    }
}
struct Sig(String);
impl SigGetter for Sig {
    fn get(&self, _u: &str, _h: &[(&str, &str)]) -> Result<(u16, String), String> {
        Ok((200, format!("{{\"signing_address\":\"aa\",\"signature\":\"bb\",\"text\":\"{}\"}}", self.0)))
    }
}
fn const_sha(_: &[u8]) -> String { "HASH".to_string() }
fn jc<'a>(p: &'a Fixed, g: &'a Sig, verify_ok: bool) -> StreamJudgeCaller<'a> {
    StreamJudgeCaller {
        api_base: "https://x".into(), api_key: "SECRETKEY123456789012345678".into(), poster: p, getter: g,
        sleep_ms: Box::new(|_| {}), now_ms: Box::new(|| 0), sha256_hex: Box::new(const_sha), verify: Box::new(move |_, _, _| verify_ok),
    }
}
fn msgs() -> Vec<(String, String)> { vec![("user".into(), "q".into())] }
fn good_resp() -> StreamResp {
    StreamResp { status: 200, bytes: sse_ok("{\"answer\":\"met\"}"), stalled: false, first_byte_ms: Some(120), total_ms: 3400, idle_hit: false, total_hit: false }
}
/// Run one call through a TracingCaller and return the judge block's first run_diagnostics entry.
fn diag_of(caller: &dyn ModelCaller) -> Value {
    let tr = TracingCaller::new(caller);
    let _ = tr.call_full("m", &msgs());
    let j = judge_block(&tr, &JudgeMeta::default());
    j["run_diagnostics"][0].clone()
}

// ------------------------------------------------------------------ (2) error_body_head on non-2xx
#[test]
fn r3d_non_2xx_stream_captures_sanitised_bounded_error_body_head() {
    let body = format!("{{\"error\":{{\"message\":\"model not found: Bearer SECRETKEY123456789012345678 {}\"}}}}", "x".repeat(600));
    let p = Fixed(RefCell::new(vec![Ok(StreamResp { status: 400, bytes: body.into_bytes(), ..Default::default() })]));
    let d = diag_of(&jc(&p, &Sig("x:HASH".into()), true));
    assert_eq!(d["http_status"], json!(400));
    let h = d["error_body_head"].as_str().expect("error_body_head must be captured on a 400 stream");
    assert!(h.contains("model not found"), "{}", h);
    assert!(h.chars().count() <= 300, "bounded like 16u: {}", h.chars().count());
    assert!(!h.contains("SECRETKEY"), "sanitised: {}", h);
}

#[test]
fn r3d_2xx_stream_has_null_error_body_head() {
    let p = Fixed(RefCell::new(vec![Ok(good_resp())]));
    let d = diag_of(&jc(&p, &Sig("x:HASH".into()), true));
    assert!(d["error_body_head"].is_null());
    assert_eq!(d["http_status"], json!(200));
}

#[test]
fn r3d_verified_stream_call_exposes_error_body_head() {
    let p = Fixed(RefCell::new(vec![Ok(StreamResp { status: 404, bytes: b"{\"detail\":\"no such model\"}".to_vec(), ..Default::default() })]));
    let r = verified_stream_call("m", &msgs(), "https://x", "k", &p, &Sig("x:HASH".into()), &|_| {}, &|| 0, &const_sha, &|_, _, _| true);
    assert_eq!(r.http_status, Some(404));
    assert!(r.error_body_head.as_deref().unwrap_or("").contains("no such model"), "{:?}", r.error_body_head);
}

// ------------------------------------------------------------------ (3) stream timings + signature_verified
#[test]
fn r3d_drain_stream_reports_first_byte_total_and_which_timer_fired() {
    struct S { steps: Vec<(Chunk, u128)>, clock: std::rc::Rc<std::cell::Cell<u128>> }
    impl ByteStream for S {
        fn next_chunk(&mut self, _w: u64) -> Chunk {
            if self.steps.is_empty() { return Chunk::Closed; }
            let (c, adv) = self.steps.remove(0);
            self.clock.set(self.clock.get() + adv);
            c
        }
    }
    let lim = StreamLimits { idle_ms: 60_000, total_ms: 600_000 };
    // normal: first byte after 250 ms, closes at 1000 ms
    let clock = std::rc::Rc::new(std::cell::Cell::new(0u128));
    let mut s = S { steps: vec![(Chunk::Data(b"a".to_vec()), 250), (Chunk::Closed, 750)], clock: clock.clone() };
    let c = clock.clone();
    let r = drain_stream(&mut s, &lim, &move || c.get(), 200).unwrap();
    assert_eq!(r.first_byte_ms, Some(250));
    assert_eq!(r.total_ms, 1000);
    assert!(!r.idle_hit && !r.total_hit);
    // idle stall
    let clock = std::rc::Rc::new(std::cell::Cell::new(0u128));
    let mut s = S { steps: vec![(Chunk::Idle, 60_000)], clock: clock.clone() };
    let c = clock.clone();
    let r = drain_stream(&mut s, &lim, &move || c.get(), 200).unwrap();
    assert!(r.idle_hit && !r.total_hit && r.stalled);
    assert_eq!(r.first_byte_ms, None);
    // trickle past the total limit
    let clock = std::rc::Rc::new(std::cell::Cell::new(0u128));
    let mut s = S { steps: (0..10).map(|_| (Chunk::Data(b"a".to_vec()), 100_000)).collect(), clock: clock.clone() };
    let c = clock.clone();
    let r = drain_stream(&mut s, &lim, &move || c.get(), 200).unwrap();
    assert!(r.total_hit && !r.idle_hit && r.stalled);
    assert!(r.total_ms >= 600_000);
}

#[test]
fn r3d_run_diagnostics_carry_stream_timings_and_signature_verified_true() {
    let p = Fixed(RefCell::new(vec![Ok(good_resp())]));
    let d = diag_of(&jc(&p, &Sig("x:HASH".into()), true));
    assert_eq!(d["first_byte_ms"], json!(120));
    assert_eq!(d["total_ms"], json!(3400));
    assert_eq!(d["idle_timeout_hit"], json!(false));
    assert_eq!(d["total_timeout_hit"], json!(false));
    assert_eq!(d["signature_verified"], json!(true));
}

#[test]
fn r3d_signature_verified_false_when_check_fails() {
    let p = Fixed(RefCell::new(vec![Ok(good_resp())]));
    let d = diag_of(&jc(&p, &Sig("x:HASH".into()), false));
    assert_eq!(d["signature_verified"], json!(false));
}

#[test]
fn r3d_signature_verified_null_when_not_attempted_and_idle_flag_recorded() {
    let stalled = StreamResp { status: 200, bytes: b"data: {".to_vec(), stalled: true, first_byte_ms: Some(10), total_ms: 60_010, idle_hit: true, total_hit: false };
    let p = Fixed(RefCell::new(vec![Ok(stalled)]));
    let d = diag_of(&jc(&p, &Sig("x:HASH".into()), true));
    assert!(d["signature_verified"].is_null(), "no usable stream => signature never attempted: {}", d);
    assert_eq!(d["idle_timeout_hit"], json!(true));
    assert_eq!(d["total_timeout_hit"], json!(false));
    assert_eq!(d["total_ms"], json!(60_010));
}

#[test]
fn r3d_non_stream_callers_report_null_timings_and_signature() {
    let d = diag_of(&OfflineMock);
    for k in ["first_byte_ms", "total_ms", "idle_timeout_hit", "total_timeout_hit", "signature_verified"] {
        assert!(d.get(k).is_some() && d[k].is_null(), "{} must be present and null for the mock: {}", k, d);
    }
}

// ------------------------------------------------------------------ (4) explicit judge backend
fn judge_of(caller: &dyn ModelCaller) -> Value {
    let tr = TracingCaller::new(caller);
    let _ = tr.call_full("m", &msgs());
    judge_block(&tr, &JudgeMeta::default())
}

#[test]
fn r3d_judge_block_names_offline_mock_backend() {
    let j = judge_of(&OfflineMock);
    assert_eq!(j["judge_backend"], json!("offline-mock"), "{}", j);
}

#[test]
fn r3d_no_key_fallback_says_offline_mock_with_reason_naming_the_key_and_secret() {
    let j = judge_of(&NoKeyMock);
    assert_eq!(j["judge_backend"], json!("offline-mock"));
    let r = j["judge_backend_reason"].as_str().expect("a reason is required");
    assert!(r.contains("NEAR_AI_API_KEY"), "{}", r);
    assert!(r.contains("secrets_account_id") && r.contains("OutLayer"), "{}", r);
}

#[test]
fn r3d_real_stream_caller_names_near_ai_backend_without_reason() {
    let p = Fixed(RefCell::new(vec![Ok(good_resp())]));
    let g = Sig("x:HASH".into());
    let j = judge_of(&jc(&p, &g, true));
    assert_eq!(j["judge_backend"], json!("near-ai"));
    assert!(j["judge_backend_reason"].is_null());
}

#[test]
fn r3d_no_key_mock_still_answers_like_the_offline_mock() {
    let (c, _, _) = NoKeyMock.call("m", &msgs());
    assert!(c.contains("insufficient"));
}

// ------------------------------------------------------------------ (4) docs
#[test]
fn r3d_testing_md_documents_which_account_the_wasm_reads_the_secret_from() {
    let t = include_str!("../../../TESTING.md");
    assert!(t.contains("NEAR AI key lookup"), "TESTING.md needs a 'NEAR AI key lookup' section");
    for needle in ["secrets_account_id", "secrets_profile", "NEAR_AI_API_KEY", "OUTLAYER_HOME", "offline-mock", "bind_secret.sh"] {
        assert!(t.contains(needle), "TESTING.md must mention {}", needle);
    }
}
