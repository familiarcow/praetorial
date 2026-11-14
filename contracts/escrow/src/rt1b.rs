//! RT1b: focused red-team session on the post-JC1 escrow (main 6837b00). Every test is one attack. A passing test
//! PINS a refusal (or an accepted-by-design behaviour, named as such); a failing test is a finding.
//! Child of tests.rs (`#[path]`), reuses its private helpers. See docs/REDTEAM-RT1b.md.
use super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};

const HOUR: u64 = 3_600 * 1_000_000_000;
const DAY_T: u64 = 24 * HOUR;
const ONE_Y: NearToken = NearToken::from_yoctonear(1);

fn panic_msg<F: FnOnce()>(f: F) -> Option<String> {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let r = catch_unwind(AssertUnwindSafe(f));
    std::panic::set_hook(prev);
    r.err().map(|e| e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default())
}

fn refused<F: FnOnce()>(what: &str, needle: &str, f: F) {
    let m = panic_msg(f).unwrap_or_else(|| panic!("{what}: expected a refusal containing `{needle}`, but the call succeeded"));
    assert!(m.contains(needle), "{what}: refusal `{m}` does not contain `{needle}`");
}

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// Taken USDC bet, 120-day resolve deadline so day-scale timelines fit.
fn setup() -> (Contract, u64, String) {
    let mut c = new_contract();
    let (_, pk) = test_keypair(7);
    let mut env = base_envelope(&hex_encode(&pk));
    env.resolve_deadline = 120 * DAY_T;
    let r = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(r, vec![U128(0)]);
    let id = c.next_bet_id - 1;
    let r = do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_msg(id), 2);
    assert_eq!(r, vec![U128(0)]);
    let th = c.get_bet(id).unwrap().envelope.terms_hash.clone();
    (c, id, th)
}

fn obs(model: &str, ns: u64) -> ModelObservation {
    ModelObservation { model: model.to_string(), observed_ns: U64(ns) }
}

fn sign_submit(c: &mut Contract, ts: u64, r: SubmittedResult) {
    ctx("anyone.testnet", ts);
    let sig = sign_result(&outcome_signing_key(), &r);
    c.submit_outcome(r, sig);
}

fn res(bet_id: u64, th: &str, outcome: &str, run_no: u64, now: u64, idx: u32, o: Vec<ModelObservation>) -> SubmittedResult {
    let retry = outcome.starts_with("RETRY");
    SubmittedResult {
        bet_id,
        terms_hash: th.to_string(),
        outcome: outcome.to_string(),
        element_results_hash: if retry { "0".repeat(64) } else { "e".repeat(64) },
        run_no,
        checked_until: U64(now),
        next_check_ns: if retry { Some(U64(now + HOUR)) } else { None },
        judge_pair_index: idx,
        model_not_found: o,
    }
}

fn model(c: &Contract, pair: usize, a: bool) -> String {
    let p = &c.judge_chain()[pair];
    if a { p.model_a.clone() } else { p.model_b.clone() }
}

fn retire_pair0_directly(c: &mut Contract) {
    for m in [model(c, 0, true), model(c, 0, false)] {
        c.model_missing.insert(m, vec![1, 1 + DAY_T, 1 + 2 * DAY_T]);
    }
}

fn retire_all(c: &mut Contract) {
    for p in c.judge_chain() {
        for m in [p.model_a, p.model_b] {
            c.model_missing.insert(m, vec![1, 1 + DAY_T, 1 + 2 * DAY_T]);
        }
    }
}

fn lines_sum(c: &Contract, id: u64, token: &str) -> u128 {
    c.pending_payouts(id).iter().filter(|p| p.token_id == token).map(|p| p.amount.0).sum()
}

fn request(c: &mut Contract, id: u64, ts: u64) {
    ctx_with_deposit("anyone.testnet", ts, NearToken::from_near(1));
    let _ = c.request_resolution(id, None);
}

// =================================================================== A. retirement spoofing (orchestrator #1)

#[test]
fn rt1b_a1_one_result_cannot_retire_a_model_three_observations_of_one_model_refused() {
    let (mut c, id, th) = setup();
    let t = 10 * DAY_T;
    let m = model(&c, 0, true);
    let r = res(id, &th, "RETRY", 1, t, 1, vec![obs(&m, t), obs(&m, t), obs(&m, t)]);
    ctx("anyone.testnet", t);
    let sig = sign_result(&outcome_signing_key(), &r);
    refused("3 obs of one model in one result", "at most one observation per model", || c.submit_outcome(r, sig));
}

#[test]
fn rt1b_a1_one_result_observing_both_models_of_pair0_does_not_unlock_pair1() {
    // A single result carries at most ONE observation per model: pair 0's two models get one each -> neither retired.
    let (mut c, id, th) = setup();
    let t = 10 * DAY_T;
    let (a, b) = (model(&c, 0, true), model(&c, 0, false));
    let r = res(id, &th, "RETRY", 1, t, 1, vec![obs(&a, t), obs(&b, t)]);
    ctx("anyone.testnet", t);
    let sig = sign_result(&outcome_signing_key(), &r);
    refused("retire+walk in one result", "not the first live", || c.submit_outcome(r, sig));
    assert!(c.get_bet(id).unwrap().runs_used == 0 && c.get_bet(id).unwrap().next_expected_run_no == 1, "refusal is a no-op");
}

#[test]
fn rt1b_a1_observations_less_than_24h_apart_do_not_accumulate_across_results() {
    let (mut c, id, th) = setup();
    let m = model(&c, 0, true);
    let t0 = 10 * DAY_T;
    // three results 10h apart, each with a fresh observation: the 2nd/3rd are < 24h after the last kept one.
    for k in 0..3u64 {
        let now = t0 + k * 10 * HOUR;
        sign_submit(&mut c, now, res(id, &th, "RETRY", 1 + k, now, 0, vec![obs(&m, now)]));
    }
    let r = res(id, &th, "RETRY", 4, t0 + 30 * HOUR, 1, vec![]);
    ctx("anyone.testnet", t0 + 30 * HOUR);
    let sig = sign_result(&outcome_signing_key(), &r);
    refused("claim pair 1 with a 1-observation model", "not the first live", || c.submit_outcome(r, sig));
}

#[test]
fn rt1b_a1_minimum_time_to_retire_is_47h_over_three_results_not_less() {
    // Documented residual (RT1b-3, Low): the 1h freshness window lets the FIRST observation be backdated by 1h
    // (observed_ns >= now - 1h), so the earliest 3-result retirement spans 47h of results, not 48h. Never faster.
    let (mut c, id, th) = setup();
    let m = model(&c, 0, true);
    let t0 = 10 * DAY_T;
    sign_submit(&mut c, t0, res(id, &th, "RETRY", 1, t0, 0, vec![obs(&m, t0 - HOUR)]));
    sign_submit(&mut c, t0 + 23 * HOUR, res(id, &th, "RETRY", 2, t0 + 23 * HOUR, 0, vec![obs(&m, t0 + 23 * HOUR)]));
    // third observation 1ns short of 24h after the second: not a new check -> pair 1 still refused.
    let now = t0 + 47 * HOUR - 1;
    let r = res(id, &th, "RETRY", 3, now, 1, vec![obs(&m, now)]);
    ctx("anyone.testnet", now);
    let sig = sign_result(&outcome_signing_key(), &r);
    refused("46h59m59s", "not the first live", || c.submit_outcome(r, sig));
    // exactly 47h after the first result: retires in-run and walks (JC1x by design).
    let now = t0 + 47 * HOUR;
    sign_submit(&mut c, now, res(id, &th, "RETRY", 3, now, 1, vec![obs(&m, now)]));
    assert!(model_retired(&c.model_missing.get(&m).unwrap()), "retired after exactly 3 spaced observations");
}

#[test]
fn rt1b_a1_future_or_stale_observation_cannot_shortcut_spacing() {
    let (mut c, id, th) = setup();
    let m = model(&c, 0, true);
    let t = 10 * DAY_T;
    for (what, ns, needle) in [("future", t + 1, "in the future"), ("2h old", t - 2 * HOUR, "older than 1h")] {
        let r = res(id, &th, "RETRY", 1, t, 0, vec![obs(&m, ns)]);
        ctx("anyone.testnet", t);
        let sig = sign_result(&outcome_signing_key(), &r);
        refused(what, needle, || c.submit_outcome(r, sig));
    }
}

#[test]
fn rt1b_a1_provider_blip_two_404s_then_a_success_resets_and_three_more_are_needed() {
    // "Forced 404s / provider blips": two spaced 404s, then pair 0 answers YES -> observations cleared.
    let (mut c, id, th) = setup();
    let m = model(&c, 0, true);
    let t0 = 10 * DAY_T;
    sign_submit(&mut c, t0, res(id, &th, "RETRY", 1, t0, 0, vec![obs(&m, t0)]));
    sign_submit(&mut c, t0 + DAY_T, res(id, &th, "RETRY", 2, t0 + DAY_T, 0, vec![obs(&m, t0 + DAY_T)]));
    assert_eq!(c.model_missing.get(&m).unwrap().len(), 2);
    sign_submit(&mut c, t0 + 2 * DAY_T, res(id, &th, "YES", 3, t0 + 2 * DAY_T, 0, vec![]));
    assert!(c.model_missing.get(&m).is_none(), "a clean success clears a non-retired model's history");
}

#[test]
fn rt1b_a1_a_resolver_cannot_claim_retirement_without_observations() {
    let (mut c, id, th) = setup();
    let t = 10 * DAY_T;
    let r = res(id, &th, "YES", 1, t, 1, vec![]);
    ctx("anyone.testnet", t);
    let sig = sign_result(&outcome_signing_key(), &r);
    refused("claim pair 1 while pair 0 is live", "not the first live", || c.submit_outcome(r, sig));
    // and the symmetric lie: claiming pair 0 after it is retired.
    retire_pair0_directly(&mut c);
    let r = res(id, &th, "YES", 1, t, 0, vec![]);
    ctx("anyone.testnet", t);
    let sig = sign_result(&outcome_signing_key(), &r);
    refused("claim retired pair 0", "not the first live", || c.submit_outcome(r, sig));
}

#[test]
fn rt1b_a1_no_live_judge_refused_while_any_pair_is_live_even_with_in_result_observations() {
    let (mut c, id, th) = setup();
    let t = 10 * DAY_T;
    let (a, b) = (model(&c, 0, true), model(&c, 0, false));
    // pair 0 observed once each (not retired), pair 1 untouched: pair 0 is live.
    let mut r = res(id, &th, "RETRY:no_live_judge", 1, t, 0, vec![obs(&a, t), obs(&b, t)]);
    r.next_check_ns = Some(U64(t + DAY_T));
    ctx("anyone.testnet", t);
    let sig = sign_result(&outcome_signing_key(), &r);
    refused("no_live with live pair", "no_live_judge", || c.submit_outcome(r, sig));
}

// =================================================================== B. no_live_judge loops (orchestrator #2, #3)

fn no_live(id: u64, th: &str, run_no: u64, now: u64, next_check: u64) -> SubmittedResult {
    let mut r = res(id, th, "RETRY:no_live_judge", run_no, now, 0, vec![]);
    r.next_check_ns = Some(U64(next_check));
    r
}

#[test]
fn rt1b_b2_no_live_judge_cycles_do_not_bump_runs_used_and_request_gate_holds_12h() {
    let (mut c, id, th) = setup();
    retire_all(&mut c);
    let mut t = 10 * DAY_T;
    let mut requests = 0;
    for _ in 0..4 {
        request(&mut c, id, t);
        requests += 1;
        let b = c.get_bet(id).unwrap();
        assert_eq!(b.status, BetStatus::Resolving);
        let run = b.pending_run_no.unwrap();
        // next_check_ns = now+1 (the resolver asks for an immediate retry): the 12h floor still applies.
        sign_submit(&mut c, t + 1, no_live(id, &th, run, t + 1, t + 2));
        let b = c.get_bet(id).unwrap();
        assert_eq!(b.status, BetStatus::Taken, "request restored");
        assert_eq!(b.runs_used, 0, "no_live_judge never consumes the paid-run budget");
        assert_eq!(b.retry_count, 0);
        assert!(b.first_unavailable_ns.is_none(), "no recovery-ladder engagement");
        assert!(b.used_run_nos.is_empty(), "no_live run_no not recorded: storage stays bounded");
        // immediate re-request refused for 12h
        refused("re-request inside 12h", "waiting for a live judge model", || request(&mut c, id, t + 2));
        refused("re-request at 12h-1", "waiting for a live judge model", || request(&mut c, id, t + 1 + 12 * HOUR - 1));
        t = t + 1 + 12 * HOUR; // exactly at the gate
    }
    assert_eq!(requests, 4);
    // 4 requests in 36h+: bounded at one paid run per 12h, never free.
}

#[test]
fn rt1b_b3_replay_of_an_old_signed_no_live_result_is_refused_strict_run_order() {
    let (mut c, id, th) = setup();
    retire_all(&mut c);
    let t = 10 * DAY_T;
    request(&mut c, id, t);
    let run = c.get_bet(id).unwrap().pending_run_no.unwrap();
    let r = no_live(id, &th, run, t + 1, t + 2 * HOUR);
    let sig = sign_result(&outcome_signing_key(), &r);
    ctx("anyone.testnet", t + 1);
    c.submit_outcome(r.clone(), sig.clone());
    // identical replay, immediately and a day later (after a fresh request to make a run pending again)
    ctx("anyone.testnet", t + 2);
    refused("replay now", "run_no", || c.submit_outcome(r.clone(), sig.clone()));
    let t2 = t + 1 + DAY_T;
    request(&mut c, id, t2);
    ctx("anyone.testnet", t2 + 1);
    refused("replay after re-request", "run_no", || c.submit_outcome(r.clone(), sig.clone()));
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Resolving, "replay did not clear the in-flight request");
}

#[test]
fn rt1b_b4_a_no_live_loop_cannot_keep_a_bet_from_the_deadline_void_and_it_conserves() {
    let (mut c, id, th) = setup();
    retire_all(&mut c);
    let mut t = 10 * DAY_T;
    let mut run = 1;
    // resolver keeps answering no_live with the max 48h horizon, all the way to the deadline.
    while t + 48 * HOUR < 120 * DAY_T {
        sign_submit(&mut c, t, no_live(id, &th, run, t, t + 48 * HOUR));
        run += 1;
        t += 48 * HOUR;
    }
    assert!(c.get_bet(id).unwrap().used_run_nos.is_empty());
    ctx("anyone.testnet", 120 * DAY_T + 1);
    c.void_after_deadline(id);
    let b = c.get_bet(id).unwrap();
    assert_eq!(b.status, BetStatus::Voided);
    let dep = 2 * (1_000_000u128) + b.storage_maker.0 + b.storage_taker.0;
    assert_eq!(lines_sum(&c, id, USDC), dep, "I-2: void pays back exactly what was deposited");
}

#[test]
fn rt1b_b5_no_live_judge_while_a_request_is_in_flight_for_a_different_run_no_is_refused() {
    let (mut c, id, th) = setup();
    retire_all(&mut c);
    let t = 10 * DAY_T;
    request(&mut c, id, t);
    let run = c.get_bet(id).unwrap().pending_run_no.unwrap();
    let r = no_live(id, &th, run + 1, t + 1, t + HOUR);
    ctx("anyone.testnet", t + 1);
    let sig = sign_result(&outcome_signing_key(), &r);
    refused("future run_no", "run_no", || c.submit_outcome(r, sig));
}

// =================================================================== C. signature replay across pair indexes

#[test]
fn rt1b_c1_signature_is_bound_to_judge_pair_index_and_observation_list() {
    let (mut c, id, th) = setup();
    let t = 10 * DAY_T;
    retire_pair0_directly(&mut c); // first-live is pair 1 only, so pair 0 vs 1 differ in acceptance, not just sig
    let good = res(id, &th, "YES", 1, t, 1, vec![]);
    let sig = sign_result(&outcome_signing_key(), &good);
    // same signature, index flipped to 0 (the retired pair) and to 5 (not applied)
    for idx in [0u32, 2, 5] {
        let mut forged = good.clone();
        forged.judge_pair_index = idx;
        ctx("anyone.testnet", t);
        assert!(panic_msg(|| c.submit_outcome(forged, sig.clone())).is_some(), "idx {idx} must not ride on idx 1's signature");
    }
    // observation stripping / adding on a signed result
    let m = model(&c, 1, true);
    let with_obs = res(id, &th, "RETRY", 1, t, 1, vec![obs(&m, t)]);
    let sig_obs = sign_result(&outcome_signing_key(), &with_obs);
    let mut stripped = with_obs.clone();
    stripped.model_not_found = vec![];
    ctx("anyone.testnet", t);
    refused("strip observations", "bad signature", || c.submit_outcome(stripped, sig_obs.clone()));
    let plain = res(id, &th, "RETRY", 1, t, 1, vec![]);
    let sig_plain = sign_result(&outcome_signing_key(), &plain);
    let mut injected = plain.clone();
    injected.model_not_found = vec![obs(&m, t)];
    ctx("anyone.testnet", t);
    refused("inject observations", "bad signature", || c.submit_outcome(injected, sig_plain.clone()));
    // and the genuine one still lands
    ctx("anyone.testnet", t);
    c.submit_outcome(good, sig);
    assert_eq!(c.get_bet(id).unwrap().judge_pair_index, Some(1));
}

#[test]
fn rt1b_c2_signature_for_one_bet_or_run_does_not_replay_on_another() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(7);
    let mut ids = vec![];
    for k in 0..2u64 {
        let mut env = base_envelope(&hex_encode(&pk));
        env.resolve_deadline = 120 * DAY_T;
        do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1 + 2 * k);
        let id = c.next_bet_id - 1;
        do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_msg(id), 2 + 2 * k);
        ids.push(id);
    }
    let th = c.get_bet(ids[0]).unwrap().envelope.terms_hash.clone();
    let t = 10 * DAY_T;
    let r0 = res(ids[0], &th, "YES", 1, t, 0, vec![]);
    let sig0 = sign_result(&outcome_signing_key(), &r0);
    let mut r1 = r0.clone();
    r1.bet_id = ids[1];
    ctx("anyone.testnet", t);
    refused("cross-bet replay", "bad signature", || c.submit_outcome(r1, sig0.clone()));
    let mut r_run = r0.clone();
    r_run.run_no = 2;
    ctx("anyone.testnet", t);
    assert!(panic_msg(|| c.submit_outcome(r_run, sig0)).is_some(), "run_no is signed and strictly ordered");
}

// =================================================================== D. guardian abuse

fn g_call<F: FnOnce(&mut Contract)>(c: &mut Contract, who: &str, ts: u64, f: F) -> Option<String> {
    ctx_with_deposit(who, ts, ONE_Y);
    panic_msg(AssertUnwindSafe(|| f(c)))
}

fn pair(a: &str, b: &str) -> JudgePair {
    JudgePair { model_a: a.to_string(), model_b: b.to_string() }
}

#[test]
fn rt1b_d1_pending_guardian_has_no_power_until_accept_and_old_guardian_keeps_all_of_it() {
    let mut c = new_contract();
    let g2 = "g2.testnet";
    assert!(g_call(&mut c, GUARDIAN, 5, |c| c.set_guardian(acct(g2))).is_none());
    // pending guardian cannot do anything yet
    assert!(g_call(&mut c, g2, 6, |c| c.pause_new_offers()).is_some());
    assert!(g_call(&mut c, g2, 6, |c| c.propose_judge_pair(pair("o/a", "o/b"))).is_some());
    assert!(g_call(&mut c, g2, 6, |c| c.emergency_shutdown()).is_some());
    assert!(g_call(&mut c, g2, 6, |c| c.cancel_guardian()).is_some(), "only the current guardian cancels a rotation");
    // old guardian still has every power while pending, including proposing (propose_* while pending)
    assert!(g_call(&mut c, GUARDIAN, 7, |c| c.propose_judge_pair(pair("o/a", "o/b"))).is_none());
    assert_eq!(c.pending_guardian(), Some(acct(g2)));
}

#[test]
fn rt1b_d2_after_accept_the_old_guardian_has_no_power_and_inherited_proposals_are_the_new_guardians_to_cancel() {
    let mut c = new_contract();
    let g2 = "g2.testnet";
    assert!(g_call(&mut c, GUARDIAN, 5, |c| c.propose_judge_pair(pair("o/a", "o/b"))).is_none());
    assert!(g_call(&mut c, GUARDIAN, 5, |c| c.set_guardian(acct(g2))).is_none());
    assert!(g_call(&mut c, "evil.testnet", 6, |c| c.accept_guardian()).is_some(), "only the proposed account accepts");
    assert!(g_call(&mut c, g2, 7, |c| c.accept_guardian()).is_none());
    // old guardian: every guardian method refused
    let old = GUARDIAN;
    assert!(g_call(&mut c, old, 8, |c| c.pause_new_offers()).is_some());
    assert!(g_call(&mut c, old, 8, |c| c.unpause_new_offers()).is_some());
    assert!(g_call(&mut c, old, 8, |c| c.cancel_judge_pair()).is_some());
    assert!(g_call(&mut c, old, 8, |c| c.propose_judge_pair(pair("o/c", "o/d"))).is_some());
    assert!(g_call(&mut c, old, 8, |c| c.disable_asset_for_new_bets(USDC.to_string())).is_some());
    assert!(g_call(&mut c, old, 8, |c| c.cancel_asset()).is_some());
    assert!(g_call(&mut c, old, 8, |c| c.cancel_params()).is_some());
    assert!(g_call(&mut c, old, 8, |c| c.set_guardian(acct(old))).is_some());
    assert!(g_call(&mut c, old, 8, |c| c.cancel_guardian()).is_some());
    assert!(g_call(&mut c, old, 8, |c| c.emergency_shutdown()).is_some());
    // the proposal the old guardian left pending is cancellable by the new guardian (no orphaned, uncancellable change)
    assert!(g_call(&mut c, g2, 9, |c| c.cancel_judge_pair()).is_none());
    assert!(c.pending_judge_pair.is_none());
}

#[test]
fn rt1b_d3_rotation_cancel_races_replace_and_stale_accept_are_refused() {
    let mut c = new_contract();
    assert!(g_call(&mut c, GUARDIAN, 5, |c| c.set_guardian(acct("a.testnet"))).is_none());
    // replace the pending proposal: A can no longer accept
    assert!(g_call(&mut c, GUARDIAN, 6, |c| c.set_guardian(acct("b.testnet"))).is_none());
    assert!(g_call(&mut c, "a.testnet", 7, |c| c.accept_guardian()).is_some(), "replaced proposee cannot accept");
    // cancel, then B cannot accept
    assert!(g_call(&mut c, GUARDIAN, 8, |c| c.cancel_guardian()).is_none());
    assert!(g_call(&mut c, "b.testnet", 9, |c| c.accept_guardian()).is_some(), "cancelled rotation cannot be accepted");
    // double cancel
    assert!(g_call(&mut c, GUARDIAN, 10, |c| c.cancel_guardian()).is_some());
    assert_eq!(c.guardian, acct(GUARDIAN));
    // accept clears pending so a second accept (replay) fails
    assert!(g_call(&mut c, GUARDIAN, 11, |c| c.set_guardian(acct("a.testnet"))).is_none());
    assert!(g_call(&mut c, "a.testnet", 12, |c| c.accept_guardian()).is_none());
    assert!(g_call(&mut c, "a.testnet", 13, |c| c.accept_guardian()).is_some());
}

#[test]
fn rt1b_d4_chain_append_cannot_sway_a_live_bet_while_pair0_is_live() {
    // Guardian appends pair 2 mid-bet: the first-live pair stays pair 0, so a result claiming the new pair is refused.
    let (mut c, id, th) = setup();
    let t = 10 * DAY_T;
    assert!(g_call(&mut c, GUARDIAN, t, |c| c.propose_judge_pair(pair("new/a", "new/b"))).is_none());
    ctx("anyone.testnet", t + 7 * DAY_T);
    c.apply_judge_pair();
    assert_eq!(c.judge_chain().len(), 3);
    let now = t + 7 * DAY_T + 1;
    let r = res(id, &th, "YES", 1, now, 2, vec![]);
    ctx("anyone.testnet", now);
    let sig = sign_result(&outcome_signing_key(), &r);
    refused("claim the appended pair while pair 0 is live", "not the first live", || c.submit_outcome(r, sig));
    sign_submit(&mut c, now, res(id, &th, "YES", 1, now, 0, vec![]));
    assert_eq!(c.get_bet(id).unwrap().judge_pair_index, Some(0));
}

#[test]
fn rt1b_d5_chain_append_applied_before_the_7_day_delay_and_by_a_pending_non_guardian_is_refused() {
    let mut c = new_contract();
    assert!(g_call(&mut c, GUARDIAN, 5, |c| c.propose_judge_pair(pair("new/a", "new/b"))).is_none());
    ctx("anyone.testnet", 5 + 7 * DAY_T - 1);
    refused("early apply", "delay not elapsed", || c.apply_judge_pair());
    // cancel + re-propose restarts the clock (no stacking of an old, nearly-matured proposal)
    assert!(g_call(&mut c, GUARDIAN, 6 * DAY_T, |c| c.cancel_judge_pair()).is_none());
    assert!(g_call(&mut c, GUARDIAN, 6 * DAY_T, |c| c.propose_judge_pair(pair("new/c", "new/d"))).is_none());
    ctx("anyone.testnet", 5 + 7 * DAY_T);
    refused("old clock must not carry over", "delay not elapsed", || c.apply_judge_pair());
}

#[test]
fn rt1b_d6_params_change_never_touches_a_live_bets_fee_and_cannot_apply_early() {
    let (mut c, id, th) = setup();
    let before = c.get_bet(id).unwrap();
    let change = ParamsChange {
        fee_bps: None,
        assets: vec![AssetParamsChange { asset_id: USDC.to_string(), min_fee_per_side: Some(U128(1)), min_per_side: None, max_per_side: None }],
    };
    let t = 10 * DAY_T;
    assert!(g_call(&mut c, GUARDIAN, t, |c| c.propose_params(change.clone())).is_none());
    ctx("anyone.testnet", t + DAY_T - 1);
    refused("early apply", "delay", || c.apply_params());
    ctx("anyone.testnet", t + DAY_T);
    c.apply_params();
    let after = c.get_bet(id).unwrap();
    assert_eq!((before.fee_min_maker, before.fee_min_taker), (after.fee_min_maker, after.fee_min_taker), "bet keeps its own fee copies");
    let _ = th;
}

// =================================================================== E. shutdown / pause races

#[test]
fn rt1b_e1_shutdown_blocks_submit_apply_finalize_void_and_refund_is_exact_for_a_resolving_bet() {
    let (mut c, id, th) = setup();
    let t = 10 * DAY_T;
    request(&mut c, id, t);
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Resolving);
    // a judge pair + asset proposal mature in the same window
    assert!(g_call(&mut c, GUARDIAN, t, |c| c.propose_judge_pair(pair("new/a", "new/b"))).is_none());
    assert!(g_call(&mut c, GUARDIAN, t, |c| c.emergency_shutdown()).is_none());
    let run = c.get_bet(id).unwrap().pending_run_no.unwrap();
    let r = res(id, &th, "YES", run, t + 8 * DAY_T, 0, vec![]);
    ctx("anyone.testnet", t + 8 * DAY_T);
    let sig = sign_result(&outcome_signing_key(), &r);
    refused("submit after shutdown", "shut down", || c.submit_outcome(r, sig));
    refused("apply pair after shutdown", "shut down", || c.apply_judge_pair());
    refused("apply asset after shutdown", "shut down", || c.apply_asset());
    refused("finalize after shutdown", "shut down", || c.finalize(id));
    ctx("anyone.testnet", 121 * DAY_T);
    refused("void after shutdown", "shut down", || c.void_after_deadline(id));
    refused("concede after shutdown", "shut down", || {
        ctx("maker.testnet", 121 * DAY_T);
        c.concede(id)
    });
    ctx("anyone.testnet", t + 9 * DAY_T);
    c.emergency_refund(id);
    let b = c.get_bet(id).unwrap();
    assert_eq!(lines_sum(&c, id, USDC), 2_000_000 + b.storage_maker.0 + b.storage_taker.0, "I-2: refund == deposits");
    refused("second refund", "terminal", || c.emergency_refund(id));
}

#[test]
fn rt1b_e2_pause_does_not_block_submit_apply_or_void_and_shutdown_is_irreversible() {
    let (mut c, id, th) = setup();
    let t = 10 * DAY_T;
    assert!(g_call(&mut c, GUARDIAN, t, |c| c.pause_new_offers()).is_none());
    sign_submit(&mut c, t + 1, res(id, &th, "YES", 1, t + 1, 0, vec![]));
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Proposed, "pause must not freeze resolution");
    assert!(g_call(&mut c, GUARDIAN, t + 2, |c| c.emergency_shutdown()).is_none());
    assert!(g_call(&mut c, GUARDIAN, t + 3, |c| c.unpause_new_offers()).is_some(), "unpause after shutdown refused forever");
}

#[test]
fn rt1b_e3_paused_guardian_cannot_use_proposals_to_stall_an_existing_apply() {
    // propose is refused while paused, but a proposal made before the pause still applies and can still be cancelled.
    let mut c = new_contract();
    assert!(g_call(&mut c, GUARDIAN, 5, |c| c.propose_judge_pair(pair("new/a", "new/b"))).is_none());
    assert!(g_call(&mut c, GUARDIAN, 6, |c| c.pause_new_offers()).is_none());
    ctx("anyone.testnet", 5 + 7 * DAY_T);
    c.apply_judge_pair();
    assert_eq!(c.judge_chain().len(), 3);
}

// =================================================================== F. AS1 asset disable (orchestrator #4)

fn two_asset_contract() -> Contract {
    let mut assets = default_asset_limits();
    let mut btc = assets[0].1.clone();
    btc.min_per_side = U128(LENIENT_USDC_MIN);
    assets.push((MOCK_BTC.to_string(), btc));
    new_contract_with_limits_and_assets(
        Limits {
            max_stake: U128(1_000_000_000),
            max_offer_ttl_secs: 86400 * 60,
            max_stake_per_side_near: U128(100 * 10u128.pow(24)),
            max_rounds: crate::DEFAULT_MAX_ROUNDS,
            max_retries: crate::DEFAULT_MAX_RETRIES,
        },
        None,
        assets,
    )
}

#[test]
fn rt1b_f1_disabling_an_asset_mid_bet_does_not_block_challenge_bond_finalize_or_change_limits() {
    let mut c = two_asset_contract();
    let (_, pk) = test_keypair(7);
    let mut env = base_envelope(&hex_encode(&pk));
    env.maker_asset = MOCK_BTC.to_string();
    env.taker_asset = MOCK_BTC.to_string();
    env.resolve_deadline = 120 * DAY_T;
    let r = do_mt_transfer_asset(&mut c, "maker.testnet", MOCK_BTC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(r, vec![U128(0)]);
    let id = c.next_bet_id - 1;
    let r = do_mt_transfer_asset(&mut c, "taker.testnet", MOCK_BTC, env.taker_required(), take_msg(id), 2);
    assert_eq!(r, vec![U128(0)]);
    let limit_before = near_sdk::borsh::to_vec(&c.asset_limit(MOCK_BTC.to_string()).unwrap()).unwrap();
    assert!(g_call(&mut c, GUARDIAN, 3, |c| c.disable_asset_for_new_bets(MOCK_BTC.to_string())).is_none());
    sign_submit(&mut c, 4, res(id, &env.terms_hash, "YES", 1, 4, 0, vec![]));
    // challenge bond in the DISABLED asset: accepted (not refunded), so the dispute path is never blocked
    let q = c.required_challenge_bond(id, acct("taker.testnet")).unwrap();
    let r = do_mt_transfer_asset(&mut c, "taker.testnet", MOCK_BTC, q.amount.0, serde_json::to_string(&TransferMsg::Bond { bet_id: id, round: 1 }).unwrap(), 5);
    assert_eq!(r, vec![U128(0)], "bond in a disabled asset must be accepted for an existing bet");
    ctx("anyone.testnet", 121 * DAY_T);
    c.finalize(id); // a bond round with no ruling is finalizable only once resolve_deadline has passed
    let b = c.get_bet(id).unwrap();
    let dep = 2_000_000 + b.storage_maker.0 + b.storage_taker.0 + q.amount.0;
    assert_eq!(lines_sum(&c, id, MOCK_BTC), dep, "I-2 in the disabled asset");
    assert_eq!(limit_before, near_sdk::borsh::to_vec(&c.asset_limit(MOCK_BTC.to_string()).unwrap()).unwrap(), "disable never changes limits");
}

#[test]
fn rt1b_f2_reenable_cannot_smuggle_new_limits_and_pending_reenable_survives_a_second_disable_attempt() {
    let mut c = two_asset_contract();
    assert!(g_call(&mut c, GUARDIAN, 3, |c| c.disable_asset_for_new_bets(MOCK_BTC.to_string())).is_none());
    let mut changed = c.asset_limit(MOCK_BTC.to_string()).unwrap();
    changed.max_per_side = U128(changed.max_per_side.0 / 2);
    let msg = g_call(&mut c, GUARDIAN, 4, |c| c.propose_asset(MOCK_BTC.to_string(), changed));
    assert!(msg.unwrap_or_default().contains("re-enable limits must equal"), "limit change via re-enable refused");
    let same = c.asset_limit(MOCK_BTC.to_string()).unwrap();
    assert!(g_call(&mut c, GUARDIAN, 5, |c| c.propose_asset(MOCK_BTC.to_string(), same)).is_none());
    ctx("anyone.testnet", 5 + DAY_T - 1);
    refused("early re-enable", "delay", || c.apply_asset());
    ctx("anyone.testnet", 5 + DAY_T);
    c.apply_asset();
    assert!(!c.asset_disabled(MOCK_BTC.to_string()));
}

// =================================================================== G. endings: I-2 / tip / fee / storage

fn open_cross_human_with_tips(c: &mut Contract, ack: bool) -> (u64, Envelope) {
    let mut env = base_envelope("");
    env.referee = Some(Referee { account: acct("referee.testnet"), mode: RefereeMode::Human });
    env.taker_asset = MOCK_BTC.to_string();
    env.tip_maker = true;
    env.resolve_deadline = 365 * DAY_T;
    let r = do_mt_transfer_asset(c, "maker.testnet", USDC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(r, vec![U128(0)], "open");
    let id = c.next_bet_id - 1;
    let msg = serde_json::to_string(&TransferMsg::Take { bet_id: id, invite_sig: None, tip: true, referee_ack: if ack { Some(acct("referee.testnet")) } else { None } }).unwrap();
    let r = do_mt_transfer_asset(c, "taker.testnet", MOCK_BTC, env.taker_required(), msg, 2);
    assert_eq!(r, vec![U128(0)], "take");
    (id, env)
}

fn assert_cross_conserved(c: &Contract, id: u64, env: &Envelope) {
    let b = c.get_bet(id).unwrap();
    assert_eq!(lines_sum(c, id, USDC), env.stake_maker.0 + b.storage_maker.0, "I-2 USDC side");
    assert_eq!(lines_sum(c, id, MOCK_BTC), env.stake_taker.0 + b.storage_taker.0, "I-2 BTC side");
    // the referee is paid only tips, in each bettor's own asset, never more than the opt-in carve-out
    let tips: Vec<_> = c.pending_payouts(id).into_iter().filter(|p| p.receiver == acct("referee.testnet")).collect();
    assert!(tips.iter().all(|p| p.reason == "referee_tip"));
    assert!(tips.iter().map(|p| p.amount.0).sum::<u128>() <= b.tip_maker.0 + b.tip_taker.0);
}

fn contract_two() -> Contract {
    two_asset_contract()
}

fn g1(ending: &str) {
    {
        let mut c = contract_two();
        let (id, env) = open_cross_human_with_tips(&mut c, true);
        ctx("referee.testnet", 1_001);
        match ending {
            "yes" => c.referee_rule(id, "YES".into()),
            "no" => c.referee_rule(id, "NO".into()),
            "void" => c.referee_rule(id, "VOID".into()),
            "concede_maker" => {
                ctx("maker.testnet", 1_001);
                c.concede(id)
            }
            "concede_taker" => {
                ctx("taker.testnet", 1_001);
                c.concede(id)
            }
            "deadline" => {
                ctx("anyone.testnet", 366 * DAY_T);
                c.void_after_deadline(id)
            }
            _ => {
                assert!(g_call(&mut c, GUARDIAN, 1_002, |c| c.emergency_shutdown()).is_none());
                ctx("anyone.testnet", 1_003);
                c.emergency_refund(id)
            }
        }
        assert_cross_conserved(&c, id, &env);
    }
}

// one #[test] per ending: the mocked VM storage outlives a Contract value, so endings must not share a thread.
#[test] fn rt1b_g1_cross_asset_human_tips_conserve_referee_yes() { g1("yes") }
#[test] fn rt1b_g1_cross_asset_human_tips_conserve_referee_no() { g1("no") }
#[test] fn rt1b_g1_cross_asset_human_tips_conserve_referee_void() { g1("void") }
#[test] fn rt1b_g1_cross_asset_human_tips_conserve_concede_maker() { g1("concede_maker") }
#[test] fn rt1b_g1_cross_asset_human_tips_conserve_concede_taker() { g1("concede_taker") }
#[test] fn rt1b_g1_cross_asset_human_tips_conserve_deadline_void() { g1("deadline") }
#[test] fn rt1b_g1_cross_asset_human_tips_conserve_emergency_refund() { g1("emergency") }

fn g2(ending: &str) {
    {
        let mut c = new_contract();
        let (_, pk) = test_keypair(7);
        let mut env = base_envelope(&hex_encode(&pk));
        env.resolve_deadline = 120 * DAY_T;
        do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
        let id = c.next_bet_id - 1;
        do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_msg(id), 2);
        sign_submit(&mut c, 2_000, res(id, &env.terms_hash, "YES", 1, 2_000, 0, vec![]));
        let q = c.required_challenge_bond(id, acct("taker.testnet")).unwrap();
        let r = do_mt_transfer(&mut c, "taker.testnet", q.amount.0, serde_json::to_string(&TransferMsg::Bond { bet_id: id, round: 1 }).unwrap(), 2_050);
        assert_eq!(r, vec![U128(0)]);
        let r = do_mt_transfer(&mut c, "taker.testnet", 1_000_000, objection_msg(id, "ex1", false), 2_060);
        assert_eq!(r, vec![U128(0)], "objection accepted");
        match ending {
            "concede" => {
                ctx("maker.testnet", 2_100);
                c.concede(id)
            }
            "emergency" => {
                assert!(g_call(&mut c, GUARDIAN, 2_100, |c| c.emergency_shutdown()).is_none());
                ctx("anyone.testnet", 2_101);
                c.emergency_refund(id)
            }
            _ => {
                ctx("anyone.testnet", 121 * DAY_T);
                c.finalize(id)
            }
        }
        let b = c.get_bet(id).unwrap();
        let dep = 2_000_000 + b.storage_maker.0 + b.storage_taker.0 + q.amount.0 + 1_000_000;
        assert_eq!(lines_sum(&c, id, USDC), dep, "I-2 on {ending}: scheduled == deposited (bond + objection included)");
    }
}
#[test] fn rt1b_g2_ai_bet_bond_and_objection_conserve_on_concede() { g2("concede") }
#[test] fn rt1b_g2_ai_bet_bond_and_objection_conserve_on_emergency_refund() { g2("emergency") }
#[test] fn rt1b_g2_ai_bet_bond_and_objection_conserve_on_finalize_after_deadline() { g2("finalize") }

#[test]
fn rt1b_g3_challenged_bet_past_resolve_deadline_never_strands_bond_or_stake() {
    // Challenge, then nobody finalizes until after resolve_deadline: void_after_deadline must not pay stakes while
    // the bond stays held, and some permissionless ending must still release EVERYTHING.
    let mut c = new_contract();
    let (_, pk) = test_keypair(7);
    let mut env = base_envelope(&hex_encode(&pk));
    env.resolve_deadline = 120 * DAY_T;
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    let id = c.next_bet_id - 1;
    do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_msg(id), 2);
    sign_submit(&mut c, 2_000, res(id, &env.terms_hash, "YES", 1, 2_000, 0, vec![]));
    let q = c.required_challenge_bond(id, acct("taker.testnet")).unwrap();
    do_mt_transfer(&mut c, "taker.testnet", q.amount.0, serde_json::to_string(&TransferMsg::Bond { bet_id: id, round: 1 }).unwrap(), 2_050);
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Challenged);
    let late = 121 * DAY_T;
    ctx("anyone.testnet", late);
    refused("void on a challenged bet", "already has an outcome; use finalize", || c.void_after_deadline(id));
    ctx("anyone.testnet", late);
    c.finalize(id);
    let b = c.get_bet(id).unwrap();
    let dep = 2_000_000 + b.storage_maker.0 + b.storage_taker.0 + q.amount.0;
    assert_eq!(lines_sum(&c, id, USDC), dep, "finalize after the deadline releases stake, storage AND the bond");
}

// =================================================================== H. stale pending_resolution_request (orchestrator #8)

#[test]
fn rt1b_h1_stale_pending_resolution_request_after_a_verdict_cannot_revert_or_move_money() {
    let (mut c, id, th) = setup();
    let t = 10 * DAY_T;
    request(&mut c, id, t);
    let b = c.get_bet(id).unwrap();
    let rid = b.pending_resolution_request.unwrap();
    let run = b.pending_run_no.unwrap();
    sign_submit(&mut c, t + 1, res(id, &th, "YES", run, t + 1, 0, vec![]));
    let b = c.get_bet(id).unwrap();
    assert_eq!(b.status, BetStatus::Proposed);
    assert_eq!(b.outcome.as_deref(), Some("YES"));
    // the late OutLayer callback for that same request, in its worst shape (promise failed)
    ctx_with_promise_result(CONTRACT, t + 2, PromiseResult::Failed);
    c.on_resolution(rid);
    let b = c.get_bet(id).unwrap();
    assert_eq!(b.status, BetStatus::Proposed, "a stale failed callback must not roll a settled verdict back to Taken");
    assert_eq!(b.outcome.as_deref(), Some("YES"));
    // and a replayed callback (bookkeeping already dropped) is a no-op
    ctx_with_promise_result(CONTRACT, t + 3, PromiseResult::Failed);
    c.on_resolution(rid);
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Proposed);
    ctx("anyone.testnet", t + 3 + 2 * DAY_T);
    c.finalize(id);
    let b = c.get_bet(id).unwrap();
    assert_eq!(lines_sum(&c, id, USDC), 2_000_000 + b.storage_maker.0 + b.storage_taker.0);
}

#[test]
fn rt1b_h2_stale_request_then_challenge_then_late_failed_callback_keeps_the_dispute_state() {
    let (mut c, id, th) = setup();
    let t = 10 * DAY_T;
    request(&mut c, id, t);
    let rid = c.get_bet(id).unwrap().pending_resolution_request.unwrap();
    let run = c.get_bet(id).unwrap().pending_run_no.unwrap();
    sign_submit(&mut c, t + 1, res(id, &th, "YES", run, t + 1, 0, vec![]));
    let q = c.required_challenge_bond(id, acct("taker.testnet")).unwrap();
    let r = do_mt_transfer(&mut c, "taker.testnet", q.amount.0, serde_json::to_string(&TransferMsg::Bond { bet_id: id, round: 1 }).unwrap(), t + 2);
    assert_eq!(r, vec![U128(0)]);
    ctx_with_promise_result(CONTRACT, t + 3, PromiseResult::Failed);
    c.on_resolution(rid);
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Challenged, "old request's failure must not restore an older status");
}

// =================================================================== I. B2 snapshot + concede-while-Resolving

#[test]
fn rt1b_i1_snapshot_pair_is_accepted_only_for_the_requested_run_and_only_while_in_flight() {
    let (mut c, id, th) = setup();
    let t = 10 * DAY_T;
    request(&mut c, id, t);
    let run = c.get_bet(id).unwrap().pending_run_no.unwrap();
    // pair 0 retires in flight (other bet's evidence); pair 1 is now first-live.
    retire_pair0_directly(&mut c);
    // different run_no on the snapshot pair: refused (pending run mismatch)
    let r = res(id, &th, "YES", run + 1, t + 1, 0, vec![]);
    ctx("anyone.testnet", t + 1);
    let sig = sign_result(&outcome_signing_key(), &r);
    refused("snapshot idx for a different run_no", "run_no", || c.submit_outcome(r, sig));
    // the run's own result on the snapshot pair: accepted (B2)
    let ok = res(id, &th, "RETRY", run, t + 2, 0, vec![]);
    sign_submit(&mut c, t + 2, ok);
    // the snapshot died with that run: with no request in flight, the retired pair is refused again
    let r = res(id, &th, "YES", run + 1, t + 3, 0, vec![]);
    ctx("anyone.testnet", t + 3);
    let sig = sign_result(&outcome_signing_key(), &r);
    refused("stale snapshot reuse", "not the first live", || c.submit_outcome(r, sig));
}

#[test]
fn rt1b_i2_pair_applied_between_request_and_submit_does_not_let_a_no_live_snapshot_result_claim_a_pair() {
    let (mut c, id, th) = setup();
    retire_all(&mut c);
    let t = 10 * DAY_T;
    request(&mut c, id, t); // snapshot = NO_LIVE
    let run = c.get_bet(id).unwrap().pending_run_no.unwrap();
    assert!(g_call(&mut c, GUARDIAN, t, |c| c.propose_judge_pair(pair("new/a", "new/b"))).is_none());
    ctx("anyone.testnet", t + 7 * DAY_T);
    c.apply_judge_pair();
    let now = t + 7 * DAY_T + 1;
    // a YES from a pair on a NO_LIVE snapshot: only the genuinely first-live (new, idx 2) pair may judge it
    let r = res(id, &th, "YES", run, now, 0, vec![]);
    ctx("anyone.testnet", now);
    let sig = sign_result(&outcome_signing_key(), &r);
    refused("retired pair on a no-live snapshot", "not the first live", || c.submit_outcome(r, sig));
    sign_submit(&mut c, now, res(id, &th, "YES", run, now, 2, vec![]));
    assert_eq!(c.get_bet(id).unwrap().judge_pair_index, Some(2));
}

#[test]
fn rt1b_i3_concede_while_resolving_then_late_result_or_callback_cannot_pay_twice() {
    let (mut c, id, th) = setup();
    let t = 10 * DAY_T;
    request(&mut c, id, t);
    let rid = c.get_bet(id).unwrap().pending_resolution_request.unwrap();
    let run = c.get_bet(id).unwrap().pending_run_no.unwrap();
    ctx("maker.testnet", t + 1);
    c.concede(id);
    let n = c.pending_payouts(id).len();
    let sum = lines_sum(&c, id, USDC);
    let r = res(id, &th, "NO", run, t + 2, 0, vec![]);
    ctx("anyone.testnet", t + 2);
    let sig = sign_result(&outcome_signing_key(), &r);
    refused("late result after concede", "not awaiting", || c.submit_outcome(r, sig));
    ctx_with_promise_result(CONTRACT, t + 3, PromiseResult::Failed);
    c.on_resolution(rid);
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Finalized);
    assert_eq!((c.pending_payouts(id).len(), lines_sum(&c, id, USDC)), (n, sum));
    let b = c.get_bet(id).unwrap();
    assert_eq!(sum, 2_000_000 + b.storage_maker.0 + b.storage_taker.0, "I-2 after concede");
}
