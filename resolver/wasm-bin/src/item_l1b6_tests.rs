//! L1b6 (queue item l1b-jason-noout-timing): the Jason one-venue NO sheet produced no output ~120 s after the request
//! on OutLayer. Native runs against the live public candle endpoints finish in ~1 s (DIAGNOSIS_l1b6.md), but the wasm
//! source fetch (`WasiFetcher`) had NO per-request deadline and NO total fetch budget: one source that accepts the
//! connection and never answers blocks the whole run until the platform kills it. Fix: every source GET carries a
//! per-request deadline (<= 15 s), all source fetches share one 45 s budget inside D-BUDGET1's 120 s; a source that
//! cannot be fetched in budget is UNAVAILABLE (COULDNT_CHECK), which under the sheet's fallback rule is VOID when fewer
//! than two venues can be checked -- never NO, never YES. Fake clock + fake hanging sources; no network, no model.
use super::*;
use serde_json::json;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

const L1: &str = super::item_l1a_tests::L1;

struct FakeClock(Rc<Cell<u64>>);
impl Clock for FakeClock {
    fn now_ns(&self) -> u64 { self.0.get() }
}
struct Guard;
impl Drop for Guard { fn drop(&mut self) { budget::clear(); } }

/// A source that never answers: it blocks for exactly the deadline it was given (a fetcher that cannot honour a
/// deadline, i.e. one called through plain `fetch`, blocks for 10 minutes = the platform's default).
struct Hang { overshoot_ms: u64, now: Rc<Cell<u64>>, hang_hosts: Vec<&'static str>, timeouts: RefCell<Vec<u64>>, served: RefCell<Vec<String>> }
impl Hang {
    fn serve(url: &str) -> Result<RawFetchResponse, String> {
        let f = if url.contains("coinbase") { "cb_BTC_1m_p0.json" } else if url.contains("bitstamp") { "bs_BTC_1m.json" } else { "kr_BTC_1m.json" };
        let body = std::fs::read(format!("{}/fixtures/{}", L1, f)).map_err(|e| e.to_string())?;
        Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: "application/json".into(), body, status_code: 200 })
    }
    fn hangs(&self, url: &str) -> bool { self.hang_hosts.iter().any(|h| url.contains(h)) }
}
impl HttpFetcher for Hang {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        if self.hangs(url) {
            self.now.set(self.now.get() + 600_000_000_000);
            return Err("transport error: hung for 600 s".into());
        }
        self.served.borrow_mut().push(url.to_string());
        Self::serve(url)
    }
    fn fetch_timeout(&self, url: &str, timeout_ms: u64) -> Result<RawFetchResponse, String> {
        self.timeouts.borrow_mut().push(timeout_ms);
        if self.hangs(url) {
            self.now.set(self.now.get() + (timeout_ms + self.overshoot_ms) * 1_000_000);
            return Err(format!("request timed out after {} ms", timeout_ms));
        }
        self.served.borrow_mut().push(url.to_string());
        Self::serve(url)
    }
}
struct Judge;
impl ModelCaller for Judge {
    fn call(&self, _m: &str, _msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        (json!({"answer":"not_met","quote":"1794029220,75950","source_id":"S_CB","reason":"l1b6 canned"}).to_string(), None, None)
    }
}
fn sheet_job() -> Value {
    let raw = String::from_utf8(std::fs::read(format!("{}/live2/terms_jason_bitstamp_only_no.json", L1)).unwrap()).unwrap();
    let raw = serde_json::from_str::<Value>(&raw).unwrap().to_string();
    json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 1, "checked_until": 0, "round": 0, "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw})
}
fn run(hang_hosts: Vec<&'static str>) -> (String, Vec<String>, Rc<Cell<u64>>, Hang) {
    run_with(hang_hosts, 0)
}
fn run_with(hang_hosts: Vec<&'static str>, overshoot_ms: u64) -> (String, Vec<String>, Rc<Cell<u64>>, Hang) {
    let now = Rc::new(Cell::new(0u64));
    budget::install(Box::new(FakeClock(now.clone())));
    let f = Hang { overshoot_ms, now: now.clone(), hang_hosts, timeouts: RefCell::new(vec![]), served: RefCell::new(vec![]) };
    let (r, notes, _) = build_submission_judged_at(&sheet_job(), &Judge, &f, false, 1794065826);
    (r.outcome, notes, now, f)
}

#[test]
fn all_sources_hanging_finish_inside_the_fetch_budget_as_void() {
    let _g = Guard;
    let (out, notes, now, f) = run(vec!["coinbase", "bitstamp", "kraken"]);
    let elapsed_s = now.get() / 1_000_000_000;
    assert!(elapsed_s <= 45, "fetch stage took {} s of fake wall clock (budget 45 s): {:?}", elapsed_s, notes);
    assert!(f.timeouts.borrow().iter().all(|t| *t <= 15_000), "per-request deadline must be <= 15 s: {:?}", f.timeouts.borrow());
    assert_eq!(out, "VOID", "no venue could be checked -> VOID (never NO/YES): {:?}", notes);
}

#[test]
fn a_fetcher_that_overshoots_its_deadline_exhausts_the_budget_and_later_fetches_are_refused() {
    let _g = Guard;
    // each hung request really costs deadline + 10 s (connect/TLS before the timer starts). 25 s + 25 s = 50 s > 45 s:
    // the third request (Kraken) must never be sent; it is unavailable, not waited for.
    let (out, notes, now, f) = run_with(vec!["coinbase", "bitstamp", "kraken"], 10_000);
    assert_eq!(f.timeouts.borrow().len(), 2, "third request must be refused by the exhausted fetch budget: {:?}", f.timeouts.borrow());
    assert!(now.get() / 1_000_000_000 <= 50, "stage must stop at 50 s, not run on: {:?}", notes);
    assert!(notes.iter().any(|n| n.contains("S_KR") && n.contains("fetch budget")), "refusal must be reported on S_KR: {:?}", notes);
    assert_eq!(out, "VOID", "{:?}", notes);
}

#[test]
fn one_hanging_source_is_unavailable_never_no_or_yes() {
    let _g = Guard;
    // Coinbase hangs; Bitstamp + Kraken are served (fixtures). Fallback rule decides from the remaining venues only.
    let (out, notes, now, f) = run(vec!["coinbase"]);
    assert!(now.get() / 1_000_000_000 <= 15, "one hung source costs at most one 15 s deadline: {:?}", notes);
    assert!(f.timeouts.borrow().iter().all(|t| *t <= 15_000), "{:?}", f.timeouts.borrow());
    assert!(notes.iter().any(|n| n.contains("S_CB") && n.contains("COULDNT_CHECK")), "hung Coinbase must be reported unavailable: {:?}", notes);
    assert_ne!(out, "YES", "{:?}", notes);
    assert_eq!(out, "VOID", "an unavailable venue never turns into NO: {:?}", notes);
}

#[test]
fn request_deadline_is_clamped_to_the_remaining_fetch_budget() {
    let _g = Guard;
    let now = Rc::new(Cell::new(0u64));
    budget::install(Box::new(FakeClock(now.clone())));
    assert_eq!(budget::fetch_timeout_ms(), Ok(15_000));
    for ms in [20_000u64, 20_000] {
        let t = budget::tick();
        now.set(now.get() + ms * 1_000_000);
        budget::record_fetch("https://x.example/a", budget::tick() - t, true);
    }
    // 40 s spent of 45 s -> 5 s left
    assert_eq!(budget::fetch_timeout_ms(), Ok(5_000));
    let t = budget::tick();
    now.set(now.get() + 5_000_000_000);
    budget::record_fetch("https://x.example/b", budget::tick() - t, false);
    assert!(budget::fetch_timeout_ms().is_err(), "budget exhausted -> no further fetch");
}

#[test]
fn uninstalled_budget_never_limits_fetches() {
    budget::clear();
    assert_eq!(budget::fetch_timeout_ms(), Ok(15_000));
}

#[test]
fn healthy_sources_are_unaffected_and_timed() {
    let _g = Guard;
    let (out, notes, _now, f) = run(vec![]);
    assert_eq!(f.served.borrow().len(), 3, "all three venues fetched once: {:?}", f.served.borrow());
    assert_ne!(out, "YES");
    let log = budget::fetch_log();
    assert_eq!(log.len(), 3, "per-fetch timing recorded: {:?} {:?}", log, notes);
    assert!(log.iter().any(|l| l.contains("coinbase") && l.contains("ok")), "{:?}", log);
}

#[test]
fn budget_constants_are_documented_values() {
    assert_eq!(budget::FETCH_BUDGET_NS, 45_000_000_000);
    assert_eq!(budget::FETCH_REQUEST_TIMEOUT_MS, 15_000);
    assert!(budget::FETCH_BUDGET_NS < budget::TOTAL_BUDGET_NS);
}
