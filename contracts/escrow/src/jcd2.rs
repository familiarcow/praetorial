//! JCD2 (D-JCD1a, GATE-05 delta pass ea0643f finding B1): a retired judge model stays retired on the B2 snapshot path.
//! An in-flight verdict from a pair retired mid-flight is still ACCEPTED (D-JCD1 #2), but a success clears
//! `model_missing` only for models that are NOT retired at submit time. No money path is touched.
//! Child of tests.rs (`#[path]`), reuses its private helpers.
use super::*;

const HOUR_NS: u64 = 3_600 * 1_000_000_000;
const DAY_NS_D: u64 = 24 * HOUR_NS;
const T0: u64 = 5_000;

fn setup() -> (Contract, u64, String) {
    let mut c = new_contract();
    let (_, pk) = test_keypair(7);
    let pk_hex = hex_encode(&pk);
    let mut env = base_envelope(&pk_hex);
    env.resolve_deadline = 120 * DAY_NS_D;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)]);
    let bet_id = c.next_bet_id - 1;
    let resp = do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_msg(bet_id), 2);
    assert_eq!(resp, vec![U128(0)]);
    let th = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();
    (c, bet_id, th)
}

fn submit(c: &mut Contract, ts: u64, r: SubmittedResult) {
    ctx("anyone.testnet", ts);
    let sig = sign_result(&outcome_signing_key(), &r);
    c.submit_outcome(r, sig);
}

fn request(c: &mut Contract, bet_id: u64, ts: u64) {
    ctx_with_deposit("anyone.testnet", ts, NearToken::from_near(1));
    let _ = c.request_resolution(bet_id, None);
}

fn result(bet_id: u64, th: &str, outcome: &str, run_no: u64, now: u64, idx: u32) -> SubmittedResult {
    SubmittedResult {
        bet_id,
        terms_hash: th.to_string(),
        outcome: outcome.to_string(),
        element_results_hash: if outcome == "YES" { "e".repeat(64) } else { "0".repeat(64) },
        run_no,
        checked_until: U64(now),
        next_check_ns: None,
        judge_pair_index: idx,
        model_not_found: vec![],
    }
}

/// 3 observations, each >= 24h after the previous: retired.
fn retire(c: &mut Contract, model: &str) {
    c.model_missing.insert(model.to_string(), vec![1, 1 + DAY_NS_D, 1 + 2 * DAY_NS_D]);
}

fn retired(c: &Contract, m: &str) -> bool {
    c.retired_models().contains(&m.to_string())
}

/// Snapshot pair 0 at request time, then retire BOTH its models while the run is in flight.
fn inflight_retired_pair() -> (Contract, u64, String, JudgePair) {
    let (mut c, bet_id, th) = setup();
    request(&mut c, bet_id, T0);
    let p = c.judge_chain()[0].clone();
    retire(&mut c, &p.model_a);
    retire(&mut c, &p.model_b);
    assert!(retired(&c, &p.model_a) && retired(&c, &p.model_b));
    (c, bet_id, th, p)
}

fn stored(c: &Contract, p: &JudgePair) -> (Vec<U64>, Vec<U64>) {
    (c.model_missing(p.model_a.clone()), c.model_missing(p.model_b.clone()))
}

fn accepted_and_still_retired(outcome: &str) {
    let (mut c, bet_id, th, p) = inflight_retired_pair();
    let before = stored(&c, &p);
    submit(&mut c, T0 + 10, result(bet_id, &th, outcome, 1, T0 + 10, 0));
    let b = c.get_bet(bet_id).unwrap();
    assert_eq!(b.status, BetStatus::Proposed, "D-JCD1 #2: the in-flight result is accepted");
    assert_eq!(b.judge_pair_index, Some(0));
    assert!(retired(&c, &p.model_a), "model_a must stay retired");
    assert!(retired(&c, &p.model_b), "model_b must stay retired");
    assert_eq!(stored(&c, &p), before, "stored observations are byte-identical");
}

#[test]
fn jcd2_a_yes_from_a_pair_retired_mid_flight_is_accepted_and_the_models_stay_retired() {
    accepted_and_still_retired("YES");
}

#[test]
fn jcd2_b_no_from_a_pair_retired_mid_flight_is_accepted_and_the_models_stay_retired() {
    accepted_and_still_retired("NO");
}

#[test]
fn jcd2_b_void_other_from_a_pair_retired_mid_flight_is_accepted_and_the_models_stay_retired() {
    accepted_and_still_retired("VOID:source_conflict");
}

#[test]
fn jcd2_a_only_the_retired_model_is_kept_the_live_one_is_still_cleared() {
    let (mut c, bet_id, th) = setup();
    request(&mut c, bet_id, T0);
    let p = c.judge_chain()[0].clone();
    retire(&mut c, &p.model_a);
    // model_b has one observation, not retired
    c.model_missing.insert(p.model_b.clone(), vec![1]);
    let a_before = c.model_missing(p.model_a.clone());
    submit(&mut c, T0 + 10, result(bet_id, &th, "YES", 1, T0 + 10, 0));
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Proposed);
    assert!(retired(&c, &p.model_a));
    assert_eq!(c.model_missing(p.model_a.clone()), a_before);
    assert!(c.model_missing(p.model_b.clone()).is_empty(), "a non-retired model is still cleared by a success");
}

#[test]
fn jcd2_c_a_success_from_a_live_pair_still_clears_its_observations() {
    let (mut c, bet_id, th) = setup();
    request(&mut c, bet_id, T0);
    let p = c.judge_chain()[0].clone();
    c.model_missing.insert(p.model_a.clone(), vec![1, 1 + DAY_NS_D]);
    c.model_missing.insert(p.model_b.clone(), vec![1]);
    assert!(!retired(&c, &p.model_a));
    submit(&mut c, T0 + 10, result(bet_id, &th, "YES", 1, T0 + 10, 0));
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Proposed);
    assert!(c.model_missing(p.model_a.clone()).is_empty());
    assert!(c.model_missing(p.model_b.clone()).is_empty());
}

#[test]
fn jcd2_d_after_a_retired_pair_verdict_the_first_live_pair_is_the_next_one_not_the_retired_one() {
    let (mut c, bet_id, th, p) = inflight_retired_pair();
    assert!(c.judge_chain().len() >= 2);
    let live_pair = |c: &Contract| {
        let r = c.retired_models();
        c.judge_chain().into_iter().position(|q| !r.contains(&q.model_a) && !r.contains(&q.model_b))
    };
    let before = live_pair(&c);
    assert_ne!(before, Some(0));
    submit(&mut c, T0 + 10, result(bet_id, &th, "YES", 1, T0 + 10, 0));
    let after = live_pair(&c);
    assert_eq!(after, before, "the verdict must not make pair 0 live again");
    assert_ne!(after, Some(0));
    assert!(retired(&c, &p.model_a) && retired(&c, &p.model_b));
}
