//! D-EXH1a: the production settle path (build_submission_judged_at) renders a code-derived as-of anchor into the
//! judge's per-bet USER content. Source = the request clock `now_unix` (never read from the job/terms); FIXED_SYSTEM untouched.
use super::*;
use serde_json::json;
use std::cell::RefCell;

const LINE: &str = "Resolution time: 2028-01-10T00:00:00Z; the bet window closed before this time.";

struct Spy(RefCell<Vec<Vec<(String, String)>>>);
impl ModelCaller for Spy {
    fn call(&self, model: &str, msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        self.0.borrow_mut().push(msgs.to_vec());
        (r#"{"answer":"insufficient","reason":"spy"}"#.to_string(), None, Some(model.to_string()))
    }
}

fn job(extra_term: Value, extra_job: Value) -> Value {
    let mut terms = json!({
        "claim": "x", "rule": "ALL", "sources": true, "clauses": ["AVAILABLE_V1"],
        "custom_definitions": ["fallback: no fallback source applies to this test. early: early resolution not applicable to this test."],
        "time": {"window_start": "2027-01-01T00:00:00Z", "window_end": "2027-12-31T23:59:59Z", "evidence_cutoff": "2028-01-07T00:00:00Z"},
        "elements": [{"id": "e1", "q": "did it happen"}],
        "sources_allowed": [{"id": "S1", "publisher": "Pub A"}, {"id": "S2", "publisher": "Pub B"}],
        "models": ["Qwen/Qwen3.8-27B"],
    });
    for (k, v) in extra_term.as_object().cloned().unwrap_or_default() { terms[k] = v; }
    let raw = terms.to_string();
    let mut j = json!({"contract": "escrow.testnet", "bet_id": 1, "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw, "round": 0, "run_no": 1});
    for (k, v) in extra_job.as_object().cloned().unwrap_or_default() { j[k] = v; }
    j
}

#[test]
fn anchor_is_in_user_content_from_the_request_clock_not_in_system() {
    let spy = Spy(RefCell::new(vec![]));
    let _ = build_submission_judged_at(&job(json!({}), json!({})), &spy, &NullFetcher, false, 1831075200);
    let calls = spy.0.borrow();
    assert!(!calls.is_empty());
    for m in calls.iter() {
        assert!(m[1].1.contains(LINE), "user content lacks the anchor: {}", m[1].1);
        assert!(!m[0].1.contains("Resolution time"));
        assert_eq!(m[0].1, praetorial_core::FIXED_SYSTEM);
    }
}

#[test]
fn caller_supplied_resolution_time_in_job_or_terms_is_ignored() {
    let spy = Spy(RefCell::new(vec![]));
    let j = job(json!({"resolution_time": "1999-01-01T00:00:00Z", "as_of": "1999-01-01T00:00:00Z"}),
                json!({"resolution_time": "1999-01-01T00:00:00Z", "now": 915148800, "as_of": "1999-01-01T00:00:00Z", "now_unix": 915148800}));
    let _ = build_submission_judged_at(&j, &spy, &NullFetcher, false, 1831075200);
    for m in spy.0.borrow().iter() {
        let rules = m[1].1.split("</rules>").next().unwrap();
        assert_eq!(rules.matches("Resolution time:").count(), 1, "{}", rules);
        assert!(rules.contains(LINE) && !rules.contains("1999"), "{}", rules);
    }
}
