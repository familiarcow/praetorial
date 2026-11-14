//! JC1s (D-JUDGECHAIN1, D-JUDGECHAIN1a, D-RESOLVE1): the resolver walks the judge chain. A model is retired only after 3
//! not-found observations >= 24h apart (observations come from the job envelope `model_missing`, absent = none, and the
//! resolver emits its own new ones); a single 404 is a RETRY, never a switch; when the first live pair decides, the signed
//! result carries its `judge_pair_index`; no live pair -> `RETRY:no_live_judge`; a provider 400 is an outage, not a retirement.
use super::*;
use serde_json::json;
use std::cell::RefCell;

const DAY: i64 = 86_400;
const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/wx1");
const LIST: &str = "https://api.weather.gov/products/types/CLI/locations/IAH";
const PROD: &str = "https://api.weather.gov/products/61a52f4b-bee7-4ed2-8ebd-99b9ea19ca75";
const IEM: &str = "https://mesonet.agron.iastate.edu/json/cli.py?station=KIAH&year=2026";
const P2A: &str = "meta-llama/Llama-JC-2a";
const P2B: &str = "qwen/Qwen-JC-2b";
const P3A: &str = "openai/gpt-jc-3a";
const P3B: &str = "mistralai/Mistral-JC-3b";

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

/// Models in `gone` answer 404; models in `bad_request` answer 400 "unsupported parameter"; everything else agrees.
struct Mock {
    gone: Vec<String>,
    bad_request: Vec<String>,
    asked: RefCell<Vec<String>>,
}
impl Mock {
    fn new(gone: &[&str]) -> Mock {
        Mock { gone: gone.iter().map(|s| s.to_string()).collect(), bad_request: vec![], asked: RefCell::new(vec![]) }
    }
    fn asked_model(&self, m: &str) -> bool {
        self.asked.borrow().iter().any(|x| x == m)
    }
}
impl ModelCaller for Mock {
    fn call(&self, m: &str, msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        let r = self.call_full(m, msgs);
        (r.content, r.chat_id, r.model_echoed)
    }
    fn call_full(&self, m: &str, _msgs: &[(String, String)]) -> ModelReply {
        self.asked.borrow_mut().push(m.to_string());
        if self.gone.iter().any(|g| g == m) {
            return ModelReply { http_status: Some(404), error_body_head: Some("{\"error\":\"model not found\"}".into()), ..Default::default() };
        }
        if self.bad_request.iter().any(|g| g == m) {
            return ModelReply { http_status: Some(400), error_body_head: Some("{\"error\":\"unsupported parameter: response_format\"}".into()), ..Default::default() };
        }
        ModelReply { content: r#"{"audit":"agree"}"#.to_string(), ..Default::default() }
    }
}

fn typed_sheet() -> String {
    json!({"template": {"id": "nws_daily_high", "version": 1}, "fields": {"station": "KIAH", "date": "2026-11-03", "op": ">=", "x_f": 85}}).to_string()
}
fn now_unix() -> i64 {
    praetorial_core::template::parse_iso("2026-11-08T12:00:00Z").unwrap()
}
fn now_ns() -> u64 {
    now_unix() as u64 * 1_000_000_000
}
fn chain() -> Value {
    json!([
        {"model_a": PRIMARY_JUDGE_MODEL, "model_b": SECOND_JUDGE_MODEL},
        {"model_a": P2A, "model_b": P2B},
        {"model_a": P3A, "model_b": P3B},
    ])
}
fn job(missing: Value) -> Value {
    let raw = typed_sheet();
    let mut j = json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 3, "checked_until": 0, "round": 0, "retry_count": 0,
        "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw, "judge_chain": chain()});
    if !missing.is_null() {
        j["model_missing"] = missing;
    }
    j
}
fn ago(days: i64) -> u64 {
    ((now_unix() - days * DAY) as u64) * 1_000_000_000
}
fn run(j: &Value, m: &Mock) -> (SubmittedResult, Vec<String>, Value) {
    build_submission_judged_at(j, m, &Fx, true, now_unix())
}

#[test]
fn a_single_404_on_the_primary_pair_is_retry_not_a_switch() {
    let m = Mock::new(&[PRIMARY_JUDGE_MODEL, SECOND_JUDGE_MODEL]);
    let (r, n, j) = run(&job(Value::Null), &m);
    assert_eq!(r.outcome, "RETRY", "{:?}", n);
    assert_eq!(r.judge_pair_index, 0);
    assert!(!m.asked_model(P2A) && !m.asked_model(P2B), "one 404 must not move to pair 2: {:?}", m.asked.borrow());
    let obs = j["model_not_found_observations"].as_array().expect("observations exhibit");
    assert!(obs.iter().any(|o| o["model"] == PRIMARY_JUDGE_MODEL && o["observed_ns"] == json!(now_ns())), "{:?}", obs);
}

#[test]
fn primary_404_three_times_over_48h_hands_the_decision_to_pair_two_index_one() {
    // two prior observations 48h and 24h ago (from the envelope) + this run's 404 = 3 checks >= 24h apart
    let missing = json!({PRIMARY_JUDGE_MODEL: [ago(2), ago(1)]});
    let m = Mock::new(&[PRIMARY_JUDGE_MODEL, SECOND_JUDGE_MODEL]);
    let (r, n, j) = run(&job(missing), &m);
    assert_eq!(r.outcome, "YES", "{:?}", n);
    assert_eq!(r.judge_pair_index, 1, "pair 2 decided");
    assert!(m.asked_model(P2A), "{:?}", m.asked.borrow());
    assert_eq!(j["judge_pair_index"], json!(1));
    let obs = j["model_not_found_observations"].as_array().unwrap();
    assert!(obs.iter().any(|o| o["model"] == PRIMARY_JUDGE_MODEL), "the 3rd observation is recorded for the verifier: {:?}", obs);
}

#[test]
fn already_retired_primary_is_skipped_without_calling_it() {
    let missing = json!({PRIMARY_JUDGE_MODEL: [ago(3), ago(2), ago(1)]});
    let m = Mock::new(&[]);
    let (r, n, _) = run(&job(missing), &m);
    assert_eq!(r.outcome, "YES", "{:?}", n);
    assert_eq!(r.judge_pair_index, 1);
    assert!(!m.asked_model(PRIMARY_JUDGE_MODEL) && !m.asked_model(SECOND_JUDGE_MODEL), "{:?}", m.asked.borrow());
}

#[test]
fn a_live_earlier_pair_always_wins() {
    // pair 3 models are retired but pair 1 is healthy -> pair 1 decides
    let missing = json!({P3A: [ago(3), ago(2), ago(1)]});
    let m = Mock::new(&[]);
    let (r, _n, _) = run(&job(missing), &m);
    assert_eq!(r.outcome, "YES");
    assert_eq!(r.judge_pair_index, 0);
}

#[test]
fn whole_chain_retired_is_retry_no_live_judge_within_24h_never_void() {
    let dead = json!([ago(3), ago(2), ago(1)]);
    let missing = json!({PRIMARY_JUDGE_MODEL: dead, P2A: dead, P3B: dead});
    let m = Mock::new(&[]);
    let (r, n, j) = run(&job(missing), &m);
    assert_eq!(r.outcome, NO_LIVE_JUDGE_OUTCOME, "{:?}", n);
    assert_eq!(NO_LIVE_JUDGE_OUTCOME, "RETRY:no_live_judge");
    assert_eq!(r.next_check_ns, Some(now_ns() + 24 * 3600 * 1_000_000_000), "next check <= 24h");
    assert!(m.asked.borrow().is_empty(), "no model is called when none is live");
    assert!(!r.outcome.starts_with("VOID"));
    assert_eq!(j["no_live_judge"], json!(true));
}

#[test]
fn becoming_retired_on_the_last_pair_during_the_run_is_no_live_judge() {
    let dead = json!([ago(3), ago(2), ago(1)]);
    let missing = json!({PRIMARY_JUDGE_MODEL: dead, P2A: dead, P3A: [ago(2), ago(1)]});
    let m = Mock::new(&[P3A, P3B]);
    let (r, n, _) = run(&job(missing), &m);
    assert_eq!(r.outcome, NO_LIVE_JUDGE_OUTCOME, "{:?}", n);
}

#[test]
fn every_pair_404_once_is_a_plain_retry_with_observations() {
    let m = Mock::new(&[PRIMARY_JUDGE_MODEL, SECOND_JUDGE_MODEL, P2A, P2B, P3A, P3B]);
    let (r, _n, j) = run(&job(Value::Null), &m);
    assert_eq!(r.outcome, "RETRY");
    assert_eq!(r.judge_pair_index, 0);
    assert!(j["model_not_found_observations"].as_array().unwrap().len() >= 1);
}

#[test]
fn a_provider_400_unsupported_parameter_is_an_outage_not_a_retirement() {
    let mut m = Mock::new(&[]);
    m.bad_request = vec![PRIMARY_JUDGE_MODEL.to_string(), SECOND_JUDGE_MODEL.to_string()];
    let missing = json!({PRIMARY_JUDGE_MODEL: [ago(2), ago(1)]});
    let (r, _n, j) = run(&job(missing), &m);
    assert!(r.outcome != "YES" && r.outcome != "NO", "no decision from a 400");
    assert_eq!(r.judge_pair_index, 0, "a 400 never advances the chain");
    assert!(!m.asked_model(P2A), "{:?}", m.asked.borrow());
    let obs = j["model_not_found_observations"].as_array().map(|a| a.len()).unwrap_or(0);
    assert_eq!(obs, 0, "400 is not a not-found observation");
}

#[test]
fn a_chain_without_judge_chain_or_model_missing_behaves_as_the_single_primary_pair() {
    let raw = typed_sheet();
    let j = json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 3, "checked_until": 0, "round": 0, "retry_count": 0,
        "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw});
    let m = Mock::new(&[]);
    let (r, _n, _) = run(&j, &m);
    assert_eq!(r.outcome, "YES");
    assert_eq!(r.judge_pair_index, 0);
}

#[test]
fn appended_pair_uses_the_same_fixed_call_settings() {
    let msgs = vec![("user".to_string(), "x".to_string())];
    let strip = |mut v: Value| {
        v["model"] = Value::Null;
        v
    };
    assert_eq!(strip(chat_body(PRIMARY_JUDGE_MODEL, &msgs)), strip(chat_body(P2A, &msgs)));
}

fn sample(idx: u32, outcome: &str) -> SubmittedResult {
    SubmittedResult {
        bet_id: 5,
        terms_hash: "t".repeat(64),
        outcome: outcome.to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 2,
        checked_until: 77,
        next_check_ns: if outcome.starts_with("RETRY") { Some(99) } else { None },
        judge_pair_index: idx, model_not_found: vec![],
    }
}

#[test]
fn signed_buffer_binds_judge_pair_index_right_after_checked_until() {
    let b0 = submitted_result_borsh_buf("escrow.testnet", &sample(0, "YES"));
    let b1 = submitted_result_borsh_buf("escrow.testnet", &sample(1, "YES"));
    assert_ne!(b0, b1, "index is signed");
    assert_eq!(b1.len(), b0.len());
    let tail = &b1[b1.len() - 12..];
    assert_eq!(&tail[..8], &77u64.to_le_bytes());
    assert_eq!(&tail[8..], &1u32.to_le_bytes());
}

#[test]
fn signed_buffer_for_both_retry_forms_carries_index_then_next_check() {
    for o in ["RETRY", "RETRY:no_live_judge"] {
        let b = submitted_result_borsh_buf("escrow.testnet", &sample(2, o));
        let tail = &b[b.len() - 20..];
        assert_eq!(&tail[..8], &77u64.to_le_bytes(), "{o}");
        assert_eq!(&tail[8..12], &2u32.to_le_bytes(), "{o}");
        assert_eq!(&tail[12..], &99u64.to_le_bytes(), "{o}");
    }
}

#[test]
fn jc1x_the_404_observation_is_in_the_signed_result_and_matches_the_exhibit() {
    let m = Mock::new(&[PRIMARY_JUDGE_MODEL, SECOND_JUDGE_MODEL]);
    let (r, _n, j) = run(&job(Value::Null), &m);
    assert_eq!(r.outcome, "RETRY");
    assert!(r.model_not_found.contains(&(PRIMARY_JUDGE_MODEL.to_string(), now_ns())), "{:?}", r.model_not_found);
    let exhibit = j["model_not_found_observations"].as_array().unwrap();
    assert_eq!(exhibit.len(), r.model_not_found.len());
}

#[test]
fn jc1y_signed_model_not_found_equals_the_exhibit_observations_for_a_404_run() {
    let m = Mock::new(&[PRIMARY_JUDGE_MODEL, SECOND_JUDGE_MODEL]);
    let (r, _n, j) = run(&job(Value::Null), &m);
    assert_eq!(r.outcome, "RETRY");
    let mut signed: Vec<(String, u64)> = r.model_not_found.clone();
    let mut exhibit: Vec<(String, u64)> = j["model_not_found_observations"]
        .as_array()
        .expect("exhibit observations")
        .iter()
        .map(|o| (o["model"].as_str().unwrap().to_string(), o["observed_ns"].as_u64().unwrap()))
        .collect();
    assert!(!signed.is_empty(), "a 404 run must sign at least one observation");
    signed.sort();
    exhibit.sort();
    assert_eq!(signed, exhibit, "signed observations must equal the exhibit's, element for element");
    assert!(signed.contains(&(PRIMARY_JUDGE_MODEL.to_string(), now_ns())));
}
