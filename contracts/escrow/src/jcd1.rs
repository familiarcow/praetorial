//! JCD1 (D-JCD1, fixes from GATE-05 delta pass 6397f5f). RED-first tests:
//!  (a) B1: an accepted RETRY after a REAL `request_resolution` restores the prior status (Taken / Challenged /
//!      Evidence), clears `pending_resolution_request`, and the bet can be re-requested and later settle;
//!  (b) B2: a result signed with the request-time first-live pair index is accepted even if the chain changed
//!      between request and submit; an index that was never first-live is still refused;
//!  (c) B3: `observed_ns` must be within 1h before block time; one observation per model per result;
//!  (d) B5: events are emitted only after every check passed; `*_proposed` for the proposing half of a two-party
//!      commit, `*_amended` for the applying half.
//! Child of tests.rs (`#[path]`), reuses its private helpers.
use super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};

const ONE_YOCTO_D: NearToken = NearToken::from_yoctonear(1);
const HOUR_NS: u64 = 3_600 * 1_000_000_000;
const DAY_NS_D: u64 = 24 * HOUR_NS;
const WEEK_D: u64 = JUDGE_PAIR_DELAY_NS;
const T0: u64 = 5_000;

fn fails<F: FnOnce()>(f: F) -> bool {
    catch_unwind(AssertUnwindSafe(f)).is_err()
}

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
        next_check_ns: if outcome.starts_with("RETRY") { Some(U64(now + HOUR_NS)) } else { None },
        judge_pair_index: idx,
        model_not_found: vec![],
    }
}

fn obs(model: &str, ns: u64) -> ModelObservation {
    ModelObservation { model: model.to_string(), observed_ns: U64(ns) }
}

fn retire(c: &mut Contract, model: &str) {
    c.model_missing.insert(model.to_string(), vec![1, 1 + DAY_NS_D, 1 + 2 * DAY_NS_D]);
}

fn retire_pair(c: &mut Contract, i: usize) {
    let p = c.judge_chain()[i].clone();
    retire(c, &p.model_a);
    retire(c, &p.model_b);
}

fn retire_all(c: &mut Contract) {
    for i in 0..c.judge_chain().len() {
        retire_pair(c, i);
    }
}

fn pending_none(c: &Contract, bet_id: u64) -> bool {
    c.get_bet(bet_id).unwrap().pending_resolution_request.is_none()
}

fn status(c: &Contract, bet_id: u64) -> BetStatus {
    c.get_bet(bet_id).unwrap().status
}

#[derive(Clone, Copy, Debug)]
enum Prior {
    Taken,
    Challenged,
    Evidence,
}

/// Drive the bet to `prior`. Returns the next unused run_no (the run a fresh request will be assigned).
fn to_prior(c: &mut Contract, bet_id: u64, th: &str, prior: Prior) -> u64 {
    match prior {
        Prior::Taken => 1,
        Prior::Challenged | Prior::Evidence => {
            submit(c, T0, result(bet_id, th, "YES", 1, T0, 0));
            let bond = c.required_challenge_bond(bet_id, "taker.testnet".parse().unwrap()).unwrap().amount.0;
            do_mt_transfer(c, "taker.testnet", bond, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), T0 + 50);
            assert_eq!(status(c, bet_id), BetStatus::Challenged);
            if let Prior::Evidence = prior {
                ctx("taker.testnet", T0 + 60);
                c.submit_exhibits(bet_id, vec!["h".repeat(64)]);
                assert_eq!(status(c, bet_id), BetStatus::Evidence);
            }
            2
        }
    }
}

fn prior_status(p: Prior) -> BetStatus {
    match p {
        Prior::Taken => BetStatus::Taken,
        Prior::Challenged => BetStatus::Challenged,
        Prior::Evidence => BetStatus::Evidence,
    }
}

// ------------------------------------------------------------------------------------------------ (a) B1

fn outage_retry_then_rerequest(prior: Prior) {
    let (mut c, bet_id, th) = setup();
    let run = to_prior(&mut c, bet_id, &th, prior);
    let want = prior_status(prior);
    assert_eq!(status(&c, bet_id), want);

    let t1 = T0 + 1_000;
    request(&mut c, bet_id, t1);
    assert_eq!(status(&c, bet_id), BetStatus::Resolving, "{prior:?}: request sets Resolving");
    assert!(c.get_bet(bet_id).unwrap().pending_resolution_request.is_some());

    // the resolver reports an outage for the pending run
    submit(&mut c, t1 + 10, result(bet_id, &th, "RETRY", run, t1 + 10, 0));
    let b = c.get_bet(bet_id).unwrap();
    assert_eq!(b.status, want, "{prior:?}: accepted RETRY restores the prior status");
    assert!(b.pending_resolution_request.is_none(), "{prior:?}: pending request cleared");
    assert!(b.pending_run_no.is_none());
    assert_eq!(b.retry_count, 1);

    // re-request works (the keeper does this at next_check_ns)
    let t2 = t1 + 10 + HOUR_NS;
    ctx_with_deposit("anyone.testnet", t2, NearToken::from_near(1));
    assert_eq!(c.can_request_resolution(bet_id), None, "{prior:?}: can_request after next_check_ns");
    request(&mut c, bet_id, t2);
    assert_eq!(status(&c, bet_id), BetStatus::Resolving, "{prior:?}: second request accepted");
    assert!(c.get_bet(bet_id).unwrap().pending_resolution_request.is_some());

    // and a later YES settles normally
    submit(&mut c, t2 + 10, result(bet_id, &th, "YES", run + 1, t2 + 10, 0));
    let b = c.get_bet(bet_id).unwrap();
    assert_eq!(b.status, BetStatus::Proposed, "{prior:?}");
    assert_eq!(b.outcome.as_deref(), Some("YES"));
    if let Prior::Taken = prior {
        ctx("anyone.testnet", t2 + 10 + DAY_NS_D + 1);
        c.finalize(bet_id);
        assert_eq!(status(&c, bet_id), BetStatus::Finalized);
    }
}

#[test]
fn jcd1_a_outage_retry_after_real_request_restores_taken() {
    outage_retry_then_rerequest(Prior::Taken);
}

#[test]
fn jcd1_a_outage_retry_after_real_request_restores_challenged() {
    outage_retry_then_rerequest(Prior::Challenged);
}

#[test]
fn jcd1_a_outage_retry_after_real_request_restores_evidence() {
    outage_retry_then_rerequest(Prior::Evidence);
}

fn no_live_retry_then_rerequest(prior: Prior) {
    let (mut c, bet_id, th) = setup();
    let run = to_prior(&mut c, bet_id, &th, prior);
    let want = prior_status(prior);
    retire_all(&mut c);

    let t1 = T0 + 1_000;
    request(&mut c, bet_id, t1);
    assert_eq!(status(&c, bet_id), BetStatus::Resolving);
    submit(&mut c, t1 + 10, result(bet_id, &th, "RETRY:no_live_judge", run, t1 + 10, 0));
    let b = c.get_bet(bet_id).unwrap();
    assert_eq!(b.status, want, "{prior:?}: no_live_judge RETRY restores the prior status");
    assert!(b.pending_resolution_request.is_none());
    assert_eq!(b.retry_count, 0, "no_live_judge leaves the ladder counters alone");

    // D-JCB1: still gated until max(next_check, +12h) ...
    ctx("anyone.testnet", t1 + 10 + HOUR_NS);
    assert!(c.can_request_resolution(bet_id).is_some(), "{prior:?}: gated inside the JCB1 window");
    // ... then it succeeds once a judge is live again
    let t2 = t1 + 10 + 12 * HOUR_NS;
    for i in 0..c.judge_chain().len() {
        let p = c.judge_chain()[i].clone();
        c.model_missing.remove(&p.model_a);
        c.model_missing.remove(&p.model_b);
    }
    ctx("anyone.testnet", t2);
    assert_eq!(c.can_request_resolution(bet_id), None, "{prior:?}: allowed after the gap");
    request(&mut c, bet_id, t2);
    assert_eq!(status(&c, bet_id), BetStatus::Resolving, "{prior:?}: re-request accepted");
}

#[test]
fn jcd1_a_no_live_judge_retry_after_real_request_restores_taken_then_gated_then_succeeds() {
    no_live_retry_then_rerequest(Prior::Taken);
}

#[test]
fn jcd1_a_no_live_judge_retry_after_real_request_restores_challenged() {
    no_live_retry_then_rerequest(Prior::Challenged);
}

#[test]
fn jcd1_a_no_live_judge_retry_after_real_request_restores_evidence() {
    no_live_retry_then_rerequest(Prior::Evidence);
}

#[test]
fn jcd1_a_retry_without_a_request_leaves_status_alone() {
    // pre-existing behaviour (tests.rs RETRY tests start here) must not change
    let (mut c, bet_id, th) = setup();
    submit(&mut c, T0, result(bet_id, &th, "RETRY", 1, T0, 0));
    assert_eq!(status(&c, bet_id), BetStatus::Taken);
    assert!(pending_none(&c, bet_id));
}

// ------------------------------------------------------------------------------------------------ (b) B2

#[test]
fn jcd1_b_in_flight_result_with_request_time_first_live_index_survives_a_retirement() {
    let (mut c, bet_id, th) = setup();
    request(&mut c, bet_id, T0);
    assert_eq!(c.judge_chain().len() >= 2, true);
    // another bet's signed observations retire pair 0 while this run is in flight
    retire_pair(&mut c, 0);
    submit(&mut c, T0 + 10, result(bet_id, &th, "YES", 1, T0 + 10, 0));
    let b = c.get_bet(bet_id).unwrap();
    assert_eq!(b.status, BetStatus::Proposed, "the honest in-flight result signed with idx 0 is accepted");
    assert_eq!(b.judge_pair_index, Some(0));
}

#[test]
fn jcd1_b_in_flight_retry_with_request_time_first_live_index_survives_a_retirement() {
    let (mut c, bet_id, th) = setup();
    request(&mut c, bet_id, T0);
    retire_pair(&mut c, 0);
    submit(&mut c, T0 + 10, result(bet_id, &th, "RETRY", 1, T0 + 10, 0));
    assert_eq!(c.get_bet(bet_id).unwrap().retry_count, 1);
    assert_eq!(status(&c, bet_id), BetStatus::Taken);
}

#[test]
fn jcd1_b_third_observation_landing_mid_flight_does_not_strand_the_result() {
    let (mut c, bet_id, th) = setup();
    let m0 = c.judge_chain()[0].model_a.clone();
    c.model_missing.insert(m0.clone(), vec![1, 1 + DAY_NS_D]);
    request(&mut c, bet_id, T0 + 3 * DAY_NS_D);
    // a 3rd (real, fresh) observation of pair 0's model lands via another bet's run
    c.model_missing.insert(m0, vec![1, 1 + DAY_NS_D, T0 + 3 * DAY_NS_D]);
    submit(&mut c, T0 + 3 * DAY_NS_D + 10, result(bet_id, &th, "YES", 1, T0 + 3 * DAY_NS_D + 10, 0));
    assert_eq!(status(&c, bet_id), BetStatus::Proposed);
}

#[test]
fn jcd1_b_an_index_that_was_never_first_live_is_still_refused() {
    // request-time first-live is 0: index 1 was never first-live, stored or snapshotted.
    let (mut c, bet_id, th) = setup();
    request(&mut c, bet_id, T0);
    let r = result(bet_id, &th, "YES", 1, T0 + 10, 1);
    assert!(fails(|| submit(&mut c, T0 + 10, r)), "idx 1 was never first-live");
    assert_eq!(status(&c, bet_id), BetStatus::Resolving);
    // even after pair 0 retires mid-flight, idx 2 (never first-live) is refused, idx 1 (post) is fine for a fresh state
    retire_pair(&mut c, 0);
    let r = result(bet_id, &th, "YES", 1, T0 + 20, 2);
    assert!(fails(|| submit(&mut c, T0 + 20, r)), "idx 2 was never first-live");
}

#[test]
fn jcd1_b_the_snapshot_covers_only_the_run_it_belongs_to() {
    // after the in-flight run's RETRY the snapshot is gone: a later run signed with the stale idx 0 is refused
    let (mut c, bet_id, th) = setup();
    request(&mut c, bet_id, T0);
    submit(&mut c, T0 + 10, result(bet_id, &th, "RETRY", 1, T0 + 10, 0));
    retire_pair(&mut c, 0);
    // no new request: a result for run 2 signed at stale idx 0 must be refused (no snapshot, pair 0 retired)
    let r = result(bet_id, &th, "YES", 2, T0 + 20, 0);
    assert!(fails(|| submit(&mut c, T0 + 20, r)));
    // a fresh request snapshots the NEW first-live (1)
    request(&mut c, bet_id, T0 + 10 + HOUR_NS);
    let r = result(bet_id, &th, "YES", 2, T0 + 30 + HOUR_NS, 0);
    assert!(fails(|| submit(&mut c, T0 + 30 + HOUR_NS, r)), "stale idx 0 refused for the new run");
    submit(&mut c, T0 + 40 + HOUR_NS, result(bet_id, &th, "YES", 2, T0 + 40 + HOUR_NS, 1));
    assert_eq!(status(&c, bet_id), BetStatus::Proposed);
}

#[test]
fn jcd1_b_no_live_judge_in_flight_survives_a_guardian_pair_apply() {
    let (mut c, bet_id, th) = setup();
    retire_all(&mut c);
    request(&mut c, bet_id, T0);
    ctx_with_deposit(GUARDIAN, T0 + 1, ONE_YOCTO_D);
    c.propose_judge_pair(JudgePair { model_a: "neworg/a".to_string(), model_b: "neworg/b".to_string() });
    ctx("anyone.testnet", T0 + 1 + WEEK_D);
    c.apply_judge_pair();
    // the resolver (stateless, request-time view: nothing live) signs no_live_judge for the in-flight run
    submit(&mut c, T0 + 2 + WEEK_D, SubmittedResult { next_check_ns: Some(U64(T0 + 2 + WEEK_D + DAY_NS_D)), ..result(bet_id, &th, "RETRY:no_live_judge", 1, T0 + 2 + WEEK_D, 0) });
    assert_eq!(status(&c, bet_id), BetStatus::Taken);
    assert!(pending_none(&c, bet_id));
}

// ------------------------------------------------------------------------------------------------ (c) B3

fn retry_obs(bet_id: u64, th: &str, run: u64, now: u64, o: Vec<ModelObservation>) -> SubmittedResult {
    SubmittedResult { model_not_found: o, ..result(bet_id, th, "RETRY", run, now, 0) }
}

#[test]
fn jcd1_c_observation_older_than_one_hour_is_refused_but_exactly_one_hour_is_fine() {
    let now = 10 * DAY_NS_D;
    let (mut c, bet_id, th) = setup();
    let m = c.judge_chain()[0].model_a.clone();
    let r = retry_obs(bet_id, &th, 1, now, vec![obs(&m, now - HOUR_NS - 1)]);
    assert!(fails(|| submit(&mut c, now, r)), "now - 1h - 1ns is too old");
    assert!(c.model_missing(m.clone()).is_empty());
    submit(&mut c, now, retry_obs(bet_id, &th, 1, now, vec![obs(&m, now - HOUR_NS)]));
    assert_eq!(c.model_missing(m).len(), 1);
}

#[test]
fn jcd1_c_future_observation_still_refused() {
    let now = 10 * DAY_NS_D;
    let (mut c, bet_id, th) = setup();
    let m = c.judge_chain()[0].model_a.clone();
    let r = retry_obs(bet_id, &th, 1, now, vec![obs(&m, now + 1)]);
    assert!(fails(|| submit(&mut c, now, r)));
}

#[test]
fn jcd1_c_two_observations_of_the_same_model_in_one_result_are_refused() {
    let now = 10 * DAY_NS_D;
    let (mut c, bet_id, th) = setup();
    let m = c.judge_chain()[0].model_a.clone();
    // same model twice (even though 2nd would be dropped as < 24h by add_observation today)
    let r = retry_obs(bet_id, &th, 1, now, vec![obs(&m, now - 10), obs(&m, now)]);
    assert!(fails(|| submit(&mut c, now, r)), "two obs of one model in one result");
    // a backdated triple cannot retire a model in one result
    let r = retry_obs(bet_id, &th, 1, now, vec![obs(&m, now - 2 * DAY_NS_D), obs(&m, now - DAY_NS_D), obs(&m, now)]);
    assert!(fails(|| submit(&mut c, now, r)), "backdated triple");
    assert!(c.retired_models().is_empty());
    // one observation each for the two models of a pair is fine
    let m2 = c.judge_chain()[0].model_b.clone();
    submit(&mut c, now, retry_obs(bet_id, &th, 1, now, vec![obs(&m, now), obs(&m2, now)]));
    assert_eq!(c.model_missing(m).len(), 1);
    assert_eq!(c.model_missing(m2).len(), 1);
}

#[test]
fn jcd1_c_retirement_still_needs_three_separate_results_at_least_24h_apart() {
    let (mut c, bet_id, th) = setup();
    let m = c.judge_chain()[0].model_a.clone();
    let t = 10 * DAY_NS_D;
    // 3 results 23h apart: only the first and (not the second, <24h after the first) ... never retired
    submit(&mut c, t, retry_obs(bet_id, &th, 1, t, vec![obs(&m, t)]));
    submit(&mut c, t + 23 * HOUR_NS, retry_obs(bet_id, &th, 2, t + 23 * HOUR_NS, vec![obs(&m, t + 23 * HOUR_NS)]));
    submit(&mut c, t + 46 * HOUR_NS, retry_obs(bet_id, &th, 3, t + 46 * HOUR_NS, vec![obs(&m, t + 46 * HOUR_NS)]));
    assert!(!c.retired_models().contains(&m), "23h-apart checks do not retire");

    // fresh contract: 3 results exactly 24h apart retire
    let (mut c, bet_id, th) = setup();
    let m = c.judge_chain()[0].model_a.clone();
    for k in 0..3u64 {
        let now = t + k * DAY_NS_D;
        submit(&mut c, now, retry_obs(bet_id, &th, k + 1, now, vec![obs(&m, now)]));
    }
    assert!(c.retired_models().contains(&m), "3 results 24h apart retire the model");
}

// ------------------------------------------------------------------------------------------------ (d) B5

fn event_names(logs: &[String]) -> Vec<String> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<serde_json::Value>(j).unwrap()["event"].as_str().unwrap().to_string())
        .collect()
}

fn event_logs() -> Vec<String> {
    near_sdk::test_utils::get_logs().into_iter().filter(|l| l.starts_with("EVENT_JSON:")).collect()
}

fn open_bet_only() -> (Contract, u64) {
    let mut c = new_contract();
    let (_, pk) = test_keypair(7);
    let env = base_envelope(&hex_encode(&pk));
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)]);
    let id = c.next_bet_id - 1;
    (c, id)
}

#[test]
fn jcd1_d_amend_events_only_after_checks_proposed_then_amended() {
    let (mut c, bet_id, _) = setup();
    // failing calls (stranger / unknown bet / after funding_deadline) emit nothing
    ctx("stranger.testnet", 3);
    assert!(fails(|| c.amend(bet_id, "b".repeat(64))));
    assert!(event_logs().is_empty(), "stranger's failed amend emitted: {:?}", event_logs());
    ctx("maker.testnet", 3);
    assert!(fails(|| c.amend(9999, "b".repeat(64))));
    assert!(event_logs().is_empty(), "amend on unknown bet emitted: {:?}", event_logs());
    ctx("maker.testnet", 1_001);
    assert!(fails(|| c.amend(bet_id, "b".repeat(64))));
    assert!(event_logs().is_empty(), "late amend emitted: {:?}", event_logs());

    // maker's call only PROPOSES
    ctx("maker.testnet", 4);
    c.amend(bet_id, "b".repeat(64));
    assert_eq!(event_names(&event_logs()), vec!["terms_amend_proposed"]);
    assert_eq!(c.get_bet(bet_id).unwrap().envelope.terms_hash, "terms-hash-1");
    // taker's matching call APPLIES
    ctx("taker.testnet", 5);
    c.amend(bet_id, "b".repeat(64));
    assert_eq!(event_names(&event_logs()), vec!["terms_amended"]);
    assert_eq!(c.get_bet(bet_id).unwrap().envelope.terms_hash, "b".repeat(64));
}

#[test]
fn jcd1_d_amend_referee_events_only_after_checks_proposed_then_amended() {
    let (mut c, bet_id, _) = setup();
    let r = serde_json::to_string(&Some(Referee { account: "referee.testnet".parse().unwrap(), mode: RefereeMode::Human })).unwrap();
    // failing: shutdown-independent bad json / stranger / referee == maker: nothing emitted
    ctx("maker.testnet", 3);
    assert!(fails(|| c.amend_referee(bet_id, "not json".to_string())));
    assert!(event_logs().is_empty(), "bad json emitted: {:?}", event_logs());
    ctx("stranger.testnet", 3);
    assert!(fails(|| c.amend_referee(bet_id, r.clone())));
    assert!(event_logs().is_empty(), "stranger emitted: {:?}", event_logs());
    let bad = serde_json::to_string(&Some(Referee { account: "maker.testnet".parse().unwrap(), mode: RefereeMode::Human })).unwrap();
    ctx("maker.testnet", 3);
    assert!(fails(|| c.amend_referee(bet_id, bad)));
    assert!(event_logs().is_empty(), "invalid referee emitted: {:?}", event_logs());

    // taken bet: maker proposes, taker applies
    ctx("maker.testnet", 4);
    c.amend_referee(bet_id, r.clone());
    assert_eq!(event_names(&event_logs()), vec!["referee_amend_proposed"]);
    assert!(c.get_bet(bet_id).unwrap().envelope.referee.is_none());
    ctx("taker.testnet", 5);
    c.amend_referee(bet_id, r);
    assert_eq!(event_names(&event_logs()), vec!["referee_amended"]);
    assert!(c.get_bet(bet_id).unwrap().envelope.referee.is_some());
}

#[test]
fn jcd1_d_amend_referee_on_an_untaken_offer_is_applied_at_once_and_says_amended() {
    let (mut c, bet_id) = open_bet_only();
    let r = serde_json::to_string(&Some(Referee { account: "referee.testnet".parse().unwrap(), mode: RefereeMode::Human })).unwrap();
    ctx("stranger.testnet", 3);
    assert!(fails(|| c.amend_referee(bet_id, r.clone())));
    assert!(event_logs().is_empty(), "stranger emitted: {:?}", event_logs());
    ctx("maker.testnet", 4);
    c.amend_referee(bet_id, r);
    assert_eq!(event_names(&event_logs()), vec!["referee_amended"]);
}

/// Every event-emitting method: a call that panics emits no EVENT_JSON line.
#[test]
fn jcd1_d_a_failing_call_to_any_event_emitting_method_emits_no_event() {
    type Case = (&'static str, Box<dyn Fn() -> bool>);
    let cases: Vec<Case> = vec![
        ("cancel by stranger", Box::new(|| { let (mut c, id) = open_bet_only(); ctx("stranger.testnet", 3); fails(|| c.cancel(id)) })),
        ("expire too early", Box::new(|| { let (mut c, id) = open_bet_only(); ctx("anyone.testnet", 3); fails(|| c.expire(id)) })),
        ("reclaim by stranger", Box::new(|| { let (mut c, id) = open_bet_only(); ctx("stranger.testnet", 3); fails(|| c.reclaim(id)) })),
        ("finalize too early", Box::new(|| { let (mut c, id, _) = setup(); ctx("anyone.testnet", 3); fails(|| c.finalize(id)) })),
        ("void_after_deadline too early", Box::new(|| { let (mut c, id, _) = setup(); ctx("anyone.testnet", 3); fails(|| c.void_after_deadline(id)) })),
        ("concede by stranger", Box::new(|| { let (mut c, id, _) = setup(); ctx("stranger.testnet", 3); fails(|| c.concede(id)) })),
        ("referee_rule on an AI bet", Box::new(|| { let (mut c, id, _) = setup(); ctx("referee.testnet", 3_000); fails(|| c.referee_rule(id, "YES".to_string())) })),
        ("submit_outcome bad run_no", Box::new(|| { let (mut c, id, th) = setup(); let r = result(id, &th, "YES", 9, 2_000, 0); fails(|| submit(&mut c, 2_000, r)) })),
        ("submit_outcome bad index", Box::new(|| { let (mut c, id, th) = setup(); let r = result(id, &th, "YES", 1, 2_000, 99); fails(|| submit(&mut c, 2_000, r)) })),
        ("submit_outcome bad signature", Box::new(|| { let (mut c, id, th) = setup(); let r = result(id, &th, "YES", 1, 2_000, 0); ctx("anyone.testnet", 2_000); fails(|| c.submit_outcome(r, "00".repeat(64))) })),
        ("propose_judge_pair by stranger", Box::new(|| { let mut c = new_contract(); ctx_with_deposit("stranger.testnet", 5, ONE_YOCTO_D); fails(|| c.propose_judge_pair(JudgePair { model_a: "n/a".to_string(), model_b: "n/b".to_string() })) })),
        ("propose_judge_pair invalid ids", Box::new(|| { let mut c = new_contract(); ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO_D); fails(|| c.propose_judge_pair(JudgePair { model_a: "bad".to_string(), model_b: "n/b".to_string() })) })),
        ("apply_judge_pair with none pending", Box::new(|| { let mut c = new_contract(); ctx("anyone.testnet", 5); fails(|| c.apply_judge_pair()) })),
        ("apply_judge_pair too early", Box::new(|| { let mut c = new_contract(); ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO_D); c.propose_judge_pair(JudgePair { model_a: "n/a".to_string(), model_b: "n/b".to_string() }); ctx("anyone.testnet", 6); fails(|| c.apply_judge_pair()) })),
        ("cancel_judge_pair by stranger", Box::new(|| { let mut c = new_contract(); ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO_D); c.propose_judge_pair(JudgePair { model_a: "n/a".to_string(), model_b: "n/b".to_string() }); ctx_with_deposit("stranger.testnet", 6, ONE_YOCTO_D); fails(|| c.cancel_judge_pair()) })),
        ("set_guardian by stranger", Box::new(|| { let mut c = new_contract(); ctx_with_deposit("stranger.testnet", 5, ONE_YOCTO_D); fails(|| c.set_guardian("ng.testnet".parse().unwrap())) })),
        ("accept_guardian with none pending", Box::new(|| { let mut c = new_contract(); ctx_with_deposit("ng.testnet", 5, ONE_YOCTO_D); fails(|| c.accept_guardian()) })),
        ("accept_guardian by wrong account", Box::new(|| { let mut c = new_contract(); ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO_D); c.set_guardian("ng.testnet".parse().unwrap()); ctx_with_deposit("stranger.testnet", 6, ONE_YOCTO_D); fails(|| c.accept_guardian()) })),
        ("cancel_guardian with none pending", Box::new(|| { let mut c = new_contract(); ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO_D); fails(|| c.cancel_guardian()) })),
        ("pause by stranger", Box::new(|| { let mut c = new_contract(); ctx_with_deposit("stranger.testnet", 5, ONE_YOCTO_D); fails(|| c.pause_new_offers()) })),
        ("unpause by stranger", Box::new(|| { let mut c = new_contract(); ctx_with_deposit("stranger.testnet", 5, ONE_YOCTO_D); fails(|| c.unpause_new_offers()) })),
        ("emergency_shutdown by stranger", Box::new(|| { let mut c = new_contract(); ctx_with_deposit("stranger.testnet", 5, ONE_YOCTO_D); fails(|| c.emergency_shutdown()) })),
        ("emergency_refund before shutdown", Box::new(|| { let (mut c, id, _) = setup(); ctx("anyone.testnet", 5); fails(|| c.emergency_refund(id)) })),
        ("amend by stranger", Box::new(|| { let (mut c, id, _) = setup(); ctx("stranger.testnet", 3); fails(|| c.amend(id, "b".repeat(64))) })),
        ("amend_referee by stranger", Box::new(|| { let (mut c, id, _) = setup(); ctx("stranger.testnet", 3); fails(|| c.amend_referee(id, "null".to_string())) })),
    ];
    let mut bad: Vec<String> = Vec::new();
    for (label, f) in cases {
        near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
        // the case itself builds state (which may legitimately log events) and ends with the failing call; so the
        // failing call's context is set last inside `f`, which resets the log buffer for the failing call only.
        let panicked = f();
        if !panicked {
            bad.push(format!("{label}: expected the call to panic (case is not a failing path)"));
            continue;
        }
        let ev = event_logs();
        if !ev.is_empty() {
            bad.push(format!("{label}: a panicking call emitted {ev:?}"));
        }
    }
    assert!(bad.is_empty(), "{bad:#?}");
}
