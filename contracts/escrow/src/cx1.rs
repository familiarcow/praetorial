//! CX1: BTC maker vs USDC taker, one challenge round the maker wins, exact
//! per-asset money. Mirrors chaos/scenarios/cross_asset_bond.mjs
//! btc_maker_vs_usdc_taker_challenge_round_per_asset_balances (harness limits).
//!
//! Rules (Decision register):
//! - D-FEEMIN1: each side's fee = max(1% of THAT side's stake, that asset's
//!   `min_fee_per_side`), in the asset's own units. BTC min fee here = 325
//!   sats (= min_per_side 6_501 / 20, the harness value); 1% of 10_000 sats is
//!   only 100, so the BTC side pays 325. USDC min fee 1 (harness fixture), so
//!   the USDC side pays plain 1% = 100_000.
//! - D-BOND1 / D-BOND2: the bond is posted and settled in the challenger's own
//!   asset; a WON round returns bond - run_price to the challenger and pays
//!   run_price to the keeper.
//! - D-STORAGE1: each side's storage charge goes to the fee account in that
//!   side's own asset.
//! Child of tests.rs (`#[path]`).
use super::*;

const BTC_STAKE: u128 = 10_000;
const USDC_STAKE: u128 = 10_000_000;
const BTC_MIN_FEE: u128 = 325;
const BTC_RUN_PRICE: u128 = 1;

fn limits() -> Vec<(String, AssetLimit)> {
    let mut v = spec_default_asset_limits();
    for (id, l) in v.iter_mut() {
        if id == MOCK_BTC {
            l.min_fee_per_side = U128(BTC_MIN_FEE); // D-FEEMIN1: = min_per_side/20
        }
    }
    v
}

#[test]
fn cx1_btc_maker_usdc_taker_won_challenge_round_applies_btc_min_fee() {
    let mut c = new_contract_with_limits_and_assets(
        Limits {
            max_stake: U128(1_000_000_000),
            max_offer_ttl_secs: 86400 * 60,
            max_stake_per_side_near: U128(100 * 10u128.pow(24)),
            max_rounds: crate::DEFAULT_MAX_ROUNDS,
            max_retries: crate::DEFAULT_MAX_RETRIES,
        },
        None,
        limits(),
    );
    let (_sk, pk) = test_keypair(230);
    let mut env = base_envelope(&hex_encode(&pk));
    env.maker_asset = MOCK_BTC.to_string();
    env.taker_asset = USDC.to_string();
    env.stake_maker = U128(BTC_STAKE);
    env.stake_taker = U128(USDC_STAKE);
    let r = do_mt_transfer_asset(&mut c, "maker.testnet", MOCK_BTC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(r, vec![U128(0)]);
    let id = c.next_bet_id - 1;
    let r = do_mt_transfer_asset(&mut c, "taker.testnet", USDC, env.taker_required(), take_msg(id), 2);
    assert_eq!(r, vec![U128(0)]);
    let bet = c.get_bet(id).unwrap();
    let (st_m, st_t) = (bet.storage_maker.0, bet.storage_taker.0);

    // Round 1: outcome NO (maker side YES loses) -> maker challenges with a BTC bond.
    let submit = |c: &mut Contract, outcome: &str, run_no: u64, ts: u64| {
        ctx("anyone.testnet", ts);
        let result = SubmittedResult {
            bet_id: id,
            terms_hash: "terms-hash-1".to_string(),
            outcome: outcome.to_string(),
            element_results_hash: "e".repeat(64),
            run_no,
            checked_until: U64(ts),
            next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig = sign_result(&outcome_signing_key(), &result);
        c.submit_outcome(result, sig);
    };
    submit(&mut c, "NO", 1, 2_000);
    ctx("maker.testnet", 2_010);
    let q = c.required_challenge_bond(id, "maker.testnet".parse().unwrap()).expect("quote");
    assert_eq!(q.asset, MOCK_BTC, "D-BOND1: maker bonds in BTC");
    let bond = q.amount.0;
    let r = do_mt_transfer_asset(
        &mut c, "maker.testnet", MOCK_BTC, bond,
        serde_json::to_string(&TransferMsg::Bond { bet_id: id, round: 1 }).unwrap(), 2_050,
    );
    assert_eq!(r, vec![U128(0)]);
    // Re-judge flips to YES: maker wins the round and the bet.
    submit(&mut c, "YES", 2, 2_060);
    ctx("anyone.testnet", 2_060 + c.get_bet(id).unwrap().envelope.settlement_period + 1);
    c.finalize(id);

    let fee_btc = (BTC_STAKE / 100).max(BTC_MIN_FEE); // D-FEEMIN1 -> 325, not 100
    assert_eq!(fee_btc, 325);
    let fee_usdc = USDC_STAKE / 100; // 100_000 (USDC min fee 1)
    let to = |who: &str, asset: &str| sum_to(&c, id, who, asset);
    let maker = "maker.testnet";
    assert_eq!(to(maker, MOCK_BTC), BTC_STAKE - fee_btc + (bond - BTC_RUN_PRICE), "maker BTC: stake less the 325 min fee, plus bond less run price");
    assert_eq!(to(maker, USDC), USDC_STAKE - fee_usdc);
    assert_eq!(to("taker.testnet", MOCK_BTC), 0);
    assert_eq!(to("taker.testnet", USDC), 0);
    assert_eq!(to(FEE, MOCK_BTC), fee_btc + st_m, "fee account BTC: min fee + maker storage");
    assert_eq!(to(FEE, USDC), fee_usdc + st_t, "fee account USDC: 1% + taker storage");
    assert_eq!(to(KEEPER, MOCK_BTC), BTC_RUN_PRICE);
    // I-1 per asset.
    let out_btc: u128 = to(maker, MOCK_BTC) + to(FEE, MOCK_BTC) + to(KEEPER, MOCK_BTC);
    assert_eq!(out_btc, BTC_STAKE + st_m + bond);
    let out_usdc: u128 = to(maker, USDC) + to(FEE, USDC);
    assert_eq!(out_usdc, USDC_STAKE + st_t);
}

fn sum_to(c: &Contract, id: u64, who: &str, asset: &str) -> u128 {
    let who: AccountId = who.parse().unwrap();
    c.payout_ids_in_order()
        .iter()
        .map(|p| c.pending_payouts.get(p).unwrap().clone())
        .filter(|p| p.bet_id == id && p.receiver == who && p.token_id == asset)
        .map(|p| p.amount.0)
        .sum()
}
