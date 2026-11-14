//! STG1 (D-STORAGE1, MONEY): per-asset, per-side storage charge. The contract
//! computes each side's charge from the byte estimate and THAT side's own
//! asset rate (`AssetLimit.storage_per_kib`): maker at open, taker at take
//! (primary or option asset actually taken). The envelope's
//! `storage_charge_per_side` must be "0". Child of tests.rs (`#[path]`).
use super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};

const DAY: u64 = 24 * 60 * 60 * 1_000_000_000;
const REF: &str = "referee.testnet";
// Distinct, deliberately unequal rates (raw units per KiB).
const R_USDC: u128 = 4_096;
const R_BTC: u128 = 100_000;
const R_WNEAR: u128 = 10_240_000_000_000_000_000_000;

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

/// Independent copy of the D-STORAGE1 formula: max(1, ceil(bytes * rate / 1024 / 2)).
fn expect(bytes: u64, rate: u128) -> u128 {
    std::cmp::max(1, (bytes as u128 * rate + 2047) / 2048)
}

fn table() -> Vec<(String, AssetLimit)> {
    let mut t = spec_default_asset_limits();
    for (id, l) in t.iter_mut() {
        l.storage_per_kib = U128(match id.as_str() {
            x if x == USDC => R_USDC,
            x if x == MOCK_BTC => R_BTC,
            _ => R_WNEAR,
        });
    }
    t
}

fn limits() -> Limits {
    Limits {
        max_stake: U128(1_000_000_000),
        max_offer_ttl_secs: 86400 * 60,
        max_stake_per_side_near: U128(100 * 10u128.pow(24)),
        max_rounds: crate::DEFAULT_MAX_ROUNDS,
        max_retries: crate::DEFAULT_MAX_RETRIES,
    }
}

fn contract() -> Contract {
    new_contract_with_limits_and_assets(limits(), None, table())
}

/// BTC maker (10_000 sats) vs USDC taker (5 USDC); storage "0" on the envelope.
fn cross_env(keep_terms: bool, human: bool) -> Envelope {
    let mut env = base_envelope("");
    env.maker_asset = MOCK_BTC.to_string();
    env.taker_asset = USDC.to_string();
    env.stake_maker = U128(10_000);
    env.stake_taker = U128(5_000_000);
    env.storage_charge_per_side = U128(0);
    env.keep_terms = keep_terms;
    if !keep_terms {
        env.terms = None;
    }
    if human {
        env.referee = Some(Referee { account: acct(REF), mode: RefereeMode::Human });
    }
    env.resolve_deadline = 365 * DAY;
    env
}

fn take_msg_h(bet_id: u64, ack: Option<&str>) -> String {
    serde_json::to_string(&TransferMsg::Take { bet_id, invite_sig: None, tip: false, referee_ack: ack.map(acct) })
        .unwrap()
}

/// Opens with the exactly-computed maker deposit; returns (id, maker deposit).
fn open(c: &mut Contract, env: &Envelope, maker_dep: u128) -> (u64, u128) {
    let r = do_mt_transfer_asset(c, "maker.testnet", &env.maker_asset, maker_dep, open_msg(env), 1);
    assert_eq!(r, vec![U128(0)], "open must be accepted with the contract-computed deposit");
    (c.next_bet_id - 1, maker_dep)
}

fn take(c: &mut Contract, env: &Envelope, id: u64, asset: &str, dep: u128) {
    let ack = env.referee.as_ref().map(|r| r.account.to_string());
    let r = do_mt_transfer_asset(c, "taker.testnet", asset, dep, take_msg_h(id, ack.as_deref()), 2);
    assert_eq!(r, vec![U128(0)], "take must be accepted with the contract-computed deposit");
}

fn lines_of(c: &Contract, id: u64) -> Vec<PendingPayout> {
    c.payout_ids_in_order()
        .iter()
        .map(|p| c.pending_payouts.get(p).unwrap().clone())
        .filter(|p| p.bet_id == id)
        .collect()
}

fn sum_to(c: &Contract, id: u64, who: &str, asset: &str) -> u128 {
    lines_of(c, id).iter().filter(|p| p.receiver == acct(who) && p.token_id == asset).map(|p| p.amount.0).sum()
}

fn total(c: &Contract, id: u64, asset: &str) -> u128 {
    lines_of(c, id).iter().filter(|p| p.token_id == asset).map(|p| p.amount.0).sum()
}

fn bytes_of(env: &Envelope) -> u64 {
    env.estimated_storage_bytes()
}

/// Opens + takes the cross-asset bet with the independently computed deposits.
/// Returns (id, env, sm, st) with sm/st the expected per-side charges.
fn cross_bet(c: &mut Contract, keep_terms: bool, human: bool) -> (u64, Envelope, u128, u128) {
    let env = cross_env(keep_terms, human);
    let b = bytes_of(&env);
    let (sm, st) = (expect(b, R_BTC), expect(b, R_USDC));
    let (id, _) = open(c, &env, env.stake_maker.0 + sm);
    take(c, &env, id, USDC, env.stake_taker.0 + st);
    (id, env, sm, st)
}

fn conserved(c: &Contract, id: u64, env: &Envelope, sm: u128, st: u128, what: &str) {
    assert_eq!(total(c, id, MOCK_BTC), env.stake_maker.0 + sm, "{what}: I-2 BTC");
    assert_eq!(total(c, id, USDC), env.stake_taker.0 + st, "{what}: I-2 USDC");
}

fn submit_and_finalize(c: &mut Contract, id: u64, env: &Envelope, outcome: &str) {
    let ts = 2_000u64;
    ctx("anyone.testnet", ts);
    let result = SubmittedResult {
        bet_id: id,
        terms_hash: env.terms_hash.clone(),
        outcome: outcome.to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(ts),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    ctx("anyone.testnet", ts + env.settlement_period + 1);
    c.finalize(id);
}

// (a) BTC-maker vs USDC-taker: each side's charge is its own-asset formula and
// the payout returns/keeps exactly those amounts in the right assets.
#[test]
fn stg1_a_cross_asset_each_side_own_formula_and_payout() {
    let mut c = contract();
    let (id, env, sm, st) = cross_bet(&mut c, true, false);
    let bet = c.get_bet(id).unwrap();
    assert_eq!(bet.storage_maker.0, sm, "maker charge = BTC-rate formula");
    assert_eq!(bet.storage_taker.0, st, "taker charge = USDC-rate formula");
    assert_ne!(sm, st);
    submit_and_finalize(&mut c, id, &env, "YES");
    let fee = acct(FEE);
    let _ = fee;
    // fee account keeps fee + own-asset storage in each asset (keep_terms).
    assert_eq!(sum_to(&c, id, FEE, MOCK_BTC), 100 + sm, "fee(1% of 10_000) + BTC storage, BTC");
    assert_eq!(sum_to(&c, id, FEE, USDC), 50_000 + st, "fee(1% of 5 USDC) + USDC storage, USDC");
    conserved(&c, id, &env, sm, st, "decisive");
}

// (a, VOID refund variant) !keep_terms VOID returns each side its own charge in its own asset.
#[test]
fn stg1_a_void_refunds_each_side_own_charge_own_asset() {
    let mut c = contract();
    let (id, env, sm, st) = cross_bet(&mut c, false, true);
    ctx(REF, 1_001);
    c.referee_rule(id, "VOID".to_string());
    assert_eq!(sum_to(&c, id, "maker.testnet", MOCK_BTC), env.stake_maker.0 + sm);
    assert_eq!(sum_to(&c, id, "taker.testnet", USDC), env.stake_taker.0 + st);
    assert_eq!(sum_to(&c, id, "maker.testnet", USDC), 0);
    assert_eq!(sum_to(&c, id, "taker.testnet", MOCK_BTC), 0);
    conserved(&c, id, &env, sm, st, "referee VOID");
}

// (b) a wNEAR side pays the nonzero wNEAR rate.
#[test]
fn stg1_b_wnear_side_pays_nonzero_wnear_rate() {
    let mut c = contract();
    let mut env = cross_env(true, false);
    env.maker_asset = MOCK_WNEAR.to_string();
    env.stake_maker = U128(2_000_000_000_000_000_000_000_000);
    let want = expect(bytes_of(&env), R_WNEAR);
    assert!(want > 1_000_000_000_000_000_000, "wNEAR charge must be a real amount, got {want}");
    let (id, _) = open(&mut c, &env, env.stake_maker.0 + want);
    assert_eq!(c.get_bet(id).unwrap().storage_maker.0, want);
    // the old flat raw-unit-per-byte number must NOT be accepted for a wNEAR maker
    let mut c2 = contract();
    let old_flat = env.stake_maker.0 + bytes_of(&env) as u128 / 2;
    let r = do_mt_transfer_asset(&mut c2, "maker.testnet", MOCK_WNEAR, old_flat, open_msg(&env), 1);
    assert_eq!(r, vec![U128(old_flat)], "a deposit short of the wNEAR charge is refunded in full");
}

// (c) a take via a taker option uses the OPTION asset's rate.
#[test]
fn stg1_c_take_via_option_uses_option_asset_rate() {
    let mut c = contract();
    let mut env = cross_env(true, false);
    env.taker_options = vec![TakerOption { asset: MOCK_WNEAR.to_string(), amount: U128(1_500_000_000_000_000_000_000_000) }];
    let b = bytes_of(&env);
    let sm = expect(b, R_BTC);
    let (id, _) = open(&mut c, &env, env.stake_maker.0 + sm);
    let st_wnear = expect(b, R_WNEAR);
    let st_primary = expect(b, R_USDC);
    // the primary-asset charge is wrong for the option asset -> refunded
    let wrong = 1_500_000_000_000_000_000_000_000u128 + st_primary;
    let r = do_mt_transfer_asset(&mut c, "taker.testnet", MOCK_WNEAR, wrong, take_msg_h(id, None), 2);
    assert_eq!(r, vec![U128(wrong)], "primary-asset charge on an option take is refunded");
    let right = 1_500_000_000_000_000_000_000_000u128 + st_wnear;
    let r = do_mt_transfer_asset(&mut c, "taker.testnet", MOCK_WNEAR, right, take_msg_h(id, None), 3);
    assert_eq!(r, vec![U128(0)]);
    let bet = c.get_bet(id).unwrap();
    assert_eq!(bet.storage_taker.0, st_wnear);
    assert_eq!(bet.envelope.taker_asset, MOCK_WNEAR);
}

// (d) 8 KiB terms cost proportionally more than empty terms on every asset.
#[test]
fn stg1_d_big_terms_cost_proportionally_more_on_every_asset() {
    for (asset, rate) in [(USDC, R_USDC), (MOCK_BTC, R_BTC), (MOCK_WNEAR, R_WNEAR)] {
        let mut small = cross_env(true, false);
        small.terms = Some(String::new());
        let mut big = cross_env(true, false);
        big.terms = Some("x".repeat(MAX_TERMS_LEN));
        let (bs, bb) = (bytes_of(&small), bytes_of(&big));
        assert_eq!(bb - bs, MAX_TERMS_LEN as u64);
        let (cs, cb) = (expect(bs, rate), expect(bb, rate));
        assert!(cb > cs, "{asset}: 8KiB terms must cost more than empty terms");
        // the contract actually charges that: open the big one with the exact amount
        let stake = if asset == MOCK_BTC { 10_000 } else if asset == USDC { 5_000_000 } else { 2_000_000_000_000_000_000_000_000 };
        let mut env = big.clone();
        env.maker_asset = asset.to_string();
        env.taker_asset = asset.to_string();
        env.stake_maker = U128(stake);
        env.stake_taker = U128(stake);
        let mut c = contract();
        let r = do_mt_transfer_asset(&mut c, "maker.testnet", asset, stake + cb - 1, open_msg(&env), 1);
        assert_eq!(r, vec![U128(stake + cb - 1)], "{asset}: one unit short of the 8KiB charge is refunded");
        let (id, _) = open(&mut c, &env, stake + cb);
        assert_eq!(c.get_bet(id).unwrap().storage_maker.0, cb);
    }
}

// (e) new() rejects a 0 storage_per_kib (a missing one is a deserialization
// failure: AssetLimit has no serde default for it).
#[test]
fn stg1_e_new_rejects_zero_storage_per_kib() {
    for idx in 0..3 {
        let mut t = table();
        t[idx].1.storage_per_kib = U128(0);
        let r = catch_unwind(AssertUnwindSafe(|| {
            new_contract_with_limits_and_assets(limits(), None, t);
        }));
        assert!(r.is_err(), "asset #{idx}: storage_per_kib 0 must be rejected by new()");
    }
}

#[test]
fn stg1_e_missing_storage_per_kib_is_not_defaulted() {
    let json = r#"{"min_per_side":"5","max_per_side":"10","min_fee_per_side":"1","run_price":"1","min_bond":"1","min_objection":"1"}"#;
    assert!(serde_json::from_str::<AssetLimit>(json).is_err(), "no serde default for storage_per_kib");
    let with = r#"{"min_per_side":"5","max_per_side":"10","min_fee_per_side":"1","run_price":"1","min_bond":"1","min_objection":"1","storage_per_kib":"7"}"#;
    assert_eq!(serde_json::from_str::<AssetLimit>(with).unwrap().storage_per_kib.0, 7);
}

// (f) a nonzero envelope storage_charge_per_side is refused at open.
#[test]
fn stg1_f_nonzero_envelope_storage_refused_at_open() {
    let mut c = contract();
    let first_id = c.next_bet_id;
    let mut env = cross_env(true, false);
    env.storage_charge_per_side = U128(10_000);
    let b = bytes_of(&env);
    let dep = env.stake_maker.0 + expect(b, R_BTC);
    let r = do_mt_transfer_asset(&mut c, "maker.testnet", MOCK_BTC, dep, open_msg(&env), 1);
    assert_eq!(r, vec![U128(dep)], "refunded in full");
    assert_eq!(c.next_bet_id, first_id, "no bet created");
    let dep2 = env.stake_maker.0 + 10_000;
    let r = do_mt_transfer_asset(&mut c, "maker.testnet", MOCK_BTC, dep2, open_msg(&env), 1);
    assert_eq!(r, vec![U128(dep2)], "the old envelope-driven amount is refused too");
    assert_eq!(env.sanity_check(), Err("storage_charge_per_side must be \"0\": the contract computes per-side storage charges"));
}

// (g) I-2 conservation on every ending for a cross-asset bet.
#[test]
fn stg1_g_conservation_every_ending_cross_asset() {
    for keep_terms in [true, false] {
        // decisive via AI finalize
        let mut c = contract();
        let (id, env, sm, st) = cross_bet(&mut c, keep_terms, false);
        submit_and_finalize(&mut c, id, &env, "NO");
        conserved(&c, id, &env, sm, st, "decisive NO");
        // AI VOID via finalize
        let mut c = contract();
        let (id, env, sm, st) = cross_bet(&mut c, keep_terms, false);
        submit_and_finalize(&mut c, id, &env, "VOID");
        conserved(&c, id, &env, sm, st, "AI VOID");
        // referee decisive + VOID
        for outcome in ["YES", "VOID"] {
            let mut c = contract();
            let (id, env, sm, st) = cross_bet(&mut c, keep_terms, true);
            ctx(REF, 1_001);
            c.referee_rule(id, outcome.to_string());
            conserved(&c, id, &env, sm, st, outcome);
        }
        // concede
        let mut c = contract();
        let (id, env, sm, st) = cross_bet(&mut c, keep_terms, false);
        ctx("maker.testnet", 3_000);
        c.concede(id);
        conserved(&c, id, &env, sm, st, "concede");
        // deadline refund
        let mut c = contract();
        let (id, env, sm, st) = cross_bet(&mut c, keep_terms, false);
        ctx("anyone.testnet", env.resolve_deadline + 1);
        c.void_after_deadline(id);
        conserved(&c, id, &env, sm, st, "void_after_deadline");
        // emergency refund of a taken bet
        let mut c = contract();
        let (id, env, sm, st) = cross_bet(&mut c, keep_terms, false);
        ctx_with_deposit(GUARDIAN, 3_000, NearToken::from_yoctonear(1));
        c.emergency_shutdown();
        ctx("anyone.testnet", 3_001);
        c.emergency_refund(id);
        conserved(&c, id, &env, sm, st, "emergency_refund");
        // untaken: cancel / expire / reclaim / emergency refund of an Open offer
        for how in ["cancel", "expire", "reclaim", "emergency"] {
            let mut c = contract();
            let env = cross_env(keep_terms, false);
            let sm = expect(bytes_of(&env), R_BTC);
            let (id, _) = open(&mut c, &env, env.stake_maker.0 + sm);
            match how {
                "cancel" => {
                    ctx("maker.testnet", 5);
                    c.cancel(id)
                }
                "expire" => {
                    ctx("anyone.testnet", env.funding_deadline + 1);
                    c.expire(id)
                }
                "reclaim" => {
                    ctx(OPERATOR, 5);
                    c.reclaim(id)
                }
                _ => {
                    ctx_with_deposit(GUARDIAN, 5, NearToken::from_yoctonear(1));
                    c.emergency_shutdown();
                    ctx("anyone.testnet", 6);
                    c.emergency_refund(id)
                }
            }
            assert_eq!(sum_to(&c, id, "maker.testnet", MOCK_BTC), env.stake_maker.0 + sm, "{how}: full BTC deposit back");
            assert_eq!(total(&c, id, MOCK_BTC), env.stake_maker.0 + sm, "{how}");
            assert_eq!(total(&c, id, USDC), 0, "{how}: nothing in the taker asset");
        }
    }
}
