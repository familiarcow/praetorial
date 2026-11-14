//! L1b2a (D-BUDGET1 option A): the resolver keeps a wall-clock budget. Before the two-model disagreement rerun, if
//! elapsed + worst-case call time would pass TOTAL_BUDGET (120 s of OutLayer's 150 s max_execution_seconds), the rerun is
//! skipped and NO signed outcome is emitted (null output -> escrow retries, D-RESOLVE4a). A skipped rerun never yields
//! YES/NO/VOID. Fake clock + scripted slow/fast models; no model call.
use super::*;
use serde_json::json;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

struct FakeClock(Rc<Cell<u64>>);
impl Clock for FakeClock {
    fn now_ns(&self) -> u64 { self.0.get() }
}
/// Each call advances the fake clock by `latency_s`; model "m1" answers `a`, "m2" answers `b`
/// (the first-round replies); `later` is used for both models on every call after the first two.
struct Slow { now: Rc<Cell<u64>>, latency_s: u64, a: &'static str, b: &'static str, later: &'static str, calls: RefCell<usize> }
impl ModelCaller for Slow {
    fn call(&self, model: &str, _m: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        let n = { let mut c = self.calls.borrow_mut(); *c += 1; *c };
        self.now.set(self.now.get() + self.latency_s * 1_000_000_000);
        let r = if n > 2 { self.later } else if model == "m1" { self.a } else { self.b };
        (r.to_string(), None, None)
    }
}
const INSUF: &str = r#"{"answer":"insufficient","reason":"x"}"#;
const GARBAGE: &str = "not json at all";

struct Guard;
impl Drop for Guard { fn drop(&mut self) { budget::clear(); } }

fn job() -> Value {
    let terms = json!({
        "claim": "x", "rule": "ANY", "sources": true,
        "clauses": ["AVAILABLE_V1"],
        "custom_definitions": ["fallback: no fallback source applies to this test. early: early resolution not applicable to this test."],
        "time": {"window_start": "2026-01-01T00:00:00Z", "window_end": "2026-12-31T23:59:59Z", "evidence_cutoff": "2027-01-01T00:00:00Z"},
        "elements": [{"id": "e1", "q": "did it happen"}],
        "sources_allowed": [{"id": "S1", "publisher": "Pub A"}, {"id": "S2", "publisher": "Pub B"}],
        "models": ["m1", "m2"],
    }).to_string();
    json!({
        "contract": "escrow.testnet", "bet_id": 5, "run_no": 3, "checked_until": 0, "round": 0,
        "envelope": {"terms_hash": praetorial_core::sha_hex(&terms)}, "terms": terms,
        "sources": [
            {"id": "S1", "published": "2026-06-01T00:00:00Z", "text": "evidence text"},
            {"id": "S2", "published": "2026-06-01T00:00:00Z", "text": "other"},
        ],
    })
}

struct Keys(RefCell<usize>);
impl KeyBackend for Keys {
    fn public_key(&self, _p: &str) -> Result<Vec<u8>, String> { Ok(vec![9u8; 32]) }
    fn predecessor(&self) -> Option<String> { None }
    fn sign(&self, _p: &str, _m: &[u8]) -> Result<Vec<u8>, String> { *self.0.borrow_mut() += 1; Ok(vec![7u8; 64]) }
}

fn run(latency_s: u64, a: &'static str, b: &'static str, later: &'static str) -> (Value, usize, usize, Vec<String>, bool) {
    let now = Rc::new(Cell::new(0u64));
    budget::install(Box::new(FakeClock(now.clone())));
    let _g = Guard;
    let c = Slow { now, latency_s, a, b, later, calls: RefCell::new(0) };
    let keys = Keys(RefCell::new(0));
    let out = envelope_output_at(&job(), &c, &NullFetcher, &keys, 1_800_000_000);
    let calls = *c.calls.borrow();
    let signs = *keys.0.borrow();
    let (notes, skipped) = budget::report();
    (out, calls, signs, notes, skipped)
}

#[test]
fn slow_disagreeing_pair_skips_rerun_and_emits_no_signed_outcome() {
    // 2 calls x 40 s = 80 s elapsed; a rerun needs 2 more x 40 s worst case -> 160 s > 120 s budget.
    let (out, calls, signs, _notes, skipped) = run(40, INSUF, GARBAGE, INSUF);
    assert_eq!(calls, 2, "rerun must be skipped");
    assert!(skipped, "budget_skip must be recorded");
    assert!(out.is_null(), "no output at all (no outcome of any kind): {}", out);
    assert_eq!(signs, 0, "nothing may be signed");
}

#[test]
fn skipped_rerun_never_yields_yes_no_or_void() {
    // even if a rerun WOULD have agreed on a decisive answer, skipping must not produce any outcome
    let (out, _calls, signs, _n, skipped) = run(40, INSUF, GARBAGE, INSUF);
    assert!(skipped);
    for w in ["YES", "NO", "VOID"] { assert!(!out.to_string().contains(&format!("\"outcome\":\"{}\"", w)), "{}", out); }
    assert!(out.is_null() && signs == 0);
}

#[test]
fn fast_disagreeing_pair_still_reruns_as_today() {
    let (out, calls, signs, notes, skipped) = run(1, INSUF, GARBAGE, INSUF);
    assert_eq!(calls, 4, "fast pair: rerun still happens");
    assert!(!skipped);
    assert!(out.is_object() && signs == 1, "signed outcome as today: {}", out);
    assert!(out["result"]["outcome"].is_string());
    assert!(notes.iter().any(|n| n.contains("rerun=true")), "{:?}", notes);
}

#[test]
fn agreeing_pair_unaffected_even_when_slow() {
    let (out, calls, signs, notes, skipped) = run(55, INSUF, INSUF, INSUF);
    assert_eq!(calls, 2, "agreeing pair never reruns");
    assert!(!skipped && out.is_object() && signs == 1, "{}", out);
    assert!(notes.iter().any(|n| n.contains("rerun=false")), "{:?}", notes);
}

#[test]
fn per_call_latency_is_logged() {
    let (_o, _c, _s, notes, _k) = run(7, INSUF, INSUF, INSUF);
    assert!(notes.iter().any(|n| n.contains("calls_ms=[7000,7000]")), "{:?}", notes);
}

#[test]
fn skip_note_says_budget_skip() {
    let (_o, _c, _s, notes, _k) = run(40, INSUF, GARBAGE, INSUF);
    assert!(notes.iter().any(|n| n.contains("budget_skip")), "{:?}", notes);
}

#[test]
fn budget_constants_are_documented_values() {
    assert_eq!(budget::TOTAL_BUDGET_NS, 120_000_000_000);
    assert_eq!(budget::OUTLAYER_MAX_EXECUTION_NS, 150_000_000_000);
}
