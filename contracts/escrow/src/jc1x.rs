//! JC1x (D-JUDGECHAIN1a points 1-6): contract-side retirement state (signed observations), the first-live-applied-pair
//! check at submit, proposal/caps/model-id validation, two-step guardian rotation, contract_version 1.0.0,
//! NEP-297 events for every state change, `bet_count()`, and the full-chain envelope/gas bounds.
//! Child of tests.rs (`#[path]`), reuses its private helpers.
use super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const HOUR_NS: u64 = 3_600 * 1_000_000_000;
const DAY_NS_X: u64 = 24 * HOUR_NS;
const WEEK: u64 = JUDGE_PAIR_DELAY_NS;
const REFEREE: &str = "referee.testnet";

/// raw (non-normalising) pair: these tests exercise the model-id rules themselves.
fn jp(a: &str, b: &str) -> JudgePair {
    JudgePair { model_a: a.to_string(), model_b: b.to_string() }
}

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

fn obs(model: &str, ns: u64) -> ModelObservation {
    ModelObservation { model: model.to_string(), observed_ns: U64(ns) }
}

fn submit(c: &mut Contract, ts: u64, r: SubmittedResult) {
    ctx("anyone.testnet", ts);
    let sig = sign_result(&outcome_signing_key(), &r);
    c.submit_outcome(r, sig);
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
        judge_pair_index: idx,
        model_not_found: vec![],
    }
}

/// A plain RETRY at pair `idx` carrying not-found observations.
fn retry_with(bet_id: u64, th: &str, run_no: u64, now: u64, idx: u32, o: Vec<ModelObservation>) -> SubmittedResult {
    SubmittedResult { judge_pair_index: idx, model_not_found: o, ..retry_result(bet_id, th, run_no, now, now + HOUR_NS) }
}

fn no_live(bet_id: u64, th: &str, run_no: u64, now: u64) -> SubmittedResult {
    SubmittedResult {
        bet_id,
        terms_hash: th.to_string(),
        outcome: "RETRY:no_live_judge".to_string(),
        element_results_hash: "0".repeat(64),
        run_no,
        checked_until: U64(now),
        next_check_ns: Some(U64(now + DAY_NS_X)),
        judge_pair_index: 0,
        model_not_found: vec![],
    }
}

fn model_a0(c: &Contract) -> String {
    c.judge_chain()[0].model_a.clone()
}

/// Drives `n` not-found observations of `model` through real signed RETRY submissions, `gap` ns apart, starting at `t0`.
fn observe(c: &mut Contract, bet_id: u64, th: &str, first_run: u64, model: &str, n: u64, gap: u64, t0: u64) -> u64 {
    let mut run = first_run;
    for k in 0..n {
        let now = t0 + k * gap;
        submit(c, now, retry_with(bet_id, th, run, now, 0, vec![obs(model, now)]));
        run += 1;
    }
    run
}

fn propose(c: &mut Contract, ts: u64, pair: JudgePair) {
    ctx_with_deposit(GUARDIAN, ts, ONE_YOCTO);
    c.propose_judge_pair(pair);
}

fn apply(c: &mut Contract, ts: u64) {
    ctx("anyone.testnet", ts);
    c.apply_judge_pair();
}

fn contract_with_chain(chain: Vec<JudgePair>) -> Result<Contract, ()> {
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
    .map_err(|_| ())
}

fn org_pairs(n: usize) -> Vec<JudgePair> {
    (0..n).map(|i| jp(&format!("org{i}/m{i}a"), &format!("org{i}/m{i}b"))).collect()
}

// ------------------------------------------------------------ point 1: retirement in the contract

#[test]
fn jc1x_three_observations_less_than_24h_apart_do_not_retire() {
    let (mut c, bet_id, th) = setup();
    let m = model_a0(&c);
    observe(&mut c, bet_id, &th, 1, &m, 3, 2 * HOUR_NS, 3_000);
    assert!(c.retired_models().is_empty(), "3 observations inside 24h are not a retirement");
    // pair 0 is still the first live pair: index 1 is refused, index 0 accepted.
    assert!(fails(|| submit(&mut c, 4_000 + DAY_NS_X / 2, yes_at(bet_id, &th, 4, 1))));
    submit(&mut c, 4_000 + DAY_NS_X / 2, yes_at(bet_id, &th, 4, 0));
    assert_eq!(c.get_bet(bet_id).unwrap().judge_pair_index, Some(0));
}

#[test]
fn jc1x_three_observations_at_least_24h_apart_retire_the_model() {
    let (mut c, bet_id, th) = setup();
    let m = model_a0(&c);
    observe(&mut c, bet_id, &th, 1, &m, 3, DAY_NS_X, 3_000);
    assert_eq!(c.retired_models(), vec![m.clone()]);
    assert_eq!(c.model_missing(m.clone()).len(), 3, "stored capped at 3");
    let now = 3_000 + 3 * DAY_NS_X;
    // pair 0 (contains the retired model) is no longer live: first live applied pair is 1.
    assert!(fails(|| submit(&mut c, now, yes_at(bet_id, &th, 4, 0))), "retired pair 0 refused");
    submit(&mut c, now, yes_at(bet_id, &th, 4, 1));
    assert_eq!(c.get_bet(bet_id).unwrap().judge_pair_index, Some(1));
}

#[test]
fn jc1x_observations_cap_at_three_per_model() {
    let (mut c, bet_id, th) = setup();
    let m = model_a0(&c);
    let run = observe(&mut c, bet_id, &th, 1, &m, 3, DAY_NS_X, 3_000);
    // pair 0 is retired now; further observations of the same model arrive via pair 1 and must not grow the list
    for k in 0..2u64 {
        let now = 3_000 + (3 + k) * DAY_NS_X;
        submit(&mut c, now, retry_with(bet_id, &th, run + k, now, 1, vec![obs(&m, now)]));
    }
    assert_eq!(c.model_missing(m).len(), 3);
}

#[test]
fn jc1x_a_later_success_clears_the_observations() {
    let (mut c, bet_id, th) = setup();
    let m = model_a0(&c);
    observe(&mut c, bet_id, &th, 1, &m, 2, DAY_NS_X, 3_000);
    assert_eq!(c.model_missing(m.clone()).len(), 2);
    submit(&mut c, 3_000 + 3 * DAY_NS_X, yes_at(bet_id, &th, 3, 0)); // pair 0 answered: its models are reachable
    assert!(c.model_missing(m.clone()).is_empty(), "success clears");
    assert!(c.retired_models().is_empty());
}

#[test]
fn jc1x_observation_for_a_model_outside_the_chain_or_from_the_future_is_refused() {
    let (mut c, bet_id, th) = setup();
    assert!(fails(|| submit(&mut c, 3_000, retry_with(bet_id, &th, 1, 3_000, 0, vec![obs("nobody/not-in-chain", 3_000)]))));
    let m = model_a0(&c);
    assert!(fails(|| submit(&mut c, 3_000, retry_with(bet_id, &th, 1, 3_000, 0, vec![obs(&m, 9_000_000)]))), "observed_ns in the future");
    assert!(c.model_missing(m).is_empty());
}

#[test]
fn jc1x_observations_are_signed_tampering_fails_and_legacy_layout_is_unchanged() {
    let (mut c, bet_id, th) = setup();
    let m = model_a0(&c);
    let signed = retry_with(bet_id, &th, 1, 3_000, 0, vec![obs(&m, 3_000)]);
    let sig = sign_result(&outcome_signing_key(), &signed);
    let mut stripped = signed.clone();
    stripped.model_not_found = vec![]; // a relayer drops the observation
    ctx("anyone.testnet", 3_000);
    assert!(fails(|| c.submit_outcome(stripped, sig.clone())), "dropping observations breaks the signature");
    // layout pin: no observations => byte-identical to the JC1s buffer; with observations => borsh(Vec<(String,u64)>) appended.
    let base = retry_with(bet_id, &th, 1, 3_000, 0, vec![]);
    let mut legacy = Vec::new();
    BorshSerialize::serialize(&CONTRACT.parse::<AccountId>().unwrap(), &mut legacy).unwrap();
    BorshSerialize::serialize(&base.bet_id, &mut legacy).unwrap();
    BorshSerialize::serialize(&base.terms_hash, &mut legacy).unwrap();
    BorshSerialize::serialize(&base.outcome, &mut legacy).unwrap();
    BorshSerialize::serialize(&base.element_results_hash, &mut legacy).unwrap();
    BorshSerialize::serialize(&base.run_no, &mut legacy).unwrap();
    BorshSerialize::serialize(&base.checked_until.0, &mut legacy).unwrap();
    BorshSerialize::serialize(&base.judge_pair_index, &mut legacy).unwrap();
    BorshSerialize::serialize(&base.next_check_ns.unwrap().0, &mut legacy).unwrap();
    let sk = outcome_signing_key();
    assert_eq!(sign_result(&sk, &base), hex_encode(&ed25519_dalek::Signer::sign(&sk, &legacy).to_bytes()));
    let mut with = legacy.clone();
    BorshSerialize::serialize(&vec![(m.clone(), 3_000u64)], &mut with).unwrap();
    assert_eq!(sig, hex_encode(&ed25519_dalek::Signer::sign(&sk, &with).to_bytes()));
}

#[test]
fn jc1x_submit_with_a_pair_that_is_not_the_first_live_applied_pair_is_refused() {
    let (mut c, bet_id, th) = setup();
    // pair 0 live: index 1 refused (even though applied and correctly signed)
    assert!(fails(|| submit(&mut c, 3_000, yes_at(bet_id, &th, 1, 1))));
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Taken);
    // a live pair exists: RETRY:no_live_judge is refused
    assert!(fails(|| submit(&mut c, 3_000, no_live(bet_id, &th, 1, 3_000))));
    // retire both pairs: no_live_judge is the only accepted result, YES at either index refused
    let (m0, m1) = (c.judge_chain()[0].model_a.clone(), c.judge_chain()[1].model_a.clone());
    let mut run = observe(&mut c, bet_id, &th, 1, &m0, 3, DAY_NS_X, 4_000);
    let t = 4_000 + 3 * DAY_NS_X;
    for k in 0..3u64 {
        let now = t + k * DAY_NS_X;
        submit(&mut c, now, retry_with(bet_id, &th, run, now, 1, vec![obs(&m1, now)]));
        run += 1;
    }
    let now = t + 3 * DAY_NS_X;
    assert_eq!(c.retired_models().len(), 2);
    assert!(fails(|| submit(&mut c, now, yes_at(bet_id, &th, run, 0))));
    assert!(fails(|| submit(&mut c, now, yes_at(bet_id, &th, run, 1))));
    submit(&mut c, now, no_live(bet_id, &th, run, now));
}

#[test]
fn jc1x_resolution_input_data_carries_the_chain_and_the_retirement_state() {
    let (mut c, bet_id, th) = setup();
    let m = model_a0(&c);
    observe(&mut c, bet_id, &th, 1, &m, 2, DAY_NS_X, 3_000);
    let v = c.resolution_input_data_for_test(bet_id);
    let v: serde_json::Value = serde_json::from_str(&v).unwrap();
    assert_eq!(v["judge_chain"].as_array().unwrap().len(), 2);
    assert_eq!(v["model_missing"][&m].as_array().unwrap().len(), 2);
    assert!(v["model_missing"].as_object().unwrap().len() == 1, "only models with observations are listed");
    assert_eq!(v["retired_models"].as_array().unwrap().len(), 0);
}

// ------------------------------------------------------------ point 2/3: proposals, caps, model ids

#[test]
fn jc1x_propose_while_paused_is_refused_but_apply_and_cancel_still_work() {
    let mut c = new_contract();
    propose(&mut c, 100, jp("neworg/a", "neworg/b"));
    ctx_with_deposit(GUARDIAN, 150, ONE_YOCTO);
    c.pause_new_offers();
    assert!(fails(|| { ctx_with_deposit(GUARDIAN, 160, ONE_YOCTO); c.cancel_judge_pair(); }) == false, "cancel allowed while paused");
    assert!(fails(|| propose(&mut c, 170, jp("neworg/c", "neworg/d"))), "propose refused while paused");
    propose_unpaused_apply_check();
}

fn propose_unpaused_apply_check() {
    let mut c = new_contract();
    propose(&mut c, 100, jp("neworg/a", "neworg/b"));
    ctx_with_deposit(GUARDIAN, 150, ONE_YOCTO);
    c.pause_new_offers();
    apply(&mut c, 100 + WEEK);
    assert_eq!(c.judge_chain().len(), 3, "apply allowed while paused");
}

#[test]
fn jc1x_second_pending_proposal_is_refused() {
    let mut c = new_contract();
    propose(&mut c, 100, jp("neworg/a", "neworg/b"));
    assert!(fails(|| propose(&mut c, 200, jp("neworg/c", "neworg/d"))));
    assert_eq!(c.pending_judge_pair().unwrap().pair, jp("neworg/a", "neworg/b"));
}

#[test]
fn jc1x_thirteenth_pair_is_refused() {
    let mut c = contract_with_chain(org_pairs(4)).expect("4 initial pairs");
    let mut t = 100;
    for i in 0..8 {
        propose(&mut c, t, jp(&format!("late/a{i}"), &format!("late/b{i}")));
        t += WEEK;
        apply(&mut c, t);
        t += 1;
    }
    assert_eq!(c.judge_chain().len(), 12);
    assert!(fails(|| propose(&mut c, t, jp("late/z1", "late/z2"))), "13th refused");
    assert_eq!(c.judge_chain().len(), 12);
}

#[test]
fn jc1x_identical_models_in_a_pair_are_refused_everywhere() {
    let mut c = new_contract();
    assert!(fails(|| propose(&mut c, 100, jp("neworg/a", "neworg/a"))));
    assert!(contract_with_chain(vec![jp("o/a", "o/a"), jp("o/b", "o/c")]).is_err());
}

#[test]
fn jc1x_new_requires_two_to_four_initial_pairs() {
    assert!(contract_with_chain(org_pairs(0)).is_err());
    assert!(contract_with_chain(org_pairs(1)).is_err(), "1 pair is not a backup chain");
    assert!(contract_with_chain(org_pairs(2)).is_ok());
    assert!(contract_with_chain(org_pairs(4)).is_ok());
    assert!(contract_with_chain(org_pairs(5)).is_err());
    assert!(contract_with_chain(org_pairs(12)).is_err());
}

#[test]
fn jc1x_model_ids_must_be_ascii_org_slash_model_within_128_bytes() {
    let good = || jp("deepseek-ai/DeepSeek-V4.1-Flash-1017", "zai-org/GLM-5.3-flash");
    let ok = |p: JudgePair| contract_with_chain(vec![good(), p]).is_ok();
    assert!(ok(jp("a/b", "c/d")));
    assert!(!ok(jp("nomodel", "c/d")), "no org/ form");
    assert!(!ok(jp("/b", "c/d")), "empty org");
    assert!(!ok(jp("a/", "c/d")), "empty model");
    assert!(!ok(jp("a/b/c", "c/d")), "two slashes");
    assert!(!ok(jp("a/b c", "c/d")), "whitespace");
    assert!(!ok(jp("a/bé", "c/d")), "non-ASCII");
    assert!(!ok(jp("a/b\"x", "c/d")), "quote");
    let long = format!("o/{}", "m".repeat(126)); // 128 bytes exactly
    assert_eq!(long.len(), 128);
    assert!(ok(jp(&long, "c/d")), "128 bytes ok");
    assert!(!ok(jp(&format!("{long}x"), "c/d")), "129 bytes refused");
    // same rules for a proposal
    let mut c = new_contract();
    for bad in ["nomodel", "a/b/c", "a/bé", &format!("{long}x")] {
        assert!(fails(|| propose(&mut c, 100, jp(bad, "n/ok"))), "proposal {bad:?} refused");
    }
}

// ------------------------------------------------------------ point 6 S1: two-step guardian

#[test]
fn jc1x_set_guardian_only_proposes_and_old_guardian_stays_until_accept() {
    let mut c = new_contract();
    ctx_with_deposit(GUARDIAN, 10, ONE_YOCTO);
    c.set_guardian("new_guardian.testnet".parse().unwrap());
    assert_eq!(c.guardian, GUARDIAN.parse::<AccountId>().unwrap(), "old guardian unchanged");
    assert_eq!(c.pending_guardian(), Some("new_guardian.testnet".parse().unwrap()));
    // the old guardian still holds every power; the proposed one holds none yet
    ctx_with_deposit(GUARDIAN, 11, ONE_YOCTO);
    c.pause_new_offers();
    assert!(fails(|| { ctx_with_deposit("new_guardian.testnet", 12, ONE_YOCTO); c.unpause_new_offers(); }));
}

#[test]
fn jc1x_accept_guardian_rotates_and_only_the_proposed_account_can_accept() {
    let mut c = new_contract();
    ctx_with_deposit(GUARDIAN, 10, ONE_YOCTO);
    c.set_guardian("new_guardian.testnet".parse().unwrap());
    assert!(fails(|| { ctx_with_deposit("random.testnet", 11, ONE_YOCTO); c.accept_guardian(); }), "a stranger cannot accept");
    assert!(fails(|| { ctx_with_deposit(GUARDIAN, 11, ONE_YOCTO); c.accept_guardian(); }), "the old guardian cannot accept for the new one");
    ctx_with_deposit("new_guardian.testnet", 12, ONE_YOCTO);
    c.accept_guardian();
    assert_eq!(c.guardian, "new_guardian.testnet".parse::<AccountId>().unwrap());
    assert_eq!(c.pending_guardian(), None);
    assert!(fails(|| { ctx_with_deposit(GUARDIAN, 13, ONE_YOCTO); c.pause_new_offers(); }), "old guardian lost its powers");
    ctx_with_deposit("new_guardian.testnet", 14, ONE_YOCTO);
    c.pause_new_offers();
}

#[test]
fn jc1x_unaccepted_rotation_keeps_the_old_guardian_and_cancel_works() {
    let mut c = new_contract();
    ctx_with_deposit(GUARDIAN, 10, ONE_YOCTO);
    c.set_guardian("typo-account.testnet".parse().unwrap());
    // nobody ever accepts (the account does not exist / nobody holds its key): old guardian keeps working forever
    ctx_with_deposit(GUARDIAN, 1_000_000_000_000_000, ONE_YOCTO);
    c.pause_new_offers();
    assert_eq!(c.guardian, GUARDIAN.parse::<AccountId>().unwrap());
    // cancel: guardian only
    assert!(fails(|| { ctx_with_deposit("random.testnet", 20, ONE_YOCTO); c.cancel_guardian(); }));
    ctx_with_deposit(GUARDIAN, 21, ONE_YOCTO);
    c.cancel_guardian();
    assert_eq!(c.pending_guardian(), None);
    assert!(fails(|| { ctx_with_deposit("typo-account.testnet", 22, ONE_YOCTO); c.accept_guardian(); }), "nothing pending to accept");
    assert!(fails(|| { ctx_with_deposit(GUARDIAN, 23, ONE_YOCTO); c.cancel_guardian(); }), "nothing to cancel");
}

#[test]
fn jc1x_a_new_proposal_replaces_the_pending_one_and_non_guardian_cannot_propose() {
    let mut c = new_contract();
    assert!(fails(|| { ctx_with_deposit("random.testnet", 5, ONE_YOCTO); c.set_guardian("x.testnet".parse().unwrap()); }));
    ctx_with_deposit(GUARDIAN, 10, ONE_YOCTO);
    c.set_guardian("first.testnet".parse().unwrap());
    ctx_with_deposit(GUARDIAN, 11, ONE_YOCTO);
    c.set_guardian("second.testnet".parse().unwrap());
    assert!(fails(|| { ctx_with_deposit("first.testnet", 12, ONE_YOCTO); c.accept_guardian(); }), "replaced proposal is dead");
    ctx_with_deposit("second.testnet", 13, ONE_YOCTO);
    c.accept_guardian();
    assert_eq!(c.guardian, "second.testnet".parse::<AccountId>().unwrap());
}

// ------------------------------------------------------------ point 6 S2/S4

#[test]
fn jc1x_contract_version_is_exactly_1_0_0() {
    let c = new_contract();
    assert_eq!(c.contract_version(), "1.0.0");
}

#[test]
fn jc1x_bet_count_equals_the_opened_count() {
    let mut c = new_contract();
    assert_eq!(c.bet_count(), 0);
    let (_, pk) = test_keypair(7);
    for n in 1..=3u64 {
        let env = base_envelope(&hex_encode(&pk));
        let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), n);
        assert_eq!(resp, vec![U128(0)]);
        assert_eq!(c.bet_count(), n);
    }
    // a rejected open does not count
    let mut bad = base_envelope(&hex_encode(&pk));
    bad.fee_bps = 5;
    let resp = do_mt_transfer(&mut c, "maker.testnet", bad.maker_required(), open_msg(&bad), 9);
    assert_ne!(resp, vec![U128(0)]);
    assert_eq!(c.bet_count(), 3);
}

// ------------------------------------------------------------ point 6 S3: NEP-297 events, table-driven

fn events(logs: &[String]) -> Vec<serde_json::Value> {
    logs.iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<serde_json::Value>(j).expect("EVENT_JSON must be valid JSON"))
        .collect()
}

fn one_event(logs: Vec<String>, name: &str) {
    let evs = events(&logs);
    let named: Vec<_> = evs.iter().filter(|e| e["event"] == name).collect();
    assert_eq!(named.len(), 1, "expected exactly one `{name}` event, logs: {logs:?}");
    let e = named[0];
    assert_eq!(e["standard"], "praetorial-escrow", "{name}");
    assert_eq!(e["version"], "1.0.0", "{name}");
    let data = e["data"].as_array().unwrap_or_else(|| panic!("{name}: data must be an array"));
    assert_eq!(data.len(), 1, "{name}: one data object");
    assert!(data[0].is_object(), "{name}: data[0] is an object");
    assert_eq!(e.as_object().unwrap().len(), 4, "{name}: only standard/version/event/data");
}

fn logs() -> Vec<String> {
    near_sdk::test_utils::get_logs()
}

fn ai_bet() -> (Contract, u64, String) {
    setup()
}

fn referee_env() -> Envelope {
    let mut env = base_envelope("");
    env.referee = Some(Referee { account: REFEREE.parse().unwrap(), mode: RefereeMode::Human });
    env.resolve_deadline = 365 * DAY_NS_X;
    env
}

fn referee_bet(c: &mut Contract) -> u64 {
    let env = referee_env();
    let r = do_mt_transfer(c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(r, vec![U128(0)]);
    let id = c.next_bet_id - 1;
    let msg = serde_json::to_string(&TransferMsg::Take { bet_id: id, invite_sig: None, tip: false, referee_ack: Some(REFEREE.parse().unwrap()) }).unwrap();
    let r = do_mt_transfer(c, "taker.testnet", env.taker_required(), msg, 2);
    assert_eq!(r, vec![U128(0)]);
    id
}

#[test]
fn jc1x_every_state_change_emits_exactly_one_nep297_event() {
    let (_, pk) = test_keypair(7);
    let pkh = hex_encode(&pk);
    type Case = (&'static str, &'static str, Box<dyn Fn() -> Vec<String>>);
    let cases: Vec<Case> = vec![
        ("open", "bet_opened", Box::new({ let pkh = pkh.clone(); move || { let mut c = new_contract(); let env = base_envelope(&pkh); do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1); logs() } })),
        ("take", "bet_taken", Box::new({ let pkh = pkh.clone(); move || { let mut c = new_contract(); let env = base_envelope(&pkh); do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1); let id = c.next_bet_id - 1; do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_msg(id), 2); logs() } })),
        ("submit_outcome YES", "outcome_submitted", Box::new(|| { let (mut c, id, th) = ai_bet(); submit(&mut c, 3_000, yes_at(id, &th, 1, 0)); logs() })),
        ("submit_outcome RETRY", "outcome_retry", Box::new(|| { let (mut c, id, th) = ai_bet(); submit(&mut c, 3_000, retry_result(id, &th, 1, 3_000, 3_000 + HOUR_NS)); logs() })),
        ("submit_outcome no_live_judge is a RETRY too", "outcome_retry", Box::new(|| {
            let (mut c, id, th) = ai_bet();
            let (m0, m1) = (c.judge_chain()[0].model_a.clone(), c.judge_chain()[1].model_a.clone());
            c.model_missing.insert(m0, vec![1, 1 + DAY_NS_X, 1 + 2 * DAY_NS_X]);
            c.model_missing.insert(m1, vec![1, 1 + DAY_NS_X, 1 + 2 * DAY_NS_X]);
            submit(&mut c, 3_000, no_live(id, &th, 1, 3_000)); let out = logs(); c.model_missing.remove(&c.judge_chain()[0].model_a.clone()); c.model_missing.remove(&c.judge_chain()[1].model_a.clone()); c.model_missing.flush(); out })),
        ("finalize", "bet_finalized", Box::new(|| { let (mut c, id, th) = ai_bet(); submit(&mut c, 3_000, yes_at(id, &th, 1, 0)); ctx("anyone.testnet", 3_000 + 86_400_000_000_001); c.finalize(id); logs() })),
        ("void_after_deadline", "bet_voided", Box::new(|| { let (mut c, id, _) = ai_bet(); ctx("anyone.testnet", 10_001); c.void_after_deadline(id); logs() })),
        ("cancel", "bet_cancelled", Box::new({ let pkh = pkh.clone(); move || { let mut c = new_contract(); let env = base_envelope(&pkh); do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1); let id = c.next_bet_id - 1; ctx("maker.testnet", 2); c.cancel(id); logs() } })),
        ("expire", "bet_expired", Box::new({ let pkh = pkh.clone(); move || { let mut c = new_contract(); let env = base_envelope(&pkh); do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1); let id = c.next_bet_id - 1; ctx("anyone.testnet", 1_001); c.expire(id); logs() } })),
        ("amend", "terms_amend_proposed", Box::new({ let pkh = pkh.clone(); move || { let mut c = new_contract(); let env = base_envelope(&pkh); do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1); let id = c.next_bet_id - 1; ctx("maker.testnet", 2); c.amend(id, "b".repeat(64)); logs() } })),
        ("amend_referee", "referee_amended", Box::new({ let pkh = pkh.clone(); move || { let mut c = new_contract(); let env = base_envelope(&pkh); do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1); let id = c.next_bet_id - 1; let r = serde_json::to_string(&Some(Referee { account: REFEREE.parse().unwrap(), mode: RefereeMode::Human })).unwrap(); ctx("maker.testnet", 100); c.amend_referee(id, r); logs() } })),
        ("referee_rule", "referee_ruled", Box::new(|| { let mut c = new_contract(); let id = referee_bet(&mut c); ctx(REFEREE, 2_000); c.referee_rule(id, "YES".to_string()); logs() })),
        ("concede", "bet_conceded", Box::new({ let pkh = pkh.clone(); move || { let mut c = new_contract(); let id = open_and_take(&mut c, &pkh); ctx("taker.testnet", 3); c.concede(id); logs() } })),
        ("on_payout_result ok", "payout_done", Box::new(|| { let (mut c, id, th) = ai_bet(); submit(&mut c, 3_000, yes_at(id, &th, 1, 0)); ctx("anyone.testnet", 3_000 + 86_400_000_000_001); c.finalize(id);
            let p = c.pending_payouts(id).into_iter().find(|p| p.in_flight).expect("in flight"); ctx_with_promise_result(CONTRACT, 4_000_000_000_000, PromiseResult::Successful(vec![])); c.on_payout_result(vec![p.id]); logs() })),
        ("on_payout_result failed", "payout_failed", Box::new(|| { let (mut c, id, th) = ai_bet(); submit(&mut c, 3_000, yes_at(id, &th, 1, 0)); ctx("anyone.testnet", 3_000 + 86_400_000_000_001); c.finalize(id);
            let p = c.pending_payouts(id).into_iter().find(|p| p.in_flight).expect("in flight"); ctx_with_promise_result(CONTRACT, 4_000_000_000_000, PromiseResult::Failed); c.on_payout_result(vec![p.id]); logs() })),
        ("propose_params", "params_proposed", Box::new(|| { let mut c = new_contract(); ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO); c.propose_params(ParamsChange { fee_bps: Some(100), assets: vec![] }); logs() })),
        ("propose_judge_pair", "judge_pair_proposed", Box::new(|| { let mut c = new_contract(); propose(&mut c, 5, jp("neworg/a", "neworg/b")); logs() })),
        ("apply_judge_pair", "judge_pair_applied", Box::new(|| { let mut c = new_contract(); propose(&mut c, 5, jp("neworg/a", "neworg/b")); apply(&mut c, 5 + WEEK); logs() })),
        ("cancel_judge_pair", "judge_pair_cancelled", Box::new(|| { let mut c = new_contract(); propose(&mut c, 5, jp("neworg/a", "neworg/b")); ctx_with_deposit(GUARDIAN, 6, ONE_YOCTO); c.cancel_judge_pair(); logs() })),
        ("propose_asset", "asset_proposed", Box::new(|| { let mut c = new_contract(); super::as1::propose_for_table(&mut c, 5); logs() })),
        ("apply_asset", "asset_applied", Box::new(|| { let mut c = new_contract(); super::as1::propose_for_table(&mut c, 5); super::as1::apply_for_table(&mut c, 5); logs() })),
        ("cancel_asset", "asset_cancelled", Box::new(|| { let mut c = new_contract(); super::as1::propose_other_for_table(&mut c, 5); ctx_with_deposit(GUARDIAN, 6, ONE_YOCTO); c.cancel_asset(); logs() })),
        ("disable_asset_for_new_bets", "asset_disabled", Box::new(|| { let mut c = new_contract(); ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO); c.disable_asset_for_new_bets(USDC.to_string()); logs() })),
        ("set_guardian", "guardian_proposed", Box::new(|| { let mut c = new_contract(); ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO); c.set_guardian("ng.testnet".parse().unwrap()); logs() })),
        ("accept_guardian", "guardian_rotated", Box::new(|| { let mut c = new_contract(); ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO); c.set_guardian("ng.testnet".parse().unwrap()); ctx_with_deposit("ng.testnet", 6, ONE_YOCTO); c.accept_guardian(); logs() })),
        ("cancel_guardian", "guardian_cancelled", Box::new(|| { let mut c = new_contract(); ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO); c.set_guardian("ng.testnet".parse().unwrap()); ctx_with_deposit(GUARDIAN, 6, ONE_YOCTO); c.cancel_guardian(); logs() })),
        ("pause_new_offers", "offers_paused", Box::new(|| { let mut c = new_contract(); ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO); c.pause_new_offers(); logs() })),
        ("unpause_new_offers", "offers_unpaused", Box::new(|| { let mut c = new_contract(); ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO); c.pause_new_offers(); ctx_with_deposit(GUARDIAN, 6, ONE_YOCTO); c.unpause_new_offers(); logs() })),
        ("emergency_shutdown", "emergency_shutdown", Box::new(|| { let mut c = new_contract(); ctx_with_deposit(GUARDIAN, 5, ONE_YOCTO); c.emergency_shutdown(); logs() })),
    ];
    for (label, ev, f) in cases {
        // the mocked VM storage outlives a Contract value: start every case from an empty chain-state store.
        near_sdk::testing_env!(near_sdk::test_utils::VMContextBuilder::new().build());
        let l = f();
        let r = catch_unwind(AssertUnwindSafe(|| one_event(l.clone(), ev)));
        assert!(r.is_ok(), "case `{label}` (event `{ev}`) failed; logs: {l:?}");
    }
}

#[test]
fn jc1x_pre_existing_event_json_format_is_unchanged() {
    // the hand-formatted events keep key order standard,version,event,data (S3: consistent format).
    let mut c = new_contract();
    propose(&mut c, 5, jp("neworg/a", "neworg/b"));
    let l = logs();
    let line = l.iter().find(|l| l.contains("judge_pair_proposed")).unwrap();
    assert!(line.starts_with("EVENT_JSON:{\"standard\":\"praetorial-escrow\",\"version\":\"1.0.0\",\"event\":\"judge_pair_proposed\",\"data\":[{"));
}

// ------------------------------------------------------------ point 5: full-chain envelope and gas

fn full_chain_contract() -> Contract {
    let long = |i: usize, s: &str| format!("{}/{}", "o".repeat(30), format!("{s}{i}{}", "m".repeat(128 - 30 - 1 - 1 - s.len() - i.to_string().len())));
    let mut c = contract_with_chain((0..4).map(|i| jp(&long(i, "a"), &long(i, "b"))).collect()).expect("4 pairs with 128-byte ids");
    let mut t = 100;
    for i in 4..12 {
        propose(&mut c, t, jp(&long(i, "a"), &long(i, "b")));
        t += WEEK;
        apply(&mut c, t);
        t += 1;
    }
    assert_eq!(c.judge_chain().len(), 12);
    c
}

#[test]
fn jc1x_full_12_pair_envelope_with_max_terms_and_all_observations_stays_under_the_free_input_bytes() {
    let c = full_chain_contract();
    let mut missing = std::collections::BTreeMap::new();
    for p in c.judge_chain() {
        for m in [p.model_a, p.model_b] {
            missing.insert(m, vec![U64(1_700_000_000_000_000_000), U64(1_700_086_400_000_000_000), U64(1_700_172_800_000_000_000)]);
        }
    }
    let mut env = base_envelope("");
    env.terms = Some("t".repeat(MAX_TERMS_LEN));
    let s = c.resolution_input_data_with_missing_for_test(&env, &missing);
    assert!(
        s.len() <= OUTLAYER_INPUT_DATA_FREE_BYTES,
        "worst-case input_data is {} bytes, over the {} free bytes",
        s.len(),
        OUTLAYER_INPUT_DATA_FREE_BYTES
    );
    let v: serde_json::Value = serde_json::from_str(&s).unwrap();
    assert_eq!(v["judge_chain"].as_array().unwrap().len(), 12);
    assert_eq!(v["model_missing"].as_object().unwrap().len(), 24);
}

#[test]
fn jc1x_submit_outcome_gas_with_a_full_chain_and_all_models_observed_is_under_budget() {
    const TGAS: u64 = 1_000_000_000_000;
    let mut c = full_chain_contract();
    let (_, pk) = test_keypair(7);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let th = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();
    let chain = c.judge_chain();
    // 22 models carry two observations each (not retired), pair 0 models too.
    for p in &chain {
        for m in [&p.model_a, &p.model_b] {
            c.model_missing.insert(m.clone(), vec![1, 1 + DAY_NS_X]);
        }
    }
    let ts = 5_000 + 12 * WEEK;
    let r = retry_with(bet_id, &th, 1, ts, 0, vec![obs(&chain[0].model_a, ts)]);
    let sig = sign_result(&outcome_signing_key(), &r);
    let mut c = cold_contract(c, ts);
    c.submit_outcome(r, sig);
    let used = near_sdk::env::used_gas().as_gas();
    assert!(used < 30 * TGAS, "submit_outcome with a 12-pair chain used {} Tgas (budget 30)", used / TGAS);
}
