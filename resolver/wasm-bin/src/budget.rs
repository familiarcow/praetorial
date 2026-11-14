//! D-BUDGET1 (L1b2a, option A): the resolver keeps a wall-clock budget so it stops BEFORE OutLayer's
//! `max_execution_seconds` kills it (a platform kill is reported as a bare "Failed" with no output; L1b2 diagnosis).
//!
//! Before the two-model disagreement rerun (2 more sequential model calls), if `elapsed + calls * worst_case_call`
//! would pass `TOTAL_BUDGET_NS`, the rerun is SKIPPED and the resolver emits NO output at all (clean exit; the escrow
//! treats a Successful result with null/empty output as a failed, retryable run, D-RESOLVE4a). A skipped rerun is never
//! turned into YES / NO / VOID (rejected options B and C of D-BUDGET1): no signed outcome exists, so nothing is settled.
//!
//! The clock is injectable (`crate::Clock`): production = `SystemClock` (WASI wall clock), tests = a fake clock.
//! State is thread-local (the wasm component is single-threaded; each test thread has its own).
use crate::Clock;
use std::cell::RefCell;

/// OutLayer `max_execution_seconds` for the resolver (limits pinned in the release record: 150 s).
pub const OUTLAYER_MAX_EXECUTION_NS: u64 = 150_000_000_000;
/// The resolver's own budget: stop starting new model calls that cannot finish by here. 30 s of headroom below the
/// platform limit covers the final fetches/hash/sign/print after the last model call.
pub const TOTAL_BUDGET_NS: u64 = 120_000_000_000;
/// Floor for the worst-case single model call estimate when we have seen no/short calls (observed live: ~25-28 s per call).
pub const WORST_CALL_FLOOR_NS: u64 = 20_000_000_000;
/// L1b6: ALL source fetches share this budget (inside TOTAL_BUDGET_NS); each request also has its own deadline. The wasm
/// fetch had neither: a source that accepted the connection and never answered blocked the run until the platform kill.
/// A fetch refused or timed out here makes that source UNAVAILABLE (COULDNT_CHECK), never NO and never YES.
/// L1b13: NO model stream may run past this point of the run (elapsed since `install`). The Jason NO sheet's two sequential
/// calls took 88-127 s natively; the platform kills at ~120 s with no output. 100 s leaves ~20 s for sign + print.
pub const MODEL_DEADLINE_NS: u64 = 100_000_000_000;
/// L1b13: a model call is not started with less than this left (it could not finish a useful stream).
pub const MIN_MODEL_CALL_NS: u64 = 5_000_000_000;
pub const FETCH_BUDGET_NS: u64 = 45_000_000_000;
pub const FETCH_REQUEST_TIMEOUT_MS: u64 = 15_000;

struct State {
    clock: Option<Box<dyn Clock>>,
    start_ns: u64,
    calls_ms: Vec<u64>,
    rerun: bool,
    skipped: Option<(u64, u64)>, // (elapsed_ms, needed_ms) when the rerun was skipped
    fetch_spent_ns: u64,
    fetches: Vec<String>,
    model_capped: bool,
    judge_deadline: bool,
}
thread_local! {
    static STATE: RefCell<State> = RefCell::new(State { clock: None, start_ns: 0, calls_ms: vec![], rerun: false, skipped: None, fetch_spent_ns: 0, fetches: vec![], model_capped: false, judge_deadline: false });
}

/// Uninstalled (any path that never called `install`, i.e. everything but the production envelope entry and the tests that
/// opt in) the clock is frozen at 0: nothing is ever skipped and recorded diagnostics stay deterministic (recorded fixtures).
fn now(s: &mut State) -> u64 {
    s.clock.as_ref().map(|c| c.now_ns()).unwrap_or(0)
}

/// Start the budget: record the start time on `clock` and reset the diagnostics.
pub fn install(clock: Box<dyn Clock>) {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.start_ns = clock.now_ns();
        s.clock = Some(clock);
        s.calls_ms.clear();
        s.rerun = false;
        s.skipped = None;
        s.fetch_spent_ns = 0;
        s.fetches.clear();
        s.model_capped = false;
        s.judge_deadline = false;
    });
}
pub fn clear() {
    STATE.with(|s| *s.borrow_mut() = State { clock: None, start_ns: 0, calls_ms: vec![], rerun: false, skipped: None, fetch_spent_ns: 0, fetches: vec![], model_capped: false, judge_deadline: false });
}
/// Current clock reading (ns), for timing a call.
pub fn tick() -> u64 {
    STATE.with(|s| now(&mut s.borrow_mut()))
}
/// Record one model call's latency, measured as `tick()` after minus before.
pub fn record_call(_model: &str, ms: u64) {
    STATE.with(|s| s.borrow_mut().calls_ms.push(ms));
}
/// May a rerun needing `calls_needed` more sequential calls start? Worst case per call = max observed so far, at least
/// `WORST_CALL_FLOOR_NS`. If not, records the skip (and `skipped()` becomes true).
pub fn allow_rerun(calls_needed: usize) -> bool {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let elapsed = now(&mut s).saturating_sub(s.start_ns);
        let worst = s.calls_ms.iter().copied().max().unwrap_or(0).saturating_mul(1_000_000).max(WORST_CALL_FLOOR_NS);
        let need = worst.saturating_mul(calls_needed as u64);
        if elapsed.saturating_add(need) > TOTAL_BUDGET_NS {
            s.skipped = Some((elapsed / 1_000_000, need / 1_000_000));
            false
        } else {
            true
        }
    })
}
pub fn note_rerun(ran: bool) {
    STATE.with(|s| s.borrow_mut().rerun = ran);
}
pub fn skipped() -> bool {
    STATE.with(|s| s.borrow().skipped.is_some() || s.borrow().judge_deadline)
}
/// (diagnostic notes, rerun skipped)
pub fn report() -> (Vec<String>, bool) {
    STATE.with(|s| {
        let s = s.borrow();
        let calls = s.calls_ms.iter().map(|c| c.to_string()).collect::<Vec<_>>().join(",");
        let mut n = format!("D-BUDGET1: calls_ms=[{}] rerun={}", calls, s.rerun);
        if let Some((el, need)) = s.skipped {
            n.push_str(&format!(" budget_skip elapsed_ms={} rerun_needs_ms={} budget_ms={} (no outcome emitted; escrow retries, D-RESOLVE4a)", el, need, TOTAL_BUDGET_NS / 1_000_000));
        }
        if s.judge_deadline {
            n.push_str(" D-JUDGETIME1: model deadline, no outcome (no signed outcome; escrow retries, D-RESOLVE4a)");
        }
        (vec![n], s.skipped.is_some() || s.judge_deadline)
    })
}


/// L1b6: deadline (ms) for the next source request = min(per-request cap, what is left of the fetch budget).
/// Err once the budget is spent: the caller must not send the request (source unavailable).
pub fn fetch_timeout_ms() -> Result<u64, String> {
    STATE.with(|s| {
        let s = s.borrow();
        let left_ns = FETCH_BUDGET_NS.saturating_sub(s.fetch_spent_ns);
        if left_ns == 0 {
            return Err(format!("fetch budget exhausted ({} ms of {} ms spent on source requests); source not requested", s.fetch_spent_ns / 1_000_000, FETCH_BUDGET_NS / 1_000_000));
        }
        Ok((left_ns / 1_000_000).min(FETCH_REQUEST_TIMEOUT_MS))
    })
}
/// L1b6: account one source request (`ns` = its wall time) and log the stage timing line on stderr.
pub fn record_fetch(url: &str, ns: u64, ok: bool) {
    let host = url.split("//").nth(1).and_then(|r| r.split('/').next()).unwrap_or("?");
    let line = format!("L1b6 fetch host={} ms={} {}", host, ns / 1_000_000, if ok { "ok" } else { "err" });
    eprintln!("{}", line);
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.fetch_spent_ns = s.fetch_spent_ns.saturating_add(ns);
        s.fetches.push(line);
    });
}
/// L1b6: per-source-request timing lines recorded so far.
pub fn fetch_log() -> Vec<String> {
    STATE.with(|s| s.borrow().fetches.clone())
}

/// L1b13: ms left for a model stream before MODEL_DEADLINE_NS. `None` = budget not installed (tests / non-envelope paths):
/// no cap, behaviour unchanged. `Some(0)` = deadline reached.
pub fn model_call_cap_ms() -> Option<u64> {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.clock.as_ref()?;
        let elapsed = now(&mut s).saturating_sub(s.start_ns);
        Some(MODEL_DEADLINE_NS.saturating_sub(elapsed) / 1_000_000)
    })
}
/// L1b13: a model call was cut short or refused because of the model deadline (its verdict is unusable, not a disagreement).
pub fn note_model_capped() {
    STATE.with(|s| s.borrow_mut().model_capped = true);
}
pub fn model_capped() -> bool {
    STATE.with(|s| s.borrow().model_capped)
}
/// D-JUDGETIME1: the model deadline cut the judge and no usable verdict exists -> the run emits no signed outcome.
pub fn note_judge_deadline() {
    STATE.with(|s| s.borrow_mut().judge_deadline = true);
}
