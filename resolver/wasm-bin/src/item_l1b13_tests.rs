//! L1b13 (queue item l1b-jason-noout-model-timing): the Jason one-venue NO sheet gave no OutLayer output ~120-126 s
//! after the request (7/7). Native reproduction with real NEAR AI (DIAGNOSIS_l1b13.md): no stall, fetches ~1 s, but the
//! two sequential model calls on this prompt take 40-90 s EACH (thinking, ~170 KB streams): 88 / 119 / 127 s total.
//! D-BUDGET1 only guarded the rerun, so a first pair that alone reaches the platform limit was killed (bare "Failed",
//! no output). Fix: every model stream is capped by what is left of a 100 s model deadline (stream idle/total limits
//! and retry attempts alike); a call that cannot start (< 5 s left) is not made. A capped / unstarted call is an
//! unusable verdict, never YES/NO. [L1b15 / D-JUDGETIME1 (A) REVERSES the original "-> signed VOID": a cut judge now emits
//! NO signed outcome (clean no-output, retryable failed run); the three capped tests below were changed accordingly.]
use super::*;
use serde_json::json;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

const L1: &str = super::item_l1a_tests::L1;
struct FakeClock(Rc<Cell<u64>>);
impl Clock for FakeClock { fn now_ns(&self) -> u64 { self.0.get() } }
struct Guard;
impl Drop for Guard { fn drop(&mut self) { budget::clear(); } }
/// `Fx(true)` serves the Coinbase 12-minute-gap fixture: the price gate cannot fully decide that sheet, so it keeps the FULL-judge path
/// (D-JUDGETIME1b (c)). `Fx(false)` = complete coverage: gate-decided, short audit path.
struct Fx(bool);
impl HttpFetcher for Fx {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        let f = if url.contains("coinbase") { if self.0 { "SYNTHETIC_cb_BTC_1m_gap12.json" } else { "cb_BTC_1m_p0.json" } } else if url.contains("bitstamp") { "bs_BTC_1m.json" } else { "kr_BTC_1m.json" };
        let body = std::fs::read(format!("{}/fixtures/{}", L1, f)).map_err(|e| e.to_string())?;
        Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: "application/json".into(), body, status_code: 200 })
    }
}
struct Sig;
impl SigGetter for Sig {
    fn get(&self, _u: &str, _h: &[(&str, &str)]) -> Result<(u16, String), String> {
        Ok((200, "{\"signing_address\":\"aa\",\"signature\":\"bb\",\"text\":\"x:HASH\"}".into()))
    }
}
fn sse(content: &str) -> Vec<u8> {
    format!("data: {{\"id\":\"c1\",\"choices\":[{{\"delta\":{{\"content\":{c}}},\"finish_reason\":null}}]}}\n\ndata: {{\"id\":\"c1\",\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\ndata: [DONE]\n\n", c = serde_json::to_string(content).unwrap()).into_bytes()
}
/// Model that needs `answer_s` seconds of fake wall clock per call. A stream that is not done by `limits.total_ms`
/// (or has been idle past `limits.idle_ms` when `silent`) is cut at the limit, like drain_stream does.
struct SlowModel { now: Rc<Cell<u64>>, answer_s: u64, silent: bool, audit_agrees: bool, verdict: &'static str, limits_seen: RefCell<Vec<(u64, u64)>>, posts: Cell<usize> }
impl StreamPoster for SlowModel {
    fn post_stream(&self, _u: &str, _h: &[(&str, &str)], _b: &[u8], l: &StreamLimits) -> Result<StreamResp, String> {
        self.posts.set(self.posts.get() + 1);
        self.limits_seen.borrow_mut().push((l.idle_ms, l.total_ms));
        let need_ms = self.answer_s * 1000;
        let cut = if self.silent { l.idle_ms.min(l.total_ms) } else { l.total_ms };
        if need_ms > cut || self.silent {
            self.now.set(self.now.get() + cut * 1_000_000);
            return Ok(StreamResp { status: 200, bytes: b"data: {\"id\"".to_vec(), stalled: true, total_ms: cut, idle_hit: self.silent, total_hit: !self.silent, ..Default::default() });
        }
        self.now.set(self.now.get() + need_ms * 1_000_000);
        // D-JUDGETIME1b (a): with `audit_agrees`, a short audit prompt (<proposal>) is answered {"audit":"agree"}; full-judge prompts get the recorded verdict.
        let is_audit = self.audit_agrees && String::from_utf8_lossy(_b).contains("<proposal>");
        let answer = if is_audit { json!({"audit":"agree"}).to_string() } else { json!({"answer":self.verdict,"quote":"1794029880,75952.18","source_id":"S_BS","reason":"l1b13 canned"}).to_string() };
        Ok(StreamResp { status: 200, bytes: sse(&answer), total_ms: need_ms, ..Default::default() })
    }
}
fn caller<'a>(p: &'a SlowModel, g: &'a Sig) -> StreamJudgeCaller<'a> {
    StreamJudgeCaller { api_base: "https://x".into(), api_key: "key".into(), poster: p, getter: g, sleep_ms: Box::new(|_| {}), now_ms: Box::new(|| 0),
        sha256_hex: Box::new(|_| "HASH".to_string()), verify: Box::new(|_, _, _| true) }
}
fn jason_job() -> Value {
    let raw = String::from_utf8(std::fs::read(format!("{}/live2/terms_jason_bitstamp_only_no.json", L1)).unwrap()).unwrap();
    let raw = serde_json::from_str::<Value>(&raw).unwrap().to_string();
    json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 1, "checked_until": 0, "round": 0, "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw})
}
/// (outcome, no-output flag, fake seconds elapsed, posts, limits seen). real_http=true = the production two-model panel.
fn run(answer_s: u64, silent: bool) -> (String, bool, u64, usize, Vec<(u64, u64)>) { run_on(answer_s, silent, false, false) }
fn run_on(answer_s: u64, silent: bool, gap: bool, audit_agrees: bool) -> (String, bool, u64, usize, Vec<(u64, u64)>) {
    let now = Rc::new(Cell::new(0u64));
    budget::install(Box::new(FakeClock(now.clone())));
    let (p, g) = (SlowModel { now: now.clone(), answer_s, silent, audit_agrees, verdict: "not_met", limits_seen: RefCell::new(vec![]), posts: Cell::new(0) }, Sig);
    let c = caller(&p, &g);
    let (r, _notes, _) = build_submission_judged_at(&jason_job(), &c, &Fx(gap), true, 1794065826);
    let no_output = budget::report().1 || early_request_reason().is_some();
    let lim = p.limits_seen.borrow().clone();
    (r.outcome, no_output, now.get() / 1_000_000_000, p.posts.get(), lim)
}

#[test]
fn model_stream_limits_are_capped_by_the_remaining_model_deadline() {
    let _g = Guard;
    let now = Rc::new(Cell::new(60_000_000_000u64)); // 60 s already spent
    budget::install(Box::new(FakeClock(now.clone())));
    now.set(120_000_000_000); // elapsed 60 s since install
    let p = SlowModel { now: now.clone(), answer_s: 1, silent: false, audit_agrees: false, verdict: "not_met", limits_seen: RefCell::new(vec![]), posts: Cell::new(0) };
    let g = Sig;
    let _ = caller(&p, &g).call_full("m", &[("user".into(), "q".into())]);
    let seen = p.limits_seen.borrow().clone();
    assert_eq!(seen.len(), 1);
    assert!(seen[0].0 <= 40_000 && seen[0].1 <= 40_000, "idle/total must be <= the 40 s left of the 100 s model deadline: {:?}", seen);
}

#[test]
fn a_model_call_with_under_5s_left_is_not_made() {
    let _g = Guard;
    let now = Rc::new(Cell::new(0u64));
    budget::install(Box::new(FakeClock(now.clone())));
    now.set(97_000_000_000);
    let p = SlowModel { now: now.clone(), answer_s: 1, silent: false, audit_agrees: false, verdict: "not_met", limits_seen: RefCell::new(vec![]), posts: Cell::new(0) };
    let g = Sig;
    let r = caller(&p, &g).call_full("m", &[("user".into(), "q".into())]);
    assert_eq!(p.posts.get(), 0, "no stream may be opened with < 5 s of model deadline left");
    assert!(r.content.is_empty() && r.transport_error.is_some(), "{:?}", r.transport_error);
}

#[test]
fn a_silent_first_stream_cannot_run_two_60s_attempts_past_the_deadline_and_emits_no_outcome() {
    let _g = Guard;
    let (out, no_output, secs, _posts, lim) = run(0, true);
    assert!(secs <= 100, "stalled first stream took {} s of fake clock (old behaviour: 120 s of idle timeouts): {:?}", secs, lim);
    // L1b15 (D-JUDGETIME1 A, spec change by ruling): was `out == "VOID"` + signed; now NO signed outcome.
    assert!(no_output, "D-JUDGETIME1: a judge cut by the model deadline emits no signed outcome (out was {})", out);
    assert_ne!(out, "YES"); assert_ne!(out, "NO");
}

#[test]
fn two_70s_models_emit_no_signed_outcome_before_100s_never_yes_or_no() {
    let _g = Guard;
    // each model needs 70 s: first completes (70 s), the second gets only 30 s -> capped -> no agreement -> VOID.
    let (out, no_output, secs, _posts, _lim) = run(70, false);
    assert!(secs <= 100, "run took {} s of fake clock", secs);
    // L1b15 (D-JUDGETIME1 A, spec change by ruling): was `out == "VOID"` + signed; now NO signed outcome.
    assert!(no_output, "D-JUDGETIME1: second model cut by the deadline -> no signed outcome (out was {})", out);
    assert_ne!(out, "YES"); assert_ne!(out, "NO");
}

// D-JUDGETIME1b (a): the Jason sheet is gate-decided, so the "fast" run is ONE audit call (agree -> NO), not the old two-model judge pair.
#[test]
fn fast_models_are_unaffected_and_still_resolve() {
    let _g = Guard;
    let (out, no_output, secs, posts, _lim) = run_on(10, false, false, true);
    assert_eq!(posts, 1, "D-JUDGETIME1b: one audit call by PRIMARY_JUDGE_MODEL, no second model, no rerun");
    assert!(secs <= 30);
    assert_eq!(out, "NO", "fast agreeing audit must produce the code verdict");
    assert!(!no_output);
}

// ---- D-JUDGETIME1b (c): the same deadline tests on a sheet the gate cannot fully decide (Coinbase gap) keep the FULL-judge path covered ----
#[test]
fn gap_sheet_fast_models_still_resolve_with_the_full_two_model_judge() {
    let _g = Guard;
    let (out, no_output, secs, posts, _lim) = run_on(10, false, true, true);
    assert_eq!(posts, 2, "full judge: two models, no rerun (D-JUDGETIME1b c)");
    assert!(secs <= 30);
    assert_eq!(out, "NO");
    assert!(!no_output);
}
#[test]
fn gap_sheet_a_silent_first_stream_emits_no_outcome_within_the_deadline() {
    let _g = Guard;
    let (out, no_output, secs, _posts, lim) = run_on(0, true, true, true);
    assert!(secs <= 100, "{} s: {:?}", secs, lim);
    assert!(no_output, "D-JUDGETIME1b (c): full-judge copy; out was {}", out);
    assert_ne!(out, "YES"); assert_ne!(out, "NO");
}
#[test]
fn gap_sheet_two_70s_models_emit_no_signed_outcome_before_100s() {
    let _g = Guard;
    let (out, no_output, secs, _posts, _lim) = run_on(70, false, true, true);
    assert!(secs <= 100, "{} s", secs);
    assert!(no_output, "D-JUDGETIME1b (c): full-judge copy; out was {}", out);
    assert_ne!(out, "YES"); assert_ne!(out, "NO");
}
