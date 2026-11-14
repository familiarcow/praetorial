//! L1b16 (ruling D-JUDGETIME1 part B): a custom price-condition sheet that `price_condition_gate` FULLY decides from complete,
//! gap-free venue coverage sends the model(s) a SHORT audit prompt (code result + the candle facts it used), as typed lanes A/B
//! do, instead of the ~12.6 KB full-judge prompt. The model can agree or disagree, never flip the code result; disagreement
//! reuses the existing lane-audit rule (one re-run, then signed VOID "audit disagreed"). Sheets the gate cannot fully decide
//! keep the full-judge path unchanged. D-TPL1b / D-L1MESSY2 / D-EARLYREQ1 / D-JUDGETIME1(A) / D-VOID rules are untouched.
use super::*;
use serde_json::json;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

const L1: &str = super::item_l1a_tests::L1;
const NOW: i64 = 1794063600; // after window_end (06:00Z) and inside the evidence cutoff

fn example(id: &str) -> Value {
    let doc: Value = serde_json::from_slice(&std::fs::read(format!("{}/examples.json", L1)).unwrap()).unwrap();
    doc["examples"].as_array().unwrap().iter().find(|e| e["id"] == id).unwrap_or_else(|| panic!("no example {}", id)).clone()
}
fn merged_cb() -> String {
    let mut all: Vec<Value> = Vec::new();
    for i in 0..3 {
        let v: Value = serde_json::from_slice(&std::fs::read(format!("{}/fixtures/cb_BTC_1m_p{}.json", L1, i)).unwrap()).unwrap();
        all.extend(v.as_array().unwrap().iter().cloned());
    }
    serde_json::to_string(&all).unwrap()
}
struct Fx { cb: String }
impl HttpFetcher for Fx {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        let body = if url.contains("coinbase") {
            if self.cb.is_empty() { merged_cb().into_bytes() } else { std::fs::read(format!("{}/fixtures/{}", L1, self.cb)).map_err(|e| e.to_string())? }
        } else if url.contains("bitstamp") {
            std::fs::read(format!("{}/fixtures/bs_BTC_1m.json", L1)).unwrap()
        } else if url.contains("kraken") {
            std::fs::read(format!("{}/fixtures/kr_BTC_1m.json", L1)).unwrap()
        } else {
            return Err("no recorded fixture".into());
        };
        Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: "application/json".into(), body, status_code: 200 })
    }
}
/// Records every model request; answers with `reply(prompt)`.
struct Rec { reply: Box<dyn Fn(&[(String, String)]) -> String>, seen: RefCell<Vec<Vec<(String, String)>>> }
impl ModelCaller for Rec {
    fn call(&self, _m: &str, msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        self.seen.borrow_mut().push(msgs.to_vec());
        ((self.reply)(msgs), None, None)
    }
}
fn rec(f: impl Fn(&[(String, String)]) -> String + 'static) -> Rec { Rec { reply: Box::new(f), seen: RefCell::new(vec![]) } }
fn agree(_: &[(String, String)]) -> String { r#"{"audit":"agree"}"#.to_string() }
fn flag(_: &[(String, String)]) -> String { r#"{"audit":"flag"}"#.to_string() }
fn job_for(sheet: &Value) -> Value {
    let raw = sheet.to_string();
    json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 1, "checked_until": 0, "round": 0, "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw})
}
fn live3_jason() -> Value {
    serde_json::from_slice(&std::fs::read(format!("{}/live3/terms_jason_bitstamp_only_no.json", L1)).unwrap()).unwrap()
}
fn run(sheet: &Value, cb: &str, c: &Rec) -> (String, Vec<String>) {
    let (r, notes, _) = build_submission_judged_at(&job_for(sheet), c, &Fx { cb: cb.to_string() }, false, NOW);
    (r.outcome, notes)
}
fn prompt_bytes(m: &[(String, String)]) -> usize { m.iter().map(|(_, c)| c.len()).sum() }
fn prompt_text(m: &[(String, String)]) -> String { m.iter().map(|(_, c)| c.as_str()).collect::<Vec<_>>().join("\n") }
fn is_full_judge(m: &[(String, String)]) -> bool { m.len() >= 2 && m[1].1.contains("</rules>") && prompt_bytes(m) > 10_000 }
fn is_audit_form(m: &[(String, String)]) -> bool {
    let t = prompt_text(m);
    prompt_bytes(m) < 3_000 && t.contains("<proposal>") && t.contains("auditor") && !t.contains("</rules>")
}

// (a) Jason live3 one-venue NO sheet: the gate decides NO -> short audit prompt; auditor agrees -> NO
#[test]
fn a_jason_live3_sheet_gate_decided_no_uses_short_audit_prompt() {
    let c = rec(agree);
    let (out, notes) = run(&live3_jason(), "", &c);
    let seen = c.seen.borrow();
    assert!(!seen.is_empty(), "the model must be asked once");
    for m in seen.iter() {
        assert!(is_audit_form(m), "audit prompt expected, got {} bytes: {}", prompt_bytes(m), &prompt_text(m)[..prompt_text(m).len().min(400)]);
        assert!(prompt_text(m).contains("NO"), "the code result is in the prompt");
        assert!(prompt_text(m).contains("S_CB") && prompt_text(m).contains("S_BS"), "the candle facts used are in the prompt");
    }
    assert_eq!(out, "NO", "{:?}", notes);
    assert_eq!(seen.len(), 1, "one audit call when the auditor agrees");
}

// (b) auditor disagrees (flag) -> existing lane-audit-disagreement outcome: re-run once, then VOID "audit disagreed", never YES
#[test]
fn b_auditor_disagreement_is_the_lane_audit_void_never_a_flip() {
    let c = rec(flag);
    let (out, notes) = run(&live3_jason(), "", &c);
    assert_eq!(out, "VOID", "{:?}", notes);
    assert!(notes.iter().any(|n| n.contains("audit disagreed")), "{:?}", notes);
    assert_eq!(c.seen.borrow().len(), 2, "exactly one re-run, as the typed lanes do");
    // an auditor that answers with the OPPOSITE verdict in the old judge shape cannot flip it either
    let c2 = rec(|_| json!({"answer": "met", "quote": "1794029880,75952.18", "source_id": "S_BS", "reason": "x"}).to_string());
    let (out2, _) = run(&live3_jason(), "", &c2);
    assert_eq!(out2, "VOID");
}

// (c) gate-decided YES (both venues cross in one bucket) -> YES with an agreeing audit, short prompt
#[test]
fn c_gate_decided_yes_is_yes_with_agreeing_audit() {
    let e = example("jason_same_bucket_yes");
    let c = rec(agree);
    let (out, notes) = run(&e["sheet"], e.get("cb_file").and_then(|v| v.as_str()).unwrap_or(""), &c);
    assert_eq!(out, "YES", "{:?}", notes);
    let seen = c.seen.borrow();
    assert!(seen.iter().all(|m| is_audit_form(m)));
    assert!(prompt_text(&seen[0]).contains("YES"));
    // disagreeing auditor on a YES: VOID, never NO
    let c2 = rec(flag);
    let (out2, _) = run(&e["sheet"], "", &c2);
    assert_eq!(out2, "VOID");
}

// (d) gate not deciding / coverage not complete+gap-free -> the full-judge prompt, exactly as before
#[test]
fn d_gate_not_deciding_keeps_the_full_judge_path() {
    // d1: a small Coinbase gap (COMPLETE_WITH_GAPS) is not "complete coverage": full judge, recorded verdict stands
    let e = example("jason_coinbase_small_gap_yes");
    let c = rec(|_| json!({"answer": "met", "quote": "1794029820,75948.99", "source_id": "S_CB", "reason": "d1"}).to_string());
    let (out, notes) = run(&e["sheet"], e["cb_file"].as_str().unwrap(), &c);
    let seen = c.seen.borrow();
    assert!(!seen.is_empty() && seen.iter().all(|m| is_full_judge(m) && !prompt_text(m).contains("<proposal>")), "full-judge prompt expected");
    assert_eq!(out, "YES", "{:?}", notes);
    drop(seen);
    // d2: a range sheet (no threshold/coincidence the gate can decide) -> full judge
    let e2 = example("range_breakout_no");
    let c2 = rec(|_| json!({"answer": "not_met", "quote": "x", "source_id": "S_CB", "reason": "d2"}).to_string());
    let _ = run(&e2["sheet"], "", &c2);
    let seen2 = c2.seen.borrow();
    assert!(!seen2.is_empty() && seen2.iter().all(|m| is_full_judge(m)), "full-judge prompt expected for the range sheet");
}

// (e) the messy 'BTC breaks' sheet stays PRICE_READING_UNDEFINED at open and keeps the full judge at resolution
#[test]
fn e_messy_btc_breaks_sheet_stays_rejected_and_unchanged() {
    let messy: Value = serde_json::from_slice(&std::fs::read(format!("{}/live2/terms_btc_breaks_76140_messy.json", L1)).unwrap()).unwrap();
    let (out, _, notes) = super::item_l1a_tests::run_one(&json!({"kind": "custom_open", "now": NOW, "sheet": messy}));
    assert!(out.starts_with("REJECT:") && out.contains("PRICE_READING_UNDEFINED"), "{} {:?}", out, notes);
    let c = rec(|_| json!({"answer": "met", "quote": "x", "source_id": "S_CB", "reason": "e"}).to_string());
    let _ = run(&messy, "", &c);
    assert!(c.seen.borrow().iter().all(|m| !prompt_text(m).contains("<proposal>")), "an undefined-reading sheet never gets the audit prompt");
    // a gate-decidable sheet whose reading is undefined must also stay on the full judge
    let mut s = live3_jason();
    s["claim"] = json!("BTC breaks 75,951 on BOTH Coinbase and Bitstamp within the same 5-minute window");
    s["elements"] = json!([{"id": "e1", "q": "Did BTC break 75,951 on both within the same 5-minute window?"}]);
    s["custom_definitions"] = json!(["Only candle data from the three listed venues counts."]);
    let c2 = rec(agree);
    let _ = run(&s, "", &c2);
    assert!(c2.seen.borrow().iter().all(|m| !prompt_text(m).contains("<proposal>")), "PRICE_READING_UNDEFINED claim keeps the full judge");
}

// (f) end to end through the envelope entry: one short signed audit call, NO signed, well under the deadline
struct Guard;
impl Drop for Guard { fn drop(&mut self) { budget::clear(); } }
struct FakeClock(Rc<Cell<u64>>);
impl Clock for FakeClock { fn now_ns(&self) -> u64 { self.0.get() } }
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
struct Poster { now: Rc<Cell<u64>>, secs: u64, answer: &'static str, bodies: RefCell<Vec<usize>> }
impl StreamPoster for Poster {
    fn post_stream(&self, _u: &str, _h: &[(&str, &str)], b: &[u8], l: &StreamLimits) -> Result<StreamResp, String> {
        self.bodies.borrow_mut().push(b.len());
        let need_ms = self.secs * 1000;
        if need_ms > l.total_ms {
            self.now.set(self.now.get() + l.total_ms * 1_000_000);
            return Ok(StreamResp { status: 200, bytes: b"data: {\"id\"".to_vec(), stalled: true, total_ms: l.total_ms, total_hit: true, ..Default::default() });
        }
        self.now.set(self.now.get() + need_ms * 1_000_000);
        Ok(StreamResp { status: 200, bytes: sse(self.answer), total_ms: need_ms, ..Default::default() })
    }
}
fn envelope(secs: u64, answer: &'static str, sheet: &Value) -> (Value, usize, Vec<usize>, u64) {
    let now = Rc::new(Cell::new(0u64));
    budget::install(Box::new(FakeClock(now.clone())));
    let p = Poster { now: now.clone(), secs, answer, bodies: RefCell::new(vec![]) };
    let g = Sig;
    let c = StreamJudgeCaller { api_base: "https://x".into(), api_key: "key".into(), poster: &p, getter: &g, sleep_ms: Box::new(|_| {}), now_ms: Box::new(|| 0),
        sha256_hex: Box::new(|_| "HASH".to_string()), verify: Box::new(|_, _, _| true) };
    let keys = Keys(RefCell::new(0));
    let out = envelope_output_at_with(&job_for(sheet), &c, &Fx { cb: String::new() }, &keys, NOW, true);
    let n = *keys.0.borrow();
    let bodies = p.bodies.borrow().clone();
    (out, n, bodies, now.get() / 1_000_000_000)
}
#[test]
fn f_envelope_entry_resolves_the_jason_sheet_with_one_short_audit_call() {
    let _g = Guard;
    let (out, signs, bodies, secs) = envelope(15, r#"{"audit":"agree"}"#, &live3_jason());
    assert_eq!(out["result"]["outcome"], "NO", "{}", out);
    assert_eq!(signs, 1);
    assert_eq!(bodies.len(), 1, "one model request");
    assert!(bodies[0] < 4_000, "request body {} B should be the short audit form", bodies[0]);
    assert!(secs <= 20, "{} s", secs);
}
#[test]
fn f_envelope_entry_disagreeing_audit_is_signed_void_not_a_flip() {
    let _g = Guard;
    let (out, _signs, bodies, _s) = envelope(5, r#"{"audit":"flag"}"#, &live3_jason());
    assert_eq!(out["result"]["outcome"], "VOID", "{}", out);
    assert_eq!(bodies.len(), 2);
}
#[test]
fn f_envelope_entry_audit_cut_by_the_deadline_emits_no_signed_outcome() {
    let _g = Guard;
    // D-JUDGETIME1(A) still holds on the audit path: a call cut by the 100 s model deadline -> no signed outcome
    let (out, signs, _b, _s) = envelope(130, r#"{"audit":"agree"}"#, &live3_jason());
    assert!(out.is_null(), "{}", out);
    assert_eq!(signs, 0);
}
