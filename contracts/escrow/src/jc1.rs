//! JC1 (D-JUDGECHAIN1): append-only judge-pair chain with a 7-day timelock.
//! Child of tests.rs (`#[path]`), reuses its private helpers.
use super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};

const WEEK: u64 = JUDGE_PAIR_DELAY_NS;
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

fn fails<F: FnOnce()>(f: F) -> bool {
    catch_unwind(AssertUnwindSafe(f)).is_err()
}

fn propose(c: &mut Contract, ts: u64, pair: JudgePair) {
    ctx_with_deposit(GUARDIAN, ts, ONE_YOCTO);
    c.propose_judge_pair(pair);
}

fn apply(c: &mut Contract, ts: u64) {
    ctx("anyone.testnet", ts);
    c.apply_judge_pair();
}

fn cancel(c: &mut Contract, ts: u64) {
    ctx_with_deposit(GUARDIAN, ts, ONE_YOCTO);
    c.cancel_judge_pair();
}

fn try_new_with_chain(chain: Vec<JudgePair>) -> bool {
    catch_unwind(AssertUnwindSafe(|| {
        ctx(OPERATOR, 0);
        Contract::new(
            INTENTS.parse().unwrap(),
            USDC.to_string(),
            OUTLAYER.parse().unwrap(),
            OPERATOR.parse().unwrap(),
            GUARDIAN.parse().unwrap(),
            REGISTRY.parse().unwrap(),
            FEE.parse().unwrap(),
            KEEPER.parse().unwrap(),
            Limits {
                max_stake: U128(1_000_000_000),
                max_offer_ttl_secs: 86400 * 60,
                max_stake_per_side_near: U128(100 * 10u128.pow(24)),
                max_rounds: crate::DEFAULT_MAX_ROUNDS,
                max_retries: crate::DEFAULT_MAX_RETRIES,
            },
            None,
            default_asset_limits(),
            outcome_pubkey_hex(),
            attest_pubkey_hex(),
            test_resolver_wasm_hash(),
            test_outlayer_config(),
            chain,
        )
    }))
    .is_ok()
}

fn n_pairs(n: usize) -> Vec<JudgePair> {
    (0..n).map(|i| jp(&format!("m{i}a"), &format!("m{i}b"))).collect()
}

fn logs_contain(needle: &str) -> bool {
    near_sdk::test_utils::get_logs().iter().any(|l| l.contains(needle))
}

// ---------------------------------------------------------------- new()

#[test]
fn jc1_new_stores_the_built_in_chain_in_order() {
    let c = new_contract();
    assert_eq!(c.judge_chain(), test_judge_chain());
    assert_eq!(c.judge_chain()[0], jp("DeepSeek-V4.1-Flash-1017", "GLM-5.3-flash"));
    assert!(c.pending_judge_pair().is_none());
}

#[test]
fn jc1_new_accepts_2_to_4_pairs_rejects_0_1_5_and_13() {
    // JC1x (D-JUDGECHAIN1a #3) deliberately changes the initial chain bound from 1..=12 to 2..=4.
    assert!(try_new_with_chain(n_pairs(2)), "2 pairs ok");
    assert!(try_new_with_chain(n_pairs(4)), "4 pairs ok");
    assert!(!try_new_with_chain(n_pairs(1)), "1 pair must be rejected");
    assert!(!try_new_with_chain(vec![]), "0 pairs must be rejected");
    assert!(!try_new_with_chain(n_pairs(5)), "5 pairs must be rejected");
    assert!(!try_new_with_chain(n_pairs(13)), "13 pairs must be rejected");
}

#[test]
fn jc1_new_rejects_malformed_pairs() {
    // JC1x: the initial chain needs 2..=4 pairs, so each case carries one valid partner pair.
    let ok = || jp("c", "d");
    assert!(try_new_with_chain(vec![jp("a", "b"), ok()]), "control");
    assert!(!try_new_with_chain(vec![jp("a", "a"), ok()]), "identical models");
    assert!(!try_new_with_chain(vec![jp("", "b"), ok()]), "empty model_a");
    assert!(!try_new_with_chain(vec![jp("a", ""), ok()]), "empty model_b");
    assert!(!try_new_with_chain(vec![jp("a", "b"), jp("a", "b")]), "duplicate pair");
    assert!(!try_new_with_chain(vec![jp("a", "b"), jp("b", "a")]), "same set in other order is a duplicate");
}

// ---------------------------------------------------------------- propose

#[test]
#[should_panic(expected = "only guardian")]
fn jc1_non_guardian_propose_refused() {
    let mut c = new_contract();
    ctx_with_deposit("anyone.testnet", 10, ONE_YOCTO);
    c.propose_judge_pair(jp("x1", "x2"));
}

#[test]
fn jc1_propose_records_pending_with_7_day_effective_time_and_emits_event() {
    let mut c = new_contract();
    propose(&mut c, 100, jp("x1", "x2"));
    let p = c.pending_judge_pair().expect("pending");
    assert_eq!(p.pair, jp("x1", "x2"));
    assert_eq!(p.proposed_at_ns, 100);
    assert_eq!(p.effective_at_ns, 100 + WEEK);
    assert!(logs_contain("judge_pair_proposed"), "propose event");
    assert_eq!(c.judge_chain(), test_judge_chain(), "propose never touches the chain");
}

#[test]
fn jc1_propose_rejects_malformed_and_duplicate_pairs() {
    let mut c = new_contract();
    for bad in [jp("a", "a"), jp("", "b"), jp("a", ""), jp("DeepSeek-V4.1-Flash-1017", "GLM-5.3-flash"), jp("GLM-5.3-flash", "DeepSeek-V4.1-Flash-1017")] {
        assert!(fails(|| propose(&mut c, 10, bad.clone())), "{bad:?} must be refused");
        assert!(c.pending_judge_pair().is_none());
    }
}

#[test]
#[should_panic(expected = "judge pair already pending")]
fn jc1_second_pending_proposal_refused() {
    let mut c = new_contract();
    propose(&mut c, 10, jp("x1", "x2"));
    propose(&mut c, 20, jp("y1", "y2"));
}

#[test]
fn jc1_propose_requires_one_yocto() {
    let mut c = new_contract();
    ctx_with_deposit(GUARDIAN, 10, NearToken::from_yoctonear(0));
    assert!(fails(|| c.propose_judge_pair(jp("x1", "x2"))));
}

#[test]
fn jc1_cap_proposal_that_would_make_13_refused_but_12th_ok() {
    let mut c = new_contract_with_chain(n_pairs(11));
    propose(&mut c, 10, jp("x1", "x2"));
    apply(&mut c, 10 + WEEK);
    assert_eq!(c.judge_chain().len(), 12);
    assert!(fails(|| propose(&mut c, 20 + WEEK, jp("y1", "y2"))), "13th pair must be refused");
    assert!(c.pending_judge_pair().is_none());
    assert_eq!(c.judge_chain().len(), 12);
}

fn new_contract_with_chain(chain: Vec<JudgePair>) -> Contract {
    ctx(OPERATOR, 0);
    let mut c = new_contract();
    c.judge_chain = chain; // fixture only: state built directly, new() validation is covered above
    c
}

// ---------------------------------------------------------------- apply

#[test]
fn jc1_apply_before_7_days_refused() {
    let mut c = new_contract();
    propose(&mut c, 100, jp("x1", "x2"));
    assert!(fails(|| apply(&mut c, 100 + WEEK - 1)), "1ns early must be refused");
    assert_eq!(c.judge_chain(), test_judge_chain());
    assert!(c.pending_judge_pair().is_some(), "still pending");
}

#[test]
fn jc1_apply_without_pending_refused() {
    let mut c = new_contract();
    assert!(fails(|| apply(&mut c, WEEK * 2)));
}

#[test]
fn jc1_apply_at_exactly_7_days_appends_at_the_end_permissionless_with_event() {
    let mut c = new_contract();
    let before = c.judge_chain();
    propose(&mut c, 100, jp("x1", "x2"));
    apply(&mut c, 100 + WEEK); // caller is anyone.testnet
    let after = c.judge_chain();
    assert_eq!(after.len(), before.len() + 1);
    assert_eq!(&after[..before.len()], &before[..], "existing order untouched");
    assert_eq!(after.last().unwrap(), &jp("x1", "x2"), "appended at the END");
    assert!(c.pending_judge_pair().is_none());
    assert!(logs_contain("judge_pair_applied"), "apply event");
}

#[test]
fn jc1_apply_long_after_7_days_also_works_and_frees_the_slot() {
    let mut c = new_contract();
    propose(&mut c, 100, jp("x1", "x2"));
    apply(&mut c, 100 + 40 * WEEK);
    propose(&mut c, 100 + 41 * WEEK, jp("y1", "y2"));
    apply(&mut c, 100 + 49 * WEEK);
    let chain = c.judge_chain();
    assert_eq!(&chain[chain.len() - 2..], &[jp("x1", "x2"), jp("y1", "y2")]);
}

// ---------------------------------------------------------------- cancel

#[test]
#[should_panic(expected = "only guardian")]
fn jc1_non_guardian_cancel_refused() {
    let mut c = new_contract();
    propose(&mut c, 10, jp("x1", "x2"));
    ctx_with_deposit("anyone.testnet", 11, ONE_YOCTO);
    c.cancel_judge_pair();
}

#[test]
fn jc1_guardian_cancel_clears_pending_emits_event_and_allows_new_proposal() {
    let mut c = new_contract();
    propose(&mut c, 10, jp("x1", "x2"));
    cancel(&mut c, 20);
    assert!(c.pending_judge_pair().is_none());
    assert!(logs_contain("judge_pair_cancelled"), "cancel event");
    assert_eq!(c.judge_chain(), test_judge_chain());
    assert!(fails(|| apply(&mut c, 10 + WEEK)), "cancelled proposal can't be applied");
    propose(&mut c, 30, jp("y1", "y2"));
    assert_eq!(c.pending_judge_pair().unwrap().pair, jp("y1", "y2"));
}

#[test]
fn jc1_cancel_without_pending_refused_and_after_apply_refused() {
    let mut c = new_contract();
    assert!(fails(|| cancel(&mut c, 10)), "nothing pending");
    propose(&mut c, 10, jp("x1", "x2"));
    apply(&mut c, 10 + WEEK);
    assert!(fails(|| cancel(&mut c, 11 + WEEK)), "cancel only while pending");
    assert_eq!(c.judge_chain().len(), test_judge_chain().len() + 1);
}

// ---------------------------------------------------------------- append-only

/// Any sequence of propose/apply/cancel (including refused calls) leaves the
/// existing chain as an unchanged PREFIX of the new chain.
#[test]
fn jc1_chain_prefix_unchanged_after_any_sequence() {
    let mut c = new_contract();
    let mut seen: Vec<Vec<JudgePair>> = vec![c.judge_chain()];
    let mut t = 100u64;
    for i in 0..30u64 {
        t += WEEK / 3 + i;
        let _ = catch_unwind(AssertUnwindSafe(|| match i % 6 {
            0 | 3 => propose(&mut c, t, jp(&format!("p{i}a"), &format!("p{i}b"))),
            1 => apply(&mut c, t),            // too early: refused
            2 => apply(&mut c, t + WEEK),     // due: appends
            4 => cancel(&mut c, t),           // cancels the pending one
            _ => apply(&mut c, t + WEEK),     // nothing pending: refused
        }));
        seen.push(c.judge_chain());
    }
    for w in seen.windows(2) {
        assert!(w[1].len() >= w[0].len(), "chain never shrinks");
        assert_eq!(&w[1][..w[0].len()], &w[0][..], "prior chain is an unchanged prefix");
    }
    assert!(seen.last().unwrap().len() > seen[0].len(), "control: some append happened");
    assert!(seen.last().unwrap().len() <= MAX_JUDGE_PAIRS);
    assert_eq!(&seen.last().unwrap()[..seen[0].len()], &seen[0][..]);
}

/// No remove / reorder / replace method exists, and `judge_chain` is only
/// ever mutated by `apply_judge_pair` (push). Adding any other mutator or
/// guardian power breaks this on purpose.
#[test]
fn jc1_no_remove_reorder_or_replace_method_exists() {
    let src = include_str!("lib.rs");
    let mut judge_methods: Vec<String> = Vec::new();
    let mut chain_writers: Vec<String> = Vec::new();
    for chunk in src.split("pub fn ").skip(1) {
        let name = chunk.split('(').next().unwrap().to_string();
        if name.contains("judge") {
            judge_methods.push(name.clone());
        }
        let body = chunk.split("\n    pub fn ").next().unwrap();
        let body = body.split("\n#[cfg(test)]").next().unwrap();
        if body.contains("self.judge_chain.push")
            || body.contains("self.judge_chain =")
            || body.contains("self.judge_chain.remove")
            || body.contains("self.judge_chain.insert")
            || body.contains("self.judge_chain.swap")
            || body.contains("self.judge_chain.clear")
            || body.contains("self.judge_chain.truncate")
            || body.contains("self.judge_chain.sort")
            || body.contains("self.judge_chain.reverse")
            || body.contains("self.judge_chain.retain")
            || body.contains("self.judge_chain.drain")
            || body.contains("self.judge_chain.pop")
            || body.contains("self.judge_chain[")
            || body.contains("self.judge_chain.iter_mut")
            || body.contains("judge_chain.last_mut")
        {
            chain_writers.push(name);
        }
    }
    judge_methods.sort();
    assert_eq!(
        judge_methods,
        vec!["apply_judge_pair", "cancel_judge_pair", "judge_chain", "pending_judge_pair", "propose_judge_pair"]
    );
    assert_eq!(chain_writers, vec!["apply_judge_pair"], "the only writer of the chain is apply_judge_pair");
    let apply_src = src.split("pub fn apply_judge_pair").nth(1).unwrap().split("\n    pub fn ").next().unwrap();
    assert!(apply_src.contains("self.judge_chain.push("), "append at END via push");
}

// ---------------------------------------------------------------- envelope

/// The `request_execution` input_data the escrow sends to OutLayer for a
/// keeper credit-funded request (parsed JSON).
fn sent_input_data(c: &mut Contract, bet_id: u64, ts: u64) -> serde_json::Value {
    ctx_with_deposit(KEEPER, 1, NearToken::from_millinear(50));
    c.topup_keeper_credit();
    ctx_with_deposit(KEEPER, ts, NearToken::from_yoctonear(0));
    let _ = c.request_resolution(bet_id, None);
    for r in near_sdk::test_utils::get_created_receipts() {
        for a in r.actions {
            if let near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } = a {
                if method_name == b"request_execution" {
                    let top: serde_json::Value = serde_json::from_slice(&args).unwrap();
                    let id = &top["input_data"];
                    return match id {
                        serde_json::Value::String(s) => serde_json::from_str(s).unwrap(),
                        v => v.clone(),
                    };
                }
            }
        }
    }
    panic!("no request_execution receipt created");
}

fn chain_json(v: &serde_json::Value) -> serde_json::Value {
    v["judge_chain"].clone()
}

fn expected_json(chain: &[JudgePair]) -> serde_json::Value {
    serde_json::to_value(chain).unwrap()
}

#[test]
fn jc1_resolution_input_data_carries_the_chain_field() {
    let pk_hex = "a".repeat(64);
    let env = base_envelope(&pk_hex);
    let payer: AccountId = KEEPER.parse().unwrap();
    let chain = test_judge_chain();
    let input = resolution_input_data(&CONTRACT.parse().unwrap(), 1, &env, &None, 0, 1, &payer, &chain);
    let v: serde_json::Value = serde_json::from_str(&input).unwrap();
    assert_eq!(chain_json(&v), expected_json(&chain));
    assert_eq!(v["judge_chain"][0]["model_a"], "t/DeepSeek-V4.1-Flash-1017"); // JC1x: org/model form
    assert_eq!(v["judge_chain"][0]["model_b"], "t/GLM-5.3-flash");
}

#[test]
fn jc1_request_resolution_sends_the_chain_to_the_resolver() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(150);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let sent = sent_input_data(&mut c, bet_id, 1_001);
    assert_eq!(chain_json(&sent), expected_json(&c.judge_chain()));
}

#[test]
fn jc1_already_open_bet_envelope_reflects_pair_appended_after_it_opened() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(151);
    // long-lived bet: funding at 1_000ns, resolve deadline 20 days out
    let mut env = base_envelope(&hex_encode(&pk));
    env.resolve_deadline = 20 * 24 * 60 * 60 * 1_000_000_000;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)]);
    let bet_id = c.next_bet_id - 1;
    let resp = do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_msg(bet_id), 2);
    assert_eq!(resp, vec![U128(0)]);

    let opened_with = c.judge_chain();
    propose(&mut c, 500, jp("late1", "late2"));
    apply(&mut c, 500 + WEEK);
    assert_eq!(c.judge_chain().len(), opened_with.len() + 1);

    let sent = sent_input_data(&mut c, bet_id, 500 + WEEK + 1);
    let got = chain_json(&sent);
    assert_eq!(got, expected_json(&c.judge_chain()), "envelope uses the CURRENT chain");
    assert_eq!(got.as_array().unwrap().last().unwrap(), &serde_json::json!({"model_a": "t/late1", "model_b": "t/late2"})); // JC1x: org/model form);
    assert!(c.get_bet(bet_id).unwrap().envelope.referee.is_none());
}

#[test]
fn jc1_bet_envelope_has_no_per_bet_chain_opt_out() {
    // The chain is contract-level only: nothing a bettor signs or stores
    // (the Envelope) carries a judge chain, so there is no per-bettor opt-out.
    let env = base_envelope(&"a".repeat(64));
    let v = serde_json::to_value(&env).unwrap();
    assert!(v.get("judge_chain").is_none() && v.get("judge_pairs").is_none());
}

// ---------------------------------------------------------------- I-2

/// I-2 (payouts equal deposits) still holds on a bet that lives through a
/// chain change, and the chain methods never move funds.
#[test]
fn jc1_i2_payouts_equal_deposits_across_a_chain_change() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(152);
    let mut env = base_envelope(&hex_encode(&pk));
    env.resolve_deadline = 20 * 24 * 60 * 60 * 1_000_000_000;
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    let bet_id = c.next_bet_id - 1;
    do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_msg(bet_id), 2);
    let deposited = env.maker_required() + env.taker_required();

    propose(&mut c, 500, jp("late1", "late2"));
    apply(&mut c, 500 + WEEK);
    assert!(c.pending_payouts(bet_id).is_empty(), "chain methods schedule no payouts");

    ctx("anyone.testnet", 21 * 24 * 60 * 60 * 1_000_000_000);
    c.void_after_deadline(bet_id);
    let out: u128 = c.pending_payouts(bet_id).iter().filter(|p| p.token_id == USDC).map(|p| p.amount.0).sum();
    assert_eq!(out, deposited, "I-2: payouts in USDC must equal deposits");
}
