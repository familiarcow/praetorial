//! REDTEAM-DUST: fund-drain via rounding/dust across the six launch assets
//! (USDC 6dp, USDT 6dp, BTC 8dp, NEAR/wNEAR 24dp, ETH 18dp, ZEC 8dp).
//!
//! Asset ids, decimals-derived limits, min fees, storage rates are read at
//! test time from release/draft-args.mainnet.json (the real launch args),
//! never hardcoded here. All tests drive the PUBLIC surface only
//! (`mt_on_transfer`, `concede`, `cancel`, `expire`, `reclaim`,
//! `void_after_deadline`, `referee_rule`, `emergency_*`, `side_fee`), so
//! contracts/escrow/src stays untouched (frozen at freeze-candidate-2).
//!
//! Core invariant per bet, per asset, EXACT: sum(scheduled payout lines)
//! == sum(accepted deposits). No unit created, none lost, none stranded.
use ed25519_dalek::Signer;
use escrow::*;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, NearToken, PromiseOrValue};
use std::collections::BTreeMap;

const INTENTS: &str = "intents.near";
const OUTLAYER: &str = "outlayer.near";
const OPERATOR: &str = "operator.near";
const GUARDIAN: &str = "guardian.near";
const REGISTRY: &str = "registry.near";
const FEE: &str = "fee.near";
const KEEPER: &str = "keeper.near";
const CONTRACT: &str = "escrow.near";
const MAKER: &str = "maker.near";
const TAKER: &str = "taker.near";
const REFEREE: &str = "referee.near";
const NS: u64 = 1_000_000_000;

const ARGS: &str = include_str!("../../../release/draft-args.mainnet.json");

#[derive(Clone, Debug)]
struct Asset {
    id: String,
    min: u128,
    max: u128,
    min_fee: u128,
    rate: u128,
}

fn u(v: &Value) -> u128 {
    v.as_str().unwrap().parse().unwrap()
}

fn assets() -> Vec<Asset> {
    let d: Value = serde_json::from_str(ARGS).unwrap();
    d["asset_limits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| Asset {
            id: p[0].as_str().unwrap().to_string(),
            min: u(&p[1]["min_per_side"]),
            max: u(&p[1]["max_per_side"]),
            min_fee: u(&p[1]["min_fee_per_side"]),
            rate: u(&p[1]["storage_per_kib"]),
        })
        .collect()
}

fn asset_limit_vec() -> Vec<(String, AssetLimit)> {
    let d: Value = serde_json::from_str(ARGS).unwrap();
    d["asset_limits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            (
                p[0].as_str().unwrap().to_string(),
                AssetLimit {
                    min_per_side: U128(u(&p[1]["min_per_side"])),
                    max_per_side: U128(u(&p[1]["max_per_side"])),
                    min_fee_per_side: U128(u(&p[1]["min_fee_per_side"])),
                    min_fee_cap_per_side: U128(u(&p[1]["min_fee_cap_per_side"])),
                    run_price: U128(u(&p[1]["run_price"])),
                    min_bond: U128(u(&p[1]["min_bond"])),
                    min_objection: U128(u(&p[1]["min_objection"])),
                    storage_per_kib: U128(u(&p[1]["storage_per_kib"])),
                },
            )
        })
        .collect()
}

fn ctx_full(pred: &str, ts: u64, yocto: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .signer_account_id(pred.parse().unwrap())
        .predecessor_account_id(pred.parse().unwrap())
        .attached_deposit(NearToken::from_yoctonear(yocto))
        .block_timestamp(ts);
    testing_env!(b.build());
}
fn ctx(pred: &str, ts: u64) {
    ctx_full(pred, ts, 0)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}
fn sk() -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[0xd1; 32])
}

fn new_contract() -> Contract {
    // testing_env! carries mock storage across calls in a thread; start every
    // contract from EMPTY storage so scenarios cannot leak into each other.
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .signer_account_id(OPERATOR.parse().unwrap())
        .predecessor_account_id(OPERATOR.parse().unwrap())
        .block_timestamp(0);
    near_sdk::env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        vec![],
        Default::default(),
        Default::default(),
        None,
    ));
    let d: Value = serde_json::from_str(ARGS).unwrap();
    let usdc = d["usdc_token_id"].as_str().unwrap().to_string();
    let pk = hex(&sk().verifying_key().to_bytes());
    Contract::new(
        INTENTS.parse().unwrap(),
        usdc,
        OUTLAYER.parse().unwrap(),
        OPERATOR.parse().unwrap(),
        GUARDIAN.parse().unwrap(),
        REGISTRY.parse().unwrap(),
        FEE.parse().unwrap(),
        KEEPER.parse().unwrap(),
        Limits {
            max_stake: U128(u(&d["limits"]["max_stake"])),
            max_offer_ttl_secs: 5_184_000,
            max_stake_per_side_near: U128(u(&d["limits"]["max_stake_per_side_near"])),
            max_rounds: escrow::DEFAULT_MAX_ROUNDS,
            max_retries: escrow::DEFAULT_MAX_RETRIES,
        },
        None,
        asset_limit_vec(),
        pk.clone(),
        pk,
        "f".repeat(64),
        OutlayerConfig {
            wasm_base_url: "https://test.fastfs.io/x/outlayer.near".to_string(),
            secrets_profile: "praetorial-resolver".to_string(),
            secrets_account_id: "escrow.near".parse().unwrap(),
        },
        vec![
            JudgePair { model_a: "deepseek-ai/DeepSeek-V4.1-Flash-1017".into(), model_b: "zai-org/GLM-5.3-flash".into() },
            JudgePair { model_a: "t/jc-backup-a1".into(), model_b: "t/jc-backup-a2".into() },
        ],
    )
}

fn envelope(ma: &Asset, ta: &Asset, sm: u128, st: u128, referee: bool, tip_maker: bool, nonce: u64) -> Envelope {
    Envelope {
        bet_id: 0,
        version: 1,
        maker: MAKER.parse().unwrap(),
        taker_allow: TakerAllow::Any,
        terms_hash: format!("{:064x}", nonce + 1),
        models_snapshot_hash: "c".repeat(64),
        outcomes: vec!["YES".to_string(), "NO".to_string()],
        maker_side: "YES".to_string(),
        maker_asset: ma.id.clone(),
        taker_asset: ta.id.clone(),
        stake_maker: U128(sm),
        stake_taker: U128(st),
        taker_options: Vec::new(),
        fee_bps: 100,
        storage_charge_per_side: U128(0),
        keep_terms: false,
        terms: None,
        max_paid_runs: 3,
        tier: 1,
        referee: if referee { Some(Referee { account: REFEREE.parse().unwrap(), mode: RefereeMode::Human }) } else { None },
        tip_maker,
        funding_deadline: 3600 * NS,
        early_settle_outcome: None,
        finality_delay: 0,
        settlement_period: 3600 * NS,
        resolve_deadline: 7 * 24 * 3600 * NS,
        consent_party_controlled: false,
    }
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde", tag = "kind")]
enum Msg {
    Open { envelope: Envelope, attestation: SourceCheckAttestation },
    Take { bet_id: u64, invite_sig: Option<String>, tip: bool, referee_ack: Option<String> },
}

fn attest(env: &Envelope) -> SourceCheckAttestation {
    let m = sourcecheck_message(&env.terms_hash, 0);
    SourceCheckAttestation { checked_at: 0, signature_hex: hex(&sk().sign(m.as_bytes()).to_bytes()) }
}

/// Returns the refund vector the contract hands back to intents.
fn transfer(c: &mut Contract, from: &str, asset: &str, amount: u128, msg: Msg) -> Vec<U128> {
    ctx(INTENTS, 1000);
    let m = serde_json::to_string(&msg).unwrap();
    match c.mt_on_transfer(
        from.parse().unwrap(),
        vec![from.parse().unwrap()],
        vec![asset.to_string()],
        vec![U128(amount)],
        m,
    ) {
        PromiseOrValue::Value(v) => v,
        _ => panic!("promise"),
    }
}

fn open_msg(env: &Envelope) -> Msg {
    Msg::Open { envelope: env.clone(), attestation: attest(env) }
}

/// Exact-amount deposits for an envelope: (maker_deposit, taker_deposit).
fn required(env: &Envelope, ma: &Asset, ta: &Asset) -> (u128, u128) {
    (env.stake_maker.0 + env.storage_for(ma.rate), env.stake_taker.0 + env.storage_for(ta.rate))
}

#[derive(Clone, Copy, Debug)]
enum End {
    Cancel,
    Expire,
    Reclaim,
    ConcedeMaker,
    ConcedeTaker,
    VoidDeadline,
    EmergencyTaken,
    EmergencyOpen,
    RefYes,
    RefNo,
    RefVoid,
}

fn sum_by_asset(v: impl IntoIterator<Item = (String, u128)>) -> BTreeMap<String, u128> {
    let mut m = BTreeMap::new();
    for (a, x) in v {
        *m.entry(a).or_insert(0u128) += x;
    }
    m.retain(|_, x| *x != 0);
    m
}

/// Runs one bet to `end`; returns (deposits, payouts) per asset.
fn run(
    ma: &Asset,
    ta: &Asset,
    sm: u128,
    st: u128,
    end: End,
    referee: bool,
    tip_maker: bool,
    tip_taker: bool,
    nonce: u64,
) -> (BTreeMap<String, u128>, BTreeMap<String, u128>, Vec<PendingPayout>) {
    let mut c = new_contract();
    let env = envelope(ma, ta, sm, st, referee, tip_maker, nonce);
    let (md, td) = required(&env, ma, ta);
    let refund = transfer(&mut c, MAKER, &ma.id, md, open_msg(&env));
    assert_eq!(refund, vec![U128(0)], "open must be accepted: {:?} {:?}", ma, env.stake_maker);
    let mut deposits = vec![(ma.id.clone(), md)];
    let taken = !matches!(end, End::Cancel | End::Expire | End::Reclaim | End::EmergencyOpen);
    if taken {
        let refund = transfer(
            &mut c,
            TAKER,
            &ta.id,
            td,
            Msg::Take { bet_id: 1, invite_sig: None, tip: tip_taker, referee_ack: if referee { Some(REFEREE.to_string()) } else { None } },
        );
        assert_eq!(refund, vec![U128(0)], "take must be accepted");
        deposits.push((ta.id.clone(), td));
    }
    match end {
        End::Cancel => {
            ctx(MAKER, 2000);
            c.cancel(1);
        }
        End::Expire => {
            ctx(TAKER, 3601 * NS);
            c.expire(1);
        }
        End::Reclaim => {
            ctx(OPERATOR, 2000);
            c.reclaim(1);
        }
        End::ConcedeMaker => {
            ctx(MAKER, 2000);
            c.concede(1);
        }
        End::ConcedeTaker => {
            ctx(TAKER, 2000);
            c.concede(1);
        }
        End::VoidDeadline => {
            ctx(TAKER, 8 * 24 * 3600 * NS);
            c.void_after_deadline(1);
        }
        End::EmergencyTaken | End::EmergencyOpen => {
            ctx_full(GUARDIAN, 2000, 1);
            c.emergency_shutdown();
            ctx(TAKER, 2001);
            c.emergency_refund(1);
        }
        End::RefYes | End::RefNo | End::RefVoid => {
            ctx(REFEREE, 4000 * NS);
            let o = match end {
                End::RefYes => "YES",
                End::RefNo => "NO",
                _ => "VOID",
            };
            c.referee_rule(1, o.to_string());
        }
    }
    let pays = c.pending_payouts(1);
    let payouts = sum_by_asset(pays.iter().map(|p| (p.token_id.clone(), p.amount.0)));
    (sum_by_asset(deposits), payouts, pays)
}

fn stake_points(a: &Asset) -> Vec<u128> {
    let be = a.min_fee * 100; // 100-bps break-even: 1% of be == min_fee
    let mut v = vec![
        a.min,
        a.min + 1,
        a.min * 2 - 1,
        be.saturating_sub(1).max(a.min),
        be.max(a.min),
        (be + 1).max(a.min),
        (be + 99).max(a.min),
        (be + 100).max(a.min),
        a.min * 7 + 3,
        a.min * 10_000 + 9_999,
        a.max / 3 + 1, // odd dust near the ceiling
        a.max,
    ];
    v.retain(|s| *s >= a.min && *s <= a.max);
    v.sort();
    v.dedup();
    v
}

// ---------------------------------------------------------------------
// (1) side_fee arithmetic per asset
// ---------------------------------------------------------------------

#[test]
fn rtdust_assets_are_the_six_launch_assets() {
    let a = assets();
    let ids: Vec<&str> = a.iter().map(|x| x.id.as_str()).collect();
    assert_eq!(a.len(), 6, "six launch assets expected, got {ids:?}");
    for want in ["usdt.tether-token.near", "btc.omft.near", "wrap.near", "eth.omft.near", "zec.omft.near"] {
        assert!(ids.iter().any(|i| i.ends_with(want)), "missing {want} in {ids:?}");
    }
    assert!(ids.iter().any(|i| i.starts_with("nep141:17208628")), "missing USDC");
}

#[test]
fn rtdust_side_fee_bounds_every_asset_every_stake_point() {
    for a in assets() {
        for s in stake_points(&a) {
            let f = side_fee(s, 100, a.min_fee);
            let pct = s * 100 / 10_000;
            assert!(f <= s, "{} fee {f} > stake {s}", a.id);
            assert!(f >= pct, "{} fee {f} below 1% floor {pct} at stake {s}", a.id);
            assert!(f >= a.min_fee.min(s), "{} fee {f} below min_fee at stake {s}", a.id);
            assert_eq!(f, pct.max(a.min_fee).min(s), "{} formula mismatch at {s}", a.id);
            // fee never exceeds max(1%, min_fee) => never an over-charge
            assert!(f <= pct.max(a.min_fee));
            // at the legal minimum stake the fee is <= 5% (min_fee <= min/20)
            if s == a.min {
                assert!(f * 20 <= s, "{} fee at min stake exceeds 5%: {f}/{s}", a.id);
            }
            // winner net payout can never underflow
            let _net = s - f;
        }
    }
}

#[test]
fn rtdust_side_fee_breakeven_boundary_is_monotone_and_exact() {
    for a in assets() {
        let be = a.min_fee * 100;
        // Below break-even the minimum applies, at/after the 1% rule; scan +-300 units around it.
        let mut prev_fee = 0u128;
        let mut prev_net = 0u128;
        for s in be.saturating_sub(300)..=(be + 300) {
            if s == 0 {
                continue;
            }
            let f = side_fee(s, 100, a.min_fee);
            assert!(f >= prev_fee, "{}: fee not monotone at stake {s}: {f} < {prev_fee}", a.id);
            let net = s - f;
            // Adding a unit of stake must never REDUCE the winner's net (no negative marginal).
            assert!(net >= prev_net, "{}: net payout dropped at stake {s}: {net} < {prev_net}", a.id);
            // ...and the fee grows by at most 1 per unit of stake (no fee cliff / jump).
            if prev_fee != 0 {
                assert!(f - prev_fee <= 1, "{}: fee cliff at stake {s}: {prev_fee}->{f}", a.id);
            }
            prev_fee = f;
            prev_net = net;
        }
        assert_eq!(side_fee(be - 1, 100, a.min_fee), a.min_fee.min(be - 1));
        assert_eq!(side_fee(be, 100, a.min_fee), a.min_fee);
        assert_eq!(side_fee(be + 99, 100, a.min_fee), a.min_fee, "floor(1%) stays at min_fee until +100");
        assert_eq!(side_fee(be + 100, 100, a.min_fee), a.min_fee + 1);
    }
}

#[test]
fn rtdust_side_fee_one_unit_and_below_min_fee() {
    for a in assets() {
        // stake 1 unit: fee is clamped to the stake, never more than deposited.
        assert_eq!(side_fee(1, 100, a.min_fee), 1);
        assert_eq!(side_fee(0, 100, a.min_fee), 0);
        // stake < min_fee: whole stake is fee (loser-pays model: winner gets 0), never underflow.
        assert_eq!(side_fee(a.min_fee - 1, 100, a.min_fee), a.min_fee - 1);
        assert_eq!(side_fee(a.min_fee, 100, a.min_fee), a.min_fee);
        // 100 bps of a sub-100-unit stake rounds DOWN to 0: no free-bet dust below the min.
        assert_eq!(side_fee(99, 100, 0), 0, "documents that without a min the 1% floor rounds to zero");
        assert!(side_fee(99, 100, a.min_fee) >= 1);
    }
}

#[test]
fn rtdust_side_fee_no_overflow_at_the_per_side_ceiling_for_any_legal_fee_bps() {
    for a in assets() {
        assert_eq!(a.max, escrow::MAX_PER_SIDE_CEILING, "launch max_per_side must equal the ceiling");
        // MAX_FEE_BPS (200) is the guardian's hard cap; the 10:1 odds check multiplies stake by 10 as well.
        for bps in [100u128, escrow::MAX_FEE_BPS as u128, 10_000] {
            let f = side_fee(a.max, bps, a.min_fee);
            assert_eq!(f, a.max / 10_000 * bps + (a.max % 10_000) * bps / 10_000);
            assert!(f <= a.max);
        }
        // pot * 1_000 (challenge bond), lo*10 (odds), stake*10000 all fit in u128 at the ceiling.
        let pot = a.max.checked_mul(2).unwrap();
        assert!(pot.checked_mul(1_000).is_some());
        assert!(a.max.checked_mul(10_000).is_some());
        assert!(a.max.checked_mul(MAX_SAME_ASSET_ODDS).is_some());
        // 2^(max_rounds-1) doubling of the bond floor also fits at the ceiling.
        // bond floor = max(min_bond, pot/10); round r doubles it (max_rounds=2 => x2).
        assert!((pot * 1_000 / 10_000).checked_mul(2u128.pow(escrow::DEFAULT_MAX_ROUNDS - 1)).is_some());
    }
}

// ---------------------------------------------------------------------
// (2) payout conservation for every ending, every asset
// ---------------------------------------------------------------------

fn all_endings() -> Vec<End> {
    vec![
        End::Cancel,
        End::Expire,
        End::Reclaim,
        End::ConcedeMaker,
        End::ConcedeTaker,
        End::VoidDeadline,
        End::EmergencyTaken,
        End::EmergencyOpen,
    ]
}

#[test]
fn rtdust_conservation_all_endings_all_assets_all_stake_points_same_asset() {
    let mut n = 0u64;
    for a in assets() {
        for s in stake_points(&a) {
            // same-asset odds: partner stake within 10:1; use equal, and 3x/10x-ish dust variants
            let partners: Vec<u128> = [s, s.saturating_mul(3) / 2 + 1, a.min.max(s / 10 + 1)]
                .into_iter()
                .filter(|p| *p >= a.min && *p <= a.max && (s.max(*p) <= s.min(*p).saturating_mul(10)))
                .collect();
            for p in partners {
                for end in all_endings() {
                    n += 1;
                    let (dep, pay, _) = run(&a, &a, s, p, end, false, false, false, n);
                    assert_eq!(dep, pay, "{} {:?} stakes ({s},{p}): deposits != payouts", a.id, end);
                }
            }
        }
    }
    assert!(n > 200, "ran {n} scenarios");
}

#[test]
fn rtdust_conservation_cross_asset_36_pairs_min_stakes() {
    let a = assets();
    let mut n = 1_000_000u64;
    for ma in &a {
        for ta in &a {
            for end in [End::ConcedeMaker, End::ConcedeTaker, End::VoidDeadline, End::EmergencyTaken, End::Cancel] {
                n += 1;
                let (dep, pay, _) = run(ma, ta, ma.min, ta.min, end, false, false, false, n);
                assert_eq!(dep, pay, "{} -> {} {:?}", ma.id, ta.id, end);
            }
        }
    }
}

#[test]
fn rtdust_conservation_referee_rule_with_tips_all_assets() {
    let mut n = 2_000_000u64;
    for a in assets() {
        for s in stake_points(&a) {
            for (tm, tt) in [(false, false), (true, false), (false, true), (true, true)] {
                for end in [End::RefYes, End::RefNo, End::RefVoid, End::ConcedeMaker, End::ConcedeTaker, End::VoidDeadline, End::EmergencyTaken] {
                    n += 1;
                    let (dep, pay, pays) = run(&a, &a, s, s, end, true, tm, tt, n);
                    assert_eq!(dep, pay, "{} {:?} stake {s} tips({tm},{tt}): deposits != payouts; lines {:?}", a.id, end, pays);
                    // tip lines are exactly side_fee and go only to the referee
                    for p in pays.iter().filter(|p| p.reason == "referee_tip") {
                        assert_eq!(p.receiver.as_str(), REFEREE);
                        assert_eq!(p.amount.0, side_fee(s, 100, a.min_fee));
                    }
                }
            }
        }
    }
}

#[test]
fn rtdust_yesno_ending_pays_exactly_one_fee_per_side_and_winner_gets_remainder() {
    // concede == finalize arithmetic: winner = stake - fee per asset, fee_account = fee + storage.
    for a in assets() {
        for s in stake_points(&a) {
            let (_, _, pays) = run(&a, &a, s, s, End::ConcedeTaker, false, false, false, 3_000_000 + s as u64);
            let fee = side_fee(s, 100, a.min_fee);
            let winner: u128 = pays.iter().filter(|p| p.reason == "payout_winner").map(|p| p.amount.0).sum();
            assert_eq!(winner, 2 * (s - fee), "{} stake {s}", a.id);
            let fee_acct: u128 = pays.iter().filter(|p| p.receiver.as_str() == FEE).map(|p| p.amount.0).sum();
            let storage = envelope(&a, &a, s, s, false, false, 0).storage_for(a.rate);
            assert_eq!(fee_acct, 2 * (fee + storage));
            // nobody else is paid
            assert!(pays.iter().all(|p| p.receiver.as_str() == MAKER || p.receiver.as_str() == FEE));
        }
    }
}

// ---------------------------------------------------------------------
// (3) storage-deposit refund rounding
// ---------------------------------------------------------------------

#[test]
fn rtdust_storage_charge_is_ceil_never_zero_and_refunded_to_the_unit() {
    for a in assets() {
        let env = envelope(&a, &a, a.min, a.min, false, false, 0);
        let st = env.storage_for(a.rate);
        assert!(st >= 1, "{}: storage charge must never be 0", a.id);
        // ceil(bytes * rate / 2048): charge * 2048 >= bytes*rate > (charge-1)*2048
        // bytes not public; bound it by comparing two rates (monotone) and a 1-unit rate.
        assert!(env.storage_for(a.rate + 1) >= st);
        assert!(env.storage_for(1) >= 1);
        // void with !keep_terms returns BOTH storage charges to their owners exactly.
        let (dep, pay, pays) = run(&a, &a, a.min, a.min, End::VoidDeadline, false, false, false, 4_000_000);
        assert_eq!(dep, pay);
        let refunded: u128 = pays.iter().filter(|p| p.reason.starts_with("void_storage_refund")).map(|p| p.amount.0).sum();
        assert_eq!(refunded, 2 * st, "{}: storage refund rounding", a.id);
        // cancel refunds stake+storage
        let (dep, pay, _) = run(&a, &a, a.min, a.min, End::Cancel, false, false, false, 4_000_001);
        assert_eq!(dep, pay);
        assert_eq!(pay.values().sum::<u128>(), a.min + st);
    }
}

// ---------------------------------------------------------------------
// (4) dust bets: many minimal bets cannot accumulate rounding gain
// ---------------------------------------------------------------------

#[test]
fn rtdust_many_minimal_bets_accumulate_no_residue_or_attacker_gain() {
    for a in assets() {
        let mut c = new_contract();
        let (mut dep_total, mut pay_total) = (0u128, 0u128);
        let mut gain_attacker = 0i128; // maker+taker are the same attacker (sybil): net flow must be <= 0
        for i in 0..40u64 {
            let s = a.min + (i as u128 % 7); // jiggle across rounding classes
            let env = envelope(&a, &a, s, s, false, false, 10 + i);
            let (md, td) = required(&env, &a, &a);
            assert_eq!(transfer(&mut c, MAKER, &a.id, md, open_msg(&env)), vec![U128(0)]);
            assert_eq!(
                transfer(&mut c, TAKER, &a.id, td, Msg::Take { bet_id: i + 1, invite_sig: None, tip: false, referee_ack: None }),
                vec![U128(0)]
            );
            ctx(TAKER, 2000);
            c.concede(i + 1);
            let pays = c.pending_payouts(i + 1);
            let paid: u128 = pays.iter().map(|p| p.amount.0).sum();
            let to_attacker: u128 = pays.iter().filter(|p| p.receiver.as_str() == MAKER || p.receiver.as_str() == TAKER).map(|p| p.amount.0).sum();
            assert_eq!(paid, md + td, "{} bet {i}", a.id);
            dep_total += md + td;
            pay_total += paid;
            gain_attacker += to_attacker as i128 - (md + td) as i128;
        }
        assert_eq!(dep_total, pay_total);
        assert!(gain_attacker < 0, "{}: sybil self-bets must lose fees, got net {gain_attacker}", a.id);
    }
}

#[test]
fn rtdust_odds_mismatch_same_asset_boundary_and_conservation() {
    for a in assets() {
        let lo = a.min;
        // exactly 10:1 accepted, 10:1 + 1 unit rejected, both directions.
        let ok = envelope(&a, &a, lo, lo * 10, false, false, 5_000_000);
        let mut c = new_contract();
        let (md, _) = required(&ok, &a, &a);
        assert_eq!(transfer(&mut c, MAKER, &a.id, md, open_msg(&ok)), vec![U128(0)], "{} 1:10 accepted", a.id);
        let bad = envelope(&a, &a, lo, lo * 10 + 1, false, false, 5_000_001);
        let (md, _) = required(&bad, &a, &a);
        assert_eq!(transfer(&mut c, MAKER, &a.id, md, open_msg(&bad)), vec![U128(md)], "{} 1:10+1 rejected, refunded in full", a.id);
        let bad2 = envelope(&a, &a, lo * 10 + 1, lo, false, false, 5_000_002);
        let (md, _) = required(&bad2, &a, &a);
        assert_eq!(transfer(&mut c, MAKER, &a.id, md, open_msg(&bad2)), vec![U128(md)]);
        // lopsided accepted bets conserve funds, and the winning-side asymmetry is fee-bounded.
        for end in [End::ConcedeMaker, End::ConcedeTaker, End::RefYes, End::VoidDeadline] {
            let (dep, pay, _) = run(&a, &a, lo, lo * 10, end, matches!(end, End::RefYes), false, false, 5_000_010);
            assert_eq!(dep, pay, "{} {:?} lopsided", a.id, end);
        }
    }
}

// ---------------------------------------------------------------------
// (5) deposit amount != required (over / under by 1 unit) refunded exactly
// ---------------------------------------------------------------------

#[test]
fn rtdust_open_and_take_off_by_one_refunded_exactly_every_asset() {
    for a in assets() {
        let env = envelope(&a, &a, a.min, a.min, false, false, 6_000_000);
        let (md, td) = required(&env, &a, &a);
        for bad in [md - 1, md + 1, md * 2, 0, 1, md - env.storage_for(a.rate)] {
            let mut c = new_contract();
            let r = transfer(&mut c, MAKER, &a.id, bad, open_msg(&env));
            assert_eq!(r, vec![U128(bad)], "{} open with {bad} (required {md}) must be returned in full", a.id);
            assert!(c.get_bet(1).is_none(), "no bet created on a bad deposit");
        }
        // a good open, then bad takes
        let mut c = new_contract();
        assert_eq!(transfer(&mut c, MAKER, &a.id, md, open_msg(&env)), vec![U128(0)]);
        for bad in [td - 1, td + 1, td - env.storage_for(a.rate), td * 2] {
            let r = transfer(&mut c, TAKER, &a.id, bad, Msg::Take { bet_id: 1, invite_sig: None, tip: false, referee_ack: None });
            assert_eq!(r, vec![U128(bad)], "{} take with {bad} (required {td}) must be returned in full", a.id);
            assert_eq!(c.get_bet(1).unwrap().status, BetStatus::Open);
        }
        // wrong asset with the right number is refunded too
        let other = assets().into_iter().find(|x| x.id != a.id).unwrap();
        let r = transfer(&mut c, TAKER, &other.id, td, Msg::Take { bet_id: 1, invite_sig: None, tip: false, referee_ack: None });
        assert_eq!(r, vec![U128(td)]);
        // below-min and above-max stakes are refused (deposit refunded), ceiling+1 never overflows.
        for bad_stake in [a.min - 1, a.max + 1] {
            let mut c = new_contract();
            let e = envelope(&a, &a, bad_stake, bad_stake, false, false, 6_000_100);
            let amt = e.stake_maker.0 + e.storage_for(a.rate);
            assert_eq!(transfer(&mut c, MAKER, &a.id, amt, open_msg(&e)), vec![U128(amt)], "{} stake {bad_stake}", a.id);
        }
        // fee_bps tampering (0 bps = free bet) refused
        let mut e = envelope(&a, &a, a.min, a.min, false, false, 6_000_200);
        e.fee_bps = 0;
        let mut c = new_contract();
        let amt = e.stake_maker.0 + e.storage_for(a.rate);
        assert_eq!(transfer(&mut c, MAKER, &a.id, amt, open_msg(&e)), vec![U128(amt)]);
    }
}

#[test]
fn rtdust_taker_options_cross_asset_take_conserves_and_off_by_one_refunded() {
    let a = assets();
    for (ma, ta) in [(&a[0], &a[3]), (&a[2], &a[4]), (&a[5], &a[1])] {
        // maker USDC-like, primary taker asset ta, option: the other asset
        let opt_asset = a.iter().find(|x| x.id != ma.id && x.id != ta.id).unwrap();
        let mut env = envelope(ma, ta, ma.min, ta.min, false, false, 7_000_000);
        env.taker_options = vec![TakerOption { asset: opt_asset.id.clone(), amount: U128(opt_asset.min + 1) }];
        let mut c = new_contract();
        let (md, _) = required(&env, ma, ta);
        assert_eq!(transfer(&mut c, MAKER, &ma.id, md, open_msg(&env)), vec![U128(0)]);
        let opt_req = opt_asset.min + 1 + env.storage_for(opt_asset.rate);
        for bad in [opt_req - 1, opt_req + 1] {
            let r = transfer(&mut c, TAKER, &opt_asset.id, bad, Msg::Take { bet_id: 1, invite_sig: None, tip: false, referee_ack: None });
            assert_eq!(r, vec![U128(bad)]);
        }
        assert_eq!(
            transfer(&mut c, TAKER, &opt_asset.id, opt_req, Msg::Take { bet_id: 1, invite_sig: None, tip: false, referee_ack: None }),
            vec![U128(0)]
        );
        ctx(MAKER, 2000);
        c.concede(1); // taker wins both pots
        let pays = c.pending_payouts(1);
        let paid = sum_by_asset(pays.iter().map(|p| (p.token_id.clone(), p.amount.0)));
        let dep = sum_by_asset(vec![(ma.id.clone(), md), (opt_asset.id.clone(), opt_req)]);
        assert_eq!(dep, paid, "option take {} / {}", ma.id, opt_asset.id);
        // fee on the option leg uses the OPTION asset's min fee, not the primary's.
        let fee_opt = side_fee(opt_asset.min + 1, 100, opt_asset.min_fee);
        let got: u128 = pays.iter().filter(|p| p.token_id == opt_asset.id && p.receiver.as_str() == FEE).map(|p| p.amount.0).sum();
        assert_eq!(got, fee_opt + env.storage_for(opt_asset.rate));
    }
}

// ---------------------------------------------------------------------
// (6) bond / objection quote boundaries
// ---------------------------------------------------------------------

#[test]
fn rtdust_challenge_bond_quote_boundaries_never_overflow_or_zero() {
    for a in assets() {
        for s in stake_points(&a) {
            let mut c = new_contract();
            let env = envelope(&a, &a, s, s, false, false, 8_000_000);
            let (md, td) = required(&env, &a, &a);
            assert_eq!(transfer(&mut c, MAKER, &a.id, md, open_msg(&env)), vec![U128(0)]);
            assert_eq!(
                transfer(&mut c, TAKER, &a.id, td, Msg::Take { bet_id: 1, invite_sig: None, tip: false, referee_ack: None }),
                vec![U128(0)]
            );
            let q = c.required_challenge_bond(1, MAKER.parse().unwrap()).unwrap();
            let lim = c.asset_limit(a.id.clone()).unwrap();
            let pot = s * 2;
            // floor = max(min_bond, 10% pot) (floor division), + run_price for round 1
            assert_eq!(q.amount.0, lim.min_bond.0.max(pot * 1_000 / 10_000) + lim.run_price.0);
            assert!(q.amount.0 > lim.run_price.0, "bond must exceed bare compute cost");
            assert!(q.amount.0 >= lim.min_bond.0);
            assert_eq!(q.asset, a.id);
        }
    }
}

