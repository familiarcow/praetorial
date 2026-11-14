//! Item 17d2c (D-SNAP1, ruled by praetorial-bot under D-PM3): direct WIRING tests. Unlike the 17d red_a4 outcome
//! guards, these assert on the prompt, the run notes and `rejected`:
//!   * a snapshot exhibit that fails `is_resolver_archive` is never admitted as evidence (reason is named);
//!   * a verified pre-deadline snapshot governs its source over a live fetch of that source's URL;
//!   * an honest snapshot plus an agreeing second origin still resolves decisively;
//!   * caller `job.sources` text never replaces the resolver's fetch of an allow-listed URL.
use super::*;
use serde_json::json;
use std::cell::RefCell;
use std::collections::BTreeMap;

const WS: &str = "2026-11-01T00:00:00Z";
const WE: &str = "2026-11-02T00:00:00Z";
const URL_A: &str = "https://scores.neutral-a.example/game/1";
const URL_B: &str = "https://stats.neutral-b.example/game/1";
const SNAP_BODY: &str = "Final: Owls 3, Hawks 1 - the Owls won the game.";
const EDITED: &str = "Final: Hawks 4, Owls 3 - the Hawks won the game (corrected).";
const B_BODY: &str = "Box score: Owls 3, Hawks 1 - the Owls won the game.";
const CALLER_TXT: &str = "Hawks 5, Owls 0 - the Hawks won the game.";
const SEED: [u8; 32] = [7u8; 32];

struct Pages(BTreeMap<String, String>);
impl HttpFetcher for Pages {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        let b = self.0.get(url).ok_or_else(|| format!("no fixture for {}", url))?;
        Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: "text/html; charset=utf-8".into(), body: format!("<html><body><p>{}</p></body></html>", b).into_bytes(), status_code: 200 })
    }
}
fn pages(v: &[(&str, &str)]) -> Pages { Pages(v.iter().map(|(u, b)| (u.to_string(), b.to_string())).collect()) }

/// Scripted judge that records every prompt it was shown.
struct Judge<F: Fn(&str) -> String>(F, RefCell<Vec<String>>);
impl<F: Fn(&str) -> String> ModelCaller for Judge<F> {
    fn call(&self, _m: &str, msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        let p = msgs.iter().map(|(_, c)| c.as_str()).collect::<Vec<_>>().join("\n");
        self.1.borrow_mut().push(p.clone());
        (self.0(&p), None, None)
    }
}
fn insufficient() -> String { r#"{"answer":"insufficient","reason":"scripted"}"#.into() }
fn ans(a: &str, sid: &str, quote: &str) -> String { json!({"answer": a, "quote": quote, "source_id": sid, "reason": "scripted"}).to_string() }
fn seen(j: &Judge<impl Fn(&str) -> String>, s: &str) -> bool { j.1.borrow().iter().any(|p| p.contains(s)) }
fn notes_of(out: &Value) -> Vec<String> { out["fetch_notes"].as_array().cloned().unwrap_or_default().iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect() }
fn has(n: &[String], s: &str) -> bool { n.iter().any(|x| x.contains(s)) }
fn rejected_has(out: &Value, id: &str, why: &str) -> bool {
    out["rejected"].as_array().map(|a| a.iter().any(|r| r.to_string().contains(id) && r.to_string().contains(why))).unwrap_or(false)
}

fn th() -> String { "ab".repeat(32) }
fn pk_hex() -> String {
    use ed25519_dalek::SigningKey;
    hex::encode(SigningKey::from_bytes(&SEED).verifying_key().to_bytes())
}
fn term() -> Value {
    json!({"claim": "x", "rule": "ALL", "bet_id": "170",
        "elements": [{"id": "e1", "q": "Did the Hawks win the game?"}], "clauses": ["UTC_V1", "BEFORE_INCLUSIVE_V1", "NO_DATA_FALLBACK_V1"], "sources": true,
        "custom_definitions": [
            "Fallback: if one named source is unavailable (no admissible exhibit reaches the evidence cutoff), the remaining source must decide; if none can be checked the outcome is VOID with full refunds.",
            "Early YES resolution is allowed at the first final score, never before; if the Hawks did not win the game the outcome is NO.",
            "Only the final score on the named pages counts."],
        "time": {"window_start": WS, "window_end": WE, "evidence_cutoff": "2026-11-09T00:00:00Z"},
        "sources_allowed": [{"id": "SA", "publisher": "Scores A", "url": URL_A}, {"id": "SB", "publisher": "Stats B", "url": URL_B}],
        "source_classes": {"Scores A": "primary", "Stats B": "primary"}, "terms_hash": th()})
}
/// Snapshot of source `sid`, signed with `seed` for terms `sth`, captured `cap`, posted on chain `sub`.
fn snap_with(id: &str, sid: &str, publisher: &str, cap: &str, sub: &str, body: &str, seed: [u8; 32], sth: &str) -> Value {
    use ed25519_dalek::{Signer, SigningKey};
    let msg = praetorial_core::archive_message("170", sid, cap, sth, &praetorial_core::sha_hex(body));
    let sig = hex::encode(SigningKey::from_bytes(&seed).sign(msg.as_bytes()).to_bytes());
    json!({"id": id, "by": "no", "publisher": publisher, "published": cap, "text": body, "source_type": "archive_snapshot",
        "source_id": sid, "captured_at": cap, "body": body, "resolver_sig": sig, "terms_hash": sth, "onchain_submitted_at": sub})
}
fn snap(cap: &str, sub: &str, body: &str) -> Value { snap_with("ARC1", "SA", "Scores A", cap, sub, body, SEED, &th()) }
fn job_with(exhibits: Vec<Value>) -> Value {
    json!({"bet_id": "170", "term": term(), "window_close": "2026-11-09T00:00:00Z", "exhibits": exhibits, "runs": 1,
           "resolver_pubkey": pk_hex(), "terms_hash": th()})
}

/// (1) Every way a snapshot can fail is_resolver_archive: the exhibit never reaches the prompt, the notes and `rejected`
/// name the reason. The exhibit is a yes-side claim so that, were it admitted, the (obeying) judge would quote it.
#[test]
fn w1_snapshot_failing_is_resolver_archive_is_not_admitted_and_reason_is_named() {
    let mut forged = snap("2026-11-01T23:50:00Z", "2026-11-02T00:00:00Z", SNAP_BODY);
    forged["resolver_sig"] = json!("00".repeat(64));
    let cases: Vec<(&str, Value, &str)> = vec![
        ("late +15:01", snap("2026-11-01T23:50:00Z", "2026-11-02T00:05:01Z", SNAP_BODY), "more than 15 minutes"),
        ("forged signature", forged, "valid resolver signature"),
        ("wrong terms_hash", snap_with("ARC1", "SA", "Scores A", "2026-11-01T23:50:00Z", "2026-11-02T00:00:00Z", SNAP_BODY, SEED, &"cd".repeat(32)), "terms_hash"),
        ("keeper-signed", snap_with("ARC1", "SA", "Scores A", "2026-11-01T23:50:00Z", "2026-11-02T00:00:00Z", SNAP_BODY, [9u8; 32], &th()), "valid resolver signature"),
        ("captured outside window", snap("2026-10-31T23:50:00Z", "2026-10-31T23:55:00Z", SNAP_BODY), "outside the bet window"),
    ];
    for (name, mut ex, reason) in cases {
        ex["by"] = json!("yes");
        let j = Judge(|p: &str| if p.contains(SNAP_BODY) { ans("met", "ARC1", SNAP_BODY) } else { insufficient() }, RefCell::new(vec![]));
        let out = resolve_job_with(&job_with(vec![ex]), &j, &pages(&[]), false);
        let n = notes_of(&out);
        assert!(!seen(&j, SNAP_BODY), "{}: rejected snapshot reached the judge prompt: {}", name, out);
        assert_ne!(out["outcome"], "YES", "{}: {}", name, out);
        assert!(has(&n, "REJECTED") && has(&n, reason), "{}: notes must name the rejection reason `{}`: {:?}", name, reason, n);
        assert!(rejected_has(&out, "ARC1", reason), "{}: `rejected` must carry the reason `{}`: {}", name, reason, out["rejected"]);
    }
}

/// (1b) Fail closed: no trustworthy resolver pubkey on the path => even a perfectly signed snapshot is not admitted.
#[test]
fn w1b_no_resolver_pubkey_rejects_snapshot_fail_closed() {
    let mut job = job_with(vec![snap("2026-11-01T23:50:00Z", "2026-11-02T00:00:00Z", SNAP_BODY)]);
    job.as_object_mut().unwrap().remove("resolver_pubkey");
    let j = Judge(|p: &str| if p.contains(SNAP_BODY) { ans("not_met", "ARC1", SNAP_BODY) } else { insufficient() }, RefCell::new(vec![]));
    let out = resolve_job_with(&job, &j, &pages(&[]), false);
    assert!(!seen(&j, SNAP_BODY), "snapshot admitted without a resolver pubkey: {}", out);
    assert!(has(&notes_of(&out), "no trustworthy resolver pubkey"), "{:?}", notes_of(&out));
}

/// (2) A verified pre-deadline snapshot for SA governs SA: the judge sees the snapshot body, never the live (edited) text
/// fetched from SA's URL; the live exhibit is excluded with a note and cannot be quoted.
#[test]
fn w2_verified_snapshot_governs_over_live_fetch_of_same_source() {
    let live = json!({"id": "Y1", "by": "yes", "publisher": "Scores A", "published": "2026-11-02T00:30:00Z", "text": EDITED,
        "url": URL_A, "onchain_submitted_at": "2026-11-02T01:00:00Z"});
    let b = json!({"id": "B1", "by": "no", "publisher": "Stats B", "published": "2026-11-01T23:00:00Z", "text": B_BODY,
        "url": URL_B, "onchain_submitted_at": "2026-11-01T23:30:00Z"});
    let j = Judge(|p: &str| if p.contains(EDITED) { ans("met", "Y1", EDITED) } else if p.contains(SNAP_BODY) { ans("not_met", "ARC1", SNAP_BODY) } else { insufficient() }, RefCell::new(vec![]));
    let f = pages(&[(URL_A, EDITED), (URL_B, B_BODY)]);
    let out = resolve_job_with(&job_with(vec![snap("2026-11-01T23:50:00Z", "2026-11-02T00:00:00Z", SNAP_BODY), live, b]), &j, &f, false);
    assert!(seen(&j, SNAP_BODY), "the snapshot body must be what the judge sees for SA: {}", out);
    assert!(!seen(&j, EDITED), "live post-deadline text for SA reached the judge: {}", out);
    assert!(has(&notes_of(&out), "governs"), "{:?}", notes_of(&out));
    assert!(rejected_has(&out, "Y1", "superseded"), "{}", out["rejected"]);
    assert_ne!(out["outcome"], "YES", "{}", out);
}

/// (2b) The `text` field of a verified snapshot is party-supplied; the SIGNED body is what the judge must see.
#[test]
fn w2b_judge_sees_signed_body_not_party_supplied_text() {
    let mut s = snap("2026-11-01T23:50:00Z", "2026-11-02T00:00:00Z", SNAP_BODY);
    s["text"] = json!(EDITED);
    let j = Judge(|_: &str| insufficient(), RefCell::new(vec![]));
    let _ = resolve_job_with(&job_with(vec![s]), &j, &pages(&[]), false);
    assert!(seen(&j, SNAP_BODY) || j.1.borrow().is_empty(), "signed body must be shown");
    assert!(!seen(&j, EDITED), "party-supplied text of a snapshot reached the judge");
}

/// (3) Honest snapshots still work: valid snapshot of SA + an agreeing, independent second origin (SB) => decisive NO.
#[test]
fn w3_valid_snapshot_plus_agreeing_second_origin_is_decisive() {
    let b = json!({"id": "B1", "by": "no", "publisher": "Stats B", "published": "2026-11-01T23:00:00Z", "text": B_BODY,
        "url": URL_B, "onchain_submitted_at": "2026-11-01T23:30:00Z"});
    let j = Judge(|p: &str| if p.contains(SNAP_BODY) && p.contains(B_BODY) {
        json!({"answer": "not_met", "quote": SNAP_BODY, "source_id": "ARC1", "also": [{"source_id": "B1", "quote": B_BODY}], "reason": "scripted"}).to_string()
    } else { insufficient() }, RefCell::new(vec![]));
    let f = pages(&[(URL_A, SNAP_BODY), (URL_B, B_BODY)]);
    let out = resolve_job_with(&job_with(vec![snap("2026-11-01T23:50:00Z", "2026-11-02T00:00:00Z", SNAP_BODY), b]), &j, &f, false);
    assert_eq!(out["outcome"], "NO", "honest snapshot + agreeing second origin must stay decisive: {}", out);
    assert!(!has(&notes_of(&out), "REJECTED"), "{:?}", notes_of(&out));
}

fn bs_job(sources: Value) -> Value {
    let t = term();
    let raw = t.to_string();
    json!({"contract": "escrow.testnet", "bet_id": 170, "run_no": 1, "checked_until": 0, "round": 0,
        "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw, "sources": sources})
}

/// (4) build_submission: caller text for allow-listed SA is ignored in favour of the resolver fetch, with a note.
#[test]
fn w4_caller_text_ignored_for_allow_listed_url_build_submission() {
    let j = Judge(|p: &str| if p.contains(CALLER_TXT) { ans("met", "SA", CALLER_TXT) } else { insufficient() }, RefCell::new(vec![]));
    let f = pages(&[(URL_A, SNAP_BODY), (URL_B, B_BODY)]);
    let job = bs_job(json!([{"id": "SA", "published": "2026-11-01T01:00:00Z", "text": CALLER_TXT}]));
    let (_r, n) = build_submission_with(&job, &j, &f, false);
    assert!(!seen(&j, CALLER_TXT), "caller text for an allow-listed URL reached the judge: {:?}", n);
    assert!(seen(&j, SNAP_BODY), "the resolver's own fetch of SA must be what the judge sees: {:?}", n);
    assert!(has(&n, "caller-supplied text for source SA ignored"), "{:?}", n);
}

/// (4b) build_submission: the fetch of SA fails => SA is COULDNT_CHECK, never the caller text.
#[test]
fn w4b_failed_fetch_means_couldnt_check_never_caller_text_build_submission() {
    let j = Judge(|p: &str| if p.contains(CALLER_TXT) { ans("met", "SA", CALLER_TXT) } else { insufficient() }, RefCell::new(vec![]));
    let f = pages(&[(URL_B, B_BODY)]); // SA's URL has no fixture => fetch fails
    let job = bs_job(json!([{"id": "SA", "published": "2026-11-01T01:00:00Z", "text": CALLER_TXT}]));
    let (r, n) = build_submission_with(&job, &j, &f, false);
    assert!(!seen(&j, CALLER_TXT), "caller text stood in for a failed fetch: {:?}", n);
    assert_ne!(r.outcome, "YES", "{:?}", n);
    assert!(has(&n, "caller-supplied text for source SA ignored") && has(&n, "source fetch dropped SA"), "{:?}", n);
}

/// (4c) resolve_direct (job.term + job.sources, no exhibits): same rule.
#[test]
fn w4c_caller_text_ignored_for_allow_listed_url_resolve_direct() {
    let j = Judge(|p: &str| if p.contains(CALLER_TXT) { ans("met", "SA", CALLER_TXT) } else { insufficient() }, RefCell::new(vec![]));
    let f = pages(&[(URL_A, SNAP_BODY), (URL_B, B_BODY)]);
    let job = json!({"bet_id": "170", "term": term(), "runs": 1, "sources": [{"id": "SA", "publisher": "Scores A", "published": "2026-11-01T01:00:00Z", "text": CALLER_TXT}]});
    let out = resolve_job_with(&job, &j, &f, false);
    assert!(!seen(&j, CALLER_TXT), "caller text for an allow-listed URL reached the judge: {}", out);
    assert!(seen(&j, SNAP_BODY), "{}", out);
    assert!(has(&notes_of(&out), "caller-supplied text for source SA ignored"), "{:?}", notes_of(&out));
}
