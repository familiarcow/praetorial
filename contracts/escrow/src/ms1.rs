//! MS1 (per-asset-max-stake, MONEY/availability): `handle_open` used to compare
//! both stakes against the single flat RAW `limits.max_stake` for every asset,
//! so USDC (6dp) and wNEAR (24dp) shared one number. The only upper bound must
//! be each asset's own `AssetLimit.max_per_side` (D-PARAMS1). Child of tests.rs.
use super::*;

const USDC_MAX: u128 = 500_000_000; // 500 USDC
const WNEAR_MIN: u128 = 1_326_259_946_949_602_229_354_496;
const WNEAR_MAX: u128 = 66_312_997_347_480_103_951_532_032;
const STORAGE: u128 = 10_000;

fn assets() -> Vec<(String, AssetLimit)> {
    vec![
        (
            USDC.to_string(),
            AssetLimit {
                min_per_side: U128(5_000_000),
                min_fee_per_side: U128(1),
                min_fee_cap_per_side: U128(0),
                storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
                max_per_side: U128(USDC_MAX),
                run_price: U128(DEFAULT_RUN_PRICE),
                min_bond: U128(USDC_MIN_BOND),
                min_objection: U128(USDC_MIN_OBJECTION),
            },
        ),
        (
            MOCK_WNEAR.to_string(),
            AssetLimit {
                min_per_side: U128(WNEAR_MIN),
                min_fee_per_side: U128(1),
                min_fee_cap_per_side: U128(0),
                storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
                max_per_side: U128(WNEAR_MAX),
                run_price: U128(1),
                min_bond: U128(WNEAR_MIN),
                min_objection: U128(WNEAR_MIN / 5),
            },
        ),
    ]
}

/// The flat `max_stake` is set to a value that is tiny in wNEAR raw units
/// (1e9) so a surviving flat comparison would refuse every wNEAR bet.
fn contract() -> Contract {
    new_contract_with_limits_and_assets(
        Limits {
            max_stake: U128(1_000_000_000),
            max_offer_ttl_secs: 86400 * 60,
            max_stake_per_side_near: U128(100 * 10u128.pow(24)),
            max_rounds: crate::DEFAULT_MAX_ROUNDS,
            max_retries: crate::DEFAULT_MAX_RETRIES,
        },
        None,
        assets(),
    )
}

fn env_with(seed: u8, maker_asset: &str, sm: u128, taker_asset: &str, st: u128) -> Envelope {
    let (_, pk) = test_keypair(seed);
    let mut env = base_envelope(&hex_encode(&pk));
    env.maker_asset = maker_asset.to_string();
    env.stake_maker = U128(sm);
    env.taker_asset = taker_asset.to_string();
    env.stake_taker = U128(st);
    env
}

fn try_open(c: &mut Contract, env: &Envelope) -> Vec<U128> {
    do_mt_transfer_asset(c, "maker.testnet", &env.maker_asset, env.maker_required(), open_msg(env), 1)
}

fn assert_opens(c: &mut Contract, env: &Envelope, what: &str) {
    assert_eq!(try_open(c, env), vec![U128(0)], "{what}: must open");
}

fn assert_refunded_in_full(c: &mut Contract, env: &Envelope, what: &str) {
    // I-2 / I-3: a rejected open returns the whole deposit, creates no bet.
    let before = c.next_bet_id;
    assert_eq!(try_open(c, env), vec![U128(env.maker_required())], "{what}: must be fully refunded");
    assert_eq!(c.next_bet_id, before, "{what}: no bet created");
}

#[test]
fn ms1_wnear_bet_at_max_per_side_opens_despite_small_flat_max_stake() {
    let mut c = contract();
    let env = env_with(190, MOCK_WNEAR, WNEAR_MAX, MOCK_WNEAR, WNEAR_MAX);
    assert_opens(&mut c, &env, "wNEAR at its own max_per_side");
}

#[test]
fn ms1_wnear_bet_one_over_its_max_per_side_refunded() {
    let mut c = contract();
    let env = env_with(191, MOCK_WNEAR, WNEAR_MAX + 1, MOCK_WNEAR, WNEAR_MAX);
    assert_refunded_in_full(&mut c, &env, "wNEAR maker one over max");
}

#[test]
fn ms1_usdc_bet_over_its_own_max_refunded_and_at_max_opens() {
    let mut c = contract();
    let over = env_with(192, USDC, USDC_MAX + 1, USDC, USDC_MAX);
    assert_refunded_in_full(&mut c, &over, "USDC maker over own max");
    let over_t = env_with(193, USDC, USDC_MAX, USDC, USDC_MAX + 1);
    assert_refunded_in_full(&mut c, &over_t, "USDC taker over own max");
    let at = env_with(194, USDC, USDC_MAX, USDC, USDC_MAX);
    assert_opens(&mut c, &at, "USDC at own max");
}

#[test]
fn ms1_cross_asset_each_side_checked_against_its_own_asset() {
    let mut c = contract();
    // both at own max in different assets: opens
    let ok = env_with(195, USDC, USDC_MAX, MOCK_WNEAR, WNEAR_MAX);
    assert_opens(&mut c, &ok, "USDC maker / wNEAR taker both at own max");
    let ok2 = env_with(196, MOCK_WNEAR, WNEAR_MAX, USDC, USDC_MAX);
    assert_opens(&mut c, &ok2, "wNEAR maker / USDC taker both at own max");
    // USDC side fine, wNEAR taker over its own max
    let bad_t = env_with(197, USDC, USDC_MAX, MOCK_WNEAR, WNEAR_MAX + 1);
    assert_refunded_in_full(&mut c, &bad_t, "wNEAR taker over wNEAR max");
    // wNEAR side fine, USDC taker over its own max (raw value far below wNEAR max)
    let bad_t2 = env_with(198, MOCK_WNEAR, WNEAR_MAX, USDC, USDC_MAX + 1);
    assert_refunded_in_full(&mut c, &bad_t2, "USDC taker over USDC max");
}

#[test]
fn ms1_taker_option_checked_against_its_own_asset_max() {
    let mut c = contract();
    let mut ok = env_with(199, USDC, USDC_MAX, USDC, USDC_MAX);
    ok.taker_options = vec![TakerOption { asset: MOCK_WNEAR.to_string(), amount: U128(WNEAR_MAX) }];
    assert_opens(&mut c, &ok, "wNEAR option at its own max");
    let mut bad = env_with(200, USDC, USDC_MAX, USDC, USDC_MAX);
    bad.taker_options = vec![TakerOption { asset: MOCK_WNEAR.to_string(), amount: U128(WNEAR_MAX + 1) }];
    assert_refunded_in_full(&mut c, &bad, "wNEAR option over its own max");
}

#[test]
fn ms1_take_with_option_asset_checks_option_assets_max() {
    // Guardian lowers the wNEAR max after open; a take paying in wNEAR over
    // the (now lower) option-asset max must not slip in via the primary
    // asset's limit. Opens at wNEAR max, then take in wNEAR option.
    let mut c = contract();
    let mut env = env_with(201, USDC, USDC_MAX, USDC, USDC_MAX);
    env.taker_options = vec![TakerOption { asset: MOCK_WNEAR.to_string(), amount: U128(WNEAR_MAX) }];
    assert_opens(&mut c, &env, "open");
    let id = c.next_bet_id - 1;
    let msg = serde_json::to_string(&TransferMsg::Take { bet_id: id, invite_sig: None, tip: false, referee_ack: None }).unwrap();
    let r = do_mt_transfer_asset(&mut c, "taker.testnet", MOCK_WNEAR, WNEAR_MAX + STORAGE, msg, 2);
    assert_eq!(r, vec![U128(0)], "take in the wNEAR option at its max must be accepted (I-2: nothing refunded)");
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Taken);
}
