//! Praetorial conformance audit -- escrow contract claims that the spec
//! makes but that `contracts/escrow/src` had no dedicated test for
//! (ENFORCED-UNTESTED in `Conformance matrix.md`). This crate is a
//! separate, non-workspace-member Cargo project that path-depends on
//! `contracts/escrow` as a library; it never edits that crate's own
//! files, per the loop's "don't touch contracts/escrow/src" rule.
//!
//! Claim IDs match the conformance matrix (internal design notes).

use ed25519_dalek::Signer;
use escrow::*;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use near_sdk::borsh::BorshSerialize;
use near_sdk::{AccountId, PromiseOrValue};

const INTENTS: &str = "intents.testnet";
const USDC: &str = "nep141:usdc.testnet";
const OUTLAYER: &str = "outlayer.testnet";
const OPERATOR: &str = "operator.testnet";
const GUARDIAN: &str = "guardian.testnet";
const REGISTRY: &str = "registry.testnet";
const FEE: &str = "fee.testnet";
const KEEPER: &str = "keeper.testnet";
const CONTRACT: &str = "escrow.testnet";

fn ctx(predecessor: &str, ts: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .signer_account_id(predecessor.parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .block_timestamp(ts);
    testing_env!(b.build());
}

fn new_contract() -> Contract {
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
            max_stake_per_side_near: U128(1_000_000_000),
            max_rounds: escrow::DEFAULT_MAX_ROUNDS,
            // D-RESOLVE1 (item 7d): documented default (7).
            max_retries: 7,
        },
        None, // beta_sunset_ns: use the documented default (D6)
        // Sub-job 1 (D-PRICE6): lenient USDC-only whitelist, matching
        // this crate's pre-existing (no asset-limit-specific) coverage.
        vec![(
            USDC.to_string(),
            AssetLimit {
                min_per_side: U128(20), // D-FEEMIN1: min_fee_per_side 1 requires min_per_side >= 20
                min_fee_per_side: U128(1), // D-FEEMIN1 fixture: below 1% of any fixture stake, old fee expectations unchanged
                min_fee_cap_per_side: U128(0), // D-PARAMS1 fixture: 0 = cap pinned at min_fee_per_side
                storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
                max_per_side: U128(1_000_000_000),
                run_price: U128(5_000),
                // D-BOND1: matches the pre-D-BOND1 hardcoded USDC
                // challenge-bond/objection floors exactly.
                min_bond: U128(5_000_000),
                min_objection: U128(1_000_000),
            },
        )],
        outcome_pubkey_hex(),
        attest_pubkey_hex(),
        test_resolver_wasm_hash(),
        OutlayerConfig {
            wasm_base_url: "https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet".to_string(),
            secrets_profile: "praetorial-resolver".to_string(),
            secrets_account_id: "escrow.praetorial-dev-1101.testnet".parse().unwrap(),
        },
        vec![
            JudgePair { model_a: "deepseek-ai/DeepSeek-V4.1-Flash-1017".to_string(), model_b: "zai-org/GLM-5.3-flash".to_string() },
            JudgePair { model_a: "t/jc-backup-a1".to_string(), model_b: "t/jc-backup-a2".to_string() },
        ], // JC1x: 2..=4 initial pairs, org/model ids
    )
}

fn test_keypair(seed: u8) -> (ed25519_dalek::SigningKey, [u8; 32]) {
    let sk = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
    let pk = sk.verifying_key().to_bytes();
    (sk, pk)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// D-KEY1: this crate's own fixed test keys for the pinned
// outcome/attest keys, mirroring contracts/escrow/src/tests.rs.
const OUTCOME_TEST_SEED: u8 = 240;
const ATTEST_TEST_SEED: u8 = 241;
fn outcome_signing_key() -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[OUTCOME_TEST_SEED; 32])
}
fn attest_signing_key() -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[ATTEST_TEST_SEED; 32])
}
fn outcome_pubkey_hex() -> String {
    hex_encode(&outcome_signing_key().verifying_key().to_bytes())
}
fn attest_pubkey_hex() -> String {
    hex_encode(&attest_signing_key().verifying_key().to_bytes())
}
fn test_resolver_wasm_hash() -> String {
    "a".repeat(64)
}

#[allow(unused_variables)]
/// STG1 fixture: raw units per KiB for every asset in this crate's tables.
const STG_FIXTURE_RATE: u128 = 6305;

fn base_envelope(resolver_pk_hex: &str) -> Envelope {
    Envelope {
        bet_id: 0,
        version: 1,
        maker: "maker.testnet".parse().unwrap(),
        taker_allow: TakerAllow::Any,
        terms_hash: "terms-hash-1".to_string(),
        models_snapshot_hash: "m".repeat(64),
        outcomes: vec!["YES".to_string(), "NO".to_string()],
        maker_side: "YES".to_string(),
        maker_asset: USDC.to_string(),
        taker_asset: USDC.to_string(),
        stake_maker: U128(1_000_000),
        stake_taker: U128(1_000_000),
        taker_options: Vec::new(),
        fee_bps: 100,
        storage_charge_per_side: U128(0), // STG1: must be 0; the contract computes the charge
        keep_terms: true,
        terms: Some("{\"claim\":\"test claim\",\"elements\":[]}".to_string()),
        max_paid_runs: 3,
        tier: 0,
        referee: None,
        tip_maker: false,
        funding_deadline: 1_000,
        early_settle_outcome: None,
        finality_delay: 0,
        settlement_period: 24 * 60 * 60 * 1_000_000_000,
        resolve_deadline: 10_000,
        consent_party_controlled: false,
    }
}

/// `Envelope::maker_required`/`taker_required` are private to the
/// escrow crate; this mirrors the public formula from the spec
/// (stake + storage_charge_per_side) since this crate only has access
/// to the envelope's pub fields. D-ECON5: no per-bet reserve any more.
fn maker_required(env: &Envelope) -> u128 {
    env.stake_maker.0 + env.storage_for(STG_FIXTURE_RATE)
}
fn taker_required(env: &Envelope) -> u128 {
    env.stake_taker.0 + env.storage_for(STG_FIXTURE_RATE)
}

/// D-FETCH2 (item 7f2b) design note: every envelope here comes from
/// `base_envelope(resolver_pk_hex)` where `resolver_pk_hex` is built
/// via this crate's own `test_keypair(seed)` -- brute-force the seed
/// to recover the matching `SigningKey` without plumbing a secret key
/// through every `open_msg` call site.
fn find_test_signing_key(pubkey_hex: &str) -> ed25519_dalek::SigningKey {
    for seed in 0u8..=255 {
        let (sk, pk) = test_keypair(seed);
        if hex_encode(&pk) == pubkey_hex {
            return sk;
        }
    }
    panic!(
        "find_test_signing_key: no seed 0..=255 matches resolver_pubkey {pubkey_hex}"
    );
}

fn source_check_attestation(env: &Envelope, checked_at: u64) -> SourceCheckAttestation {
    // D-KEY1: verified against the pinned contract-level attest_pubkey
    // now, never a maker-supplied envelope key.
    let sk = attest_signing_key();
    let message = sourcecheck_message(&env.terms_hash, checked_at);
    let sig = sk.sign(message.as_bytes());
    SourceCheckAttestation {
        checked_at,
        signature_hex: hex_encode(&sig.to_bytes()),
    }
}

fn open_msg(env: &Envelope) -> String {
    open_msg_at(env, 0)
}

fn open_msg_at(env: &Envelope, checked_at: u64) -> String {
    serde_json::to_string(&TransferMsg::Open {
        envelope: env.clone(),
        attestation: source_check_attestation(env, checked_at),
    })
    .unwrap()
}

fn take_msg(bet_id: u64) -> String {
    serde_json::to_string(&TransferMsg::Take {
        bet_id,
        invite_sig: None,
        tip: false,
        referee_ack: None,
    })
    .unwrap()
}

fn objection_msg(bet_id: u64, exhibit_hash: &str, is_rebuttal: bool) -> String {
    serde_json::to_string(&TransferMsg::Objection {
        bet_id,
        exhibit_hash: exhibit_hash.to_string(),
        is_rebuttal,
    })
    .unwrap()
}

fn do_mt_transfer(c: &mut Contract, sender: &str, amount: u128, msg: String, ts: u64) -> Vec<U128> {
    ctx(INTENTS, ts);
    match c.mt_on_transfer(
        sender.parse().unwrap(),
        vec![sender.parse().unwrap()],
        vec![USDC.to_string()],
        vec![U128(amount)],
        msg,
    ) {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("unexpected promise"),
    }
}

/// Opens + takes a fresh bet on a fresh contract; bet_id is always 0
/// (next_bet_id starts at 0, this is the first and only bet opened).
fn open_and_take(c: &mut Contract, pk_hex: &str) -> u64 {
    let env = base_envelope(pk_hex);
    let resp = do_mt_transfer(c, "maker.testnet", maker_required(&env), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)], "open should be accepted");
    let bet_id = 1u64;
    let env2 = base_envelope(pk_hex);
    let resp = do_mt_transfer(c, "taker.testnet", taker_required(&env2), take_msg(bet_id), 2);
    assert_eq!(resp, vec![U128(0)], "take should be accepted");
    bet_id
}

fn sign_result(sk: &ed25519_dalek::SigningKey, result: &SubmittedResult) -> String {
    let mut buf = Vec::new();
    BorshSerialize::serialize(&CONTRACT.parse::<AccountId>().unwrap(), &mut buf).unwrap();
    BorshSerialize::serialize(&result.bet_id, &mut buf).unwrap();
    BorshSerialize::serialize(&result.terms_hash, &mut buf).unwrap();
    BorshSerialize::serialize(&result.outcome, &mut buf).unwrap();
    BorshSerialize::serialize(&result.element_results_hash, &mut buf).unwrap();
    BorshSerialize::serialize(&result.run_no, &mut buf).unwrap();
    BorshSerialize::serialize(&result.checked_until.0, &mut buf).unwrap();
    BorshSerialize::serialize(&result.judge_pair_index, &mut buf).unwrap();
    let sig = sk.sign(&buf);
    hex_encode(&sig.to_bytes())
}

/// Drives a fresh bet all the way to `Proposed` so bond-gated paths
/// (challenge -> Evidence -> submit_exhibits) are reachable.
fn open_take_propose(c: &mut Contract, pk_hex: &str, sk: &ed25519_dalek::SigningKey) -> u64 {
    let bet_id = open_and_take(c, pk_hex);
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        // D-RESOLVE1 (item 7d): only RETRY carries next_check_ns.
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    // D-KEY1: submit_outcome verifies against the pinned contract-level
    // outcome key now, never a maker-supplied envelope key.
    let _ = sk;
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    bet_id
}

// =====================================================================
// CM-11 -- Escrow contract spec v1 §`amend`: "pre-deadline, ≤5, cannot
// change parties/stakes/assets/fee". `amend_count < 5` IS enforced
// (lib.rs:1579, "max 5 amendments") but had no test exercising the
// 6th call. ENFORCED-UNTESTED -> now ENFORCED+TESTED.
// =====================================================================
/// `amend` is a two-party commit (`commit_two_party`): it only takes
/// effect once BOTH maker and taker have called it with the identical
/// `new_terms_hash`. Each round here has maker propose, then taker
/// confirm the same value, which commits exactly one amendment.
fn commit_amend_round(c: &mut Contract, bet_id: u64, hash: &str, ts: u64) {
    ctx("maker.testnet", ts);
    c.amend(bet_id, hash.to_string());
    ctx("taker.testnet", ts);
    c.amend(bet_id, hash.to_string());
}

#[test]
#[should_panic(expected = "max 5 amendments")]
fn cm11_sixth_amend_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(1);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    for i in 0..5 {
        commit_amend_round(&mut c, bet_id, &format!("new-hash-{i}"), 3);
    }
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.amend_count, 5, "setup sanity: 5 rounds must have committed before the 6th is attempted");
    // 6th amend (either party, even as a fresh proposal) must panic,
    // not silently succeed or saturate the counter.
    ctx("maker.testnet", 3);
    c.amend(bet_id, "new-hash-6".to_string());
}

#[test]
fn cm11_five_amends_succeed() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(1);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    for i in 0..5 {
        commit_amend_round(&mut c, bet_id, &format!("new-hash-{i}"), 3);
    }
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.amend_count, 5);
    assert_eq!(bet.envelope.terms_hash, "new-hash-4");
}

// =====================================================================
// CM-12 -- Escrow contract spec v1 §`submit_exhibits`: "records hashes
// (≤5 each)". The `bet.exhibits.len() + hashes.len() <= 5` guard
// (lib.rs:1543) had no dedicated test. ENFORCED-UNTESTED -> now
// ENFORCED+TESTED.
// =====================================================================
#[test]
fn cm12_sixth_exhibit_rejected_via_mt_on_transfer() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(3);
    let bet_id = open_take_propose(&mut c, &hex_encode(&pk), &sk);

    // Challenge to enter Evidence/Challenged so submit_exhibits is open.
    // D-ECON5: run_price moved off Envelope onto the USDC AssetLimit --
    // read it via the contract's own `required_challenge_bond` view
    // (it mirrors max($5, 5% pot) + run_price exactly) instead of
    // reimplementing the formula against a field that no longer exists.
    let bond = c.required_challenge_bond(bet_id, "maker.testnet".parse().unwrap()).unwrap().amount.0;
    let bond_msg = serde_json::to_string(&TransferMsg::Bond { bet_id, round: 0 }).unwrap();
    do_mt_transfer(&mut c, "maker.testnet", bond, bond_msg, 2_100);

    let env = base_envelope(&hex_encode(&pk));
    let pot = env.stake_maker.0 + env.stake_taker.0;
    let deposit = std::cmp::max(1_000_000u128, pot * 50 / 10_000);
    for i in 0..5 {
        let msg = objection_msg(bet_id, &format!("exhibit-{i}-{}", "a".repeat(30)), false);
        let resp = do_mt_transfer(&mut c, "maker.testnet", deposit, msg, 2_200 + i);
        assert_eq!(resp, vec![U128(0)], "exhibit {i} of 5 must be accepted");
    }
    // 6th exhibit on the SAME bet must be rejected (full refund, I-3),
    // not silently accepted past the ≤5 cap.
    let msg6 = objection_msg(bet_id, "exhibit-6-overflow", false);
    let resp6 = do_mt_transfer(&mut c, "maker.testnet", deposit, msg6, 2_300);
    assert_eq!(
        resp6,
        vec![U128(deposit)],
        "CM-12: 6th exhibit must be refunded in full (I-3), the ≤5 cap must not silently extend"
    );
}

// =====================================================================
// CM-14 -- Escrow contract spec v1: resolver_wasm_hash / resolver pubkeys
// (hex-encoded hashes/pubkeys) and terms_hash / models_snapshot_hash
// length bounds (sanity_check, lib.rs:291-308, "SECURITY FIX"
// storage-griefing guard). No test exercised the rejection paths.
// ENFORCED-UNTESTED -> now ENFORCED+TESTED.
//
// D-KEY1: resolver_wasm_hash/resolver pubkeys are pinned contract-level
// config now (set once at Contract::new, validated there via `require`,
// i.e. this call panics rather than returning an error), not per-bet
// Envelope fields -- so this malformed-hash rejection is now exercised
// at `new()`, not at `handle_open`.
// =====================================================================
#[test]
#[should_panic(expected = "resolver_wasm_hash must be 32 bytes hex")]
fn cm14_short_resolver_wasm_hash_rejected_at_init() {
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
            max_stake_per_side_near: U128(1_000_000_000),
            max_rounds: escrow::DEFAULT_MAX_ROUNDS,
            max_retries: 7,
        },
        None,
        vec![(
            USDC.to_string(),
            AssetLimit {
                min_per_side: U128(20), // D-FEEMIN1: min_fee_per_side 1 requires min_per_side >= 20
                min_fee_per_side: U128(1), // D-FEEMIN1 fixture: below 1% of any fixture stake, old fee expectations unchanged
                min_fee_cap_per_side: U128(0), // D-PARAMS1 fixture: 0 = cap pinned at min_fee_per_side
                storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
                max_per_side: U128(1_000_000_000),
                run_price: U128(5_000),
                min_bond: U128(5_000_000),
                min_objection: U128(1_000_000),
            },
        )],
        outcome_pubkey_hex(),
        attest_pubkey_hex(),
        "too-short".to_string(), // not 64 hex chars
        OutlayerConfig {
            wasm_base_url: "https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet".to_string(),
            secrets_profile: "praetorial-resolver".to_string(),
            secrets_account_id: "escrow.praetorial-dev-1101.testnet".parse().unwrap(),
        },
        vec![
            JudgePair { model_a: "deepseek-ai/DeepSeek-V4.1-Flash-1017".to_string(), model_b: "zai-org/GLM-5.3-flash".to_string() },
            JudgePair { model_a: "t/jc-backup-a1".to_string(), model_b: "t/jc-backup-a2".to_string() },
        ], // JC1x: 2..=4 initial pairs, org/model ids
    );
}

#[test]
fn cm14_oversized_models_snapshot_hash_rejected_at_open() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(5);
    let mut env = base_envelope(&hex_encode(&pk));
    env.models_snapshot_hash = "m".repeat(10_000); // storage-griefing length
    let resp = do_mt_transfer(&mut c, "maker.testnet", maker_required(&env), open_msg(&env), 1);
    assert_eq!(
        resp,
        vec![U128(maker_required(&env))],
        "CM-14: oversized models_snapshot_hash must be rejected, not stored at the sponsor's expense"
    );
}

// =====================================================================
// CM-15 -- Escrow contract spec v1 envelope: `fee_bps` is a per-bet
// field expressed in basis points of the pot; sanity_check rejects
// fee_bps > BPS_DENOM (lib.rs:285, i.e. >100%). No test exercised this.
// ENFORCED-UNTESTED -> now ENFORCED+TESTED.
// =====================================================================
#[test]
fn cm15_fee_bps_over_100_percent_rejected_at_open() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(6);
    let mut env = base_envelope(&hex_encode(&pk));
    env.fee_bps = 10_001; // > BPS_DENOM (10_000 == 100%)
    let resp = do_mt_transfer(&mut c, "maker.testnet", maker_required(&env), open_msg(&env), 1);
    assert_eq!(
        resp,
        vec![U128(maker_required(&env))],
        "CM-15: fee_bps > 100% must be rejected at open, not silently accepted"
    );
}

// =====================================================================
// CM-16 -- Escrow contract spec v1 envelope ordering: `resolve_deadline`
// must be after `funding_deadline` (sanity_check, lib.rs:342). No test
// exercised the rejection path directly (only valid orderings appear
// in fixtures). ENFORCED-UNTESTED -> now ENFORCED+TESTED.
// =====================================================================
#[test]
fn cm16_resolve_deadline_before_funding_deadline_rejected_at_open() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(7);
    let mut env = base_envelope(&hex_encode(&pk));
    env.resolve_deadline = env.funding_deadline - 1; // inverted ordering
    let resp = do_mt_transfer(&mut c, "maker.testnet", maker_required(&env), open_msg(&env), 1);
    assert_eq!(
        resp,
        vec![U128(maker_required(&env))],
        "CM-16: resolve_deadline <= funding_deadline must be rejected at open"
    );
}

// =====================================================================
// CM-06 -- Escrow contract spec v1 invariant I-6: "No owner, no
// upgrade, no admin withdraw, no outcome override." Structural claim,
// no runtime assertion is possible; tested the same way the TS
// services/*/test/spec-boundary.test.ts files test their "never
// imports a signing client" claims -- static source scan for the
// absence of the forbidden capability. ENFORCED-UNTESTED (comment-only
// before this test) -> now ENFORCED+TESTED.
// =====================================================================
#[test]
fn cm06_no_owner_upgrade_or_admin_withdraw_method_exists() {
    let src = std::fs::read_to_string(
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../../contracts/escrow/src/lib.rs"),
    )
    .expect("must be able to read contracts/escrow/src/lib.rs for this static check");
    let forbidden = [
        "fn set_owner",
        "fn transfer_ownership",
        "fn upgrade(",
        "fn deploy_code",
        "fn withdraw_near(",
        "fn admin_withdraw",
        "fn force_outcome",
        "fn override_outcome",
        "fn set_outcome(",
    ];
    for needle in forbidden {
        assert!(
            !src.contains(needle),
            "CM-06 / I-6 violated: found forbidden method signature `{needle}` in contracts/escrow/src/lib.rs"
        );
    }
    // D-SUNSET2/D-SUNSET3: pause/unpause moved off `self.operator` onto
    // the guardian (`self.guardian`). `self.operator` now gates exactly
    // ONE legitimate site: `reclaim`'s operator-initiated early-close
    // gate (documented at that call site as the deliberate early-close
    // feature, not a withdraw/outcome backdoor). A 2nd site is a signal
    // this test should be re-read, not silently bumped.
    let operator_gated_count = src.matches("predecessor_account_id() == self.operator").count();
    assert_eq!(
        operator_gated_count, 1,
        "CM-06: expected exactly 1 known site gated on self.operator (reclaim early-close); \
         found {operator_gated_count} -- a new operator-restricted method may have been added \
         and needs a human to confirm it isn't a withdraw/outcome backdoor"
    );
    // D-SUNSET2/D-SUNSET3: the guardian's power must stay exactly these
    // four narrow sites (pause_new_offers, unpause_new_offers,
    // set_guardian, emergency_shutdown) PLUS the two D-PARAMS1 (PA1)
    // sites propose_params and cancel_params (apply_params is
    // permissionless) PLUS the two D-JUDGECHAIN1 (JC1) sites propose_judge_pair
    // and cancel_judge_pair (apply_judge_pair is permissionless, append-only,
    // 7-day timelock; familiarcow-approved 2026-11-08) PLUS the three AS1 (D-ASSET1)
    // sites propose_asset, cancel_asset and disable_asset_for_new_bets
    // (apply_asset is permissionless, append-only, 24h timelock; familiarcow-approved
    // 2026-11-08) -- never a 13th (e.g. a bet-level
    // void or a fund-moving power), per D-SUNSET2's "guardian can never
    // ... move funds elsewhere, or change parameters" rule.
    let guardian_gated_count = src.matches("predecessor_account_id() == self.guardian").count();
    assert_eq!(
        guardian_gated_count, 12,
        "D-SUNSET2/D-SUNSET3/D-PARAMS1: expected exactly 12 known sites gated on self.guardian \
         (pause_new_offers, unpause_new_offers, set_guardian, emergency_shutdown, \
         propose_params, cancel_params, propose_judge_pair, cancel_judge_pair, cancel_guardian [JC1x], \
         propose_asset, cancel_asset, disable_asset_for_new_bets [AS1]); found \
         {guardian_gated_count} -- a new guardian-restricted method may have been added and \
         needs a human to confirm it isn't a scope-creeping extra power"
    );
    // D-SUNSET3: emergency_refund must stay permissionless (no caller
    // gate at all) -- that's the whole point of "anyone may call
    // emergency_refund(bet_id) after shutdown".
    assert!(
        src.contains("pub fn emergency_refund(&mut self, bet_id: u64) {"),
        "D-SUNSET3: emergency_refund must exist with its documented permissionless signature"
    );
}

// =====================================================================
// CM-18b -- Decision register D-TTL1 (familiarcow, 2026-11-04): "Single
// offer-TTL limit in v1; the 1-year self-paid tier is dropped. CM-18b
// becomes a spec update, not code. Supersedes the two-tier TTL claim."
//
// Previously tracked as a NOT ENFORCED gap in
// `tests/conformance/ts/not_enforced.test.ts` (the spec claimed a
// second, longer (1y) ceiling for self-paid-storage offers, distinct
// from the sponsored 60d ceiling; no such second ceiling or
// "who pays storage" flag existed anywhere in `Envelope`/`Limits`).
// D-TTL1 resolves the gap by dropping the two-tier claim rather than
// adding code: `contracts/escrow/src/lib.rs`'s single flat
// `limits.max_offer_ttl_secs` ceiling (checked in `handle_open`) IS
// the v1 design now. This test asserts that design behaviourally
// against the real contract:
//   (a) an offer exactly at the ceiling is accepted;
//   (b) an offer one second past the ceiling is refused;
//   (c) there is no self-paid exception -- the same over-ceiling
//       offer is refused with no "who pays storage" flag anywhere to
//       even attempt to claim a longer, second ceiling.
// ENFORCED+TESTED (moved out of not_enforced.test.ts).
// =====================================================================
#[test]
fn cm18b_single_offer_ttl_ceiling_accepted_at_boundary_rejected_over_no_self_paid_exception() {
    // Matches `new_contract()`'s Limits.max_offer_ttl_secs above.
    let max_ttl_secs: u64 = 86_400 * 60;
    let max_ttl_ns: u64 = max_ttl_secs * 1_000_000_000;

    // (a) exactly at the single ceiling must be accepted.
    let mut c_at = new_contract();
    let (_, pk_at) = test_keypair(210);
    let mut env_at = base_envelope(&hex_encode(&pk_at));
    env_at.funding_deadline = 1 + max_ttl_ns;
    env_at.resolve_deadline = env_at.funding_deadline + 1;
    let resp_at = do_mt_transfer(&mut c_at, "maker.testnet", maker_required(&env_at), open_msg(&env_at), 1);
    assert_eq!(
        resp_at,
        vec![U128(0)],
        "CM-18b / D-TTL1: an offer exactly at the single TTL ceiling must be accepted"
    );

    // (b) one second past the ceiling must be refused (full refund).
    let mut c_over = new_contract();
    let (_, pk_over) = test_keypair(211);
    let mut env_over = base_envelope(&hex_encode(&pk_over));
    env_over.funding_deadline = 1 + max_ttl_ns + 1_000_000_000;
    env_over.resolve_deadline = env_over.funding_deadline + 1;
    let resp_over =
        do_mt_transfer(&mut c_over, "maker.testnet", maker_required(&env_over), open_msg(&env_over), 1);
    assert_eq!(
        resp_over,
        vec![U128(maker_required(&env_over))],
        "CM-18b / D-TTL1: an offer past the single TTL ceiling must be refused in full"
    );

    // (c) no self-paid exception: there is no "who pays storage" flag
    // anywhere on Envelope/Limits for a maker to even attempt to claim
    // a second, longer ceiling with -- the over-ceiling offer in (b)
    // above is refused unconditionally, the same way for every maker.
    // Static check so a future self-paid-storage flag added without
    // revisiting this decision is caught here, not silently shipped.
    let src = std::fs::read_to_string(
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../../contracts/escrow/src/lib.rs"),
    )
    .expect("must be able to read contracts/escrow/src/lib.rs for this static check");
    assert!(
        !src.contains("storage_self_paid") && !src.contains("self_paid_storage"),
        "CM-18b / D-TTL1 violated: a self-paid-storage flag now exists on Envelope/Limits -- \
         the single-ceiling decision (D-TTL1) assumed none exists; revisit this test and the \
         ceiling check above before re-enabling a second, longer tier"
    );
}

/// G5D: the escrow README's "Deviations" section must not contradict the
/// code on objection/rebuttal deposits (forfeited/returned per
/// `ObjectionDeposit`, no reserve) nor name removed entry points.
#[test]
fn readme_deviations_match_deposit_forfeiture_and_removed_methods() {
    let readme = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../contracts/escrow/README.md"
    ))
    .expect("read escrow README");
    let readme = readme.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(!readme.contains("never forfeited"), "README still says deposits are never forfeited");
    assert!(!readme.contains("reserve-leftover"), "README still mentions the removed reserve-leftover split");
    assert!(!readme.contains("arbiter_pick"), "README still names removed arbiter_pick");
    let item6 = readme.split("6. **Objection/rebuttal deposit").nth(1).expect("item 6 present");
    let item6 = item6.split(" 7. **").next().unwrap();
    assert!(item6.contains("forfeit") && item6.contains("counterparty"), "item 6 must describe forfeiture to the counterparty");
}
