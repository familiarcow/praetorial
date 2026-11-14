//! Item JM1 (D-JUDGE6): judge models are pinned by the resolver in real-http builds; the term sheet / job
//! `models` field is ignored (noted), two-model agreement always runs, and the ambiguity inputs never come from
//! term-sheet elements. Non-real-http behaviour is unchanged.
use super::item16e2_tests::Sim;
use super::item16e_tests::*;
use super::*;
use std::cell::RefCell;

const NOTE: &str = "D-JUDGE6: term-sheet models ignored";
const YES: &str = r#"{"answer":"insufficient","reason":"x"}"#;

fn pinned() -> Vec<String> {
    vec![PRIMARY_JUDGE_MODEL.to_string(), SECOND_JUDGE_MODEL.to_string()]
}

/// Records models called; answers per-model (`primary_ans` for PRIMARY, `second_ans` otherwise).
struct PerModel(RefCell<Vec<String>>, String, String);
impl PerModel {
    fn new(primary_ans: &str, second_ans: &str) -> Self { PerModel(RefCell::new(vec![]), primary_ans.into(), second_ans.into()) }
    fn models(&self) -> Vec<String> { self.0.borrow().clone() }
}
impl ModelCaller for PerModel {
    fn call(&self, model: &str, _m: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        self.0.borrow_mut().push(model.to_string());
        (if model == PRIMARY_JUDGE_MODEL { self.1.clone() } else { self.2.clone() }, None, None)
    }
}

fn term_with(models: Option<Value>) -> Value {
    let mut t = json!({
        "claim": "x", "rule": "ALL",
        "elements": [{"id": "e1", "q": "did it happen?"}],
        "clauses": ["AVAILABLE_V1"], "sources": true,
        "custom_definitions": ["fallback: no fallback source applies to this test. early: early resolution not applicable to this test."],
        "time": {"window_start": "2027-01-01T00:00:00Z", "window_end": "2027-12-31T23:59:59Z", "evidence_cutoff": "2028-01-01T00:00:00Z"},
        "sources_allowed": [{"id": "S1", "publisher": "A"}, {"id": "S2", "publisher": "B"}],
    });
    if let Some(m) = models { t["models"] = m; }
    t
}

// (a) pure selection: every shape of term-sheet / job models is ignored in real-http
#[test]
fn jm1_select_real_http_ignores_term_models() {
    for m in [json!(["X"]), json!(["A", "B"]), json!(["mock"]), json!(["does-not-exist"]), json!(["a", "b", "c"])] {
        let r = select_models(&json!({"models": m}), true);
        assert_eq!(r.clone().unwrap(), pinned(), "models {} -> {:?}", m, r);
    }
}
#[test]
fn jm1_select_job_real_http_ignores_job_and_term_models() {
    for jm in [None, Some(json!(["X"])), Some(json!(["A", "B"])), Some(json!(["mock"])), Some(json!(["does-not-exist"]))] {
        for tm in [None, Some(json!(["X"])), Some(json!(["mock"])), Some(json!(["A", "B"]))] {
            let mut job = json!({});
            if let Some(m) = &jm { job["models"] = m.clone(); }
            let mut term = json!({});
            if let Some(m) = &tm { term["models"] = m.clone(); }
            assert_eq!(select_models_job(&job, &term, true).unwrap(), pinned(), "job {:?} term {:?}", jm, tm);
        }
    }
}
#[test]
fn jm1_select_non_real_http_unchanged() {
    assert_eq!(select_models(&json!({}), false).unwrap(), vec!["mock".to_string()]);
    assert_eq!(select_models(&json!({"models": ["X", "Y"]}), false).unwrap(), vec!["X".to_string(), "Y".to_string()]);
    assert_eq!(select_models_job(&json!({"models": ["J"]}), &json!({"models": ["T"]}), false).unwrap(), vec!["J".to_string()]);
}

// (a) the note shows up in the run output on every real-http path
#[test]
fn jm1_direct_real_http_notes_ignored_models_and_calls_only_pinned() {
    let mut job = json!({"bet_id": "t-jm1", "term": term_with(Some(json!(["X"]))), "sources": [{"id": "S1", "published": "2027-06-01T00:00:00Z", "text": "something ambiguous"}], "runs": 1});
    job["models"] = json!(["A", "B"]);
    let c = PerModel::new(YES, YES);
    let out = resolve_direct_with(&job, &c, &NullFetcher, true);
    assert!(!c.models().is_empty() && c.models().iter().all(|m| *m == PRIMARY_JUDGE_MODEL || *m == SECOND_JUDGE_MODEL), "{:?}", c.models());
    assert!(out.to_string().contains(NOTE), "{}", out);
    assert_eq!(out["judge"]["models_requested"], json!(pinned()), "{}", out);
}
#[test]
fn jm1_direct_real_http_no_models_has_no_note() {
    let job = json!({"bet_id": "t-jm1", "term": term_with(None), "sources": [{"id": "S1", "published": "2027-06-01T00:00:00Z", "text": "something ambiguous"}], "runs": 1});
    let out = resolve_direct_with(&job, &PerModel::new(YES, YES), &NullFetcher, true);
    assert!(!out.to_string().contains(NOTE), "{}", out);
}
#[test]
fn jm1_evidence_real_http_notes_ignored_models() {
    let mut term = term_with(Some(json!(["mock"])));
    term["source_classes"] = json!({"Reuters": "wire"});
    term["time"]["evidence_cutoff"] = json!("2028-01-07T00:00:00Z");
    let job = json!({"bet_id": "t-jm1-ev", "term": term, "window_close": "2028-01-10T00:00:00Z",
        "exhibits": [{"id": "Y1", "by": "yes", "publisher": "Reuters", "published": "2027-09-21T18:00:00Z", "text": "Customers lined up.", "onchain_submitted_at": "2028-01-08T00:00:00Z"}], "runs": 1});
    let c = PerModel::new(YES, YES);
    let out = resolve_evidence_with(&job, &c, &NullFetcher, true);
    assert!(!c.models().is_empty() && c.models().iter().all(|m| *m == PRIMARY_JUDGE_MODEL || *m == SECOND_JUDGE_MODEL), "{:?}", c.models());
    assert!(out.to_string().contains(NOTE), "{}", out);
}
fn window_job(models: Option<Value>) -> Value {
    let mut t: Value = serde_json::from_str(JASON_16C_TERMS).unwrap();
    if let Some(m) = models { t["models"] = m; }
    let terms = t.to_string();
    json!({"contract": "escrow.testnet", "bet_id": 2, "run_no": 2, "checked_until": 0, "round": 0,
           "envelope": {"terms_hash": praetorial_core::sha_hex(&terms)}, "terms": terms})
}
#[test]
fn jm1_window_real_http_notes_ignored_models_and_never_calls_named() {
    for m in [json!(["X"]), json!(["A", "B"]), json!(["mock"]), json!(["does-not-exist"])] {
        let c = PerModel::new(YES, YES);
        let (_r, n) = build_submission_with(&window_job(Some(m.clone())), &c, &Sim::jason(), true);
        assert!(n.iter().any(|x| x.contains(NOTE)), "{} {:?}", m, n);
        assert!(!c.models().is_empty() && c.models().iter().all(|x| *x == PRIMARY_JUDGE_MODEL || *x == SECOND_JUDGE_MODEL), "{} {:?}", m, c.models());
    }
}
#[test]
fn jm1_window_real_http_no_models_has_no_note() {
    let (_r, n) = build_submission_with(&window_job(None), &PerModel::new(YES, YES), &Sim::jason(), true);
    assert!(!n.iter().any(|x| x.contains(NOTE)), "{:?}", n);
}

// (b) a one-model sheet still runs two-model agreement: disagreement -> one re-run -> VOID
#[test]
fn jm1_window_real_http_one_model_sheet_still_two_model_agreement_void() {
    let yes = r#"{"answer":"yes","quote":"q","source_id":"S1","reason":"x"}"#;
    let no = r#"{"answer":"no","quote":"q","source_id":"S1","reason":"x"}"#;
    let c = PerModel::new(yes, no);
    let (r, n) = build_submission_with(&window_job(Some(json!(["only-one"]))), &c, &Sim::jason(), true);
    let ms = c.models();
    assert!(ms.iter().any(|m| m == PRIMARY_JUDGE_MODEL) && ms.iter().any(|m| m == SECOND_JUDGE_MODEL), "{:?}", ms);
    assert!(!ms.iter().any(|m| m == "only-one"), "{:?}", ms);
    let p = ms.iter().filter(|m| *m == PRIMARY_JUDGE_MODEL).count();
    let s = ms.iter().filter(|m| *m == SECOND_JUDGE_MODEL).count();
    assert_eq!(p, s, "each model called equally: {:?}", ms);
    assert!(p >= 2, "disagreement triggers one re-run of both: {:?}", ms);
    assert_eq!(r.outcome, "VOID", "{:?}", n);
}
#[test]
fn jm1_direct_real_http_one_model_sheet_disagreement_voids() {
    let yes = r#"{"answer":"yes","quote":"something ambiguous","source_id":"S1","reason":"x"}"#;
    let no = r#"{"answer":"no","quote":"something ambiguous","source_id":"S1","reason":"x"}"#;
    let job = json!({"bet_id": "t-jm1", "term": term_with(Some(json!(["only-one"]))), "sources": [{"id": "S1", "published": "2027-06-01T00:00:00Z", "text": "something ambiguous"}], "runs": 1});
    let c = PerModel::new(yes, no);
    let out = resolve_direct_with(&job, &c, &NullFetcher, true);
    let ms = c.models();
    assert!(ms.iter().any(|m| m == SECOND_JUDGE_MODEL) && !ms.iter().any(|m| m == "only-one"), "{:?}", ms);
    assert_eq!(out["outcome"], "VOID", "{}", out);
}
// (d) the ambiguity inputs never come from term-sheet elements in a real-http build (D-JUDGE6 (5)); the panel wiring
// that supplies them from the resolver's own calls waits for SRC-17d2e. Non-real-http keeps the 7r3 offline behaviour.
fn ambiguity_job(el_extra: Value) -> Value {
    let mut term = term_with(None);
    term["source_classes"] = json!({"Reuters": "wire"});
    term["time"]["evidence_cutoff"] = json!("2028-01-07T00:00:00Z");
    for (k, v) in el_extra.as_object().unwrap() { term["elements"][0][k.as_str()] = v.clone(); }
    json!({"bet_id": "t-jm1-amb", "term": term, "window_close": "2028-01-10T00:00:00Z", "maker_side": "YES", "round_no": 1,
        "exhibits": [{"id": "N1", "by": "no", "publisher": "Reuters", "published": "2027-12-01T15:00:00Z", "text": "Apple delayed the launch.", "onchain_submitted_at": "2028-01-04T00:00:00Z"}], "runs": 1})
}
#[test]
fn jm1_real_http_ignores_term_sheet_ambiguity_inputs() {
    for extra in [
        json!({"ambiguity_votes": [true, true, true]}),
        json!({"ambiguity_votes": [true, true, true], "is_library_clause": true}),
    ] {
        let with = resolve_evidence_with(&ambiguity_job(extra.clone()), &PerModel::new(YES, YES), &NullFetcher, true);
        let without = resolve_evidence_with(&ambiguity_job(json!({})), &PerModel::new(YES, YES), &NullFetcher, true);
        let why = with["why"].as_str().unwrap_or("");
        assert!(!why.contains("library clause") && !why.contains("contra proferentem"), "{} {}", extra, with);
        assert_eq!(with["outcome"], without["outcome"], "{} {}", extra, with);
        assert_eq!(with["why"], without["why"], "{} {}", extra, with);
    }
}
#[test]
fn jm1_non_real_http_ambiguity_override_unchanged() {
    let out = resolve_evidence_with(&ambiguity_job(json!({"ambiguity_votes": [true, true, true], "is_library_clause": true})), &PerModel::new(YES, YES), &NullFetcher, false);
    assert_eq!(out["outcome"].as_str(), Some("VOID"), "{}", out);
    assert!(out["why"].as_str().unwrap_or("").contains("library clause"), "{}", out);
}
