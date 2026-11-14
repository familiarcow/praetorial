//! JC1s (D-JUDGECHAIN1, D-JUDGECHAIN1a, D-RESOLVE1): the signed result names the judge pair that decided
//! (`judge_pair_index`, inside the signed buffer), the contract accepts only an APPLIED pair index, records it on the bet,
//! and a "no live judge" RETRY (`RETRY:no_live_judge`) never starts or advances the D-RESOLVE1 recovery window.
//! Child of tests.rs (`#[path]`), reuses its private helpers.
use super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const HOUR_NS: u64 = 3_600 * 1_000_000_000;

fn fails<F: FnOnce()>(f: F) -> bool {
    catch_unwind(AssertUnwindSafe(f)).is_err()
}

fn setup() -> (Contract, u64, String) {
    let mut c = new_contract();
    let (_, pk) = test_keypair(7);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let th = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();
    (c, bet_id, th)
}

/// JC1x: a model is retired (3 not-found observations >= 24h apart) -- fixture state set directly.
fn retire_model(c: &mut Contract, model: &str) {
    c.model_missing.insert(model.to_string(), vec![1, 1 + 24 * HOUR_NS, 1 + 48 * HOUR_NS]);
}

/// JC1x: retire the first `n` pairs of the chain.
fn retire_first(c: &mut Contract, n: usize) {
    for p in c.judge_chain().into_iter().take(n) {
        retire_model(c, &p.model_a);
    }
}

fn unretire_all(c: &mut Contract) {
    for p in c.judge_chain() {
        c.model_missing.remove(&p.model_a);
        c.model_missing.remove(&p.model_b);
    }
}

fn yes_at(bet_id: u64, th: &str, run_no: u64, idx: u32) -> SubmittedResult {
    SubmittedResult {
        bet_id,
        terms_hash: th.to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: idx, model_not_found: vec![],
    }
}

fn no_live(bet_id: u64, th: &str, run_no: u64, now: u64) -> SubmittedResult {
    SubmittedResult {
        bet_id,
        terms_hash: th.to_string(),
        outcome: "RETRY:no_live_judge".to_string(),
        element_results_hash: "0".repeat(64),
        run_no,
        checked_until: U64(now),
        next_check_ns: Some(U64(now + 24 * HOUR_NS)),
        judge_pair_index: 0, model_not_found: vec![],
    }
}

fn submit(c: &mut Contract, ts: u64, r: SubmittedResult) {
    ctx("anyone.testnet", ts);
    let sig = sign_result(&outcome_signing_key(), &r);
    c.submit_outcome(r, sig);
}

#[test]
fn jc1s_outcome_with_an_applied_pair_index_is_accepted_and_recorded_on_the_bet() {
    for idx in [0u32, 1] {
        let (mut c, bet_id, th) = setup();
        retire_first(&mut c, idx as usize); // JC1x: only the first LIVE applied pair may judge
        submit(&mut c, 3_000, yes_at(bet_id, &th, 1, idx));
        let bet = c.get_bet(bet_id).unwrap();
        assert_eq!(bet.status, BetStatus::Proposed);
        assert_eq!(bet.judge_pair_index, Some(idx), "the bet records which pair judged");
    }
}

#[test]
fn jc1s_bet_without_a_decision_has_no_judge_pair() {
    let (c, bet_id, _) = setup();
    assert_eq!(c.get_bet(bet_id).unwrap().judge_pair_index, None);
}

#[test]
fn jc1s_out_of_range_pair_index_is_refused_even_if_correctly_signed() {
    let (mut c, bet_id, th) = setup();
    let n = c.judge_chain().len() as u32;
    for bad in [n, n + 1, 99, u32::MAX] {
        let r = yes_at(bet_id, &th, 1, bad);
        assert!(fails(|| submit(&mut c, 3_000, r)), "index {bad} must be refused");
        let bet = c.get_bet(bet_id).unwrap();
        assert_eq!(bet.status, BetStatus::Taken, "refused outcome leaves the bet untouched");
        assert_eq!(bet.judge_pair_index, None);
    }
}

#[test]
fn jc1s_pending_pair_index_is_refused_until_applied_then_accepted() {
    let (mut c, bet_id, th) = setup();
    let pending_idx = c.judge_chain().len() as u32;
    retire_first(&mut c, pending_idx as usize); // JC1x: the appended pair is the first live one once the earlier pairs are retired
    ctx_with_deposit(GUARDIAN, 100, ONE_YOCTO);
    c.propose_judge_pair(jp("jc1s-new-a", "jc1s-new-b"));
    let r = yes_at(bet_id, &th, 1, pending_idx);
    assert!(fails(|| submit(&mut c, 200, r)), "a pending pair is not a judge yet");
    ctx("anyone.testnet", 100 + JUDGE_PAIR_DELAY_NS);
    c.apply_judge_pair();
    submit(&mut c, 100 + JUDGE_PAIR_DELAY_NS + 1, yes_at(bet_id, &th, 1, pending_idx));
    assert_eq!(c.get_bet(bet_id).unwrap().judge_pair_index, Some(pending_idx));
}

#[test]
fn jc1s_cancelled_pair_index_is_refused() {
    let (mut c, bet_id, th) = setup();
    let idx = c.judge_chain().len() as u32;
    ctx_with_deposit(GUARDIAN, 100, ONE_YOCTO);
    c.propose_judge_pair(jp("jc1s-c-a", "jc1s-c-b"));
    ctx_with_deposit(GUARDIAN, 200, ONE_YOCTO);
    c.cancel_judge_pair();
    let r = yes_at(bet_id, &th, 1, idx);
    assert!(fails(|| submit(&mut c, 300, r)));
}

#[test]
#[should_panic(expected = "bad signature")]
fn jc1s_tampered_pair_index_fails_the_signature() {
    let (mut c, bet_id, th) = setup();
    let signed = yes_at(bet_id, &th, 1, 0);
    let sig = sign_result(&outcome_signing_key(), &signed);
    let tampered = yes_at(bet_id, &th, 1, 1); // a valid applied index, but not the one that was signed
    ctx("anyone.testnet", 3_000);
    c.submit_outcome(tampered, sig);
}

#[test]
fn jc1s_signed_buffer_layout_is_index_u32_after_checked_until_before_next_check() {
    // Pin the layout the resolver and the TS signers mirror.
    let r = SubmittedResult { judge_pair_index: 0x01020304, model_not_found: vec![], ..no_live(1, "t", 1, 5) };
    let mut expect = Vec::new();
    BorshSerialize::serialize(&CONTRACT.parse::<AccountId>().unwrap(), &mut expect).unwrap();
    BorshSerialize::serialize(&r.bet_id, &mut expect).unwrap();
    BorshSerialize::serialize(&r.terms_hash, &mut expect).unwrap();
    BorshSerialize::serialize(&r.outcome, &mut expect).unwrap();
    BorshSerialize::serialize(&r.element_results_hash, &mut expect).unwrap();
    BorshSerialize::serialize(&r.run_no, &mut expect).unwrap();
    BorshSerialize::serialize(&r.checked_until.0, &mut expect).unwrap();
    BorshSerialize::serialize(&0x01020304u32, &mut expect).unwrap();
    BorshSerialize::serialize(&r.next_check_ns.unwrap().0, &mut expect).unwrap();
    let sig = sign_result(&outcome_signing_key(), &r);
    let sk = outcome_signing_key();
    assert_eq!(sig, hex_encode(&ed25519_dalek::Signer::sign(&sk, &expect).to_bytes()));
}

#[test]
fn jc1s_no_live_judge_retry_does_not_start_the_recovery_window() {
    let (mut c, bet_id, th) = setup();
    retire_first(&mut c, 2); // JC1x: no_live_judge is only accepted when no pair is live
    let mut now = 3_000u64;
    for run in 1..=5u64 {
        submit(&mut c, now, no_live(bet_id, &th, run, now));
        now += 24 * HOUR_NS;
        let bet = c.get_bet(bet_id).unwrap();
        assert_eq!(bet.first_unavailable_ns, None, "run {run}: first_unavailable_ns must not start");
        assert_eq!(bet.retry_count, 0, "run {run}: no-live-judge does not count toward max_retries");
        assert_eq!(bet.status, BetStatus::Taken);
        assert_eq!(bet.outcome, None);
        assert!(bet.next_check_ns.is_some(), "keeper still re-checks at the signed next_check_ns");
    }
}

#[test]
fn jc1s_no_live_judge_retry_does_not_advance_an_already_started_window() {
    let (mut c, bet_id, th) = setup();
    submit(&mut c, 3_000, retry_result(bet_id, &th, 1, 3_000, 3_000 + HOUR_NS)); // a genuine outage RETRY starts the clock
    let started = c.get_bet(bet_id).unwrap();
    assert_eq!(started.first_unavailable_ns, Some(3_000));
    assert_eq!(started.retry_count, 1);
    retire_first(&mut c, 2); // JC1x: no_live_judge is only accepted when no pair is live
    submit(&mut c, 4_000 + HOUR_NS, no_live(bet_id, &th, 2, 4_000 + HOUR_NS));
    let after = c.get_bet(bet_id).unwrap();
    assert_eq!(after.first_unavailable_ns, Some(3_000), "unchanged");
    assert_eq!(after.retry_count, 1, "unchanged");
}

#[test]
fn jc1s_no_live_judge_runs_do_not_exhaust_max_paid_runs() {
    let (mut c, bet_id, th) = setup();
    retire_first(&mut c, 2); // JC1x: no_live_judge is only accepted when no pair is live
    let before = c.get_bet(bet_id).unwrap().runs_used;
    submit(&mut c, 3_000, no_live(bet_id, &th, 1, 3_000));
    assert_eq!(c.get_bet(bet_id).unwrap().runs_used, before);
}

#[test]
fn jc1s_void_unavailable_is_still_refused_after_only_no_live_judge_retries() {
    let (mut c, bet_id, th) = setup();
    retire_first(&mut c, 2); // JC1x: no_live_judge is only accepted when no pair is live
    submit(&mut c, 3_000, no_live(bet_id, &th, 1, 3_000));
    unretire_all(&mut c); // the guardian appended / models recovered: the VOID below must be refused by the recovery ladder itself
    let v = void_result(bet_id, &th, "unavailable", 2, 3_000 + 8 * 24 * HOUR_NS);
    let mut vv = v;
    vv.judge_pair_index = 0;
    assert!(fails(|| submit(&mut c, 3_000 + 8 * 24 * HOUR_NS, vv)), "no recovery window has started, so VOID:unavailable cannot settle");
}

#[test]
fn jc1s_no_live_judge_then_void_after_deadline_refunds() {
    let (mut c, bet_id, th) = setup();
    retire_first(&mut c, 2); // JC1x: no_live_judge is only accepted when no pair is live
    submit(&mut c, 3_000, no_live(bet_id, &th, 1, 3_000));
    ctx("anyone.testnet", 10_001);
    c.void_after_deadline(bet_id);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Voided);
}

#[test]
fn jc1s_no_live_judge_must_be_signed_by_the_resolver_key() {
    let (mut c, bet_id, th) = setup();
    retire_first(&mut c, 2); // JC1x: no_live_judge is only accepted when no pair is live
    let r = no_live(bet_id, &th, 1, 3_000);
    let wrong = test_keypair(99).0;
    let sig = sign_result(&wrong, &r);
    ctx("anyone.testnet", 3_000);
    assert!(fails(|| c.submit_outcome(r, sig)));
    assert_eq!(c.get_bet(bet_id).unwrap().next_check_ns, None);
}

#[test]
fn jc1s_no_live_judge_obeys_the_next_check_horizon_and_requires_next_check() {
    let (mut c, bet_id, th) = setup();
    retire_first(&mut c, 2); // JC1x: no_live_judge is only accepted when no pair is live
    let mut far = no_live(bet_id, &th, 1, 3_000);
    far.next_check_ns = Some(U64(3_000 + 49 * HOUR_NS));
    assert!(fails(|| submit(&mut c, 3_000, far)), ">48h refused");
    let mut none = no_live(bet_id, &th, 1, 3_000);
    none.next_check_ns = None;
    assert!(fails(|| submit(&mut c, 3_000, none)), "next_check_ns required");
}

#[test]
fn jc1s_plain_retry_still_starts_the_window_and_signs_an_applied_index() {
    let (mut c, bet_id, th) = setup();
    let mut r = retry_result(bet_id, &th, 1, 3_000, 3_000 + HOUR_NS);
    r.judge_pair_index = 99;
    assert!(fails(|| submit(&mut c, 3_000, r)), "RETRY also names an applied pair");
    submit(&mut c, 3_000, retry_result(bet_id, &th, 1, 3_000, 3_000 + HOUR_NS));
    assert_eq!(c.get_bet(bet_id).unwrap().first_unavailable_ns, Some(3_000));
}
