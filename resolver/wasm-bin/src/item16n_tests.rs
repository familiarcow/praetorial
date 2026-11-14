//! Item 16n (D-JUDGE1): judge model default + judge block in the output.
use super::item16e2_tests::Sim;
use super::item16e_tests::*;
use super::*;
use std::cell::RefCell;

const VALID: &str = r#"{"answer":"insufficient","reason":"x"}"#;

/// Counts calls and records the model id of each; answers `.1`.
struct Counting(RefCell<Vec<String>>, String);
impl Counting {
    fn new(answer: &str) -> Self { Counting(RefCell::new(vec![]), answer.to_string()) }
    fn models(&self) -> Vec<String> { self.0.borrow().clone() }
}
impl ModelCaller for Counting {
    fn call(&self, model: &str, _m: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        self.0.borrow_mut().push(model.to_string());
        (self.1.clone(), None, None)
    }
}

fn direct_job(models: Option<Value>) -> Value {
    let mut term = json!({
        "claim": "x", "rule": "ALL",
        "elements": [{"id": "e1", "q": "did it happen?"}],
        "clauses": ["AVAILABLE_V1"], "sources": true,
        "custom_definitions": ["fallback: no fallback source applies to this test. early: early resolution not applicable to this test."],
        "time": {"window_start": "2027-01-01T00:00:00Z", "window_end": "2027-12-31T23:59:59Z", "evidence_cutoff": "2028-01-01T00:00:00Z"},
        "sources_allowed": [{"id": "S1", "publisher": "A"}, {"id": "S2", "publisher": "B"}],
    });
    if let Some(m) = models { term["models"] = m; }
    json!({"bet_id": "t-16n", "term": term,
           "sources": [{"id": "S1", "published": "2027-06-01T00:00:00Z", "text": "something ambiguous"}], "runs": 1})
}
fn evidence_job(models: Option<Value>) -> Value {
    let mut term = json!({
        "claim": "x", "rule": "ALL",
        "elements": [{"id": "e1", "q": "did it happen?"}],
        "clauses": ["AVAILABLE_V1"], "sources": true,
        "time": {"window_start": "2027-01-01T00:00:00Z", "window_end": "2027-12-31T23:59:59Z", "evidence_cutoff": "2028-01-07T00:00:00Z"},
        "source_classes": {"Reuters": "wire"},
    });
    if let Some(m) = models { term["models"] = m; }
    json!({"bet_id": "t-16n-ev", "term": term, "window_close": "2028-01-10T00:00:00Z",
           "exhibits": [{"id": "Y1", "by": "yes", "publisher": "Reuters", "published": "2027-09-21T18:00:00Z",
                         "text": "Customers lined up.", "onchain_submitted_at": "2028-01-08T00:00:00Z"}],
           "runs": 1})
}
fn window_job(models: Option<Value>) -> Value {
    let mut t: Value = serde_json::from_str(JASON_16C_TERMS).unwrap();
    assert!(t.get("models").is_none(), "the Jason demo sheet has no models[]");
    if let Some(m) = models { t["models"] = m; }
    let terms = t.to_string();
    json!({"contract": "escrow.testnet", "bet_id": 2, "run_no": 2, "checked_until": 0, "round": 0,
           "envelope": {"terms_hash": praetorial_core::sha_hex(&terms)}, "terms": terms})
}
fn qwen() -> Vec<String> { vec!["Qwen/Qwen3.8-27B".to_string()] }

// ---- pure selection
#[test]
fn d_judge1_default_model_const_is_the_c13_tier1_model() {
    assert_eq!(DEFAULT_JUDGE_MODEL, "Qwen/Qwen3.8-27B");
}
#[test]
fn d_judge1_select_real_http_absent_or_empty_gives_default() {
    // D-JUDGE4a: was `== qwen()` (single default), now [PRIMARY, SECOND] because D-JUDGE4 (two-model agreement)
    let two = vec![PRIMARY_JUDGE_MODEL.to_string(), SECOND_JUDGE_MODEL.to_string()];
    assert_eq!(select_models(&json!({}), true).unwrap(), two);
    assert_eq!(select_models(&json!({"models": []}), true).unwrap(), two);
}
#[test]
fn d_judge1_select_real_http_explicit_models_kept() {
    // D-JUDGE6: was `["a/b"]` kept; now a named model is ignored and the pinned pair returned (real-http only)
    assert_eq!(select_models(&json!({"models": ["a/b"]}), true).unwrap(), vec![PRIMARY_JUDGE_MODEL.to_string(), SECOND_JUDGE_MODEL.to_string()]);
}
#[test]
fn d_judge1_select_real_http_mock_is_refused_with_note() {
    // D-JUDGE6: was Err(refused note); now "mock" is ignored like any other id and the pinned pair is returned
    let two = vec![PRIMARY_JUDGE_MODEL.to_string(), SECOND_JUDGE_MODEL.to_string()];
    assert_eq!(select_models(&json!({"models": ["mock"]}), true).unwrap(), two);
    assert_eq!(select_models(&json!({"models": ["Qwen/Qwen3.8-27B", "mock"]}), true).unwrap(), two);
}
#[test]
fn d_judge1_select_non_real_http_absent_stays_mock() {
    assert_eq!(select_models(&json!({}), false).unwrap(), vec!["mock".to_string()]);
    assert_eq!(select_models(&json!({"models": ["mock"]}), false).unwrap(), vec!["mock".to_string()]);
}

// ---- three call paths, real-http default
#[test]
fn d_judge1_window_path_real_http_without_models_calls_qwen() {
    let c = Counting::new(VALID);
    let _ = build_submission_with(&window_job(None), &c, &Sim::jason(), true);
    assert!(!c.models().is_empty(), "judge must be reached");
    // D-JUDGE4a: was `all models == Qwen/Qwen3.8-27B`, now `only PRIMARY_JUDGE_MODEL / SECOND_JUDGE_MODEL` because D-JUDGE4 (two-model agreement: primary DeepSeek + second GLM, no single default judge)
    assert!(c.models().iter().all(|m| m == PRIMARY_JUDGE_MODEL || m == SECOND_JUDGE_MODEL), "{:?}", c.models());
    assert!(c.models().iter().any(|m| m == PRIMARY_JUDGE_MODEL) && c.models().iter().any(|m| m == SECOND_JUDGE_MODEL), "{:?}", c.models());
}
#[test]
fn d_judge1_direct_path_real_http_without_models_calls_qwen() {
    let c = Counting::new(VALID);
    let _ = resolve_direct_with(&direct_job(None), &c, &NullFetcher, true);
    assert!(!c.models().is_empty(), "judge must be reached");
    // D-JUDGE4a: was `all models == Qwen/Qwen3.8-27B`, now `only PRIMARY_JUDGE_MODEL / SECOND_JUDGE_MODEL` because D-JUDGE4 (two-model agreement: primary DeepSeek + second GLM, no single default judge)
    assert!(c.models().iter().all(|m| m == PRIMARY_JUDGE_MODEL || m == SECOND_JUDGE_MODEL), "{:?}", c.models());
    assert!(c.models().iter().any(|m| m == PRIMARY_JUDGE_MODEL) && c.models().iter().any(|m| m == SECOND_JUDGE_MODEL), "{:?}", c.models());
}
#[test]
fn d_judge1_evidence_path_real_http_without_models_calls_qwen() {
    let c = Counting::new(VALID);
    let out = resolve_evidence_with(&evidence_job(None), &c, &NullFetcher, true);
    assert!(!c.models().is_empty(), "judge must be reached: {}", out);
    // D-JUDGE4a: was `all models == Qwen/Qwen3.8-27B`, now `only PRIMARY_JUDGE_MODEL / SECOND_JUDGE_MODEL` because D-JUDGE4 (two-model agreement: primary DeepSeek + second GLM, no single default judge)
    assert!(c.models().iter().all(|m| m == PRIMARY_JUDGE_MODEL || m == SECOND_JUDGE_MODEL), "{:?}", c.models());
    assert!(c.models().iter().any(|m| m == PRIMARY_JUDGE_MODEL) && c.models().iter().any(|m| m == SECOND_JUDGE_MODEL), "{:?}", c.models());
}

// ---- explicit mock refused: VOID, zero calls, note
#[test]
fn d_judge1_window_path_real_http_explicit_mock_is_void_with_zero_calls() {
    let c = Counting::new(VALID);
    let (r, n) = build_submission_with(&window_job(Some(json!(["mock"]))), &c, &Sim::jason(), true);
    // D-JUDGE6: was VOID + zero calls + D-JUDGE1 note; now "mock" is ignored: only the pinned judges are called, with the D-JUDGE6 note
    assert!(!c.models().is_empty() && c.models().iter().all(|m| m == PRIMARY_JUDGE_MODEL || m == SECOND_JUDGE_MODEL), "{:?}", c.models());
    assert!(!c.models().iter().any(|m| m == "mock"), "{:?}", c.models());
    assert!(n.iter().any(|x| x.contains("D-JUDGE6: term-sheet models ignored")), "{:?}", n);
    let _ = r;
}
#[test]
fn d_judge1_direct_path_real_http_explicit_mock_is_void_with_zero_calls() {
    let c = Counting::new(VALID);
    let out = resolve_direct_with(&direct_job(Some(json!(["mock"]))), &c, &NullFetcher, true);
    // D-JUDGE6: was VOID + zero calls + D-JUDGE1 note + judge_ran=false; now the pinned judges run and the D-JUDGE6 note is recorded
    assert!(!c.models().is_empty() && c.models().iter().all(|m| m == PRIMARY_JUDGE_MODEL || m == SECOND_JUDGE_MODEL), "{:?}", c.models());
    assert!(out.to_string().contains("D-JUDGE6: term-sheet models ignored"), "{}", out);
    assert_eq!(out["judge"]["judge_ran"], json!(true), "{}", out);
}
#[test]
fn d_judge1_direct_path_real_http_job_models_mock_is_void() {
    let mut job = direct_job(None);
    job["models"] = json!(["mock"]);
    let c = Counting::new(VALID);
    let out = resolve_direct_with(&job, &c, &NullFetcher, true);
    // D-JUDGE6: was VOID + zero calls; now job-level "mock" is ignored and the pinned judges run
    assert!(!c.models().is_empty() && c.models().iter().all(|m| m == PRIMARY_JUDGE_MODEL || m == SECOND_JUDGE_MODEL), "{:?}", c.models());
    assert!(out.to_string().contains("D-JUDGE6: term-sheet models ignored"), "{}", out);
}
#[test]
fn d_judge1_evidence_path_real_http_explicit_mock_is_void_with_zero_calls() {
    let c = Counting::new(VALID);
    let out = resolve_evidence_with(&evidence_job(Some(json!(["mock"]))), &c, &NullFetcher, true);
    // D-JUDGE6: was VOID + zero calls + D-JUDGE1 note; now "mock" is ignored and the pinned judges run
    assert!(!c.models().is_empty() && c.models().iter().all(|m| m == PRIMARY_JUDGE_MODEL || m == SECOND_JUDGE_MODEL), "{:?}", c.models());
    assert!(out.to_string().contains("D-JUDGE6: term-sheet models ignored"), "{}", out);
}

// ---- non-real-http unchanged
#[test]
fn d_judge1_non_real_http_paths_without_models_still_call_mock() {
    let c = Counting::new(VALID);
    let _ = resolve_direct_with(&direct_job(None), &c, &NullFetcher, false);
    assert!(!c.models().is_empty() && c.models().iter().all(|m| m == "mock"), "{:?}", c.models());
    let c = Counting::new(VALID);
    let _ = build_submission_with(&window_job(None), &c, &Sim::jason(), false);
    assert!(!c.models().is_empty() && c.models().iter().all(|m| m == "mock"), "{:?}", c.models());
    let c = Counting::new(VALID);
    let _ = resolve_evidence_with(&evidence_job(None), &c, &NullFetcher, false);
    assert!(!c.models().is_empty() && c.models().iter().all(|m| m == "mock"), "{:?}", c.models());
}

// ---- judge block
// RHTTP1: the mode is explicit (`envelope_output` reads the compile-time REAL_HTTP, so under `--features real-http` these
// tests silently switched to the production path and failed on their offline expectations). Each test checks both modes.
fn envelope_judge_mode(c: &dyn ModelCaller, real_http: bool) -> Value {
    let now = (SystemClock.now_ns() / 1_000_000_000) as i64;
    envelope_output_at_with(&window_job(Some(json!(["Qwen/Qwen3.8-27B"]))), c, &Sim::jason(), &NoKeys, now, real_http)
}
/// What `models_requested` must say per mode: offline honours the term-named model; real-http pins the judges (D-JUDGE6).
fn expected_models(real_http: bool) -> Value {
    if real_http { json!([PRIMARY_JUDGE_MODEL, SECOND_JUDGE_MODEL]) } else { json!(["Qwen/Qwen3.8-27B"]) }
}
#[test]
fn d_judge1_output_judge_ran_true_on_valid_verdict() {
    for real_http in [false, true] {
        let out = envelope_judge_mode(&Counting::new(VALID), real_http);
        assert_eq!(out["judge"]["judge_ran"], json!(true), "real_http={} {}", real_http, out);
        assert_eq!(out["judge"]["models_requested"], expected_models(real_http), "real_http={}", real_http);
        assert_eq!(out["judge"]["runs"], json!(1));
        assert!(out["judge"]["models_echoed"].is_array());
        assert!(out["judge"]["elements"].is_array() && !out["judge"]["elements"].as_array().unwrap().is_empty(), "{}", out);
        assert!(out["result"]["outcome"].is_string() && out["notes"].is_array(), "existing fields kept");
    }
}
#[test]
fn d_judge1_output_judge_ran_false_on_empty_completion() {
    for real_http in [false, true] {
        let out = envelope_judge_mode(&Counting::new(""), real_http);
        assert_eq!(out["judge"]["judge_ran"], json!(false), "real_http={} {}", real_http, out);
        assert_eq!(out["judge"]["models_requested"], expected_models(real_http), "real_http={}", real_http);
    }
}
#[test]
fn d_judge1_output_judge_ran_false_on_invalid_completion() {
    for real_http in [false, true] {
        let out = envelope_judge_mode(&Counting::new("I think the answer is yes"), real_http);
        assert_eq!(out["judge"]["judge_ran"], json!(false), "real_http={} {}", real_http, out);
    }
}
#[test]
fn d_judge1_output_judge_ran_false_on_pre_model_void() {
    let mut job = window_job(None);
    job["terms_hash_bad"] = json!(1);
    job["envelope"]["terms_hash"] = json!("00beef");
    let out = envelope_output(&job, &Counting::new(VALID), &Sim::jason(), &NoKeys);
    assert_eq!(out["judge"]["judge_ran"], json!(false), "{}", out);
    assert!(out["judge"]["models_requested"].is_array());
}
#[test]
fn d_judge1_direct_result_carries_judge_block() {
    let out = resolve_direct_with(&direct_job(None), &Counting::new(VALID), &NullFetcher, false);
    assert_eq!(out["judge"]["judge_ran"], json!(true), "{}", out);
    assert_eq!(out["judge"]["models_requested"], json!(["mock"]));
    let out = resolve_direct_with(&direct_job(None), &Counting::new(""), &NullFetcher, false);
    assert_eq!(out["judge"]["judge_ran"], json!(false), "{}", out);
}
