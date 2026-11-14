//! CAP3 (D-CAP3, Tyler 2026-11-08): no stake cap at launch. Every asset's `max_per_side` is set at `new()` to the
//! largest overflow-safe value, `CAP3_MAX` = 10^34 raw units (= largest power of ten <= u128::MAX / 4096; the
//! binding intermediate is `pot * 1_000` in the challenge-bond floor = 2_000 * S, ~17x below u128::MAX at the cap).
//! These tests drive a bet at EXACTLY the cap through every stage, on all six assets, same-asset and cross-asset.
//! Child of tests.rs.

use super::*;

pub(crate) const CAP3_MAX: u128 = 10_000_000_000_000_000_000_000_000_000_000_000; // 10^34

const ASSETS: [&str; 6] = [V1_USDC, V1_USDT, V1_BTC, V1_WNEAR, V1_ETH, V1_ZEC];

fn limit_of(id: &str) -> AssetLimit {
    six_asset_v1_limits().into_iter().find(|(k, _)| k == id).unwrap().1
}

fn env_for(seed: u8, maker_asset: &str, sm: u128, taker_asset: &str, st: u128) -> Envelope {
    let (_, pk) = test_keypair(seed);
    let mut env = base_envelope(&hex_encode(&pk));
    env.maker_asset = maker_asset.to_string();
    env.stake_maker = U128(sm);
    env.taker_asset = taker_asset.to_string();
    env.stake_taker = U128(st);
    env
}

/// Open (maker) + take (taker) on the six-asset contract; returns the bet id. Asserts both deposits accepted in full.
fn open_take(c: &mut Contract, env: &Envelope) -> u64 {
    let r = do_mt_transfer_asset(c, "maker.testnet", &env.maker_asset, env.maker_required(), open_msg(env), 1);
    assert_eq!(r, vec![U128(0)], "open at the cap must be accepted without refund ({} / {})", env.maker_asset, env.taker_asset);
    let id = c.next_bet_id - 1;
    let r = do_mt_transfer_asset(c, "taker.testnet", &env.taker_asset, env.taker_required(), take_msg(id), 2);
    assert_eq!(r, vec![U128(0)], "take at the cap must be accepted without refund");
    id
}

fn submit(c: &mut Contract, id: u64, env: &Envelope, outcome: &str, run_no: u64, ts: u64) {
    ctx("anyone.testnet", ts);
    let result = SubmittedResult {
        bet_id: id,
        terms_hash: env.terms_hash.clone(),
        outcome: outcome.to_string(),
        element_results_hash: "e".repeat(64),
        run_no,
        checked_until: U64(ts),
        next_check_ns: None,
        judge_pair_index: 0,
        model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
}

/// Sum of scheduled lines for `bet_id` in `token` (all receivers).
fn out_in(c: &Contract, id: u64, token: &str) -> u128 {
    c.pending_payouts(id).iter().filter(|p| p.token_id == token).map(|p| p.amount.0).sum()
}

/// I-2 per asset: everything scheduled for the bet equals everything deposited, asset by asset (checked sums).
fn assert_conserved(c: &Contract, id: u64, deposits: &[(&str, u128)]) {
    let mut tokens: Vec<&str> = deposits.iter().map(|(t, _)| *t).collect();
    tokens.sort();
    tokens.dedup();
    for t in tokens {
        let want = deposits.iter().filter(|(k, _)| *k == t).try_fold(0u128, |a, (_, v)| a.checked_add(*v)).expect("deposit sum overflows u128");
        let got = c.pending_payouts(id).iter().filter(|p| p.token_id == t).try_fold(0u128, |a, p| a.checked_add(p.amount.0)).expect("payout sum overflows u128");
        assert_eq!(got, want, "I-2 violated for {t}: scheduled {got} != deposited {want}");
    }
}

#[test]
fn cap3_fixture_max_per_side_is_the_launch_cap_for_all_six_assets() {
    for id in ASSETS {
        assert_eq!(limit_of(id).max_per_side.0, CAP3_MAX, "{id}: six_asset_v1_limits max_per_side must be the D-CAP3 cap");
    }
    // the cap is the documented derivation: largest power of ten <= u128::MAX / 4096
    assert!(CAP3_MAX <= u128::MAX / 4096);
    assert!(CAP3_MAX * 10 > u128::MAX / 4096);
    // binding intermediate: pot * 1_000 = 2_000 * S fits with room to spare
    assert!(CAP3_MAX.checked_mul(2_000 * 10).is_some());
}

#[test]
fn cap3_max_opens_takes_and_finalizes_on_each_of_six_assets_same_asset() {
    for (i, a) in ASSETS.iter().enumerate() {
        let a = a.to_string();
        c1_isolated(move || {
            let mut c = new_contract_six_asset_v1();
            let env = env_for(100 + i as u8, &a, CAP3_MAX, &a, CAP3_MAX);
            let id = open_take(&mut c, &env);
            submit(&mut c, id, &env, "YES", 1, 2_000);
            ctx("anyone.testnet", 2_000 + 86_400_000_000_001);
            c.finalize(id);
            let storage = env.storage_for(STG_FIXTURE_RATE);
            assert_conserved(&c, id, &[(&a, CAP3_MAX + storage), (&a, CAP3_MAX + storage)]);
            let fee = side_fee(CAP3_MAX, 100, limit_of(&a).min_fee_per_side.0);
            assert_eq!(c1_sum(&c, id, "maker.testnet", &a), 2 * (CAP3_MAX - fee), "{a}: winner gets both pots less two fees");
            assert_eq!(c1_sum(&c, id, FEE, &a), 2 * fee + 2 * storage);
            drain_all(&mut c, id, 3_000);
        });
    }
}

#[test]
fn cap3_max_opens_takes_and_finalizes_on_every_cross_asset_pair() {
    // 6 x 6 pairs including same-asset: each side may be a different asset, each at its own cap.
    let mut c = new_contract_six_asset_v1();
    let mut seed = 0u8;
    for ma in ASSETS {
        for ta in ASSETS {
            seed += 1;
            let env = env_for(seed, ma, CAP3_MAX, ta, CAP3_MAX);
            let id = open_take(&mut c, &env);
            submit(&mut c, id, &env, "NO", 1, 2_000);
            ctx("anyone.testnet", 2_000 + 86_400_000_000_001);
            c.finalize(id);
            let storage = env.storage_for(STG_FIXTURE_RATE);
            assert_conserved(&c, id, &[(ma, CAP3_MAX + storage), (ta, CAP3_MAX + storage)]);
            drain_all(&mut c, id, 3_000);
        }
    }
    assert_eq!(seed, 36);
}

#[test]
fn cap3_max_concede_on_each_asset_pays_exactly_and_conserves() {
    for (i, a) in ASSETS.iter().enumerate() {
        let a = a.to_string();
        c1_isolated(move || {
            let mut c = new_contract_six_asset_v1();
            let env = env_for(140 + i as u8, &a, CAP3_MAX, &a, CAP3_MAX);
            let id = open_take(&mut c, &env);
            ctx("taker.testnet", 3_000);
            c.concede(id);
            let storage = env.storage_for(STG_FIXTURE_RATE);
            assert_conserved(&c, id, &[(&a, CAP3_MAX + storage), (&a, CAP3_MAX + storage)]);
            let fee = side_fee(CAP3_MAX, 100, limit_of(&a).min_fee_per_side.0);
            assert_eq!(c1_sum(&c, id, "maker.testnet", &a), 2 * (CAP3_MAX - fee));
        });
    }
}

#[test]
fn cap3_max_void_after_deadline_refunds_exactly_on_each_asset_and_cross_asset() {
    for (i, a) in ASSETS.iter().enumerate() {
        let a = a.to_string();
        c1_isolated(move || {
            let mut c = new_contract_six_asset_v1();
            let other = ASSETS[(i + 1) % 6];
            let env = env_for(160 + i as u8, &a, CAP3_MAX, other, CAP3_MAX);
            let id = open_take(&mut c, &env);
            ctx("anyone.testnet", 10_001);
            c.void_after_deadline(id);
            let storage = env.storage_for(STG_FIXTURE_RATE);
            assert_conserved(&c, id, &[(&a, CAP3_MAX + storage), (other, CAP3_MAX + storage)]);
        });
    }
}

#[test]
fn cap3_max_emergency_refund_returns_everything_on_each_asset() {
    for (i, a) in ASSETS.iter().enumerate() {
        let a = a.to_string();
        c1_isolated(move || {
            let mut c = new_contract_six_asset_v1();
            let other = ASSETS[(i + 2) % 6];
            let env = env_for(180 + i as u8, &a, CAP3_MAX, other, CAP3_MAX);
            let id = open_take(&mut c, &env);
            // plus an open, untaken offer at the cap
            let env2 = env_for(200 + i as u8, &a, CAP3_MAX, &a, CAP3_MAX);
            let r = do_mt_transfer_asset(&mut c, "maker.testnet", &a, env2.maker_required(), open_msg(&env2), 3);
            assert_eq!(r, vec![U128(0)]);
            let id2 = c.next_bet_id - 1;
            ctx_with_deposit(GUARDIAN, 10, NearToken::from_yoctonear(1));
            c.emergency_shutdown();
            c.emergency_refund(id);
            c.emergency_refund(id2);
            let storage = env.storage_for(STG_FIXTURE_RATE);
            assert_conserved(&c, id, &[(&a, CAP3_MAX + storage), (other, CAP3_MAX + storage)]);
            assert_conserved(&c, id2, &[(&a, CAP3_MAX + storage)]);
        });
    }
}

/// The full dispute path at the cap: challenge bond (floor from pot * 1_000, the binding intermediate) + objection
/// deposit (pot * 50) + re-judge + finalize, on each asset, with the challenger on the other asset (cross-asset
/// uses 2x own stake as the pot).
#[test]
fn cap3_max_challenge_bond_objection_and_finalize_conserve_on_each_asset() {
    for (i, a) in ASSETS.iter().enumerate() {
        let a = a.to_string();
        c1_isolated(move || {
            let mut c = new_contract_six_asset_v1();
            let t = ASSETS[(i + 3) % 6].to_string();
            let cross = a != t;
            let env = env_for(10 + i as u8, &a, CAP3_MAX, &t, CAP3_MAX);
            let id = open_take(&mut c, &env);
            submit(&mut c, id, &env, "YES", 1, 2_000);
            // taker (asset t) challenges
            let lim = limit_of(&t);
            let pot = if cross { CAP3_MAX * 2 } else { CAP3_MAX * 2 };
            let floor = std::cmp::max(lim.min_bond.0, pot * 1_000 / BPS_DENOM);
            let bond = floor + lim.run_price.0;
            let r = do_mt_transfer_asset(&mut c, "taker.testnet", &t, bond, serde_json::to_string(&TransferMsg::Bond { bet_id: id, round: 1 }).unwrap(), 2_050);
            assert_eq!(r, vec![U128(0)], "bond at the cap accepted ({t})");
            let objection = std::cmp::max(lim.min_objection.0, pot * 50 / BPS_DENOM);
            let r = do_mt_transfer_asset(&mut c, "taker.testnet", &t, objection, objection_msg(id, &"e".repeat(64), false), 2_060);
            assert_eq!(r, vec![U128(0)], "objection at the cap accepted ({t})");
            submit(&mut c, id, &env, "YES", 2, 2_070);
            ctx("anyone.testnet", 2_070 + 86_400_000_000_001);
            c.finalize(id);
            let storage = env.storage_for(STG_FIXTURE_RATE);
            assert_conserved(
                &c,
                id,
                &[(&a, CAP3_MAX + storage), (&t, CAP3_MAX + storage), (&t, bond), (&t, objection)],
            );
            drain_all(&mut c, id, 4_000);
        });
    }
}

#[test]
fn cap3_one_over_max_is_refused_in_full_on_every_asset_maker_and_taker_side() {
    for a in ASSETS {
        let mut c = new_contract_six_asset_v1();
        let over_maker = env_for(30, a, CAP3_MAX + 1, a, CAP3_MAX);
        let before = c.next_bet_id;
        let r = do_mt_transfer_asset(&mut c, "maker.testnet", a, over_maker.maker_required(), open_msg(&over_maker), 1);
        assert_eq!(r, vec![U128(over_maker.maker_required())], "{a}: maker max+1 refunded in full");
        let over_taker = env_for(31, a, CAP3_MAX, a, CAP3_MAX + 1);
        let r = do_mt_transfer_asset(&mut c, "maker.testnet", a, over_taker.maker_required(), open_msg(&over_taker), 1);
        assert_eq!(r, vec![U128(over_taker.maker_required())], "{a}: taker max+1 refunded in full");
        assert_eq!(c.next_bet_id, before, "{a}: no bet created by a refused open");
        // a taker_options entry one over the cap is refused too
        let mut opt = env_for(32, a, CAP3_MAX, a, CAP3_MAX);
        opt.taker_options = vec![TakerOption { asset: ASSETS[(ASSETS.iter().position(|x| x == &a).unwrap() + 1) % 6].to_string(), amount: U128(CAP3_MAX + 1) }];
        let r = do_mt_transfer_asset(&mut c, "maker.testnet", a, opt.maker_required(), open_msg(&opt), 1);
        assert_eq!(r, vec![U128(opt.maker_required())], "{a}: taker option max+1 refunded in full");
    }
}

#[test]
fn cap3_guardian_can_still_lower_max_via_propose_params_and_new_bets_obey() {
    // D-CAP3: the guardian lowers the cap later through the 24h propose_params path; bets above the new max are refused.
    let mut c = new_contract_six_asset_v1();
    let lowered = 1_000_000_000u128; // 1,000 USDC
    ctx_with_deposit(GUARDIAN, 100, NearToken::from_yoctonear(1));
    c.propose_params(ParamsChange {
        fee_bps: None,
        assets: vec![AssetParamsChange { asset_id: V1_USDC.to_string(), min_fee_per_side: None, min_per_side: None, max_per_side: Some(U128(lowered)) }],
    });
    ctx_with_deposit(KEEPER, 100 + crate::PARAMS_DELAY_NS + 1, NearToken::from_yoctonear(0));
    c.apply_params();
    let now = crate::PARAMS_DELAY_NS + 200;
    let mut env = env_for(40, V1_USDC, lowered + 1, V1_USDC, lowered);
    env.funding_deadline = now + 1_000_000;
    env.resolve_deadline = now + 2_000_000;
    let r = do_mt_transfer_asset(&mut c, "maker.testnet", V1_USDC, env.maker_required(), open_msg_at(&env, now), now);
    assert_eq!(r, vec![U128(env.maker_required())], "after lowering, max+1 of the NEW max is refused");
    let mut ok = env_for(41, V1_USDC, lowered, V1_USDC, lowered);
    ok.funding_deadline = now + 1_000_000;
    ok.resolve_deadline = now + 2_000_000;
    let r = do_mt_transfer_asset(&mut c, "maker.testnet", V1_USDC, ok.maker_required(), open_msg_at(&ok, now), now);
    assert_eq!(r, vec![U128(0)]);
}

/// Documents the BINDING constraint: the challenge-bond floor does `pot * 1_000` in checked u128. With pot = 2S that
/// overflows once S > u128::MAX / 2000 (~1.7e35), ~17x above the 10^34 launch cap. D-CAP3b: the contract now refuses
/// any max_per_side above 10^34, so that overflow is UNREACHABLE. Asserts (1) new() refuses the former fixture
/// S = u128::MAX/2000+1 with the ceiling message, (2) the u128 arithmetic fact (overflow at S, none at 10^34), and
/// (3) a bet at exactly 10^34 per side can be challenged (bond computed and accepted, no panic).
#[test]
fn cap3_binding_constraint_bond_floor_pot_times_1000_overflows_above_u128_max_over_2000_unreachable() {
    c1_isolated(|| {
        let s = u128::MAX / 2_000 + 1; // 2 * s * 1000 > u128::MAX
        let mut limits = six_asset_v1_limits();
        for (_, l) in limits.iter_mut() {
            l.max_per_side = U128(s);
        }
        ctx(OPERATOR, 0);
        // (1) new() refuses the former fixture
        let msg = c1_panic_msg(|| { let _ = Contract::new(
            INTENTS.parse().unwrap(),
            V1_USDC.to_string(),
            OUTLAYER.parse().unwrap(),
            OPERATOR.parse().unwrap(),
            GUARDIAN.parse().unwrap(),
            REGISTRY.parse().unwrap(),
            FEE.parse().unwrap(),
            KEEPER.parse().unwrap(),
            Limits {
                max_stake: U128(crate::DEFAULT_MAX_STAKE_PER_SIDE_USDC),
                max_offer_ttl_secs: 86400 * 60,
                max_stake_per_side_near: U128(100 * 10u128.pow(24)),
                max_rounds: crate::DEFAULT_MAX_ROUNDS,
                max_retries: crate::DEFAULT_MAX_RETRIES,
            },
            None,
            limits,
            outcome_pubkey_hex(),
            attest_pubkey_hex(),
            test_resolver_wasm_hash(),
            test_outlayer_config(),
            test_judge_chain(),
        ); });
        assert!(msg.contains("max_per_side") && msg.contains("10^34"), "new() must refuse S with the 10^34 ceiling message, got: {msg:?}");

        // (2) pure u128 arithmetic: pot * 1000 overflows at S, not at the ceiling
        assert!(2u128.checked_mul(s).and_then(|pot| pot.checked_mul(1_000)).is_none(), "2*S*1000 must overflow u128");
        assert!(2u128.checked_mul(CAP3_MAX).and_then(|pot| pot.checked_mul(1_000)).is_some(), "2*10^34*1000 must not overflow");

        // (3) a bet at exactly the ceiling can be challenged
        let mut c = new_contract_six_asset_v1();
        let env = env_for(50, V1_USDC, CAP3_MAX, V1_USDC, CAP3_MAX);
        let id = open_take(&mut c, &env);
        submit(&mut c, id, &env, "YES", 1, 2_000);
        let lim = limit_of(V1_USDC);
        let floor = std::cmp::max(lim.min_bond.0, 2 * CAP3_MAX * 1_000 / BPS_DENOM);
        let bond = floor + lim.run_price.0;
        let r = do_mt_transfer_asset(&mut c, "taker.testnet", V1_USDC, bond, serde_json::to_string(&TransferMsg::Bond { bet_id: id, round: 1 }).unwrap(), 2_050);
        assert_eq!(r, vec![U128(0)], "challenge bond at exactly 10^34 per side must be accepted");
    });
}
