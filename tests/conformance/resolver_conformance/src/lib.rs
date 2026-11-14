//! CM-17 -- design map §10 L3: "ESCALATE as a 4th outcome? No. Resolver
//! never signs ESCALATE; returns unsigned 'no decision' -> next paid
//! run -> arbiter -> VOID after resolve_deadline."
//!
//! `resolver/core::decide()` is the pure decision function this claim
//! ultimately rests on (the wasm-bin signing step only signs whatever
//! `decide()` returns). It had zero test coverage of any branch
//! (ENFORCED-UNTESTED) before this crate. This test covers the part
//! resolver/core can prove: ESCALATE is returned (as a label, not
//! signed here) if and only if a verdict is "unresolved", and ESCALATE
//! is never one of the two contract-accepted outcomes {YES, NO} that
//! the caller is allowed to forward into `submit_outcome`.
//!
//! What this test can't prove (cross-component, flagged NOT ENFORCED
//! in the conformance matrix instead): that resolver/wasm-bin's
//! signing step actually refuses to produce a signature when
//! `decide()` returns "ESCALATE" -- that lives in resolver/wasm-bin,
//! out of scope for this loop (escrow/keeper-adjacent code frozen).

use praetorial_core::decide;
use serde_json::json;

fn ts(rule: &str) -> serde_json::Value {
    json!({"rule": rule})
}

#[test]
fn cm17_unresolved_verdict_yields_escalate_not_yes_or_no() {
    let (outcome, _reason) = decide(&ts("ALL"), &["met".to_string(), "unresolved".to_string()]);
    assert_eq!(outcome, "ESCALATE", "an unresolved element must ESCALATE, not fall through to YES/NO");
    assert_ne!(outcome, "YES");
    assert_ne!(outcome, "NO");
}

#[test]
fn cm17_escalate_is_not_one_of_the_two_contract_outcomes() {
    // Envelope.outcomes is pinned to ["YES", "NO"] (escrow contract
    // spec v1, Envelope.outcomes doc: "Always [YES, NO] in v1").
    // ESCALATE must never collide with that closed set, in either
    // rule mode, so a caller can't accidentally forward it as if it
    // were a real decision.
    const CONTRACT_OUTCOMES: [&str; 2] = ["YES", "NO"];
    for rule in ["ALL", "ANY"] {
        let (outcome, _) = decide(&ts(rule), &["unresolved".to_string()]);
        assert_eq!(outcome, "ESCALATE");
        assert!(
            !CONTRACT_OUTCOMES.contains(&outcome.as_str()),
            "ESCALATE must never be mistaken for a contract-valid outcome under rule={rule}"
        );
    }
}

#[test]
fn cm17_conflict_yields_void_not_escalate_or_a_side() {
    // decide()'s own precedence: an outright "conflict" verdict is
    // VOID, distinct from ESCALATE (disagreement/verification failure)
    // and from a real YES/NO decision. No test previously pinned this
    // ordering either.
    let (outcome, _) = decide(&ts("ALL"), &["conflict".to_string(), "met".to_string()]);
    assert_eq!(outcome, "VOID");
}
