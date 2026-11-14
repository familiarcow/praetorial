//! LH2 (D-HORIZON2, D-JUDGETIME1, D-RESOLVE1, D-JUDGE4): both pinned judge models permanently NOT FOUND (HTTP 404 / alias gone)
//! -> signed VOID with note MODEL_UNAVAILABLE, but ONLY once the D-RESOLVE1 7-day window (from the chain-supplied
//! `first_unavailable_ns`, the escrow's own first-RETRY time) has elapsed; before that a signed RETRY. One model gone, the other
//! answering -> RETRY (never a one-model decision). A timeout / 5xx / capped call is NOT "not found". No YES/NO from code alone.
use super::*;
use serde_json::json;
use std::cell::RefCell;

const DAY: i64 = 86_400;
const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/wx1");
const LIST: &str = "https://api.weather.gov/products/types/CLI/locations/IAH";
const PROD: &str = "https://api.weather.gov/products/61a52f4b-bee7-4ed2-8ebd-99b9ea19ca75";
const IEM: &str = "https://mesonet.agron.iastate.edu/json/cli.py?station=KIAH&year=2026";

struct Fx;
impl HttpFetcher for Fx {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        let (f, ct) = match url {
            LIST => ("nws_cli_IAH_list_20261108.json", "application/ld+json"),
            PROD => ("nws_cli_KIAH_20261103_product.json", "application/ld+json"),
            IEM => ("iem_cli_KIAH_2026_trimmed.json", "application/json"),
            u => return Err(format!("no recorded fixture for URL {}", u)),
        };
        let body = std::fs::read(format!("{}/{}", DIR, f)).unwrap();
        Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: ct.into(), body, status_code: 200 })
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    NotFound,
    Timeout,
    Http5xx,
    Answers,
}
/// Per pinned model behaviour. Records every model asked.
struct Mock {
    primary: Mode,
    second: Mode,
    asked: RefCell<Vec<String>>,
}
impl Mock {
    fn new(primary: Mode, second: Mode) -> Mock {
        Mock { primary, second, asked: RefCell::new(vec![]) }
    }
}
impl ModelCaller for Mock {
    fn call(&self, m: &str, msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        let r = self.call_full(m, msgs);
        (r.content, r.chat_id, r.model_echoed)
    }
    fn call_full(&self, m: &str, msgs: &[(String, String)]) -> ModelReply {
        self.asked.borrow_mut().push(m.to_string());
        let mode = if m == PRIMARY_JUDGE_MODEL { self.primary } else { self.second };
        match mode {
            Mode::NotFound => ModelReply { http_status: Some(404), error_body_head: Some("{\"error\":\"model not found\"}".into()), ..Default::default() },
            Mode::Http5xx => ModelReply { http_status: Some(503), error_body_head: Some("upstream unavailable".into()), ..Default::default() },
            Mode::Timeout => ModelReply { transport_error: Some("timed out".into()), total_timeout_hit: Some(true), ..Default::default() },
            Mode::Answers => {
                let user = msgs.iter().map(|(_, c)| c.as_str()).collect::<Vec<_>>().join("\n");
                let content = if user.contains("<proposal>") { r#"{"audit":"agree"}"#.to_string() } else { r#"{"answer":"insufficient","reason":"mock"}"#.to_string() };
                ModelReply { content, ..Default::default() }
            }
        }
    }
}

fn custom_sheet() -> String {
    json!({
        "claim": "x", "rule": "ALL", "sources": true, "clauses": ["AVAILABLE_V1"],
        "custom_definitions": ["fallback: no fallback source applies to this test. early: early resolution not applicable to this test."],
        "time": {"window_start": "2027-01-01T00:00:00Z", "window_end": "2027-12-31T23:59:59Z", "evidence_cutoff": "2028-01-07T00:00:00Z"},
        "elements": [{"id": "e1", "q": "did it happen"}],
        "sources_allowed": [{"id": "S1", "publisher": "Pub A"}, {"id": "S2", "publisher": "Pub B"}],
    })
    .to_string()
}
fn typed_sheet() -> String {
    json!({"template": {"id": "nws_daily_high", "version": 1}, "fields": {"station": "KIAH", "date": "2026-11-03", "op": ">=", "x_f": 85}}).to_string()
}
fn now_for(raw: &str) -> i64 {
    // custom sheet is judged after its evidence window (2028-01-10); the typed NWS sheet on 2026-11-08
    if raw.contains("template") { praetorial_core::template::parse_iso("2026-11-08T12:00:00Z").unwrap() } else { 1831075200 }
}
fn job(raw: &str, first_ago_days: Option<i64>, retry_count: u64) -> Value {
    let mut j = json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 3, "checked_until": 0, "round": 0, "retry_count": retry_count,
        "envelope": {"terms_hash": praetorial_core::sha_hex(raw)}, "terms": raw});
    if let Some(d) = first_ago_days {
        j["first_unavailable_ns"] = json!(((now_for(raw) - d * DAY) as u64) * 1_000_000_000);
    }
    j
}
fn run(raw: &str, first_ago_days: Option<i64>, m: &Mock) -> (SubmittedResult, Vec<String>) {
    let (r, n, _) = build_submission_judged_at(&job(raw, first_ago_days, 2), m, &Fx, true, now_for(raw));
    (r, n)
}
fn has_note(n: &[String], s: &str) -> bool {
    n.iter().any(|x| x.contains(s))
}

// ---- (a) JC1s (D-JUDGECHAIN1 amends LH2): both gone, first failure >= 7 days ago -> NOT a VOID any more. A not-found answer is
// one observation; the model is retired only after 3 checks >= 24h apart (observations come from the envelope), and a retired
// pair is walked past (see item_jc1s_tests). With no prior observations this run is a RETRY (+24h) that records the observation.
#[test]
fn a_custom_both_models_gone_after_7_days_is_retry_not_void_under_the_judge_chain() {
    let (r, n) = run(&custom_sheet(), Some(8), &Mock::new(Mode::NotFound, Mode::NotFound));
    assert_eq!(r.outcome, "RETRY", "{:?}", n);
    assert!(has_note(&n, "D-JUDGECHAIN1"), "{:?}", n);
    assert!(r.next_check_ns.is_some());
}
#[test]
fn a_typed_both_models_gone_after_7_days_is_retry_not_void_under_the_judge_chain() {
    let (r, n) = run(&typed_sheet(), Some(8), &Mock::new(Mode::NotFound, Mode::NotFound));
    assert_eq!(r.outcome, "RETRY", "{:?}", n);
    assert!(has_note(&n, "D-JUDGECHAIN1"), "{:?}", n);
    assert!(r.next_check_ns.is_some());
}

// ---- (b) both gone, first failure 2 days ago -> RETRY; the very first failure (no history) -> RETRY, never VOID ----
#[test]
fn b_custom_both_models_gone_2_days_in_is_retry() {
    let (r, n) = run(&custom_sheet(), Some(2), &Mock::new(Mode::NotFound, Mode::NotFound));
    assert_eq!(r.outcome, "RETRY", "{:?}", n);
    assert!(r.next_check_ns.is_some());
}
#[test]
fn b_typed_both_models_gone_2_days_in_is_retry() {
    let (r, n) = run(&typed_sheet(), Some(2), &Mock::new(Mode::NotFound, Mode::NotFound));
    assert_eq!(r.outcome, "RETRY", "{:?}", n);
    assert!(r.next_check_ns.is_some());
}
#[test]
fn b_first_ever_failure_without_history_is_retry_not_void() {
    // the escrow starts the 7-day clock at the first signed RETRY, and a bare VOID with no history would settle at once
    for raw in [custom_sheet(), typed_sheet()] {
        let (r, n) = run(&raw, None, &Mock::new(Mode::NotFound, Mode::NotFound));
        assert_eq!(r.outcome, "RETRY", "{:?}", n);
        assert!(r.next_check_ns.is_some());
    }
}

// ---- (c) one model gone, the other answers -> RETRY (never a one-model decision), even past 7 days ----
#[test]
fn c_one_model_gone_other_answers_is_retry_custom_and_typed() {
    for raw in [custom_sheet(), typed_sheet()] {
        // The typed audit asks only the primary (17c5); a second model that is never called is not known to be gone, so for a
        // typed sheet the observable one-gone case is the primary. A custom sheet calls both, so both orders apply.
        let typed = raw.contains("template");
        for (p, s) in [(Mode::NotFound, Mode::Answers), (Mode::Answers, Mode::NotFound)] {
            if typed && p == Mode::Answers { continue; }
            for days in [Some(2), Some(9), None] {
                let (r, n) = run(&raw, days, &Mock::new(p, s));
                assert_eq!(r.outcome, "RETRY", "{:?} {:?}", days, n);
                assert!(r.next_check_ns.is_some());
                assert!(!has_note(&n, "MODEL_UNAVAILABLE"), "{:?}", n);
            }
        }
    }
}

// ---- (d) timeout / 5xx are NOT "not found" ----
#[test]
fn d_timeout_and_5xx_are_never_model_unavailable() {
    for raw in [custom_sheet(), typed_sheet()] {
        for bad in [Mode::Timeout, Mode::Http5xx] {
            for (p, s) in [(bad, bad), (bad, Mode::NotFound), (Mode::NotFound, bad)] {
                let (r, n) = run(&raw, Some(9), &Mock::new(p, s));
                assert!(!has_note(&n, "MODEL_UNAVAILABLE"), "{:?}", n);
                assert_ne!(r.outcome, "YES", "{:?}", n);
                assert_ne!(r.outcome, "NO", "{:?}", n);
            }
        }
    }
}
#[test]
fn d_only_a_404_style_reply_is_not_found() {
    assert!(!model_reply_not_found(&ModelReply { total_timeout_hit: Some(true), idle_timeout_hit: Some(true), ..Default::default() }));
    assert!(!model_reply_not_found(&ModelReply { http_status: Some(500), ..Default::default() }));
    assert!(!model_reply_not_found(&ModelReply { http_status: Some(503), ..Default::default() }));
    assert!(!model_reply_not_found(&ModelReply { http_status: Some(429), ..Default::default() }));
    assert!(!model_reply_not_found(&ModelReply::default()));
    assert!(model_reply_not_found(&ModelReply { http_status: Some(404), ..Default::default() }));
}

// ---- (e) the audit cannot run -> never YES/NO from the code result alone ----
#[test]
fn e_typed_code_yes_is_never_signed_when_the_audit_models_are_gone() {
    // KIAH 2026-11-03 high 88 >= 85 is a code YES; with both audit models gone nothing may sign YES or NO
    for days in [None, Some(2), Some(8)] {
        let (r, n) = run(&typed_sheet(), days, &Mock::new(Mode::NotFound, Mode::NotFound));
        assert!(r.outcome != "YES" && r.outcome != "NO", "{:?} {:?}", days, n);
    }
}
#[test]
fn e_typed_audit_probe_asks_both_pinned_models_before_calling_them_gone() {
    let m = Mock::new(Mode::NotFound, Mode::NotFound);
    let _ = run(&typed_sheet(), Some(8), &m);
    let asked = m.asked.borrow();
    assert!(asked.iter().any(|x| x == PRIMARY_JUDGE_MODEL) && asked.iter().any(|x| x == SECOND_JUDGE_MODEL), "{:?}", asked);
}

// ---- a healthy run is untouched ----
#[test]
fn typed_both_models_answer_still_signs_the_code_outcome() {
    let (r, n) = run(&typed_sheet(), Some(8), &Mock::new(Mode::Answers, Mode::Answers));
    assert_eq!(r.outcome, "YES", "{:?}", n);
}
