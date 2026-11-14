//! AS1 (D-ASSET1, Tyler 2026-11-08: "24 hour delay is fine for new assets."): the guardian can append assets.
//! propose_asset (guardian) -> apply_asset (anyone, >= 24h) -> cancel_asset (guardian); append-only;
//! disable_asset_for_new_bets (guardian, immediate; re-enable goes through the same 24h path). Limits are validated
//! exactly like `new()`. Existing bets are never touched. Child of tests.rs.

use super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const DAY: u64 = ASSET_DELAY_NS;
const NEWA: &str = "nep141:new-asset.testnet";
const NEWB: &str = "nep141:second-new.testnet";

/// USDC + a lenient mock BTC (same shape as the USDC fixture), so cross-asset / disable cases have a second asset.
fn contract() -> Contract {
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

fn limit() -> AssetLimit {
    AssetLimit {
        min_per_side: U128(1_000),
        max_per_side: U128(super::cap3::CAP3_MAX),
        min_fee_per_side: U128(10),
        min_fee_cap_per_side: U128(50),
        run_price: U128(5),
        min_bond: U128(100),
        min_objection: U128(20),
        storage_per_kib: U128(STG_FIXTURE_RATE),
    }
}

/// Runs `f`, returns the panic message (None if it did not panic).
fn panic_msg<F: FnOnce()>(f: F) -> Option<String> {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let r = catch_unwind(AssertUnwindSafe(f));
    std::panic::set_hook(prev);
    r.err().map(|e| {
        e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
    })
}

fn refused<F: FnOnce()>(what: &str, needle: &str, f: F) {
    let m = panic_msg(f).unwrap_or_else(|| panic!("{what}: expected a refusal containing `{needle}`, but the call succeeded"));
    assert!(m.contains(needle), "{what}: refusal `{m}` does not contain `{needle}`");
}

fn propose(c: &mut Contract, ts: u64, id: &str, l: AssetLimit) {
    ctx_with_deposit(GUARDIAN, ts, ONE_YOCTO);
    c.propose_asset(id.to_string(), l);
}

fn apply(c: &mut Contract, who: &str, ts: u64) {
    ctx(who, ts);
    c.apply_asset();
}

fn disable(c: &mut Contract, ts: u64, id: &str) {
    ctx_with_deposit(GUARDIAN, ts, ONE_YOCTO);
    c.disable_asset_for_new_bets(id.to_string());
}

/// For the JC1x every-state-change-emits-one-event table.
pub(crate) fn propose_for_table(c: &mut Contract, ts: u64) {
    propose(c, ts, NEWA, limit());
}
pub(crate) fn propose_other_for_table(c: &mut Contract, ts: u64) {
    // a second id: the mocked VM storage outlives a Contract value, so the applied NEWA of the previous row persists.
    propose(c, ts, NEWB, limit());
}
pub(crate) fn apply_for_table(c: &mut Contract, ts: u64) {
    apply(c, "anyone.testnet", ts + DAY);
}

fn add_asset(c: &mut Contract, ts: u64, id: &str) {
    propose(c, ts, id, limit());
    apply(c, "anyone.testnet", ts + DAY);
}

fn env_in(seed: u8, maker_asset: &str, taker_asset: &str) -> Envelope {
    let (_, pk) = test_keypair(seed);
    let mut env = base_envelope(&hex_encode(&pk));
    env.maker_asset = maker_asset.to_string();
    env.taker_asset = taker_asset.to_string();
    env.stake_maker = U128(2_000);
    env.stake_taker = U128(2_000);
    env
}

/// Deadlines far enough out for bets opened after a 24h delay.
fn late(mut env: Envelope) -> Envelope {
    env.funding_deadline = 10 * DAY;
    env.resolve_deadline = 20 * DAY;
    env
}

fn open(c: &mut Contract, env: &Envelope, ts: u64) -> Vec<U128> {
    do_mt_transfer_asset(c, "maker.testnet", &env.maker_asset, env.maker_required(), open_msg_at(env, ts), ts)
}

fn take(c: &mut Contract, env: &Envelope, id: u64, ts: u64) -> Vec<U128> {
    do_mt_transfer_asset(c, "taker.testnet", &env.taker_asset, env.taker_required(), take_msg(id), ts)
}

fn submit_yes(c: &mut Contract, id: u64, env: &Envelope, ts: u64) {
    ctx("anyone.testnet", ts);
    let result = SubmittedResult {
        bet_id: id,
        terms_hash: env.terms_hash.clone(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(ts),
        next_check_ns: None,
        judge_pair_index: 0,
        model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
}

fn logs() -> Vec<String> {
    near_sdk::test_utils::get_logs()
}

fn event_names() -> Vec<String> {
    logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<serde_json::Value>(j).unwrap()["event"].as_str().unwrap().to_string())
        .collect()
}

fn fresh() {
    near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
}

// ---------------------------------------------------------------- propose

#[test]
fn as1_non_guardian_propose_is_refused() {
    fresh();
    let mut c = contract();
    ctx_with_deposit("attacker.testnet", 5, ONE_YOCTO);
    refused("non-guardian", "only guardian", || c.propose_asset(NEWA.to_string(), limit()));
    ctx_with_deposit(OPERATOR, 5, ONE_YOCTO);
    refused("operator", "only guardian", || c.propose_asset(NEWA.to_string(), limit()));
    assert!(c.pending_asset().is_none());
}

#[test]
fn as1_propose_requires_exactly_one_yocto() {
    fresh();
    let mut c = contract();
    ctx_with_deposit(GUARDIAN, 5, NearToken::from_yoctonear(0));
    assert!(panic_msg(|| c.propose_asset(NEWA.to_string(), limit())).is_some(), "0 yocto must be refused");
    assert!(c.pending_asset().is_none());
}

#[test]
fn as1_propose_of_an_existing_enabled_asset_is_refused_and_limits_are_not_replaced() {
    fresh();
    let mut c = contract();
    let before = c.asset_limit(USDC.to_string()).unwrap();
    let mut l = limit();
    l.min_per_side = U128(12_345);
    ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO);
    refused("existing asset", "already", || c.propose_asset(USDC.to_string(), l.clone()));
    assert!(c.pending_asset().is_none());
    assert_eq!(c.asset_limit(USDC.to_string()).unwrap().min_per_side, before.min_per_side);
    // an applied (guardian-added) asset is just as permanent
    add_asset(&mut c, 10, NEWA);
    ctx_with_deposit(GUARDIAN, 10 + DAY + 1, ONE_YOCTO);
    refused("applied asset", "already", || c.propose_asset(NEWA.to_string(), limit()));
}

#[test]
fn as1_invalid_limits_are_refused_exactly_like_new() {
    let cases: Vec<(&str, Box<dyn Fn(&mut AssetLimit)>, &str)> = vec![
        ("min > max", Box::new(|l| l.min_per_side = U128(l.max_per_side.0 + 1)), "asset_limits: min must be <= max"),
        ("min_fee 0", Box::new(|l| l.min_fee_per_side = U128(0)), "asset_limits: min_fee_per_side must be > 0"),
        ("min_fee > min_per_side/20", Box::new(|l| l.min_fee_per_side = U128(l.min_per_side.0 / 20 + 1)), "asset_limits: min_fee_per_side must be <= min_per_side/20"),
        ("run_price 0", Box::new(|l| l.run_price = U128(0)), "asset_limits: run_price must be > 0"),
        ("storage 0", Box::new(|l| l.storage_per_kib = U128(0)), "asset_limits: storage_per_kib must be > 0"),
        ("min_bond 0", Box::new(|l| l.min_bond = U128(0)), "asset_limits: min_bond must be > 0"),
        ("min_objection 0", Box::new(|l| l.min_objection = U128(0)), "asset_limits: min_objection must be > 0"),
        ("min-fee cap below min fee", Box::new(|l| { l.min_fee_per_side = U128(10); l.min_fee_cap_per_side = U128(9); }), "asset_limits: min_fee_cap_per_side must be >= min_fee_per_side"),
    ];
    for (label, mutate, msg) in cases {
        fresh();
        let mut c = contract();
        let mut l = limit();
        mutate(&mut l);
        ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO);
        refused(label, msg, || c.propose_asset(NEWA.to_string(), l.clone()));
        assert!(c.pending_asset().is_none(), "{label}: nothing pending after a refusal");
        assert!(event_names().is_empty(), "{label}: no event after a refusal");
    }
}

#[test]
fn as1_propose_is_refused_with_an_empty_token_id() {
    fresh();
    let mut c = contract();
    ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO);
    assert!(panic_msg(|| c.propose_asset(String::new(), limit())).is_some());
}

#[test]
fn as1_second_pending_proposal_is_refused() {
    fresh();
    let mut c = contract();
    propose(&mut c, 5, NEWA, limit());
    ctx_with_deposit(GUARDIAN, 6, ONE_YOCTO);
    refused("second", "already pending", || c.propose_asset(NEWB.to_string(), limit()));
    assert_eq!(c.pending_asset().unwrap().token_id, NEWA);
}

#[test]
fn as1_propose_is_refused_while_paused_but_apply_and_cancel_still_work() {
    fresh();
    let mut c = contract();
    propose(&mut c, 5, NEWA, limit());
    ctx_with_deposit(GUARDIAN, 6, ONE_YOCTO);
    c.pause_new_offers();
    ctx_with_deposit(GUARDIAN, 7, ONE_YOCTO);
    refused("propose while paused", "paused", || c.propose_asset(NEWB.to_string(), limit()));
    apply(&mut c, "anyone.testnet", 5 + DAY); // apply is allowed while paused
    assert!(c.asset_limit(NEWA.to_string()).is_some());
    // cancel while paused
    let mut c2 = contract();
    propose(&mut c2, 5, NEWA, limit());
    ctx_with_deposit(GUARDIAN, 6, ONE_YOCTO);
    c2.pause_new_offers();
    ctx_with_deposit(GUARDIAN, 7, ONE_YOCTO);
    c2.cancel_asset();
    assert!(c2.pending_asset().is_none());
}

#[test]
fn as1_propose_and_apply_are_refused_when_shut_down() {
    fresh();
    let mut c = contract();
    propose(&mut c, 5, NEWA, limit());
    ctx_with_deposit(GUARDIAN, 6, ONE_YOCTO);
    c.emergency_shutdown();
    ctx_with_deposit(GUARDIAN, 7, ONE_YOCTO);
    refused("propose after shutdown", "shut down", || c.propose_asset(NEWB.to_string(), limit()));
    refused("apply after shutdown", "shut down", || apply(&mut c, "anyone.testnet", 5 + DAY));
    assert!(c.asset_limit(NEWA.to_string()).is_none());
}

// ---------------------------------------------------------------- apply

#[test]
fn as1_apply_before_24h_is_refused_and_at_24h_works_for_any_account() {
    fresh();
    let mut c = contract();
    propose(&mut c, 1_000, NEWA, limit());
    let p = c.pending_asset().unwrap();
    assert_eq!(p.effective_at_ns, 1_000 + DAY);
    assert!(!p.reenable);
    assert!(c.asset_limit(NEWA.to_string()).is_none(), "not usable before apply");
    refused("1ns early", "delay not elapsed", || apply(&mut c, "anyone.testnet", 1_000 + DAY - 1));
    assert!(c.asset_limit(NEWA.to_string()).is_none());
    apply(&mut c, "random-stranger.testnet", 1_000 + DAY);
    assert!(c.pending_asset().is_none());
    let got = c.asset_limit(NEWA.to_string()).expect("asset in the table after apply");
    assert_eq!(got.min_per_side.0, 1_000);
    assert_eq!(got.min_fee_cap_per_side.0, 50);
    assert!(!c.asset_disabled(NEWA.to_string()));
}

#[test]
fn as1_applied_limits_normalise_the_min_fee_cap_like_new() {
    fresh();
    let mut c = contract();
    let mut l = limit();
    l.min_fee_cap_per_side = U128(0);
    propose(&mut c, 5, NEWA, l);
    apply(&mut c, "anyone.testnet", 5 + DAY);
    assert_eq!(c.asset_limit(NEWA.to_string()).unwrap().min_fee_cap_per_side.0, 10, "0 = pinned at min_fee_per_side");
}

#[test]
fn as1_apply_with_nothing_pending_is_refused() {
    fresh();
    let mut c = contract();
    refused("nothing pending", "no pending asset", || apply(&mut c, "anyone.testnet", 5));
}

#[test]
fn as1_an_applied_asset_is_usable_for_new_bets_end_to_end_with_i2() {
    fresh();
    let mut c = contract();
    let env = late(env_in(11, NEWA, NEWA));
    assert_eq!(open(&mut c, &env, 1), vec![U128(env.maker_required())], "not whitelisted before apply: full refund");
    add_asset(&mut c, 10, NEWA);
    let t0 = 10 + DAY + 5;
    assert_eq!(open(&mut c, &env, t0), vec![U128(0)], "open in the new asset accepted after apply");
    let id = c.next_bet_id - 1;
    assert_eq!(take(&mut c, &env, id, t0 + 1), vec![U128(0)]);
    submit_yes(&mut c, id, &env, t0 + 2);
    ctx("anyone.testnet", t0 + 2 + 86_400_000_000_001);
    c.finalize(id);
    let deposited = env.maker_required() + env.taker_required();
    let out: u128 = c.pending_payouts(id).iter().filter(|p| p.token_id == NEWA).map(|p| p.amount.0).sum();
    assert_eq!(out, deposited, "I-2: everything deposited in the new asset is scheduled out");
    assert!(c.pending_payouts(id).iter().all(|p| p.token_id == NEWA));
}

#[test]
fn as1_new_asset_works_cross_asset_with_an_existing_one() {
    fresh();
    let mut c = contract();
    add_asset(&mut c, 10, NEWA);
    let t0 = 10 + DAY + 5;
    let env = late(env_in(12, NEWA, USDC));
    assert_eq!(open(&mut c, &env, t0), vec![U128(0)]);
    let id = c.next_bet_id - 1;
    assert_eq!(take(&mut c, &env, id, t0 + 1), vec![U128(0)]);
}

// ---------------------------------------------------------------- cancel

#[test]
fn as1_cancel_is_guardian_only_and_only_while_pending() {
    fresh();
    let mut c = contract();
    ctx_with_deposit(GUARDIAN, 4, ONE_YOCTO);
    refused("nothing pending", "no pending asset", || c.cancel_asset());
    propose(&mut c, 5, NEWA, limit());
    ctx_with_deposit("attacker.testnet", 6, ONE_YOCTO);
    refused("non-guardian", "only guardian", || c.cancel_asset());
    assert!(c.pending_asset().is_some());
    ctx_with_deposit(GUARDIAN, 6, NearToken::from_yoctonear(0));
    assert!(panic_msg(|| c.cancel_asset()).is_some(), "needs 1 yocto");
    ctx_with_deposit(GUARDIAN, 6, ONE_YOCTO);
    c.cancel_asset();
    assert!(c.pending_asset().is_none());
    refused("apply after cancel", "no pending asset", || apply(&mut c, "anyone.testnet", 5 + DAY));
    assert!(c.asset_limit(NEWA.to_string()).is_none());
    // a new proposal is possible again
    propose(&mut c, 7, NEWB, limit());
    assert_eq!(c.pending_asset().unwrap().token_id, NEWB);
}

// ---------------------------------------------------------------- disable

#[test]
fn as1_disable_is_guardian_only_immediate_and_validates_the_asset() {
    fresh();
    let mut c = contract();
    ctx_with_deposit("attacker.testnet", 5, ONE_YOCTO);
    refused("non-guardian", "only guardian", || c.disable_asset_for_new_bets(MOCK_BTC.to_string()));
    ctx_with_deposit(GUARDIAN, 5, NearToken::from_yoctonear(0));
    assert!(panic_msg(|| c.disable_asset_for_new_bets(MOCK_BTC.to_string())).is_some(), "needs 1 yocto");
    ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO);
    refused("unknown", "unknown asset", || c.disable_asset_for_new_bets("nep141:nope.testnet".to_string()));
    assert!(!c.asset_disabled(MOCK_BTC.to_string()));
    disable(&mut c, 6, MOCK_BTC);
    assert!(c.asset_disabled(MOCK_BTC.to_string()), "immediate: no delay");
    assert!(c.asset_limit(MOCK_BTC.to_string()).is_some(), "never removed from the table");
    ctx_with_deposit(GUARDIAN, 7, ONE_YOCTO);
    refused("already disabled", "already disabled", || c.disable_asset_for_new_bets(MOCK_BTC.to_string()));
}

#[test]
fn as1_disabled_asset_refuses_new_bets_on_either_side_and_in_taker_options() {
    fresh();
    let mut c = contract();
    disable(&mut c, 5, MOCK_BTC);
    let cases = vec![
        ("maker asset", env_in(21, MOCK_BTC, USDC)),
        ("taker asset", env_in(22, USDC, MOCK_BTC)),
        ("same asset", env_in(23, MOCK_BTC, MOCK_BTC)),
        ("taker option", {
            let mut e = env_in(24, USDC, USDC);
            e.taker_options = vec![TakerOption { asset: MOCK_BTC.to_string(), amount: U128(2_000) }];
            e
        }),
    ];
    for (label, env) in cases {
        let r = open(&mut c, &env, 10);
        assert_eq!(r, vec![U128(env.maker_required())], "{label}: refused and refunded in full");
    }
    assert_eq!(c.next_bet_id, 1, "no bet was created");
    // a bet in a still-enabled asset is unaffected
    let ok = env_in(25, USDC, USDC);
    assert_eq!(open(&mut c, &ok, 11), vec![U128(0)]);
}

#[test]
fn as1_existing_bets_in_a_disabled_asset_still_take_finalize_void_cancel_and_refund() {
    fresh();
    let mut c = contract();
    // A: open + taken, B: open (to be taken after disable), C: open (to be cancelled), D: open (to expire), E: taken, to void.
    let a = env_in(31, MOCK_BTC, MOCK_BTC);
    open(&mut c, &a, 1);
    let ida = c.next_bet_id - 1;
    take(&mut c, &a, ida, 2);
    let mut b = env_in(32, MOCK_BTC, MOCK_BTC);
    b.terms_hash = "terms-hash-b".to_string();
    open(&mut c, &b, 1);
    let idb = c.next_bet_id - 1;
    let mut cc = env_in(33, MOCK_BTC, MOCK_BTC);
    cc.terms_hash = "terms-hash-c".to_string();
    open(&mut c, &cc, 1);
    let idc = c.next_bet_id - 1;
    let mut d = env_in(34, MOCK_BTC, MOCK_BTC);
    d.terms_hash = "terms-hash-d".to_string();
    open(&mut c, &d, 1);
    let idd = c.next_bet_id - 1;
    let mut e = env_in(35, MOCK_BTC, MOCK_BTC);
    e.terms_hash = "terms-hash-e".to_string();
    open(&mut c, &e, 1);
    let ide = c.next_bet_id - 1;
    take(&mut c, &e, ide, 2);
    for id in [ida, idb, idc, idd, ide] {
        assert!(c.get_bet(id).is_some());
    }

    disable(&mut c, 3, MOCK_BTC);

    // take of an existing offer still works (the offer was opened before the disable)
    assert_eq!(take(&mut c, &b, idb, 4), vec![U128(0)], "existing open bet can still be taken");
    // finalize a taken bet
    submit_yes(&mut c, ida, &a, 5);
    ctx("anyone.testnet", 5 + 86_400_000_000_001);
    c.finalize(ida);
    let deposited = a.maker_required() + a.taker_required();
    let out: u128 = c.pending_payouts(ida).iter().filter(|p| p.token_id == MOCK_BTC).map(|p| p.amount.0).sum();
    assert_eq!(out, deposited, "I-2 on a disabled asset's bet");
    // maker cancels an open bet: refunded
    ctx("maker.testnet", 6);
    c.cancel(idc);
    assert!(c.pending_payouts(idc).iter().any(|p| p.token_id == MOCK_BTC && p.amount.0 > 0), "cancel refunds in the disabled asset");
    // expire an unfilled offer
    ctx("anyone.testnet", 1_001);
    c.expire(idd);
    assert!(c.pending_payouts(idd).iter().any(|p| p.token_id == MOCK_BTC && p.amount.0 > 0));
    // void a taken bet after its deadline
    ctx("anyone.testnet", 10_001);
    c.void_after_deadline(ide);
    let out: u128 = c.pending_payouts(ide).iter().filter(|p| p.token_id == MOCK_BTC).map(|p| p.amount.0).sum();
    assert_eq!(out, e.maker_required() + e.taker_required(), "void refunds everything in the disabled asset");
}

#[test]
fn as1_reenable_goes_through_the_24h_path_with_the_stored_limits() {
    fresh();
    let mut c = contract();
    disable(&mut c, 5, MOCK_BTC);
    let stored = c.asset_limit(MOCK_BTC.to_string()).unwrap();
    // different limits are a replacement, refused
    let mut other = stored.clone();
    other.min_per_side = U128(other.min_per_side.0 + 1);
    ctx_with_deposit(GUARDIAN, 6, ONE_YOCTO);
    refused("changed limits", "limits", || c.propose_asset(MOCK_BTC.to_string(), other.clone()));
    // same limits: re-enable proposal
    propose(&mut c, 7, MOCK_BTC, stored.clone());
    let p = c.pending_asset().unwrap();
    assert!(p.reenable);
    assert_eq!(p.effective_at_ns, 7 + DAY);
    assert!(c.asset_disabled(MOCK_BTC.to_string()), "still disabled until applied");
    let env = late(env_in(41, MOCK_BTC, MOCK_BTC));
    assert_eq!(open(&mut c, &env, 8), vec![U128(env.maker_required())], "still closed while pending");
    refused("early", "delay not elapsed", || apply(&mut c, "anyone.testnet", 7 + DAY - 1));
    apply(&mut c, "anyone.testnet", 7 + DAY);
    assert!(!c.asset_disabled(MOCK_BTC.to_string()));
    assert_eq!(c.asset_limit(MOCK_BTC.to_string()).unwrap().min_per_side, stored.min_per_side);
    assert_eq!(open(&mut c, &env, 8 + DAY), vec![U128(0)], "open again after re-enable");
}

#[test]
fn as1_reenable_can_be_cancelled_and_an_enabled_asset_cannot_be_reproposed() {
    fresh();
    let mut c = contract();
    disable(&mut c, 5, MOCK_BTC);
    let stored = c.asset_limit(MOCK_BTC.to_string()).unwrap();
    propose(&mut c, 6, MOCK_BTC, stored.clone());
    ctx_with_deposit(GUARDIAN, 7, ONE_YOCTO);
    c.cancel_asset();
    assert!(c.asset_disabled(MOCK_BTC.to_string()));
    // enabled asset: refused
    ctx_with_deposit(GUARDIAN, 8, ONE_YOCTO);
    refused("enabled", "already", || c.propose_asset(USDC.to_string(), c.asset_limit(USDC.to_string()).unwrap()));
}

#[test]
fn as1_no_method_removes_an_asset_and_the_only_writers_are_new_and_apply_asset() {
    let src = include_str!("lib.rs");
    let prod = src.split("#[cfg(test)]\nmod tests;").next().unwrap();
    assert!(!prod.contains("asset_limits.remove("), "append-only: nothing removes an asset");
    // asset_limits is written in new() and apply_asset and the existing D-PARAMS1 apply path (existing assets only).
    let writers = prod.matches("asset_limits.insert(").count() + prod.matches("asset_limits_map.insert(").count();
    assert_eq!(writers, 3, "asset table writers: new(), apply_params (existing assets), apply_asset");
}

// ---------------------------------------------------------------- events

fn event_of(name: &str) -> serde_json::Value {
    let evs: Vec<serde_json::Value> = logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str(j).unwrap())
        .filter(|e: &serde_json::Value| e["event"] == name)
        .collect();
    assert_eq!(evs.len(), 1, "exactly one `{name}` event");
    evs[0].clone()
}

#[test]
fn as1_events_carry_the_asset_and_limits_and_are_emitted_once_on_success_only() {
    fresh();
    let mut c = contract();
    propose(&mut c, 100, NEWA, limit());
    let e = event_of("asset_proposed");
    assert_eq!(e["standard"], "praetorial-escrow");
    assert_eq!(e["version"], "1.0.0");
    let d = &e["data"][0];
    assert_eq!(d["token_id"], NEWA);
    assert_eq!(d["limit"]["min_per_side"], "1000");
    assert_eq!(d["limit"]["min_fee_cap_per_side"], "50");
    assert_eq!(d["reenable"], false);
    assert_eq!(d["proposed_at_ns"].to_string().trim_matches('"'), "100");
    assert_eq!(d["effective_at_ns"].to_string().trim_matches('"'), (100 + DAY).to_string());

    // refused apply emits nothing
    fresh();
    let mut c = contract();
    propose(&mut c, 100, NEWA, limit());
    let _ = panic_msg(|| apply(&mut c, "anyone.testnet", 101));
    assert!(event_names().is_empty(), "no event for a refused apply");

    apply(&mut c, "anyone.testnet", 100 + DAY);
    let e = event_of("asset_applied");
    assert_eq!(e["data"][0]["token_id"], NEWA);
    assert_eq!(e["data"][0]["limit"]["max_per_side"], super::cap3::CAP3_MAX.to_string());

    // cancel
    let mut c = contract();
    propose(&mut c, 100, NEWB, limit());
    ctx_with_deposit(GUARDIAN, 101, ONE_YOCTO);
    c.cancel_asset();
    assert_eq!(event_of("asset_cancelled")["data"][0]["token_id"], NEWB);

    // disable
    let mut c = contract();
    disable(&mut c, 100, MOCK_BTC);
    let e = event_of("asset_disabled");
    assert_eq!(e["data"][0]["token_id"], MOCK_BTC);
    // refused disable emits nothing more
    ctx_with_deposit(GUARDIAN, 101, ONE_YOCTO);
    let _ = panic_msg(|| c.disable_asset_for_new_bets(MOCK_BTC.to_string()));
    assert!(event_names().is_empty(), "a refused disable emits no event");
}

#[test]
fn as1_refused_propose_emits_no_event_in_every_refusal_path() {
    fresh();
    let mut c = contract();
    ctx_with_deposit("attacker.testnet", 5, ONE_YOCTO);
    let _ = panic_msg(|| c.propose_asset(NEWA.to_string(), limit()));
    ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO);
    let _ = panic_msg(|| c.propose_asset(USDC.to_string(), limit()));
    let mut bad = limit();
    bad.run_price = U128(0);
    ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO);
    let _ = panic_msg(|| c.propose_asset(NEWA.to_string(), bad));
    assert!(event_names().is_empty());
}
