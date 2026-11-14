//! FM1 (D-FEEMIN2, GATE-05 drift F1, MONEY): a `take` that matches a
//! `taker_options` entry swaps taker_asset/stake_taker, but the bet used to
//! keep `fee_min_taker` from the PRIMARY taker asset's limit. Every taker-side
//! fee/tip then used the wrong asset's minimum. The bet must instead hold its
//! own copy of the min fee of EACH taker option asset (D-PARAMS1 copy-for-life)
//! and use the matched one. Child of tests.rs (`#[path]`).
use super::*;

const DAY: u64 = 24 * 60 * 60 * 1_000_000_000;
const REF: &str = "referee.testnet";

const USDC_MIN_FEE: u128 = 150_000; // $0.15, dominates 1% of 10 USDC (100_000)
const USDC_CAP: u128 = 250_000; // = min_per_side / 20
const WNEAR_MIN_FEE: u128 = 60_000_000_000_000_000_000_000; // 6e22; 1% of 3e24 is 3e22
const WNEAR_STAKE: u128 = 3_000_000_000_000_000_000_000_000; // 3e24
const USDC_STAKE: u128 = 10_000_000;
const STORAGE: u128 = 10_000;

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn assets() -> Vec<(String, AssetLimit)> {
    vec![
        (
            USDC.to_string(),
            AssetLimit {
                min_per_side: U128(5_000_000),
                min_fee_per_side: U128(USDC_MIN_FEE),
                min_fee_cap_per_side: U128(USDC_CAP),
                storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
                max_per_side: U128(1_000_000_000),
                run_price: U128(DEFAULT_RUN_PRICE),
                min_bond: U128(USDC_MIN_BOND),
                min_objection: U128(USDC_MIN_OBJECTION),
            },
        ),
        (
            MOCK_WNEAR.to_string(),
            AssetLimit {
                min_per_side: U128(1_326_259_946_949_602_229_354_496),
                min_fee_per_side: U128(WNEAR_MIN_FEE),
                min_fee_cap_per_side: U128(0),
                storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
                max_per_side: U128(66_312_997_347_480_103_951_532_032),
                run_price: U128(1),
                min_bond: U128(1_326_259_946_949_602_229_354_496),
                min_objection: U128(265_251_989_389_920_445_870_899),
            },
        ),
    ]
}

fn contract() -> Contract {
    new_contract_with_limits_and_assets(
        Limits {
            max_stake: U128(u128::MAX / 4),
            max_offer_ttl_secs: 86400 * 60,
            max_stake_per_side_near: U128(100 * 10u128.pow(24)),
            max_rounds: crate::DEFAULT_MAX_ROUNDS,
            max_retries: crate::DEFAULT_MAX_RETRIES,
        },
        None,
        assets(),
    )
}

fn human(env: &mut Envelope) {
    env.referee = Some(Referee { account: acct(REF), mode: RefereeMode::Human });
    env.resolve_deadline = 365 * DAY;
}

/// (a): maker stakes 10 USDC; primary taker asset is wNEAR (3e24), with a
/// 10 USDC taker option.
fn wnear_primary_env(seed: u8) -> Envelope {
    let (_, pk) = test_keypair(seed);
    let mut env = base_envelope(&hex_encode(&pk));
    env.stake_maker = U128(USDC_STAKE);
    env.taker_asset = MOCK_WNEAR.to_string();
    env.stake_taker = U128(WNEAR_STAKE);
    env.taker_options = vec![TakerOption { asset: USDC.to_string(), amount: U128(USDC_STAKE) }];
    env
}

/// (b): USDC primary on both sides, with a 3e24 wNEAR taker option.
fn usdc_primary_env(seed: u8) -> Envelope {
    let (_, pk) = test_keypair(seed);
    let mut env = base_envelope(&hex_encode(&pk));
    env.stake_maker = U128(USDC_STAKE);
    env.stake_taker = U128(USDC_STAKE);
    env.taker_options = vec![TakerOption { asset: MOCK_WNEAR.to_string(), amount: U128(WNEAR_STAKE) }];
    env
}

fn open(c: &mut Contract, env: &Envelope) -> u64 {
    let r = do_mt_transfer_asset(c, "maker.testnet", &env.maker_asset, env.maker_required(), open_msg(env), 1);
    assert_eq!(r, vec![U128(0)], "open must be accepted");
    c.next_bet_id - 1
}

fn take_as(c: &mut Contract, id: u64, asset: &str, stake: u128, tip: bool, ack: Option<&str>, ts: u64) {
    let msg = serde_json::to_string(&TransferMsg::Take { bet_id: id, invite_sig: None, tip, referee_ack: ack.map(acct) })
        .unwrap();
    let r = do_mt_transfer_asset(c, "taker.testnet", asset, stake + STORAGE, msg, ts);
    assert_eq!(r, vec![U128(0)], "take must be accepted");
}

fn submit(c: &mut Contract, id: u64, env: &Envelope, outcome: &str, ts: u64) {
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

fn sum_to(c: &Contract, id: u64, who: &str, asset: &str) -> u128 {
    c.payout_ids_in_order()
        .iter()
        .map(|p| c.pending_payouts.get(p).unwrap().clone())
        .filter(|p| p.bet_id == id && p.receiver == acct(who) && p.token_id == asset)
        .map(|p| p.amount.0)
        .sum()
}

fn conserved(c: &Contract, id: u64, asset: &str, deposited: u128) {
    let out: u128 = c
        .payout_ids_in_order()
        .iter()
        .map(|p| c.pending_payouts.get(p).unwrap().clone())
        .filter(|p| p.bet_id == id && p.token_id == asset)
        .map(|p| p.amount.0)
        .sum();
    assert_eq!(out, deposited, "I-2: payouts in {asset} must equal deposits");
}

/// Shared assertions for case (a): maker 10 USDC vs taker 10 USDC (taken via
/// the option); the TAKER wins. Each side pays max(1%, 0.15 USDC) = 150_000.
fn assert_a_taker_wins(c: &Contract, id: u64) {
    let fee = 150_000u128;
    assert_eq!(sum_to(c, id, "taker.testnet", USDC), 2 * USDC_STAKE - 2 * fee, "taker: both pots less exactly two USDC min fees");
    assert_eq!(sum_to(c, id, FEE, USDC), 2 * fee + 2 * STORAGE, "fee_account: exactly the USDC fees + storage, NOT the whole stake");
    assert_eq!(sum_to(c, id, "taker.testnet", MOCK_WNEAR), 0);
    assert_eq!(sum_to(c, id, FEE, MOCK_WNEAR), 0);
    conserved(c, id, USDC, 2 * USDC_STAKE + 2 * STORAGE);
}

// ---------------------------------------------------------------- (a)

#[test]
fn fm1_a_wnear_primary_taken_in_usdc_finalize_charges_usdc_min_fee() {
    let mut c = contract();
    let env = wnear_primary_env(180);
    let id = open(&mut c, &env);
    take_as(&mut c, id, USDC, USDC_STAKE, false, None, 2);
    submit(&mut c, id, &env, "NO", 2_000); // maker_side YES -> NO = taker wins
    assert_a_taker_wins(&c, id);
}

// ---------------------------------------------------------------- (b)

#[test]
fn fm1_b_usdc_primary_taken_in_wnear_charges_at_least_wnear_min_fee() {
    let mut c = contract();
    let env = usdc_primary_env(181);
    let id = open(&mut c, &env);
    take_as(&mut c, id, MOCK_WNEAR, WNEAR_STAKE, false, None, 2);
    submit(&mut c, id, &env, "YES", 2_000); // maker wins; the taker's fee is still charged
    let taker_fee = sum_to(&c, id, FEE, MOCK_WNEAR) - STORAGE;
    assert!(taker_fee >= WNEAR_MIN_FEE, "taker fee {taker_fee} must be >= the wNEAR min fee {WNEAR_MIN_FEE}");
    assert_eq!(taker_fee, WNEAR_MIN_FEE, "exactly max(1%, wNEAR min fee)");
    assert_eq!(sum_to(&c, id, "maker.testnet", MOCK_WNEAR), WNEAR_STAKE - WNEAR_MIN_FEE);
    // maker's own USDC fee unaffected
    assert_eq!(sum_to(&c, id, FEE, USDC), 150_000 + STORAGE);
    conserved(&c, id, MOCK_WNEAR, WNEAR_STAKE + STORAGE);
}

// ---------------------------------------------------------------- (c)

#[test]
fn fm1_c_concede_charges_option_asset_min_fee() {
    let mut c = contract();
    let env = wnear_primary_env(182);
    let id = open(&mut c, &env);
    take_as(&mut c, id, USDC, USDC_STAKE, false, None, 2);
    ctx("maker.testnet", 1_500);
    c.concede(id); // maker concedes -> taker wins
    assert_a_taker_wins(&c, id);
}

#[test]
fn fm1_c_referee_rule_with_taker_tip_charges_option_asset_min_fee() {
    let mut c = contract();
    let mut env = wnear_primary_env(183);
    human(&mut env);
    let id = open(&mut c, &env);
    take_as(&mut c, id, USDC, USDC_STAKE, true, Some(REF), 2);
    assert_eq!(c.get_bet(id).unwrap().tip_taker.0, 150_000, "tip = max(1%, USDC min fee), in USDC");
    ctx(REF, 1_001);
    c.referee_rule(id, "NO".to_string()); // taker wins
    let fee = 150_000u128;
    assert_eq!(sum_to(&c, id, REF, USDC), fee, "referee tip");
    assert_eq!(sum_to(&c, id, "taker.testnet", USDC), 2 * USDC_STAKE - 2 * fee - fee);
    assert_eq!(sum_to(&c, id, FEE, USDC), 2 * fee + 2 * STORAGE);
    conserved(&c, id, USDC, 2 * USDC_STAKE + 2 * STORAGE);
}

#[test]
fn fm1_c_deadline_void_charges_no_fee_and_tip_uses_option_asset_min_fee() {
    // VOID rule in this contract: no protocol fee; only the opted-in referee
    // tip (taker tip sized from the taker's own bet fee copy) is carved out,
    // and keep_terms storage goes to fee_account.
    let mut c = contract();
    let mut env = wnear_primary_env(184);
    human(&mut env);
    let id = open(&mut c, &env);
    take_as(&mut c, id, USDC, USDC_STAKE, true, Some(REF), 2);
    ctx("anyone.testnet", 365 * DAY + 1);
    c.void_after_deadline(id);
    assert_eq!(sum_to(&c, id, REF, USDC), 150_000, "taker tip in USDC from the USDC option min fee");
    assert_eq!(sum_to(&c, id, "taker.testnet", USDC), USDC_STAKE - 150_000, "taker refund: stake less tip, no fee");
    assert_eq!(sum_to(&c, id, "maker.testnet", USDC), USDC_STAKE, "maker refunded in full, no fee");
    assert_eq!(sum_to(&c, id, FEE, USDC), 2 * STORAGE, "fee_account gets only keep_terms storage");
    conserved(&c, id, USDC, 2 * USDC_STAKE + 2 * STORAGE);
}

#[test]
fn fm1_c_deadline_void_without_tip_refunds_full_stakes() {
    let mut c = contract();
    let env = wnear_primary_env(185);
    let id = open(&mut c, &env);
    take_as(&mut c, id, USDC, USDC_STAKE, false, None, 2);
    ctx("anyone.testnet", env.resolve_deadline + 1);
    c.void_after_deadline(id);
    assert_eq!(sum_to(&c, id, "taker.testnet", USDC), USDC_STAKE);
    assert_eq!(sum_to(&c, id, "maker.testnet", USDC), USDC_STAKE);
    assert_eq!(sum_to(&c, id, FEE, USDC), 2 * STORAGE);
    conserved(&c, id, USDC, 2 * USDC_STAKE + 2 * STORAGE);
}

// ---------------------------------------------------------------- (d)

#[test]
fn fm1_d_guardian_min_fee_change_after_open_does_not_touch_option_fees() {
    let mut c = contract();
    let mut env = wnear_primary_env(186);
    env.funding_deadline = 3 * DAY;
    env.resolve_deadline = 10 * DAY;
    let id = open(&mut c, &env);
    // guardian raises the live USDC min fee 150_000 -> 240_000 (<= cap)
    ctx_with_deposit(GUARDIAN, 10, NearToken::from_yoctonear(1));
    c.propose_params(ParamsChange {
        fee_bps: None,
        assets: vec![AssetParamsChange {
            asset_id: USDC.to_string(),
            min_fee_per_side: Some(U128(240_000)),
            min_per_side: None,
            max_per_side: None,
        }],
    });
    ctx("anyone.testnet", 10 + PARAMS_DELAY_NS);
    c.apply_params();
    assert_eq!(c.asset_limits.get(USDC).unwrap().min_fee_per_side.0, 240_000, "live config really changed");
    take_as(&mut c, id, USDC, USDC_STAKE, false, None, 10 + PARAMS_DELAY_NS + 1);
    submit(&mut c, id, &env, "NO", 10 + PARAMS_DELAY_NS + 2_000);
    assert_a_taker_wins(&c, id); // fees stay 150_000 per side, not 240_000
}

// ---------------------------------------------------------------- view

#[test]
fn fm1_bet_view_exposes_per_option_min_fees_parallel_to_taker_options() {
    let mut c = contract();
    let env = wnear_primary_env(187);
    let id = open(&mut c, &env);
    let v = serde_json::to_value(c.get_bet(id).unwrap()).unwrap();
    assert_eq!(
        v["fee_min_taker_options"],
        serde_json::json!([USDC_MIN_FEE.to_string()]),
        "one copy per taker option, same order (U128 serialises as a string)"
    );
    // after taking in the option, fee_min_taker is that option's copy
    take_as(&mut c, id, USDC, USDC_STAKE, false, None, 2);
    assert_eq!(c.get_bet(id).unwrap().fee_min_taker.0, USDC_MIN_FEE);
}

#[test]
fn fm1_primary_take_keeps_primary_min_fee() {
    // No behaviour change: taking in the primary asset still uses its own copy.
    let mut c = contract();
    let env = wnear_primary_env(188);
    let id = open(&mut c, &env);
    take_as(&mut c, id, MOCK_WNEAR, WNEAR_STAKE, false, None, 2);
    assert_eq!(c.get_bet(id).unwrap().fee_min_taker.0, WNEAR_MIN_FEE);
}
