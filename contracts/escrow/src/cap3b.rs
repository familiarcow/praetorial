//! CAP3b: the contract itself bounds `max_per_side` at the CAP3 launch ceiling (10^34 raw), so no new() arg,
//! propose_params or propose_asset can set a value whose challenge-bond floor (`pot * 1000`, checked u128) panics.
//! Child of tests.rs.

use super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const CEIL: u128 = cap3::CAP3_MAX;
const NEWA: &str = "nep141:new-asset.testnet";

fn panic_msg<F: FnOnce()>(f: F) -> Option<String> {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let r = catch_unwind(AssertUnwindSafe(f));
    std::panic::set_hook(prev);
    r.err().map(|e| e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default())
}

fn refused_ceiling<F: FnOnce()>(what: &str, f: F) {
    let m = panic_msg(f).unwrap_or_else(|| panic!("{what}: expected refusal, but the call succeeded"));
    assert!(m.contains("max_per_side") && m.contains("10^34"), "{what}: refusal `{m}` must name max_per_side and the 10^34 ceiling");
}

fn limit(max: u128) -> AssetLimit {
    AssetLimit {
        min_per_side: U128(1_000),
        max_per_side: U128(max),
        min_fee_per_side: U128(10),
        min_fee_cap_per_side: U128(50),
        run_price: U128(5),
        min_bond: U128(100),
        min_objection: U128(20),
        storage_per_kib: U128(STG_FIXTURE_RATE),
    }
}

fn limits_table(max: u128) -> Vec<(String, AssetLimit)> {
    let mut a = default_asset_limits();
    a[0].1.max_per_side = U128(max);
    a
}

fn contract_with_max(max: u128) -> Contract {
    new_contract_with_limits_and_assets(
        Limits {
            max_stake: U128(1_000_000_000),
            max_offer_ttl_secs: 86400 * 60,
            max_stake_per_side_near: U128(100 * 10u128.pow(24)),
            max_rounds: crate::DEFAULT_MAX_ROUNDS,
            max_retries: crate::DEFAULT_MAX_RETRIES,
        },
        None,
        limits_table(max),
    )
}

fn params_max(id: &str, max: u128) -> ParamsChange {
    ParamsChange {
        fee_bps: None,
        assets: vec![AssetParamsChange { asset_id: id.to_string(), min_fee_per_side: None, min_per_side: None, max_per_side: Some(U128(max)) }],
    }
}

#[test]
fn cap3b_ceiling_const_is_10_pow_34() {
    assert_eq!(crate::MAX_PER_SIDE_CEILING, 10u128.pow(34));
    assert_eq!(crate::MAX_PER_SIDE_CEILING, cap3::CAP3_MAX);
}

#[test]
fn cap3b_new_accepts_exactly_the_ceiling() {
    let c = contract_with_max(CEIL);
    assert_eq!(c.asset_limits.get(USDC).unwrap().max_per_side.0, CEIL);
}

#[test]
fn cap3b_new_refuses_above_the_ceiling() {
    refused_ceiling("new ceiling+1", || { contract_with_max(CEIL + 1); });
    refused_ceiling("new u128::MAX", || { contract_with_max(u128::MAX); });
}

#[test]
fn cap3b_propose_params_accepts_exactly_the_ceiling() {
    let mut c = contract_with_max(1_000_000_000);
    ctx_with_deposit(GUARDIAN, 100, ONE_YOCTO);
    c.propose_params(params_max(USDC, CEIL));
    assert!(c.pending_params.is_some());
}

#[test]
fn cap3b_propose_params_refuses_above_the_ceiling() {
    let mut c = contract_with_max(1_000_000_000);
    ctx_with_deposit(GUARDIAN, 100, ONE_YOCTO);
    refused_ceiling("propose_params ceiling+1", || c.propose_params(params_max(USDC, CEIL + 1)));
    refused_ceiling("propose_params u128::MAX", || c.propose_params(params_max(USDC, u128::MAX)));
    assert!(c.pending_params.is_none(), "a refused proposal must leave nothing pending");
}

#[test]
fn cap3b_propose_asset_accepts_exactly_the_ceiling() {
    let mut c = contract_with_max(CEIL);
    ctx_with_deposit(GUARDIAN, 100, ONE_YOCTO);
    c.propose_asset(NEWA.to_string(), limit(CEIL));
    assert!(c.pending_asset.is_some());
}

#[test]
fn cap3b_propose_asset_refuses_above_the_ceiling() {
    let mut c = contract_with_max(CEIL);
    ctx_with_deposit(GUARDIAN, 100, ONE_YOCTO);
    refused_ceiling("propose_asset ceiling+1", || c.propose_asset(NEWA.to_string(), limit(CEIL + 1)));
    refused_ceiling("propose_asset u128::MAX", || c.propose_asset(NEWA.to_string(), limit(u128::MAX)));
    assert!(c.pending_asset.is_none());
}
