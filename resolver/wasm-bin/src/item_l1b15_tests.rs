//! L1b15 (ruling D-JUDGETIME1 part A): a model call cut/refused by the 100 s model deadline that leaves no usable verdict
//! emits NO signed outcome (clean no-output exit like D-EARLYREQ1; escrow counts a failed run, D-RESOLVE4a) -- never a signed
//! VOID/YES/NO. A call merely given a shortened limit that still finishes with a usable verdict is normal. Two complete
//! disagreeing verdicts keep the existing rule. (L1b13's capped->VOID assertions were changed by this ruling.)
use super::*;
use serde_json::json;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

const L1: &str = super::item_l1a_tests::L1;
struct FakeClock(Rc<Cell<u64>>);
impl Clock for FakeClock { fn now_ns(&self) -> u64 { self.0.get() } }
struct Guard;
impl Drop for Guard { fn drop(&mut self) { budget::clear(); } }
/// `Fx(true)`: Coinbase 12-minute gap -> the gate cannot fully decide the sheet -> FULL-judge path (D-JUDGETIME1b (c)).
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
struct Keys(RefCell<usize>);
impl KeyBackend for Keys {
    fn public_key(&self, _p: &str) -> Result<Vec<u8>, String> { Ok(vec![9u8; 32]) }
    fn predecessor(&self) -> Option<String> { None }
    fn sign(&self, _p: &str, _m: &[u8]) -> Result<Vec<u8>, String> { *self.0.borrow_mut() += 1; Ok(vec![7u8; 64]) }
}
fn sse(content: &str) -> Vec<u8> {
    format!("data: {{\"id\":\"c1\",\"choices\":[{{\"delta\":{{\"content\":{c}}},\"finish_reason\":null}}]}}\n\ndata: {{\"id\":\"c1\",\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\ndata: [DONE]\n\n", c = serde_json::to_string(content).unwrap()).into_bytes()
}
/// Per-call script: (seconds the call needs, answer). Calls beyond the script reuse the last entry. A call needing more than
/// its total limit is cut at the limit (stalled), like drain_stream.
struct Scripted { now: Rc<Cell<u64>>, script: Vec<(u64, &'static str)>, posts: Cell<usize>, limits: RefCell<Vec<u64>> }
impl StreamPoster for Scripted {
    fn post_stream(&self, _u: &str, _h: &[(&str, &str)], _b: &[u8], l: &StreamLimits) -> Result<StreamResp, String> {
        let i = self.posts.get();
        self.posts.set(i + 1);
        self.limits.borrow_mut().push(l.total_ms);
        let (secs, ans) = self.script[i.min(self.script.len() - 1)];
        let need_ms = secs * 1000;
        if need_ms > l.total_ms {
            self.now.set(self.now.get() + l.total_ms * 1_000_000);
            return Ok(StreamResp { status: 200, bytes: b"data: {\"id\"".to_vec(), stalled: true, total_ms: l.total_ms, total_hit: true, ..Default::default() });
        }
        self.now.set(self.now.get() + need_ms * 1_000_000);
        // D-JUDGETIME1b (a): audit prompts (the gate-decided Jason sheet) get {"audit": ...}; full-judge prompts keep the recorded verdict.
        let answer = if ans == "agree" || ans == "flag" { json!({"audit": ans}).to_string() } else { json!({"answer": ans, "quote": "1794029880,75952.18", "source_id": "S_BS", "reason": "l1b15 canned"}).to_string() };
        Ok(StreamResp { status: 200, bytes: sse(&answer), total_ms: need_ms, ..Default::default() })
    }
}
fn caller<'a>(p: &'a Scripted, g: &'a Sig) -> StreamJudgeCaller<'a> {
    StreamJudgeCaller { api_base: "https://x".into(), api_key: "key".into(), poster: p, getter: g, sleep_ms: Box::new(|_| {}), now_ms: Box::new(|| 0),
        sha256_hex: Box::new(|_| "HASH".to_string()), verify: Box::new(|_, _, _| true) }
}
fn jason_job() -> Value {
    let raw = String::from_utf8(std::fs::read(format!("{}/live2/terms_jason_bitstamp_only_no.json", L1)).unwrap()).unwrap();
    let raw = serde_json::from_str::<Value>(&raw).unwrap().to_string();
    json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 1, "checked_until": 0, "round": 0, "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw})
}
/// Envelope output through the production two-model panel. (output, signatures, posts, fake seconds, stderr-notes check via budget)
fn envelope(start_s: u64, script: Vec<(u64, &'static str)>) -> (Value, usize, usize, u64) { envelope_on(false, start_s, script) }
fn envelope_on(gap: bool, start_s: u64, script: Vec<(u64, &'static str)>) -> (Value, usize, usize, u64) {
    let now = Rc::new(Cell::new(0u64));
    budget::install(Box::new(FakeClock(now.clone())));
    now.set(start_s * 1_000_000_000);
    let (p, g) = (Scripted { now: now.clone(), script, posts: Cell::new(0), limits: RefCell::new(vec![]) }, Sig);
    let c = caller(&p, &g);
    let keys = Keys(RefCell::new(0));
    let out = envelope_output_at_with(&jason_job(), &c, &Fx(gap), &keys, 1794065826, true);
    let n = *keys.0.borrow();
    (out, n, p.posts.get(), (now.get() / 1_000_000_000).saturating_sub(start_s))
}
fn outcome_of(out: &Value) -> String { out["result"]["outcome"].as_str().unwrap_or("<none>").to_string() }

// (a) first call cut by the deadline -> no signed outcome (not VOID, not YES/NO)
#[test]
fn a_first_call_cut_by_the_deadline_emits_no_signed_outcome() {
    let _g = Guard;
    // 80 s already spent: model A gets 20 s, needs 70 -> cut. Partner can't help.
    let (out, signs, _posts, _s) = envelope(80, vec![(70, "not_met")]);
    assert!(out.is_null(), "cut judge must emit no outcome, got {}", out);
    assert_eq!(signs, 0, "nothing may be signed");
}
// (b) call refused with < 5 s left -> no signed outcome
#[test]
fn a_call_refused_with_under_5s_left_emits_no_signed_outcome() {
    let _g = Guard;
    let (out, signs, posts, _s) = envelope(97, vec![(1, "not_met")]);
    assert_eq!(posts, 0, "no stream may be opened");
    assert!(out.is_null(), "refused judge must emit no outcome, got {}", out);
    assert_eq!(signs, 0);
}
// (c) limit shortened but the call finished in time with a usable verdict -> normal signed outcome.
// D-JUDGETIME1b (a): the Jason sheet is gate-decided, so this is ONE audit call answered {"audit":"agree"} (the code NO stands).
#[test]
fn a_shortened_limit_that_still_finishes_with_a_verdict_is_a_normal_signed_outcome() {
    let _g = Guard;
    // 60 s spent -> 40 s left (< 60 s default limit => shortened); the audit needs 10 s.
    let (out, signs, posts, _s) = envelope(60, vec![(10, "agree")]);
    assert_eq!(posts, 1, "D-JUDGETIME1b: one audit call");
    assert_eq!(outcome_of(&out), "NO", "{}", out);
    assert_eq!(signs, 1);
    assert!(!budget::model_capped(), "a stream that finished inside its shortened limit is not 'capped'");
}
// D-JUDGETIME1b (c): the original two-model full-judge copy, on a sheet the gate cannot fully decide (Coinbase gap).
#[test]
fn gap_sheet_a_shortened_limit_that_still_finishes_with_a_verdict_is_a_normal_signed_outcome() {
    let _g = Guard;
    let (out, signs, posts, _s) = envelope_on(true, 60, vec![(10, "not_met")]);
    assert_eq!(posts, 2);
    assert_eq!(outcome_of(&out), "NO", "{}", out);
    assert_eq!(signs, 1);
    assert!(!budget::model_capped());
}
// (d) two COMPLETE, disagreeing verdicts (uncapped) -> unchanged: rerun, still no agreement -> signed VOID
#[test]
fn two_complete_disagreeing_verdicts_keep_the_existing_signed_void() {
    let _g = Guard;
    // fast calls, A says not_met, B says met, forever (reruns too): genuine disagreement.
    let (out, signs, posts, _s) = envelope(0, vec![(5, "not_met"), (5, "met")]);
    assert!(posts >= 2);
    assert!(!budget::model_capped());
    assert_eq!(outcome_of(&out), "VOID", "{}", out);
    assert_eq!(signs, 1);
}
// (e) first model completes, second cut by the deadline (the live Jason shape) -> end to end, no signed outcome on stdout
#[test]
fn second_model_cut_by_the_deadline_end_to_end_emits_no_signed_outcome() {
    let _g = Guard;
    let (out, signs, _posts, secs) = envelope(0, vec![(70, "not_met"), (70, "not_met")]);
    assert!(secs <= 100);
    assert!(out.is_null(), "envelope must emit no outcome, got {}", out);
    assert_eq!(signs, 0);
}
// the rerun path. D-JUDGETIME1b (a): on the gate-decided sheet the "first pair" is the audit and its single re-run: a "flag" (30 s) then a
// re-run that needs more than the ~70 s left is cut -> not "audit disagreed" -> no outcome.
#[test]
fn a_rerun_cut_by_the_deadline_emits_no_signed_outcome() {
    let _g = Guard;
    let (out, signs, _posts, _s) = envelope(0, vec![(30, "flag"), (90, "agree")]);
    assert!(out.is_null(), "a rerun cut by the deadline must emit no outcome, got {}", out);
    assert_eq!(signs, 0);
}
// D-JUDGETIME1b (c): the original full-judge rerun test, on the gap sheet (gate cannot decide).
#[test]
fn gap_sheet_a_rerun_cut_by_the_deadline_emits_no_signed_outcome() {
    let _g = Guard;
    // first pair: A 30 s not_met, B 30 s met (complete disagreement, 60 s elapsed); rerun A needs 50 s but has ~40 s left.
    let (out, signs, _posts, _s) = envelope_on(true, 0, vec![(30, "not_met"), (30, "met"), (50, "not_met")]);
    assert!(out.is_null(), "a rerun cut by the deadline must emit no outcome, got {}", out);
    assert_eq!(signs, 0);
}
// D-JUDGETIME1b (c): deadline-cut copies (a),(b),(e) on the gap sheet keep the full-judge path covered.
#[test]
fn gap_sheet_first_call_cut_or_refused_or_second_model_cut_emit_no_signed_outcome() {
    let _g = Guard;
    let (out, signs, _p, _s) = envelope_on(true, 80, vec![(70, "not_met")]);
    assert!(out.is_null() && signs == 0, "{}", out);
    let (out, signs, posts, _s) = envelope_on(true, 97, vec![(1, "not_met")]);
    assert!(posts == 0 && out.is_null() && signs == 0, "{}", out);
    let (out, signs, _p, secs) = envelope_on(true, 0, vec![(70, "not_met"), (70, "not_met")]);
    assert!(secs <= 100 && out.is_null() && signs == 0, "{}", out);
}
// ---- D-JUDGETIME1b (d): the L1b16 audit call is a model call too; a cut/refused audit emits NO signed outcome (D-JUDGETIME1 A) ----
#[test]
fn l1b16_audit_call_cut_by_the_deadline_emits_no_signed_outcome() {
    let _g = Guard;
    // 80 s spent -> 20 s left; the audit needs 70 s -> cut at the deadline: not "disagreed", not VOID, not signed.
    let (out, signs, _posts, _s) = envelope(80, vec![(70, "agree")]);
    assert!(out.is_null(), "D-JUDGETIME1b: a capped audit must emit no outcome, got {}", out);
    assert_eq!(signs, 0, "nothing may be signed");
}
#[test]
fn l1b16_audit_refused_with_under_5s_left_emits_no_signed_outcome() {
    let _g = Guard;
    let (out, signs, posts, _s) = envelope(97, vec![(1, "agree")]);
    assert_eq!(posts, 0, "no stream may be opened");
    assert!(out.is_null(), "D-JUDGETIME1b: a refused audit must emit no outcome, got {}", out);
    assert_eq!(signs, 0);
}
#[test]
fn l1b16_audit_rerun_cut_by_the_deadline_emits_no_signed_outcome() {
    let _g = Guard;
    // first audit: 30 s, flag; the re-run needs 90 s with ~70 s left -> cut. A cut re-run is not "audit disagreed".
    let (out, signs, _posts, _s) = envelope(0, vec![(30, "flag"), (90, "agree")]);
    assert!(out.is_null(), "D-JUDGETIME1b: an audit re-run cut by the deadline must emit no outcome, got {}", out);
    assert_eq!(signs, 0);
}
#[test]
fn l1b16_audit_that_finishes_in_time_agree_signs_the_code_outcome() {
    let _g = Guard;
    let (out, signs, posts, _s) = envelope(60, vec![(10, "agree")]);
    assert_eq!(posts, 1, "one audit call");
    assert_eq!(outcome_of(&out), "NO", "{}", out);
    assert_eq!(signs, 1);
}

// D-JUDGETIME1b (c)/(b): the two-complete-disagreeing-verdicts test stays as is (it still passes, but on the gate-decided sheet it now
// exercises a non-agree audit); these copies pin each path explicitly.
#[test]
fn gap_sheet_two_complete_disagreeing_verdicts_keep_the_existing_signed_void() {
    let _g = Guard;
    let (out, signs, posts, _s) = envelope_on(true, 0, vec![(5, "not_met"), (5, "met")]);
    assert!(posts >= 2);
    assert!(!budget::model_capped());
    assert_eq!(outcome_of(&out), "VOID", "{}", out);
    assert_eq!(signs, 1);
}
#[test]
fn l1b16_audit_flag_twice_is_a_signed_audit_disagreed_void() {
    let _g = Guard;
    let (out, signs, posts, _s) = envelope(0, vec![(5, "flag")]);
    assert_eq!(posts, 2, "one audit + exactly one re-run");
    assert_eq!(outcome_of(&out), "VOID", "{}", out);
    assert_eq!(signs, 1);
}
