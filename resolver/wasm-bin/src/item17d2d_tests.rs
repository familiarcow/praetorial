//! Item 17d2d attempt 2 (D-ORIGIN2, ruled by praetorial-bot under D-PM3): the trust boundary is the wasm entry.
//! The escrow never sends `sources` or `exhibits`; `sanitize_entry_job` drops them (with a named note) and keeps
//! the D-SNAP1 resolver_pubkey overwrite, so caller text can never act as evidence in production.
use super::*;
use serde_json::json;
use std::cell::RefCell;

const DROP_NOTE: &str = "D-ORIGIN2: caller-supplied sources dropped at entry; the resolver fetches allow-listed URLs itself";

fn escrow_job() -> Value {
    json!({"contract": "escrow.near", "bet_id": "17", "envelope": {"terms_hash": "ab".repeat(32), "n": [1, 2, {"k": "v"}]},
           "terms": "{\"claim\":\"x\"}", "round": 1, "run_no": 2, "payer_account_id": "payer.near"})
}
const ESCROW_KEYS: [&str; 7] = ["contract", "bet_id", "envelope", "terms", "round", "run_no", "payer_account_id"];

#[test]
fn e1_drops_sources_and_exhibits_and_notes_it() {
    let mut job = escrow_job();
    job["sources"] = json!([{"id": "S1", "publisher": "A", "text": "x"}]);
    job["exhibits"] = json!([{"id": "E1", "text": "y"}]);
    let (out, notes) = sanitize_entry_job(job, None);
    assert!(out.get("sources").is_none(), "{}", out);
    assert!(out.get("exhibits").is_none(), "{}", out);
    assert!(notes.iter().any(|n| n == DROP_NOTE), "{:?}", notes);
    assert!(notes.iter().any(|n| n.contains("D-ORIGIN2") && n.contains("exhibits")), "{:?}", notes);
}

#[test]
fn e2_no_note_when_nothing_to_drop() {
    let (_, notes) = sanitize_entry_job(escrow_job(), None);
    assert!(!notes.iter().any(|n| n.contains("D-ORIGIN2")), "{:?}", notes);
}

#[test]
fn e3_keeps_every_escrow_key_byte_identical() {
    let mut job = escrow_job();
    job["sources"] = json!([{"id": "S1"}]);
    let (out, _) = sanitize_entry_job(job, None);
    let orig = escrow_job();
    for k in ESCROW_KEYS {
        assert_eq!(serde_json::to_string(&out[k]).unwrap(), serde_json::to_string(&orig[k]).unwrap(), "key {}", k);
    }
}

#[test]
fn e4_still_overwrites_resolver_pubkey() {
    let mut job = escrow_job();
    job["resolver_pubkey"] = json!("ff".repeat(32));
    let (out, _) = sanitize_entry_job(job.clone(), Some([9u8; 32]));
    assert_eq!(out["resolver_pubkey"], json!(hex::encode([9u8; 32])));
    let (out2, _) = sanitize_entry_job(job, None);
    assert!(out2.get("resolver_pubkey").is_none(), "caller key must never survive: {}", out2);
}

const Q1: &str = "Owls 3, Hawks 1 - the Owls won the game.";
const Q2: &str = "Final score Owls 3 Hawks 1, Owls win.";
struct Judge(RefCell<Vec<String>>);
impl ModelCaller for Judge {
    fn call(&self, _m: &str, msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        self.0.borrow_mut().push(msgs.iter().map(|(_, c)| c.as_str()).collect::<Vec<_>>().join("\n"));
        (json!({"answer": "not_met", "quote": Q1, "source_id": "SX", "also": [{"source_id": "SY", "quote": Q2}], "reason": "scripted"}).to_string(), None, None)
    }
}
fn urlless_term() -> Value {
    json!({"claim": "The Hawks beat the Owls in the game played on 2026-11-01", "rule": "ALL",
        "elements": [{"id": "e1", "q": "Did the Hawks win the game against the Owls played on 2026-11-01 (final score)?"}],
        "clauses": ["UTC_V1", "BEFORE_INCLUSIVE_V1", "NO_DATA_FALLBACK_V1"],
        "time": {"window_start": "2026-11-01T00:00:00Z", "window_end": "2026-11-02T00:00:00Z", "evidence_cutoff": "2026-11-09T00:00:00Z"},
        "custom_definitions": [
            "Fallback: if one named source is unavailable (no admissible exhibit reaches the evidence cutoff), the remaining source must decide; if none can be checked the outcome is VOID with full refunds.",
            "Early YES resolution is allowed at the first final score, never before; if the Hawks did not win the game the outcome is NO.",
            "Only the final score on the named pages counts."],
        "sources_allowed": [{"id": "SX", "publisher": "Wire One"}, {"id": "SY", "publisher": "Wire Two"}],
        "source_classes": {"Wire One": "primary", "Wire Two": "primary"}, "window_close": "2026-11-09T00:00:00Z", "sources": true})
}

#[test]
fn e5_two_urlless_caller_sources_never_yield_decisive_verdict_after_entry() {
    let job = json!({"bet_id": "170", "term": urlless_term(), "runs": 1, "sources": [
        {"id": "SX", "publisher": "Wire One", "text": Q1, "published": "2026-11-01T23:00:00Z"},
        {"id": "SY", "publisher": "Wire Two", "text": Q2, "published": "2026-11-01T23:00:00Z"}]});
    let (job, _) = sanitize_entry_job(job, None);
    let j = Judge(RefCell::new(vec![]));
    let out = resolve_job(&job, &j, &NullFetcher);
    let o = out["outcome"].as_str().unwrap_or("");
    assert!(o != "YES" && o != "NO", "decisive verdict from caller text: {}", out);
    assert!(!j.0.borrow().iter().any(|p| p.contains(Q1) || p.contains(Q2)), "caller text reached the judge: {}", out);
}

#[test]
fn e6_main_calls_sanitize_entry_job_before_dispatch_and_resolve_job() {
    let src = include_str!("main.rs");
    let m = src.find("fn main()").expect("fn main present");
    let body = &src[m..];
    let s = body.find("sanitize_entry_job(").expect("main() must call sanitize_entry_job");
    let env = body.find("envelope_output(").expect("envelope path");
    let rj = body.find("resolve_job(&job").expect("resolve_job call");
    assert!(s < env, "sanitize must precede the envelope (production) path");
    assert!(s < rj, "sanitize must precede resolve_job");
}
