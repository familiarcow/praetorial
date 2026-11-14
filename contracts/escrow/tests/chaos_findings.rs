//! Failing-test record for breaks found by the local-sandbox chaos loop
//! (~/praetorial/chaos). Each test is `#[ignore]`d with an issue note --
//! these are DOCUMENTED GAPS, not regressions in currently-passing
//! behavior, confirmed end-to-end against the real compiled wasm in a
//! near-sandbox (see chaos/scenarios/economic.mjs for the full
//! integration-level reproduction over real cross-contract calls).
//!
//! This file is a NEW path (contracts/escrow/tests/), deliberately kept
//! separate from src/tests.rs (shared with other in-flight work) and
//! from tests/seams/ (out of scope per the chaos-loop task brief) so it
//! can be added without touching either.
//!
//! Scope: these drive the contract entirely through its PUBLIC surface
//! (`new` + `mt_on_transfer`, exactly what a real `transfer_with_msg`
//! caller does), since `Envelope::sanity_check`/`maker_required` are
//! private to the crate -- this is the same boundary a real caller (or
//! the chaos/ sandbox harness) is limited to, so it's an honest
//! integration-level reproduction, not a weaker substitute.
use ed25519_dalek::Signer;
use escrow::*;
use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;
use near_sdk::PromiseOrValue;

const INTENTS: &str = "intents.testnet";
const USDC: &str = "nep141:usdc.testnet";
const OUTLAYER: &str = "outlayer.testnet";
const OPERATOR: &str = "operator.testnet";
const GUARDIAN: &str = "guardian.testnet";
const REGISTRY: &str = "registry.testnet";
const FEE: &str = "fee.testnet";
const KEEPER: &str = "keeper.testnet";
const CONTRACT: &str = "escrow.testnet";
const MAKER: &str = "maker.testnet";
const STG_FIXTURE_RATE: u128 = 6274; // STG1 fixture: ceil(3264*6274/2048) = 10_000 for this file's base_envelope (3264 est. bytes)

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
            max_stake: U128(1_000_000_000_000),
            max_offer_ttl_secs: 31_536_000, // 1yr, matches chaos/harness.mjs setupSandbox
            max_stake_per_side_near: U128(100 * 10u128.pow(24)),
            max_rounds: escrow::DEFAULT_MAX_ROUNDS,
            max_retries: escrow::DEFAULT_MAX_RETRIES,
        },
        None,
        vec![(
            USDC.to_string(),
            AssetLimit {
                min_per_side: U128(20), // D-FEEMIN1: min_fee_per_side 1 requires min_per_side >= 20
                min_fee_per_side: U128(1), // D-FEEMIN1 fixture: below 1% of any fixture stake, old fee expectations unchanged
                min_fee_cap_per_side: U128(0), // D-PARAMS1 fixture: 0 = cap pinned at min_fee_per_side
                storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
                max_per_side: U128(escrow::DEFAULT_MAX_STAKE_PER_SIDE_USDC),
                run_price: U128(50_000), // D-ECON5: matches base_envelope's old run_price
                // D-BOND1: matches the pre-D-BOND1 hardcoded USDC
                // challenge-bond/objection floors exactly.
                min_bond: U128(5_000_000),
                min_objection: U128(1_000_000),
            },
        )],
        // D-KEY1: this file doesn't test outcome/attest key separation,
        // so both pinned keys reuse the same fixed `resolver_signing_key`
        // this file has always used.
        resolver_pubkey_hex(),
        resolver_pubkey_hex(),
        "f".repeat(64),
        OutlayerConfig {
            wasm_base_url: "https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet".to_string(),
            secrets_profile: "praetorial-resolver".to_string(),
            secrets_account_id: "escrow.praetorial-dev-1101.testnet".parse().unwrap(),
        },
        vec![
            escrow::JudgePair { model_a: "deepseek-ai/DeepSeek-V4.1-Flash-1017".to_string(), model_b: "zai-org/GLM-5.3-flash".to_string() },
            escrow::JudgePair { model_a: "t/jc-backup-a1".to_string(), model_b: "t/jc-backup-a2".to_string() },
        ], // JC1x: 2..=4 initial pairs, org/model ids
    )
}

/// D-FETCH2 (item 7f2b): Open now requires a resolver-signed attestation,
/// so resolver_pubkey can no longer be an arbitrary non-derivable hex
/// string ("d".repeat(64)) -- it must be a real key this file can sign
/// with. Fixed seed, same `ed25519_dalek::SigningKey::from_bytes(&[seed;
/// 32])` scheme as src/tests.rs's `test_keypair`.
const RESOLVER_SEED: u8 = 0xd1;

fn resolver_signing_key() -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[RESOLVER_SEED; 32])
}

fn resolver_pubkey_hex() -> String {
    hex_encode(&resolver_signing_key().verifying_key().to_bytes())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn base_envelope() -> Envelope {
    Envelope {
        bet_id: 0,
        version: 1,
        maker: MAKER.parse().unwrap(),
        taker_allow: TakerAllow::Any,
        terms_hash: "a".repeat(64),
        // D-KEY1: resolver_wasm_hash/resolver_pubkey are pinned
        // contract-level config now (see new_contract() above), not
        // Envelope fields.
        models_snapshot_hash: "c".repeat(64),
        outcomes: vec!["YES".to_string(), "NO".to_string()],
        maker_side: "YES".to_string(),
        maker_asset: USDC.to_string(),
        taker_asset: USDC.to_string(),
        stake_maker: U128(1_000_000),
        stake_taker: U128(1_000_000),
        taker_options: Vec::new(),
        fee_bps: 100,
        storage_charge_per_side: U128(0), // STG1: must be 0
        keep_terms: false,
        terms: None,
        max_paid_runs: 3,
        tier: 1,
        referee: None,
        tip_maker: false,
        funding_deadline: 3600 * 1_000_000_000,
        early_settle_outcome: None,
        finality_delay: 0,
        settlement_period: 3600 * 1_000_000_000,
        resolve_deadline: 7 * 24 * 3600 * 1_000_000_000,
        consent_party_controlled: false,
    }
}

/// maker_required() is private; mirror its exact formula here
/// (stake_maker + storage_charge_per_side; D-ECON5 removed the
/// per-bet reserve) so these tests can attach the correct amount
/// through the public `mt_on_transfer` surface -- same arithmetic
/// contracts/escrow/src/lib.rs Envelope::maker_required uses.
fn maker_required(env: &Envelope) -> u128 {
    env.stake_maker.0 + env.storage_for(STG_FIXTURE_RATE)
}

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde", tag = "kind")]
enum TransferMsgTestShim {
    Open {
        envelope: Envelope,
        attestation: SourceCheckAttestation,
    },
}

/// D-FETCH2 (item 7f2b) design note: some tests in this file override
/// `env.resolver_pubkey` with their own local `test_keypair(seed)`
/// (not `resolver_signing_key()`'s default) -- brute-force the seed
/// against the same `[seed; 32]` scheme to recover whichever key
/// actually matches, rather than assuming the file-level default.
fn find_signing_key_for(pubkey_hex: &str) -> ed25519_dalek::SigningKey {
    for seed in 0u8..=255 {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
        if hex_encode(&sk.verifying_key().to_bytes()) == pubkey_hex {
            return sk;
        }
    }
    panic!("find_signing_key_for: no seed 0..=255 matches resolver_pubkey {pubkey_hex}");
}

/// D-FETCH2 (item 7f2b): signs a real attestation over
/// `envelope.terms_hash` with whichever key matches
/// `envelope.resolver_pubkey` (checked_at=0, same reasoning as
/// src/tests.rs's `source_check_attestation` -- every test here uses a
/// tiny block_timestamp via `ctx`, well inside the 1h freshness
/// window).
fn attestation_for(env: &Envelope) -> SourceCheckAttestation {
    // D-KEY1: sourcecheck attestations are verified against the pinned
    // contract-level attest_pubkey now, never a maker-supplied envelope
    // key -- this file pins it to resolver_signing_key() (new_contract).
    let sk = resolver_signing_key();
    let message = sourcecheck_message(&env.terms_hash, 0);
    let sig = sk.sign(message.as_bytes());
    SourceCheckAttestation {
        checked_at: 0,
        signature_hex: hex_encode(&sig.to_bytes()),
    }
}

fn try_open(contract: &mut Contract, env: Envelope) -> bool {
    let amount = maker_required(&env);
    try_open_amount(contract, env, amount)
}

fn try_open_amount(contract: &mut Contract, env: Envelope, amount: u128) -> bool {
    let attestation = attestation_for(&env);
    let msg = near_sdk::serde_json::to_string(&TransferMsgTestShim::Open { envelope: env, attestation }).unwrap();
    matches!(
        contract.mt_on_transfer(
            MAKER.parse().unwrap(),
            vec![MAKER.parse().unwrap()],
            vec![USDC.to_string()],
            vec![U128(amount)],
            msg,
        ),
        PromiseOrValue::Value(ref v) if v == &vec![U128(0)]
    )
}

/// ISSUE: chaos/scenarios/economic.mjs `settlement_period_no_onchain_bound`.
/// MASTER MAP C10 and Decisions log D8 both specify "settlement period
/// 1 hour to 90 days" as a ruling. `Envelope::sanity_check` only checks
/// `settlement_period == 0 -> Err("settlement_period must be > 0")` --
/// no upper bound, no real lower bound beyond nonzero. This test asserts
/// the DOCUMENTED bound through the public open flow and is expected to
/// currently FAIL (the contract accepts both a 1-nanosecond and a
/// 91-day settlement_period today).
/// Rank: wrong-outcome / spec-vs-code mismatch, not fund loss (finalize
/// still waits out whatever period was actually set, however short or
/// long).
#[test]
// D1 (design decision): FIXED -- settlement_period is now bound to
// [MIN_SETTLEMENT_PERIOD_NS, MAX_SETTLEMENT_PERIOD_NS] (1h-90d) in
// sanity_check, enforced at offer creation and re-checked at amend.
fn settlement_period_enforces_documented_1h_to_90d_bound() {
    ctx(INTENTS, 1000);
    let mut contract = new_contract();
    ctx(INTENTS, 1000);

    let mut env_tiny = base_envelope();
    env_tiny.terms_hash = "1".repeat(64);
    env_tiny.settlement_period = 1; // 1ns -- should be rejected per the documented 1h floor
    let tiny_accepted = try_open(&mut contract, env_tiny);

    let mut env_huge = base_envelope();
    env_huge.terms_hash = "2".repeat(64);
    env_huge.settlement_period = 91 * 24 * 3600 * 1_000_000_000; // 91 days -- past the documented 90d ceiling
    let huge_accepted = try_open(&mut contract, env_huge);

    assert!(
        !tiny_accepted && !huge_accepted,
        "settlement_period=1ns (accepted={tiny_accepted}) and settlement_period=91days (accepted={huge_accepted}) should both be rejected per the documented 1h-90d bound; today both are accepted"
    );
}

/// ISSUE: chaos/scenarios/economic.mjs `storage_staking_asymmetric_cost`.
/// Already named in the Escrow v1 security review (F5, §3 item 5,
/// "Open -- flag for paid audit") as not byte-metered; this test
/// confirms it's reachable through the real open flow: a maker can set
/// storage_charge_per_side=0 while a keep_terms:true bet carries the
/// full MAX_TERMS_LEN (8KiB) terms blob, with no sanity_check
/// relationship between the two.
/// Rank: storage griefing against the shared sponsor pool, not a direct
/// fund-safety violation (bounded at 8KiB/bet).
#[test]
// D4 (design decision): FIXED -- Envelope::estimated_storage_bytes
// now sizes storage_charge_per_side proportionally to terms/exhibits/
// event overhead; a zero charge with 8KiB terms is rejected.
fn storage_charge_must_cover_actual_terms_size() {
    // STG1 (D-STORAGE1): the old mechanism (a maker-chosen envelope
    // `storage_charge_per_side`) is gone; the contract computes each side's
    // charge from the byte estimate and the asset's `storage_per_kib`. Same
    // intent as D-AUDIT4: a maker writing the full 8KiB MAX_TERMS_LEN blob
    // onchain cannot get away with paying (almost) nothing for it.
    ctx(INTENTS, 1000);
    let mut contract = new_contract();
    ctx(INTENTS, 1000);

    let mut env = base_envelope();
    env.keep_terms = true;
    env.terms = Some("x".repeat(MAX_TERMS_LEN)); // 8KiB, the legal max
    env.storage_charge_per_side = U128(0);
    // A stake-only deposit (zero storage) must be refused.
    let stake_only = env.stake_maker.0;
    let accepted_free = try_open_amount(&mut contract, env.clone(), stake_only);
    assert!(
        !accepted_free,
        "a maker paying no storage charge while writing MAX_TERMS_LEN of terms onchain must be rejected (accepted={accepted_free})"
    );
    // The charge the contract wants scales with the bytes written.
    let empty = {
        let mut e = env.clone();
        e.terms = Some(String::new());
        e.storage_for(STG_FIXTURE_RATE)
    };
    let big = env.storage_for(STG_FIXTURE_RATE);
    assert!(big >= empty + MAX_TERMS_LEN as u128, "8KiB terms must cost at least their own bytes more than empty terms: {big} vs {empty}");
    // One unit short of the computed charge is refused; the exact amount is accepted.
    assert!(!try_open_amount(&mut contract, env.clone(), stake_only + big - 1), "one unit short must be refused");
    assert!(try_open_amount(&mut contract, env, stake_only + big), "the exact computed charge is accepted");
}

/// ISSUE: chaos/scenarios/economic.mjs `sponsor_cap_of_3_not_enforced_onchain`.
/// Confirmed BY DESIGN (System scope map v1 #16, Identity/custody
/// caveats v0 §5.1): the "3 open offers/account" cap is app/offchore
/// policy, never enforced in `handle_open`.
///
/// Standing test policy (design decision): never `#[ignore]`/skip a
/// test to hide a gap -- either assert the real desired behavior (red
/// until fixed) or, when a recorded decision says the behavior is
/// deliberately out of the contract, rewrite the test to assert THAT
/// decided design instead (green), with the real enforcement test
/// living wherever the decision actually puts it. This is the latter:
/// the cap is deliberately app-layer (System scope map v1 #16, never
/// re-ruled), so this contract-level test now documents, as a GREEN
/// assertion, that `handle_open` has no count limit and never will by
/// design -- the REAL enforcing test is
/// `services/common/test/offerCap.test.ts` (`exceedsOpenOfferCap`),
/// which is what an app/indexer layer actually calls before letting a
/// 4th offer's `Open` transfer go out.
#[test]
fn handle_open_has_no_per_maker_open_offer_cap_by_design_cap_is_app_layer() {
    ctx(INTENTS, 1000);
    let mut contract = new_contract();
    ctx(INTENTS, 1000);
    let mut accepted_count = 0;
    for i in 0..5u64 {
        let mut env = base_envelope();
        env.terms_hash = format!("{:064x}", i); // vary to avoid any accidental dedupe
        if try_open(&mut contract, env) {
            accepted_count += 1;
        }
    }
    assert_eq!(
        accepted_count, 5,
        "by design (System scope map v1 #16): the contract itself enforces no per-maker open-offer \
         count limit at all -- all 5 offers here are accepted with zero contract-side resistance. \
         The 3-open-offer sponsor cap is an APP-LAYER policy; see \
         services/common/test/offerCap.test.ts for the test that actually enforces it."
    );
}

/// D-AUDIT8 (design decision, OQ-T10 ruling): FIXED. This is the
/// un-parked repro from commit `4b2504b` -- per the standing test
/// policy (2026-11-03, "never park a failing test"), it stays in the
/// default suite and now asserts the DECIDED fix instead of the panic
/// it used to confirm.
///
/// Original finding (D3, drift review 2026-11-02): `finalize`'s
/// per-bet reserve split charged every challenger-WON round's
/// `run_price` to the counterparty's HALF of the reserve with
/// `saturating_sub`. Three won rounds against the same counterparty
/// (this exact scenario) made the accumulated charge (15_000) exceed
/// that half (7_500), silently clipping to zero and breaking the
/// following exact-sum `require`, which panicked -- and
/// `void_after_deadline` requires `outcome.is_none()` (already
/// `Some`), so the bet had no recovery path at all.
///
/// Fix (D-AUDIT8): the reserve no longer funds ANY challenge round --
/// only round 0. Every challenge round's bond must now cover its own
/// `run_price` (enforced in `handle_bond`), so round costs are paid
/// from the bond, win or lose, and a won round's reimbursement to the
/// challenger is resolved against the counterparty's own
/// finalize-time funds (capped via `min()`, never a `require` that
/// can fail) rather than by subtracting from the reserve split. The
/// reserve split itself is now an unconditional 50/50 of whatever's
/// left after round-0's cost -- structurally incapable of going
/// negative, so this scenario (and any number of further won rounds
/// against the same party) can never panic again.
#[test]
fn d_dispute1_two_won_rounds_against_same_party_finalizes_cleanly_not_panics() {
    const TAKER: &str = "taker.testnet";

    fn taker_required(env: &Envelope) -> u128 {
        env.stake_taker.0 + env.storage_for(STG_FIXTURE_RATE)
    }

    fn test_keypair(seed: u8) -> (ed25519_dalek::SigningKey, [u8; 32]) {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
        let pk = sk.verifying_key().to_bytes();
        (sk, pk)
    }

    fn sign_result(sk: &ed25519_dalek::SigningKey, result: &SubmittedResult) -> String {
        let mut buf = Vec::new();
        BorshSerialize::serialize(&CONTRACT.parse::<near_sdk::AccountId>().unwrap(), &mut buf).unwrap();
        BorshSerialize::serialize(&result.bet_id, &mut buf).unwrap();
        BorshSerialize::serialize(&result.terms_hash, &mut buf).unwrap();
        BorshSerialize::serialize(&result.outcome, &mut buf).unwrap();
        BorshSerialize::serialize(&result.element_results_hash, &mut buf).unwrap();
        BorshSerialize::serialize(&result.run_no, &mut buf).unwrap();
        BorshSerialize::serialize(&result.checked_until.0, &mut buf).unwrap();
        BorshSerialize::serialize(&result.judge_pair_index, &mut buf).unwrap();
        let sig = sk.sign(&buf);
        sig.to_bytes().iter().map(|b| format!("{:02x}", b)).collect()
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

    fn bond_msg(bet_id: u64, round: u32) -> String {
        near_sdk::serde_json::to_string(&TransferMsg::Bond { bet_id, round }).unwrap()
    }

    fn submit(c: &mut Contract, sk: &ed25519_dalek::SigningKey, bet_id: u64, outcome: &str, run_no: u64, ts: u64) {
        ctx("anyone.testnet", ts);
        let result = SubmittedResult {
            bet_id,
            terms_hash: "a".repeat(64),
            outcome: outcome.to_string(),
            element_results_hash: "e".repeat(64),
            run_no,
            checked_until: U64(ts),
            next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig = sign_result(sk, &result);
        c.submit_outcome(result, sig);
    }

    let mut contract = new_contract();
    // D-KEY1: submit_outcome verifies against the pinned contract-level
    // outcome key (new_contract() pins it to resolver_signing_key()),
    // never a maker-supplied envelope key.
    let sk = resolver_signing_key();

    // D-ECON5: no per-bet reserve exists any more at all -- run_price
    // now lives on the contract's USDC AssetLimit (50_000, set by this
    // file's `new_contract`), not the Envelope.
    let mut env = base_envelope();
    env.terms_hash = "a".repeat(64);
    env.max_paid_runs = 10; // not enforced by submit_outcome; generous headroom
    env.stake_maker = U128(1_000_000);
    env.stake_taker = U128(1_000_000);

    ctx(INTENTS, 1);
    let opened = try_open(&mut contract, env.clone());
    assert!(opened, "setup: open must succeed");
    let bet_id = contract.next_bet_id - 1;

    let take_amount = taker_required(&env);
    let take_msg = near_sdk::serde_json::to_string(&TransferMsg::Take { bet_id, invite_sig: None, tip: false, referee_ack: None }).unwrap();
    let resp = do_mt_transfer(&mut contract, TAKER, take_amount, take_msg, 2);
    assert_eq!(resp, vec![U128(0)], "setup: take must succeed");

    // Round 0: initial resolve, outcome YES.
    submit(&mut contract, &sk, bet_id, "YES", 1, 2_000);

    // Two challenge rounds (D-DISPUTE1: default max_rounds is 2, not
    // 3 -- "Review" then "Final appeal"), ALL posted by the taker (so
    // the SAME counterparty -- the maker -- is charged every time).
    // Each round's bond snapshots `pre_challenge_outcome` = whatever
    // the outcome was right before THAT challenge (always "YES"
    // here); the last re-judge flips the outcome to the final "NO",
    // so both bonds end up with pre_challenge_outcome=YES !=
    // final=NO, i.e. the taker (challenger) WON both rounds, and
    // both round_costs land in reserve_charges[maker] (the
    // counterparty) -- submit_outcome only accepts
    // Taken/Resolving/Challenged/Evidence (never Proposed), so the
    // final re-judge has to be the last loop iteration's own
    // submission, not a separate call after the loop.
    let rounds: [(u32, u64, u64, &str); 2] = [
        (1, 2, 2_050, "YES"),
        (2, 3, 2_070, "NO"), // final outcome
    ];
    // D-AUDIT8/D-DISPUTE1: bond amount is challenge_min (5_000_000,
    // the $10-equivalent floor here, pot 2_000_000 well under the 10%
    // threshold) DOUBLED per round (2^(round-1)) + run_price (50_000,
    // D-ECON5's AssetLimit value, never doubled): round 1 = 5_050_000,
    // round 2 = 2*5_000_000 + 50_000 = 10_050_000.
    for (round, run_no, ts, outcome) in rounds {
        let bond_amount = 5_000_000u128 * 2u128.pow(round - 1) + 50_000;
        let resp = do_mt_transfer(&mut contract, TAKER, bond_amount, bond_msg(bet_id, round), ts - 10);
        assert_eq!(resp, vec![U128(0)], "challenge round {round} must be accepted");
        assert_eq!(contract.get_bet(bet_id).unwrap().status, BetStatus::Challenged);
        submit(&mut contract, &sk, bet_id, outcome, run_no, ts);
    }

    let proposed_at = contract.get_bet(bet_id).unwrap().proposed_at.unwrap();
    let finalize_ts = proposed_at + env.settlement_period + 1;
    ctx("anyone.testnet", finalize_ts);

    // THE FIX: finalize must now succeed -- no panic, however many won
    // rounds landed against the same counterparty.
    let before = contract.payout_ids_in_order().len();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        contract.finalize(bet_id);
    }));
    assert!(
        result.is_ok(),
        "finalize must never panic -- D-AUDIT8 closes OQ-T10's reserve overflow"
    );
    // OQ-T11: finalize now only persists the ledger (`Finalized`) --
    // drain it via the same permissionless `drain_payouts` a keeper
    // would use, simulating each fired transfer's callback as
    // successful, until the bet reaches `Settled`.
    assert_eq!(contract.get_bet(bet_id).unwrap().status, BetStatus::Finalized);
    let mut drain_ts = finalize_ts + 10;
    loop {
        // D-AUDIT11: `finalize` itself already fired the first grouped
        // batch inline, so resolve whatever is in_flight BEFORE asking
        // `drain_payouts` for more -- otherwise it correctly refuses to
        // re-fire an in-flight group and this loop would spin forever.
        let in_flight: Vec<_> = contract
            .pending_payouts(bet_id)
            .into_iter()
            .filter(|p| p.in_flight)
            .collect();
        if !in_flight.is_empty() {
            let mut groups: Vec<(near_sdk::AccountId, String, Vec<u64>)> = Vec::new();
            for p in &in_flight {
                match groups.iter_mut().find(|(r, t, _)| *r == p.receiver && *t == p.token_id) {
                    Some(g) => g.2.push(p.id),
                    None => groups.push((p.receiver.clone(), p.token_id.clone(), vec![p.id])),
                }
            }
            for (_, _, ids) in groups {
                let mut b = VMContextBuilder::new();
                b.current_account_id(CONTRACT.parse().unwrap())
                    .signer_account_id(CONTRACT.parse().unwrap())
                    .predecessor_account_id(CONTRACT.parse().unwrap())
                    .block_timestamp(drain_ts);
                testing_env!(
                    b.build(),
                    near_sdk::test_vm_config(),
                    near_sdk::RuntimeFeesConfig::test(),
                    std::collections::HashMap::default(),
                    vec![near_sdk::PromiseResult::Successful(vec![])],
                );
                contract.on_payout_result(ids);
            }
            continue;
        }

        let pending = contract.pending_payouts(bet_id);
        if pending.is_empty() {
            break;
        }
        ctx("anyone.testnet", drain_ts);
        let fired = contract.drain_payouts(bet_id, 10);
        assert!(fired > 0, "drain_payouts fired nothing but pending lines remain");
        drain_ts += 10;
    }
    assert_eq!(contract.get_bet(bet_id).unwrap().status, BetStatus::Settled);

    let new_payouts: Vec<_> = contract.payout_ids_in_order()[before..]
        .iter()
        .map(|id| contract.pending_payouts.get(id).unwrap().clone())
        .collect();

    // I-1: every yocto leaves only to maker, taker, fee_account or keeper.
    let maker: near_sdk::AccountId = MAKER.parse().unwrap();
    let taker: near_sdk::AccountId = TAKER.parse().unwrap();
    let fee_account: near_sdk::AccountId = FEE.parse().unwrap();
    let keeper: near_sdk::AccountId = KEEPER.parse().unwrap();
    for p in &new_payouts {
        assert!(
            [&maker, &taker, &fee_account, &keeper].contains(&&p.receiver),
            "I-1 violated: payout to unexpected receiver {}",
            p.receiver
        );
    }

    // Conservation: total paid out at finalize == total deposited for
    // this bet (2 maker/taker deposits of 1_010_000 each + round-1 bond
    // 5_050_000 + round-2 bond DOUBLED 10_050_000 -- D-DISPUTE1:
    // default max_rounds is 2, not 3, and round 2's bond is 2x round
    // 1's challenge_min + its own undoubled run_price).
    let total_in: u128 = maker_required(&env) + taker_required(&env) + 5_050_000 + 10_050_000;
    let total_out: u128 = new_payouts.iter().map(|p| p.amount.0).sum();
    assert_eq!(total_in, 17_120_000, "sanity on the hand-derived total");
    assert_eq!(total_out, total_in, "finalize must conserve exactly (I-2)");

    // Spot-check the D-AUDIT8/D-DISPUTE1 mechanics: each won round's
    // run_price is paid from ITS OWN bond to the keeper (never the
    // reserve, which no longer exists under D-ECON5), and the bond's
    // remainder returns to the challenger.
    let bond_cost_lines: u128 = new_payouts.iter().filter(|p| p.reason == "bond_round_cost_to_keeper").map(|p| p.amount.0).sum();
    assert_eq!(bond_cost_lines, 100_000, "2 won rounds x run_price(50_000), all bond-funded");
    let bond_remainders: u128 = new_payouts.iter().filter(|p| p.reason == "bond_returned_won_minus_run_cost").map(|p| p.amount.0).sum();
    assert_eq!(bond_remainders, 15_000_000, "(5_050_000-50_000) + (10_050_000-50_000) returned to the challenger");
    // D-ECON5: with no per-bet reserve left at all, and `from_stake`
    // gated on `is_void` (this final is NO, not VOID), both won-round
    // claims are entirely unrecovered.
    let reimbursed: u128 = new_payouts.iter().filter(|p| p.reason == "won_round_reimbursement").map(|p| p.amount.0).sum();
    assert_eq!(
        reimbursed, 0,
        "D-ECON5: outside VOID a won-round claim must be entirely unrecovered now that \
         there is no reserve to draw from"
    );
    assert!(
        new_payouts.iter().all(|p| p.reason != "reserve_leftover_maker"),
        "no per-bet reserve exists any more, so this reason must never appear"
    );
}
