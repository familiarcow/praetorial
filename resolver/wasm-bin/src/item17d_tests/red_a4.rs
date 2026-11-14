//! Item 17d RED tests (17d2c subset A4 snapshot wiring + caller text): DESIGNED-behaviour assertions, never loosened. See services/e2e/redteam17d/REPORT.md.
use super::*;
mod att4 {
    use super::*;
    const WS: &str = "2026-11-01T00:00:00Z";
    const WE: &str = "2026-11-02T00:00:00Z";
    const URL: &str = "https://scores.neutral-a.example/game/1";
    const SNAP_BODY: &str = "Final: Owls 3, Hawks 1 - the Owls won the game.";
    const EDITED: &str = "Final: Hawks 4, Owls 3 - the Hawks won the game (corrected).";

    fn term(th: &str) -> Value {
        json!({"claim": "x", "rule": "ALL", "bet_id": "170",
            "elements": [{"id": "e1", "q": "Did the Hawks win the game?"}], "clauses": ["AVAILABLE_V1"], "sources": true,
            "time": {"window_start": WS, "window_end": WE, "evidence_cutoff": "2026-11-09T00:00:00Z"},
            "source_classes": {"Scores A": "primary"}, "terms_hash": th})
    }
    fn seed() -> [u8; 32] { [7u8; 32] }
    fn pk_hex() -> String {
        use ed25519_dalek::SigningKey;
        hex::encode(SigningKey::from_bytes(&seed()).verifying_key().to_bytes())
    }
    /// resolver-signed snapshot exhibit captured at `cap`, posted on chain at `sub`.
    fn snap(cap: &str, sub: &str, body: &str) -> Value {
        let th = "ab".repeat(32);
        use ed25519_dalek::{Signer, SigningKey};
        let msg = praetorial_core::archive_message("170", "SA", cap, &th, &praetorial_core::sha_hex(body));
        let sig = hex::encode(SigningKey::from_bytes(&seed()).sign(msg.as_bytes()).to_bytes());
        json!({"id": "ARC1", "by": "no", "publisher": "Scores A", "published": cap, "text": body, "source_type": "archive_snapshot",
            "source_id": "SA", "captured_at": cap, "body": body, "resolver_sig": sig, "terms_hash": th, "onchain_submitted_at": sub})
    }


    fn live_edited() -> Pages { pages(&[(URL, html(&format!("<html><body><p>{}</p></body></html>", EDITED)))]) }

    fn job_with(exhibits: Vec<Value>) -> Value {
        json!({"bet_id": "170", "term": term(&"ab".repeat(32)), "window_close": "2026-11-09T00:00:00Z", "exhibits": exhibits, "runs": 1,
               "resolver_pubkey": pk_hex(), "terms_hash": "ab".repeat(32)})
    }
    /// Judge that OBEYS the later (edited) page: if the post-deadline text is in the prompt it answers met on it,
    /// even though the pre-deadline snapshot is also there. Code, not the judge, must stop the edit from winning.
    fn follows_edit(p: &str) -> String {
        if p.contains(EDITED) { ans("met", "Y1", EDITED) }
        else if p.contains(SNAP_BODY) { ans("not_met", "ARC1", SNAP_BODY) }
        else { insufficient(p) }
    }

    /// DESIGNED (D-RESOLVE1 pt 4 / D-ATTEST1a): a valid resolver-signed pre-deadline snapshot (Owls won) contradicts a
    /// live page edited after the deadline (Hawks won). The edit must never turn the result into YES (NO or VOID is safe).
    #[test]
    fn a4_edited_page_after_deadline_must_not_beat_valid_snapshot() {
        let yes = json!({"id": "Y1", "by": "yes", "publisher": "Scores A", "published": "2026-11-02T00:30:00Z", "text": EDITED,
            "url": URL, "onchain_submitted_at": "2026-11-02T01:00:00Z"});
        let out = resolve_job_with(&job_with(vec![snap("2026-11-01T23:50:00Z", "2026-11-02T00:00:00Z", SNAP_BODY), yes]),
            &Judge(follows_edit, RefCell::new(0)), &live_edited(), false);
        assert_ne!(out["outcome"], "YES", "WRONG-WINNER: page edited after the deadline beat a valid signed snapshot: {}", out);
    }

    /// DESIGNED (D-ATTEST1a part 3): a snapshot exhibit posted > captured_at+15min, or with a forged signature, is NOT an
    /// authoritative archive and must not be admitted as evidence. A yes-side "snapshot" with no url (nothing for the
    /// resolver to verify against) and a bad signature must not produce YES.
    #[test]
    fn a4_forged_or_late_snapshot_exhibit_must_not_yield_yes() {
        let mut late = snap("2026-11-01T23:50:00Z", "2026-11-02T00:05:01Z", EDITED); // +15:01
        late["by"] = json!("yes");
        late["id"] = json!("Y1");
        let mut forged = snap("2026-11-01T23:50:00Z", "2026-11-02T00:00:00Z", EDITED);
        forged["by"] = json!("yes");
        forged["id"] = json!("Y2");
        forged["resolver_sig"] = json!("00".repeat(64));
        for (name, ex) in [("late +15:01", late), ("forged signature", forged)] {
            let id = ex["id"].as_str().unwrap().to_string();
            let out = resolve_job_with(&job_with(vec![ex]), &Judge(move |p: &str| if p.contains(EDITED) { ans("met", &id, EDITED) } else { insufficient(p) }, RefCell::new(0)), &NullFetcher, false);
            assert_ne!(out["outcome"], "YES", "WRONG-WINNER ({}): non-authoritative snapshot exhibit decided YES: {}", name, out);
        }
    }

    /// DESIGNED: the resolver's OWN fetch decides nothing the caller can override: caller-supplied `sources[]` text for
    /// an allow-listed id must never replace the resolver's fetch of that URL (in production input_data is built by the
    /// escrow; this pins the resolver-side behaviour).
    #[test]
    fn a4_caller_supplied_source_text_must_not_override_resolver_fetch() {
        let t = terms(vec![src("SA", "Scores A", A, None), src("SB", "Stats B", B, None)]);
        let raw = t.to_string();
        let job = json!({"contract": "escrow.testnet", "bet_id": 170, "run_no": 1, "checked_until": 0, "round": 0,
            "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw,
            "sources": [{"id": "SA", "published": "2026-11-01T01:00:00Z", "text": "Hawks 5, Owls 0 - the Hawks won the game."}]});
        let f = pages(&[(A, html(FINAL_NO)), (B, html(FINAL_NO))]);
        let j = Judge(|p: &str| if p.contains("Hawks 5, Owls 0 - the Hawks won the game.") { ans("met", "SA", "Hawks 5, Owls 0 - the Hawks won the game.") } else { insufficient(p) }, RefCell::new(0));
        let (r, n) = build_submission_with(&job, &j, &f, false);
        assert_ne!(r.outcome, "YES", "WRONG-WINNER: caller-supplied job.sources text replaced the resolver fetch: {:?}", n);
    }
}
