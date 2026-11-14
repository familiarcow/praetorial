//! L1b9 (D-EARLYREQ1 option A): a resolution request that comes BEFORE the sheet can be decided gets NO signed outcome
//! (clean no-output exit, like D-BUDGET1's skipped rerun; the escrow treats Successful-with-null as retryable, D-RESOLVE4a).
//! Live finding (live2/raw_resolution_close_above_future.txt): request at T+1min -> REQ_BEFORE_T_PLUS_5MIN refusal was
//! signed as VOID and the escrow accepted it, denying the winner. Genuine COULDNT_CHECK AFTER the decidable time keeps VOID.
use super::*;
use serde_json::json;
use std::cell::RefCell;

const L1: &str = super::item_l1a_tests::L1;
const T_LIVE: i64 = 1794076680; // 2026-11-07T18:38:00Z
struct Keys(RefCell<usize>);
impl KeyBackend for Keys {
    fn public_key(&self, _p: &str) -> Result<Vec<u8>, String> { Ok(vec![9u8; 32]) }
    fn predecessor(&self) -> Option<String> { None }
    fn sign(&self, _p: &str, _m: &[u8]) -> Result<Vec<u8>, String> { *self.0.borrow_mut() += 1; Ok(vec![7u8; 64]) }
}
struct Agree;
impl ModelCaller for Agree {
    fn call(&self, _m: &str, _msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) { (r#"{"audit":"agree"}"#.to_string(), None, None) }
}
struct Canned(String);
impl ModelCaller for Canned {
    fn call(&self, _m: &str, _msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) { (self.0.clone(), None, None) }
}
struct Dead(RefCell<usize>);
impl HttpFetcher for Dead {
    fn fetch(&self, _u: &str) -> Result<RawFetchResponse, String> { *self.0.borrow_mut() += 1; Err("transport error: all sources down (test)".into()) }
}
fn job_for(raw: &str) -> Value {
    json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 1, "checked_until": 0, "round": 0, "envelope": {"terms_hash": praetorial_core::sha_hex(raw)}, "terms": raw})
}
/// (envelope output, number of signatures made)
fn envelope(raw: &str, caller: &dyn ModelCaller, f: &dyn HttpFetcher, now: i64) -> (Value, usize) {
    let keys = Keys(RefCell::new(0));
    let out = envelope_output_at(&job_for(raw), caller, f, &keys, now);
    let n = *keys.0.borrow();
    (out, n)
}
fn outcome_of(out: &Value) -> String { out["result"]["outcome"].as_str().unwrap_or("<none>").to_string() }
fn live2_close_above_future() -> String {
    let v: Value = serde_json::from_slice(&std::fs::read(format!("{}/live2/terms_close_above_future.json", L1)).unwrap()).unwrap();
    v.to_string()
}

// ---- (1) the live finding: typed close-at-T, request at T+1min (18:39Z) -> no signed outcome
#[test]
fn live2_close_above_future_at_1839_emits_no_signed_outcome() {
    let dead = Dead(RefCell::new(0));
    let (out, signs) = envelope(&live2_close_above_future(), &Agree, &dead, T_LIVE + 60);
    assert!(out.is_null(), "request before T+5min must produce NO output (D-EARLYREQ1), got {}", out);
    assert_eq!(signs, 0, "nothing may be signed");
    assert_eq!(*dead.0.borrow(), 0, "a too-early request fetches nothing");
}
#[test]
fn too_early_diagnostic_names_the_reason_and_decision() {
    let dead = Dead(RefCell::new(0));
    let (r, notes, _) = build_submission_judged_at(&job_for(&live2_close_above_future()), &Agree, &dead, false, T_LIVE + 60);
    let _ = r;
    assert!(notes.iter().any(|n| n.contains("REQ_BEFORE_T_PLUS_5MIN")), "{:?}", notes);
    assert!(early_request_reason().is_some_and(|r| r.contains("REQ_BEFORE_T_PLUS_5MIN")), "{:?}", early_request_reason());
}
// ---- (2) same sheet at T+5min (18:43Z) -> normal path; the sources are dead -> genuine COULDNT_CHECK keeps signing VOID
#[test]
fn live2_close_above_future_at_1843_takes_the_normal_path_and_dead_sources_stay_void() {
    let dead = Dead(RefCell::new(0));
    let (out, signs) = envelope(&live2_close_above_future(), &Agree, &dead, T_LIVE + 300);
    assert_eq!(outcome_of(&out), "VOID", "{}", out);
    assert_eq!(signs, 1);
    assert!(*dead.0.borrow() > 0, "the normal path tries the sources");
}
#[test]
fn typed_close_at_t_plus_5min_with_live_data_is_still_yes() {
    let (_, t) = super::item17c2_tests::ev("A");
    let raw = super::item17c2_tests::close_sheet("A", ">", 75900).to_string();
    let fx = super::item17c2_tests::f("A", &[]);
    let (out, signs) = envelope(&raw, &Agree, &fx, t + 300);
    assert_eq!(outcome_of(&out), "YES", "{}", out);
    assert_eq!(signs, 1);
}
// ---- typed touch: window still open and no early YES -> no outcome; early YES (>= 2 venues crossed) -> YES
#[test]
fn typed_touch_open_window_without_early_yes_emits_no_signed_outcome() {
    let (_, we) = super::item17c2_tests::ev("A");
    let raw = super::item17c2_tests::touch_sheet("A", "at_or_above", 75970).to_string();
    let fx = super::item17c2_tests::f("A", &[]);
    let (out, signs) = envelope(&raw, &Agree, &fx, we - 600);
    assert!(out.is_null(), "{}", out);
    assert_eq!(signs, 0);
}
#[test]
fn typed_touch_open_window_with_early_yes_is_yes() {
    let (_, we) = super::item17c2_tests::ev("A");
    let raw = super::item17c2_tests::touch_sheet("A", "at_or_above", 75930).to_string();
    let fx = super::item17c2_tests::f("A", &[]);
    let (out, _) = envelope(&raw, &Agree, &fx, we - 1);
    // (window nearly over; the recorded candles cross 75930 on >= 2 venues)
    assert_eq!(outcome_of(&out), "YES", "{}", out);
}
// ---- custom (Jason-style) sheets: decision time = time.window_end
fn jason_raw() -> (String, i64) {
    let raw = String::from_utf8(std::fs::read(format!("{}/live2/terms_jason_bitstamp_only_no.json", L1)).unwrap()).unwrap();
    let raw = serde_json::from_str::<Value>(&raw).unwrap().to_string();
    let we = iso_to_unix(serde_json::from_str::<Value>(&raw).unwrap()["time"]["window_end"].as_str().unwrap()).unwrap();
    (raw, we)
}
struct Rec;
impl HttpFetcher for Rec {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        let f = if url.contains("coinbase") { "cb_BTC_1m_p0.json" } else if url.contains("bitstamp") { "bs_BTC_1m.json" } else { "kr_BTC_1m.json" };
        let body = std::fs::read(format!("{}/fixtures/{}", L1, f)).map_err(|e| e.to_string())?;
        Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: "application/json".into(), body, status_code: 200 })
    }
}
#[test]
fn custom_sheet_before_window_end_without_qualifying_candle_emits_no_signed_outcome() {
    let (raw, we) = jason_raw();
    let judge = Canned(json!({"answer":"not_met","quote":"1794029220,75950","source_id":"S_CB","reason":"no qualifying candle"}).to_string());
    let (out, signs) = envelope(&raw, &judge, &Rec, we - 3600);
    assert!(out.is_null(), "before window_end and not YES -> no outcome, got {}", out);
    assert_eq!(signs, 0);
}
#[test]
fn custom_sheet_before_window_end_with_qualifying_early_yes_candle_is_yes() {
    let doc: Value = serde_json::from_slice(&std::fs::read(format!("{}/examples.json", L1)).unwrap()).unwrap();
    let mut e = doc["examples"].as_array().unwrap().iter().find(|e| e["id"] == "jason_same_bucket_yes").unwrap().clone();
    let we = iso_to_unix(e["sheet"]["time"]["window_end"].as_str().unwrap()).unwrap();
    e["now"] = json!(we - 3600); // request one hour BEFORE the deadline; the qualifying candle is already in the recorded data
    let (out, _path, notes) = super::item_l1a_tests::run_one(&e);
    assert_eq!(out, "YES", "early YES at the first qualifying candle must keep working: {:?}", notes);
}
#[test]
fn custom_sheet_after_window_end_with_dead_sources_stays_signed_void() {
    let (raw, we) = jason_raw();
    let dead = Dead(RefCell::new(0));
    let judge = Canned(json!({"answer":"insufficient","reason":"no data"}).to_string());
    let (out, signs) = envelope(&raw, &judge, &dead, we + 3600);
    assert_eq!(outcome_of(&out), "VOID", "{}", out);
    assert_eq!(signs, 1);
}
