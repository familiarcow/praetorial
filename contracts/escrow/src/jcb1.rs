//! JCB1 (D-JCB1): bound the `RETRY:no_live_judge` loop. After a no_live_judge result `request_resolution` and
//! `can_request_resolution` are refused until max(signed next_check_ns, submit time + NO_LIVE_JUDGE_MIN_GAP_NS);
//! any other result clears the gate; per-bet storage stays bounded; first_unavailable_ns / retry_count / runs_used untouched.
//! Child of tests.rs (`#[path]`), reuses its private helpers.
use super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};

const HOUR_NS: u64 = 3_600 * 1_000_000_000;
const DAY_NS_B: u64 = 24 * HOUR_NS;
const WAIT_MSG: &str = "waiting for a live judge model";

fn fails<F: FnOnce()>(f: F) -> bool {
    catch_unwind(AssertUnwindSafe(f)).is_err()
}

fn panic_msg<F: FnOnce()>(f: F) -> String {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(()) => String::new(),
        Err(e) => e
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
            .unwrap_or_default(),
    }
}

fn setup() -> (Contract, u64, String) {
    let mut c = new_contract();
    let (_, pk) = test_keypair(7);
    let pk_hex = hex_encode(&pk);
    let mut env = base_envelope(&pk_hex);
    env.resolve_deadline = 120 * DAY_NS_B;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)]);
    let bet_id = c.next_bet_id - 1;
    let resp = do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_msg(bet_id), 2);
    assert_eq!(resp, vec![U128(0)]);
    let th = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();
    (c, bet_id, th)
}

fn retire_all(c: &mut Contract) {
    for p in c.judge_chain() {
        for m in [p.model_a, p.model_b] {
            c.model_missing.insert(m, vec![1, 1 + DAY_NS_B, 1 + 2 * DAY_NS_B]);
        }
    }
}

fn unretire_all(c: &mut Contract) {
    for p in c.judge_chain() {
        c.model_missing.remove(&p.model_a);
        c.model_missing.remove(&p.model_b);
    }
}

fn submit(c: &mut Contract, ts: u64, r: SubmittedResult) {
    ctx("anyone.testnet", ts);
    let sig = sign_result(&outcome_signing_key(), &r);
    c.submit_outcome(r, sig);
}

fn no_live(bet_id: u64, th: &str, run_no: u64, now: u64, next_check: u64) -> SubmittedResult {
    SubmittedResult {
        bet_id,
        terms_hash: th.to_string(),
        outcome: "RETRY:no_live_judge".to_string(),
        element_results_hash: "0".repeat(64),
        run_no,
        checked_until: U64(now),
        next_check_ns: Some(U64(next_check)),
        judge_pair_index: 0,
        model_not_found: vec![],
    }
}

fn request(c: &mut Contract, bet_id: u64, ts: u64) {
    ctx_with_deposit("anyone.testnet", ts, NearToken::from_near(1));
    let _ = c.request_resolution(bet_id, None);
}

const T0: u64 = 5_000;

// (a)
#[test]
fn jcb1_request_refused_after_no_live_judge_at_1s_and_11h59m() {
    let (mut c, bet_id, th) = setup();
    retire_all(&mut c);
    submit(&mut c, T0, no_live(bet_id, &th, 1, T0, T0 + DAY_NS_B));
    for dt in [1_000_000_000u64, 11 * HOUR_NS + 59 * 60 * 1_000_000_000] {
        ctx_with_deposit("anyone.testnet", T0 + dt, NearToken::from_near(1));
        assert_eq!(c.can_request_resolution(bet_id), Some(WAIT_MSG.to_string()), "dt={dt}");
        let m = panic_msg(|| {
            let _ = c.request_resolution(bet_id, None);
        });
        assert!(m.contains(WAIT_MSG), "dt={dt}: {m}");
    }
    assert_eq!(c.get_bet(bet_id).unwrap().pending_resolution_request, None);
}

// (b)
#[test]
fn jcb1_allowed_again_at_max_of_signed_next_check_and_12h() {
    // signed next_check far past the 12h floor: gate = next_check
    let (mut c, bet_id, th) = setup();
    retire_all(&mut c);
    submit(&mut c, T0, no_live(bet_id, &th, 1, T0, T0 + DAY_NS_B));
    ctx("anyone.testnet", T0 + DAY_NS_B - 1);
    assert_eq!(c.can_request_resolution(bet_id), Some(WAIT_MSG.to_string()));
    ctx("anyone.testnet", T0 + DAY_NS_B);
    assert_eq!(c.can_request_resolution(bet_id), None);
    request(&mut c, bet_id, T0 + DAY_NS_B);
    assert!(c.get_bet(bet_id).unwrap().pending_resolution_request.is_some());

    // signed next_check only now+1ns: the contract's 12h floor holds
    let (mut c, bet_id, th) = setup();
    retire_all(&mut c);
    submit(&mut c, T0, no_live(bet_id, &th, 1, T0, T0 + 1));
    ctx("anyone.testnet", T0 + 12 * HOUR_NS - 1);
    assert_eq!(c.can_request_resolution(bet_id), Some(WAIT_MSG.to_string()));
    assert!(NO_LIVE_JUDGE_MIN_GAP_NS == 12 * HOUR_NS);
    ctx("anyone.testnet", T0 + 12 * HOUR_NS);
    assert_eq!(c.can_request_resolution(bet_id), None);
    request(&mut c, bet_id, T0 + 12 * HOUR_NS);
    assert!(c.get_bet(bet_id).unwrap().pending_resolution_request.is_some());
}

// (c)
#[test]
fn jcb1_normal_retry_clears_the_gate() {
    let (mut c, bet_id, th) = setup();
    retire_all(&mut c);
    submit(&mut c, T0, no_live(bet_id, &th, 1, T0, T0 + DAY_NS_B));
    ctx("anyone.testnet", T0 + 1);
    assert!(c.can_request_resolution(bet_id).is_some());
    unretire_all(&mut c);
    submit(&mut c, T0 + 2, retry_result(bet_id, &th, 2, T0 + 2, T0 + 2 + HOUR_NS));
    ctx("anyone.testnet", T0 + 3);
    assert_eq!(c.can_request_resolution(bet_id), None, "normal RETRY clears the gate");
    request(&mut c, bet_id, T0 + 3);
}

#[test]
fn jcb1_verdict_clears_the_gate() {
    let (mut c, bet_id, th) = setup();
    retire_all(&mut c);
    submit(&mut c, T0, no_live(bet_id, &th, 1, T0, T0 + DAY_NS_B));
    unretire_all(&mut c);
    let yes = SubmittedResult {
        bet_id,
        terms_hash: th.clone(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 2,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0,
        model_not_found: vec![],
    };
    submit(&mut c, T0 + 2, yes);
    assert_eq!(c.get_bet(bet_id).unwrap().no_live_judge_until_ns, None);
}

// (d)
#[test]
fn jcb1_normal_outage_retry_is_not_gated() {
    let (mut c, bet_id, th) = setup();
    submit(&mut c, T0, retry_result(bet_id, &th, 1, T0, T0 + HOUR_NS));
    ctx("anyone.testnet", T0 + 1);
    assert_eq!(c.can_request_resolution(bet_id), None);
    request(&mut c, bet_id, T0 + 1);
    assert!(c.get_bet(bet_id).unwrap().pending_resolution_request.is_some());
    assert_eq!(c.get_bet(bet_id).unwrap().no_live_judge_until_ns, None);
}

// (e)
#[test]
fn jcb1_fifty_no_live_judge_cycles_keep_per_bet_storage_bounded_and_replay_refused() {
    let (mut c, bet_id, th) = setup();
    retire_all(&mut c);
    let mut now = T0;
    for run in 1..=50u64 {
        submit(&mut c, now, no_live(bet_id, &th, run, now, now + DAY_NS_B));
        now += 12 * HOUR_NS;
        assert!(c.get_bet(bet_id).unwrap().used_run_nos.len() <= 1, "run {run}: used_run_nos must not grow per no_live_judge");
    }
    // replays are still refused: the first, a middle and the last run_no
    for replay in [1u64, 25, 50] {
        assert!(fails(|| submit(&mut c, now, no_live(bet_id, &th, replay, now, now + DAY_NS_B))), "replay {replay}");
    }
    assert_eq!(c.get_bet(bet_id).unwrap().next_expected_run_no, 51);
    // and the next in-order run is still accepted
    submit(&mut c, now, no_live(bet_id, &th, 51, now, now + DAY_NS_B));
}

// (f)
#[test]
fn jcb1_no_live_judge_leaves_ladder_counters_unchanged() {
    let (mut c, bet_id, th) = setup();
    submit(&mut c, T0, retry_result(bet_id, &th, 1, T0, T0 + HOUR_NS));
    let before = c.get_bet(bet_id).unwrap();
    retire_all(&mut c);
    submit(&mut c, T0 + HOUR_NS, no_live(bet_id, &th, 2, T0 + HOUR_NS, T0 + 2 * HOUR_NS));
    let after = c.get_bet(bet_id).unwrap();
    assert_eq!(after.first_unavailable_ns, before.first_unavailable_ns);
    assert_eq!(after.retry_count, before.retry_count);
    assert_eq!(after.runs_used, before.runs_used);
    assert_eq!(after.no_live_judge_until_ns, Some(T0 + HOUR_NS + 12 * HOUR_NS));
}
