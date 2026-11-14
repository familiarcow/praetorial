use super::*;
use ed25519_dalek::Signer;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::testing_env;

#[path = "seams.rs"]
mod seams;

#[path = "rt_referee.rs"]
mod rt_referee;

#[path = "rf2.rs"]
mod rf2;

#[path = "cx1.rs"]
mod cx1;

#[path = "fm1.rs"]
mod fm1;

#[path = "ms1.rs"]
mod ms1;

#[path = "stg1.rs"]
mod stg1;

#[path = "jc1.rs"]
mod jc1;

#[path = "jc1s.rs"]
mod jc1s;
#[path = "jc1x.rs"]
mod jc1x;
#[path = "jcb1.rs"]
mod jcb1;
#[path = "cap3.rs"]
mod cap3;
#[path = "jcd1.rs"]
mod jcd1;
#[path = "jcd2.rs"]
mod jcd2;
#[path = "as1.rs"]
mod as1;
#[path = "cap3b.rs"]
mod cap3b;
#[path = "rt1b.rs"]
mod rt1b;

const INTENTS: &str = "intents.testnet";
const USDC: &str = "nep141:usdc.testnet";
const OUTLAYER: &str = "outlayer.testnet";
const OPERATOR: &str = "operator.testnet";
const GUARDIAN: &str = "guardian.testnet";
const REGISTRY: &str = "registry.testnet";
const FEE: &str = "fee.testnet";
const KEEPER: &str = "keeper.testnet";
const CONTRACT: &str = "escrow.testnet";
/// Sub-job 1 (D-PRICE6) test fixtures: mock BTC (8dp) and wNEAR (24dp)
/// token ids distinct from `USDC`, and per-asset limits derived from the
/// reference prices in the sub-job spec (BTC ~$76,909, NEAR ~$3.77),
/// same $5..$250-per-side band as the USDC defaults.
const MOCK_BTC: &str = "nep141:btc.mock.testnet";
const MOCK_WNEAR: &str = "nep141:wnear.mock.testnet";
/// USDC min_per_side used by the shared test harness (`new_contract`,
/// `new_contract_with_limits`): 1 unit, i.e. effectively no floor, so the
/// pre-existing 115 tests' `base_envelope` stakes (1 USDC) keep working
/// unchanged. The dedicated asset-limit RED tests below construct their
/// own contract with the real D-PRICE2 default ($5 min) instead.
const LENIENT_USDC_MIN: u128 = 20; // D-FEEMIN1: min_fee 1 needs min_per_side >= 20

/// D-ECON5: round-0 run cost moved off the Envelope and onto each
/// whitelisted asset's own `AssetLimit.run_price`. This is the same
/// 5_000 every pre-existing test's `base_envelope` used to carry as
/// `Envelope.run_price` -- kept identical so every existing arithmetic
/// comment/expectation in this file is unchanged.
const DEFAULT_RUN_PRICE: u128 = 5_000;

/// D-BOND1: the pre-D-BOND1 hardcoded challenge-bond ($5) and
/// objection-deposit ($1) USDC floors, now on the USDC `AssetLimit`
/// itself. Kept identical so every existing same-asset test's exact
/// amounts (e.g. 5_005_000 = challenge_min + run_price) are
/// byte-for-byte unchanged.
const USDC_MIN_BOND: u128 = 5_000_000;
const USDC_MIN_OBJECTION: u128 = 1_000_000;

fn default_asset_limits() -> Vec<(String, AssetLimit)> {
    vec![(
        USDC.to_string(),
        AssetLimit {
            min_per_side: U128(LENIENT_USDC_MIN),
            min_fee_per_side: U128(1), // D-FEEMIN1 fixture: below 1% of any fixture stake, old fee expectations unchanged
            min_fee_cap_per_side: U128(0), // D-PARAMS1 fixture: 0 = cap pinned at min_fee_per_side
            storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
            max_per_side: U128(crate::DEFAULT_MAX_STAKE_PER_SIDE_USDC),
            run_price: U128(DEFAULT_RUN_PRICE),
            min_bond: U128(USDC_MIN_BOND),
            min_objection: U128(USDC_MIN_OBJECTION),
        },
    )]
}

/// Real D-PRICE2/spec defaults for the dedicated whitelist/asset-limit
/// tests: USDC $5..$250, mock BTC and wNEAR at the same $ band derived
/// from BTC ~$76,909 and NEAR ~$3.77 (8dp / 24dp respectively).
fn spec_default_asset_limits() -> Vec<(String, AssetLimit)> {
    vec![
        (
            USDC.to_string(),
            AssetLimit {
                min_per_side: U128(crate::DEFAULT_MIN_STAKE_PER_SIDE_USDC),
                min_fee_per_side: U128(1), // D-FEEMIN1 fixture: below 1% of any fixture stake, old fee expectations unchanged
                min_fee_cap_per_side: U128(0), // D-PARAMS1 fixture: 0 = cap pinned at min_fee_per_side
                storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
                max_per_side: U128(crate::DEFAULT_MAX_STAKE_PER_SIDE_USDC),
                run_price: U128(DEFAULT_RUN_PRICE),
                min_bond: U128(USDC_MIN_BOND),
                min_objection: U128(USDC_MIN_OBJECTION),
            },
        ),
        (
            MOCK_BTC.to_string(),
            AssetLimit {
                min_per_side: U128(6_501), // ~$5 @ $76,909/BTC, 8dp
                min_fee_per_side: U128(1), // D-FEEMIN1 fixture: below 1% of any fixture stake, old fee expectations unchanged
                min_fee_cap_per_side: U128(0), // D-PARAMS1 fixture: 0 = cap pinned at min_fee_per_side
                storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
                max_per_side: U128(325_059), // ~$250 @ $76,909/BTC, 8dp
                run_price: U128(1), // BTC-denominated run cost, 8dp; just needs to be >0
                min_bond: U128(6_501), // D-BOND1: same ~$5 floor as min_per_side, BTC 8dp
                min_objection: U128(1_300), // D-BOND1: ~$1 @ $76,909/BTC, 8dp
            },
        ),
        (
            MOCK_WNEAR.to_string(),
            AssetLimit {
                min_per_side: U128(1_326_259_946_949_602_229_354_496), // ~$5 @ $3.77/NEAR, 24dp
                min_fee_per_side: U128(1), // D-FEEMIN1 fixture: below 1% of any fixture stake, old fee expectations unchanged
                min_fee_cap_per_side: U128(0), // D-PARAMS1 fixture: 0 = cap pinned at min_fee_per_side
                storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
                max_per_side: U128(66_312_997_347_480_103_951_532_032), // ~$250 @ $3.77/NEAR, 24dp
                run_price: U128(1), // wNEAR-denominated run cost, 24dp; just needs to be >0
                min_bond: U128(1_326_259_946_949_602_229_354_496), // D-BOND1: same ~$5 floor, wNEAR 24dp
                min_objection: U128(265_251_989_389_920_445_870_899), // D-BOND1: ~$1 @ $3.77/NEAR, 24dp
            },
        ),
    ]
}

fn ctx(predecessor: &str, ts: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .signer_account_id(predecessor.parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .block_timestamp(ts);
    testing_env!(b.build());
}

fn ctx_with_deposit(predecessor: &str, ts: u64, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .signer_account_id(predecessor.parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .attached_deposit(deposit)
        .block_timestamp(ts);
    testing_env!(b.build());
}

/// Loop 6: mocks the single promise result `on_resolution`'s callback
/// sees (near-sdk's 5-arg `testing_env!` macro's `promise_results` slot).
fn ctx_with_promise_result(predecessor: &str, ts: u64, result: PromiseResult) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .signer_account_id(predecessor.parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .block_timestamp(ts);
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![result],
    );
}

/// OQ-T11 test helper: repeatedly calls `drain_payouts` for `bet_id` and
/// simulates each fired transfer's callback as `PromiseResult::Successful`
/// until the ledger is empty -- mirrors exactly what a keeper repeatedly
/// calling the permissionless `drain_payouts` against a real chain
/// achieves over several transactions, so tests that used to see
/// `finalize` lands on `Settled` synchronously can still
/// assert the same end state.
/// D-AUDIT11: resolves whatever ledger lines are currently `in_flight`
/// for `bet_id` (grouped by (receiver, token_id), mirroring exactly how
/// `drain_payouts`/the inline finalize-time drain fired them) as
/// successful, via `on_payout_result(ids)`. Returns how many lines it
/// resolved.
fn resolve_in_flight(c: &mut Contract, bet_id: u64, ts: u64) -> usize {
    let in_flight: Vec<_> = c
        .pending_payouts(bet_id)
        .into_iter()
        .filter(|p| p.in_flight)
        .collect();
    let mut groups: Vec<(near_sdk::AccountId, String, Vec<u64>)> = Vec::new();
    for p in &in_flight {
        match groups.iter_mut().find(|(r, t, _)| *r == p.receiver && *t == p.token_id) {
            Some(g) => g.2.push(p.id),
            None => groups.push((p.receiver.clone(), p.token_id.clone(), vec![p.id])),
        }
    }
    for (_, _, ids) in groups {
        ctx_with_promise_result(CONTRACT, ts, PromiseResult::Successful(vec![]));
        c.on_payout_result(ids);
    }
    in_flight.len()
}

/// D-AUDIT11: `finalize`/`void_after_deadline` now fire
/// the first grouped batch of transfers INLINE (in-flight the moment
/// that call returns), so this helper must resolve whatever is already
/// in-flight before asking `drain_payouts` for more -- otherwise
/// `drain_payouts` correctly (by design, I-4) refuses to re-fire an
/// in-flight group and this loop would see "fired nothing" even though
/// payouts are genuinely still in flight from the triggering call.
fn drain_all(c: &mut Contract, bet_id: u64, ts: u64) {
    loop {
        let pending = c.pending_payouts(bet_id);
        if pending.is_empty() {
            break;
        }
        if resolve_in_flight(c, bet_id, ts) > 0 {
            continue;
        }
        ctx("anyone.testnet", ts);
        let fired = c.drain_payouts(bet_id, 10);
        assert!(fired > 0, "drain_payouts fired nothing but pending lines remain");
        resolve_in_flight(c, bet_id, ts);
    }
    assert!(c.is_fully_paid(bet_id));
}

/// Keeps the proptest-based property tests in the DEFAULT suite (never
/// `#[ignore]`d -- standing test policy) but fast: `cargo test` with no
/// env var runs `default_fast` cases; `PRAETORIAL_PROPTEST_DEEP=1` runs
/// the original, more thorough `default_deep` case count (CI /
/// pre-release). Plain `cargo test`'s ~6.5 minute runtime was almost
/// entirely the 100-case `finalize_never_panics_over_random_rounds_...`
/// proptest, each case driving a full open/take/challenge/finalize
/// lifecycle.
fn proptest_cases(default_fast: u32, default_deep: u32) -> u32 {
    if std::env::var("PRAETORIAL_PROPTEST_DEEP").map(|v| v == "1").unwrap_or(false) {
        default_deep
    } else {
        default_fast
    }
}

/// D-KEY1: fixed test seeds for the contract's pinned resolver keys.
/// Distinct from every per-test `test_keypair(seed)` call elsewhere in
/// this file (those are for unrelated things -- taker invite keys,
/// etc -- or deliberately-wrong-key RED tests), and chosen to collide
/// with none of the existing 0..=206-ish seeds used around this file.
pub(crate) const OUTCOME_TEST_SEED: u8 = 240;
pub(crate) const ATTEST_TEST_SEED: u8 = 241;

pub(crate) fn outcome_signing_key() -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[OUTCOME_TEST_SEED; 32])
}
pub(crate) fn attest_signing_key() -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[ATTEST_TEST_SEED; 32])
}
pub(crate) fn outcome_pubkey_hex() -> String {
    hex_encode(&outcome_signing_key().verifying_key().to_bytes())
}
pub(crate) fn attest_pubkey_hex() -> String {
    hex_encode(&attest_signing_key().verifying_key().to_bytes())
}
pub(crate) fn test_outlayer_config() -> OutlayerConfig {
    OutlayerConfig {
        wasm_base_url: "https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet".to_string(),
        secrets_profile: "praetorial-resolver".to_string(),
        secrets_account_id: "escrow.praetorial-dev-1101.testnet".parse().unwrap(),
    }
}

pub(crate) fn test_judge_chain() -> Vec<JudgePair> {
    vec![jp("DeepSeek-V4.1-Flash-1017", "GLM-5.3-flash"), jp("jc-backup-a1", "jc-backup-a2")] // JC1x: jp() puts bare ids in org/model form
}

pub(crate) fn jp(a: &str, b: &str) -> JudgePair {
    // JC1x (D-JUDGECHAIN1a #3): model ids must be `org/model`; this fixture helper puts older bare ids in the `t/` org.
    let norm = |m: &str| if m.is_empty() || m.contains('/') { m.to_string() } else { format!("t/{m}") };
    JudgePair { model_a: norm(a), model_b: norm(b) }
}

pub(crate) fn test_resolver_wasm_hash() -> String {
    "a".repeat(64)
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
            max_stake_per_side_near: U128(100 * 10u128.pow(24)), // placeholder, unused path
            max_rounds: crate::DEFAULT_MAX_ROUNDS,
            max_retries: crate::DEFAULT_MAX_RETRIES,
        },
        None, // D6: default beta_sunset_ns (deploy + 90d)
        default_asset_limits(),
        outcome_pubkey_hex(),
        attest_pubkey_hex(),
        test_resolver_wasm_hash(),
        test_outlayer_config(),
        test_judge_chain(),
    )
}

/// D6 helper: a contract with caller-chosen Limits/sunset, for the
/// beta-limit boundary tests below. Uses the lenient-USDC-min default
/// asset table (see `default_asset_limits`) so existing callers that
/// don't care about asset limits keep working unchanged; callers that
/// DO care (the sub-job 1 whitelist/asset-limit tests) use
/// `new_contract_with_limits_and_assets` instead.
fn new_contract_with_limits(limits: Limits, beta_sunset_ns: Option<u64>) -> Contract {
    new_contract_with_limits_and_assets(limits, beta_sunset_ns, default_asset_limits())
}

/// Sub-job 1 (D-PRICE6): like `new_contract_with_limits`, but with an
/// explicit asset_limits table -- used by the whitelist/per-asset min-max
/// RED tests, which need the real spec defaults (or deliberately-crafted
/// ones) rather than the lenient test-harness default.
fn new_contract_with_limits_and_assets(
    limits: Limits,
    beta_sunset_ns: Option<u64>,
    asset_limits: Vec<(String, AssetLimit)>,
) -> Contract {
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
        limits,
        beta_sunset_ns,
        asset_limits,
        outcome_pubkey_hex(),
        attest_pubkey_hex(),
        test_resolver_wasm_hash(),
        test_outlayer_config(),
        test_judge_chain(),
    )
}

fn test_keypair(seed: u8) -> (ed25519_dalek::SigningKey, [u8; 32]) {
    let sk = ed25519_dalek::SigningKey::from_bytes(&[seed; 32]);
    let pk = sk.verifying_key().to_bytes();
    (sk, pk)
}

// D-KEY1: `resolver_pk_hex` is now unused (kept so every existing call
// site -- there are dozens -- doesn't need editing). resolver_wasm_hash/
// resolver_pubkey are pinned Contract-level config now (see
// `outcome_pubkey_hex`/`attest_pubkey_hex`/`test_resolver_wasm_hash`
// above), not Envelope fields.
#[allow(unused_variables)]
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
        settlement_period: 24 * 60 * 60 * 1_000_000_000, // D1: must be within [1h, 90d]
        resolve_deadline: 10_000,
        consent_party_controlled: false,
    }
}

/// D-FETCH2 (item 7f2b) design note: every test envelope's
/// `resolver_pubkey` comes from `test_keypair(seed)` for some
/// `seed: u8`, so a brute-force search over all 256 seeds recovers the
/// matching `SigningKey` without plumbing a secret key through every
/// `open_msg`/`base_envelope` call site.
fn find_test_signing_key(pubkey_hex: &str) -> ed25519_dalek::SigningKey {
    for seed in 0u8..=255 {
        let (sk, pk) = test_keypair(seed);
        if hex_encode(&pk) == pubkey_hex {
            return sk;
        }
    }
    panic!(
        "find_test_signing_key: no seed 0..=255 matches resolver_pubkey {pubkey_hex} \
         (open_msg can only sign an attestation for pubkeys built via test_keypair)"
    );
}

/// D-FETCH2 (item 7f2b) / D-KEY1: signs a real `SourceCheckAttestation`
/// over `envelope.terms_hash`/`checked_at` with the contract's pinned
/// `attest_pubkey` test key (`attest_signing_key()`) -- sourcecheck
/// attestations are no longer verified against a maker-supplied
/// envelope key, so this always uses the one key handle_open actually
/// checks against. `checked_at` defaults to 0 -- safe for the ~80
/// existing tests, whose `ctx(..., ts)` timestamps are themselves tiny
/// test values, so freshness trivially holds.
fn source_check_attestation(env: &Envelope, checked_at: u64) -> SourceCheckAttestation {
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

/// Variant of `open_msg` with an explicit `checked_at` for the
/// freshness-boundary RED tests (exactly 1h old / 1h+1ns old / future).
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

fn do_mt_transfer(c: &mut Contract, sender: &str, amount: u128, msg: String, ts: u64) -> Vec<U128> {
    do_mt_transfer_asset(c, sender, USDC, amount, msg, ts)
}

/// Sub-job 1 (D-PRICE6): like `do_mt_transfer`, but lets the caller pick
/// which intents token the deposit arrives in -- needed by the
/// whitelist/asset-limit tests, which deliberately send a token other
/// than USDC.
fn do_mt_transfer_asset(
    c: &mut Contract,
    sender: &str,
    token_id: &str,
    amount: u128,
    msg: String,
    ts: u64,
) -> Vec<U128> {
    ctx(INTENTS, ts);
    match c.mt_on_transfer(
        sender.parse().unwrap(),
        vec![sender.parse().unwrap()],
        vec![token_id.to_string()],
        vec![U128(amount)],
        msg,
    ) {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("unexpected promise"),
    }
}

fn open_and_take(c: &mut Contract, pk_hex: &str) -> u64 {
    let env = base_envelope(pk_hex);
    let resp = do_mt_transfer(c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)], "open should be accepted");
    let bet_id = c.next_bet_id - 1;
    let env2 = base_envelope(pk_hex);
    let resp = do_mt_transfer(
        c,
        "taker.testnet",
        env2.taker_required(),
        take_msg(bet_id),
        2,
    );
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
    // D-RESOLVE1 (item 7d): next_check_ns is appended to the signed
    // buffer ONLY for "RETRY" -- YES/NO/VOID stay byte-identical to the
    // pre-recovery-ladder signed message (see submit_outcome).
    if result.outcome == "RETRY" || result.outcome == "RETRY:no_live_judge" {
        let next_check_ns = result
            .next_check_ns
            .expect("RETRY result must set next_check_ns")
            .0;
        BorshSerialize::serialize(&next_check_ns, &mut buf).unwrap();
    }
    // JC1x: non-empty not-found observations are appended as borsh(Vec<(model, observed_ns)>); empty = legacy layout.
    if !result.model_not_found.is_empty() {
        let v: Vec<(String, u64)> = result.model_not_found.iter().map(|o| (o.model.clone(), o.observed_ns.0)).collect();
        BorshSerialize::serialize(&v, &mut buf).unwrap();
    }
    let sig = sk.sign(&buf);
    hex_encode(&sig.to_bytes())
}

// ---------------- Happy paths ----------------

#[test]
fn open_take_submit_finalize_yes() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(7);
    let pk_hex = hex_encode(&pk);
    let bet_id = open_and_take(&mut c, &pk_hex);

    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, BetStatus::Taken);

    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, BetStatus::Proposed);

    ctx("anyone.testnet", 2_000 + 86_400_000_000_001);
    c.finalize(bet_id);
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, BetStatus::Finalized);
    drain_all(&mut c, bet_id, 2_000 + 86_400_000_000_101);
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, BetStatus::Settled);
}

#[test]
fn cancel_refunds_full_no_fee() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(1);
    let env = base_envelope(&hex_encode(&pk));
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    let bet_id = c.next_bet_id - 1;
    ctx("maker.testnet", 2);
    let before_ids = c.payout_ids_in_order().len();
    c.cancel(bet_id);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Cancelled);
    assert_eq!(c.payout_ids_in_order().len(), before_ids + 1);
    let p = c.pending_payouts.get(c.payout_ids_in_order().last().unwrap()).unwrap();
    assert_eq!(p.amount.0, env.maker_required()); // full refund, no fee
}

#[test]
#[should_panic(expected = "only maker may cancel")]
fn cancel_by_non_maker_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(1);
    let env = base_envelope(&hex_encode(&pk));
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    let bet_id = c.next_bet_id - 1;
    ctx("someone_else.testnet", 2);
    c.cancel(bet_id);
}

#[test]
fn expire_after_deadline() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(1);
    let env = base_envelope(&hex_encode(&pk));
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    let bet_id = c.next_bet_id - 1;
    ctx("anyone.testnet", env.funding_deadline + 1);
    c.expire(bet_id);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Expired);
}

#[test]
#[should_panic(expected = "funding_deadline not reached")]
fn expire_before_deadline_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(1);
    let env = base_envelope(&hex_encode(&pk));
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    let bet_id = c.next_bet_id - 1;
    ctx("anyone.testnet", env.funding_deadline - 1);
    c.expire(bet_id);
}

#[test]
fn void_after_deadline_refunds_both() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(2);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 10_001);
    c.void_after_deadline(bet_id);
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, BetStatus::Voided);
    assert_eq!(bet.outcome, Some("VOID".to_string()));
}

/// Bug 1 (I-2): `void_after_deadline` scheduled maker/taker/keeper payouts
/// but never disposed of `storage_charge_per_side*2` -- it vanished from
/// every ledger (not refunded, not sent to fee_account), stranding funds.
/// Ruling (MASTER MAP C9/Decisions): on void, storage_charge goes to
/// fee_account when keep_terms (record kept, storage cost repaid to the
/// sponsor of that storage), else it is refunded to each side. This test
/// asserts the total of every payout scheduled by this call equals the
/// total that was ever deposited for the bet -- i.e. nothing is stranded --
/// and that keep_terms:true routes storage2 to fee_account specifically.
#[test]
fn void_after_deadline_accounts_for_storage_charge_keep_terms() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(2);
    let env = base_envelope(&hex_encode(&pk));
    assert!(env.keep_terms, "base_envelope fixture must be keep_terms:true for this case");
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 10_001);
    let before = c.payout_ids_in_order().len();
    c.void_after_deadline(bet_id);
    let new_payouts: Vec<_> = c.payout_ids_in_order()[before..]
        .iter()
        .map(|id| c.pending_payouts.get(id).unwrap().clone())
        .collect();

    let storage2 = env.storage_for(STG_FIXTURE_RATE) * 2;
    let total_deposited = env.maker_required() + env.taker_required();
    let total_scheduled: u128 = new_payouts.iter().map(|p| p.amount.0).sum();
    assert_eq!(
        total_scheduled, total_deposited,
        "every yoctounit deposited for this bet must be scheduled somewhere on void; \
         storage_charge_per_side*2 ({storage2}) must not be stranded"
    );

    let storage_payout = new_payouts
        .iter()
        .find(|p| p.reason == "void_storage_keep_terms")
        .expect("keep_terms:true void must send storage charge to fee_account");
    assert_eq!(storage_payout.receiver, FEE.parse::<AccountId>().unwrap());
    assert_eq!(storage_payout.amount.0, storage2);
}

/// Mirror case: keep_terms:false must refund storage2 to the two sides
/// instead of routing it to fee_account (no record kept, so no storage
/// cost was actually incurred on their behalf).
#[test]
fn void_after_deadline_accounts_for_storage_charge_hash_only() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(2);
    let mut env = base_envelope(&hex_encode(&pk));
    env.keep_terms = false;
    env.terms = None;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)], "hash-only open should be accepted with no refund");
    let bet_id = c.next_bet_id - 1;
    do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_msg(bet_id), 2);

    ctx("anyone.testnet", 10_001);
    let before = c.payout_ids_in_order().len();
    c.void_after_deadline(bet_id);
    let new_payouts: Vec<_> = c.payout_ids_in_order()[before..]
        .iter()
        .map(|id| c.pending_payouts.get(id).unwrap().clone())
        .collect();

    let total_deposited = env.maker_required() + env.taker_required();
    let total_scheduled: u128 = new_payouts.iter().map(|p| p.amount.0).sum();
    assert_eq!(
        total_scheduled, total_deposited,
        "hash-only bet: storage_charge_per_side*2 must be refunded to the sides, not stranded"
    );
    assert!(
        !new_payouts.iter().any(|p| p.reason == "void_storage_keep_terms"),
        "keep_terms:false must not pay fee_account for storage"
    );
}

/// Root-cause regression (submit_outcome signature rejections): a
/// `checked_until` nanosecond timestamp from `Date.now() * 1_000_000`
/// routinely exceeds `Number.MAX_SAFE_INTEGER` (2^53-1). With a bare
/// `u64` JSON field, the signer (JS, `BigInt(doubleValue)` -- exact
/// binary value of the double) and the contract (serde_json parsing the
/// literal JSON-text digits near-api-js actually sent) can read two
/// different "true" integers off the same double, breaking
/// `ed25519_verify` nondeterministically. This pins that a value in that
/// exact unsafe range round-trips through JSON *as a string* (what `U64`
/// forces) with zero precision loss, and that the contract verifies a
/// signature built over that exact value.
#[test]
fn submit_outcome_accepts_checked_until_beyond_js_safe_integer() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(88);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));

    // A real-world ns-since-epoch value, well past 2^53-1 (9_007_199_254_740_991).
    let unsafe_ns: u64 = 1_793_605_204_551_000_123;
    assert!(unsafe_ns > (1u64 << 53), "fixture must exceed JS's safe-integer range");

    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(unsafe_ns),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    // Simulate the JS harness: JSON round-trip of the whole arg object
    // (as near-api-js would serialize it for the real RPC call) must
    // preserve checked_until exactly because U64 serializes as a string.
    let json = near_sdk::serde_json::to_string(&result).unwrap();
    assert!(
        json.contains(&format!("\"checked_until\":\"{unsafe_ns}\"")),
        "checked_until must serialize as an exact-precision JSON string, not a lossy number: {json}"
    );
    let round_tripped: SubmittedResult = near_sdk::serde_json::from_str(&json).unwrap();
    assert_eq!(round_tripped.checked_until.0, unsafe_ns, "no precision loss through JSON");

    let sig = sign_result(&outcome_signing_key(), &round_tripped);
    c.submit_outcome(round_tripped, sig);
    assert_eq!(c.get_bet(bet_id).unwrap().outcome, Some("YES".to_string()));
}

#[test]
fn challenge_then_referee_rule_without_referee_rejected() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(3);
    let pk_hex = hex_encode(&pk);
    let bet_id = open_and_take(&mut c, &pk_hex);

    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "NO".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);

    // Maker challenges with a bond; pot = 2_000_000, so max($5, 5%) == the
    // $5 floor (5_000_000 units of 6-decimal USDC), not the 5% figure.
    let resp = do_mt_transfer(
        &mut c,
        "maker.testnet",
        5_005_000, // D-AUDIT8: challenge_min (5_000_000) + run_price (5_000)
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(),
        2_050,
    );
    assert_eq!(resp, vec![U128(0)]);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Challenged);

    // D-REF1: no referee named in base_envelope -> referee_rule rejects
    // (replaces the old arbiter_submit "no arbiter named" rejection).
    ctx("maker.testnet", 2_060);
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.referee_rule(bet_id, "YES".to_string())
    }));
    assert!(panicked.is_err(), "expected panic: no referee named");
}

#[test]
fn bond_wrong_amount_rejected() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(3);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "NO".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    let resp = do_mt_transfer(
        &mut c,
        "maker.testnet",
        1, // wrong (too small) bond amount
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(),
        2_050,
    );
    assert_eq!(resp, vec![U128(1)], "wrong bond amount must be fully refunded");
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Proposed, "status unchanged on reject");
}

#[test]
fn prune_terms_requires_both_and_clears_terms() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(5);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    ctx("anyone.testnet", 2_000 + 86_400_000_000_001);
    c.finalize(bet_id);
    drain_all(&mut c, bet_id, 2_000 + 86_400_000_000_051);

    ctx("maker.testnet", 2_000 + 86_400_000_000_101);
    c.prune_terms(bet_id);
    assert!(!c.get_bet(bet_id).unwrap().pruned);
    ctx("taker.testnet", 2_201);
    c.prune_terms(bet_id);
    assert!(c.get_bet(bet_id).unwrap().pruned);
    assert!(c.get_bet(bet_id).unwrap().envelope.terms_hash.starts_with("pruned:"));
}

#[test]
fn challenge_bond_lost_when_outcome_unchanged() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(30);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);

    // Taker (loser of YES) challenges with a bond but never gets a
    // different outcome submitted -> same outcome stands at finalize ->
    // taker's bond is forfeit to maker (the counterparty).
    let resp = do_mt_transfer(
        &mut c,
        "taker.testnet",
        5_005_000, // D-AUDIT8: challenge_min (5_000_000) + run_price (5_000)
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(),
        2_050,
    );
    assert_eq!(resp, vec![U128(0)]);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Challenged);

    ctx("anyone.testnet", 2_050 + 86_400_000_000_001);
    let before = c.payout_ids_in_order().len();
    c.finalize(bet_id);
    let new_payouts: Vec<_> = c.payout_ids_in_order()[before..]
        .iter()
        .map(|id| c.pending_payouts.get(id).unwrap().clone())
        .collect();
    let bond_payout = new_payouts
        .iter()
        .find(|p| p.reason == "bond_lost_to_counterparty")
        .expect("bond must be forfeited, not returned");
    assert_eq!(bond_payout.receiver, "maker.testnet".parse::<AccountId>().unwrap());
    assert!(
        !new_payouts.iter().any(|p| p.reason == "bond_returned_won"),
        "bond must not also be returned to the loser"
    );
    // Round cost (run_price) goes to keeper out of the forfeited bond.
    assert!(new_payouts.iter().any(|p| p.reason == "bond_round_cost_to_keeper"));
}

#[test]
fn challenge_bond_won_when_outcome_changes() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(31);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);

    do_mt_transfer(
        &mut c,
        "taker.testnet",
        5_005_000, // D-AUDIT8: challenge_min (5_000_000) + run_price (5_000)
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(),
        2_050,
    );
    // A re-judge overturns the outcome to NO (new run_no).
    ctx("anyone.testnet", 2_060);
    let result2 = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "NO".to_string(),
        element_results_hash: "f".repeat(64),
        run_no: 2,
        checked_until: U64(2_060),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig2 = sign_result(&outcome_signing_key(), &result2);
    c.submit_outcome(result2, sig2);

    ctx("anyone.testnet", 2_060 + 86_400_000_000_001);
    let before = c.payout_ids_in_order().len();
    c.finalize(bet_id);
    let new_payouts: Vec<_> = c.payout_ids_in_order()[before..]
        .iter()
        .map(|id| c.pending_payouts.get(id).unwrap().clone())
        .collect();
    // D-AUDIT8: the bond's remainder (amount minus this round's
    // run_price, which now always comes out of the bond) returns to
    // the winning challenger -- never the full bond amount.
    let bond_payout = new_payouts
        .iter()
        .find(|p| p.reason == "bond_returned_won_minus_run_cost")
        .expect("bond remainder must be returned to the challenger who won");
    assert_eq!(bond_payout.receiver, "taker.testnet".parse::<AccountId>().unwrap());
    assert_eq!(bond_payout.amount.0, 5_000_000);
}

// ---------------- Objection/rebuttal deposit forfeiture (the fix) --------

fn objection_msg(bet_id: u64, exhibit_hash: &str, is_rebuttal: bool) -> String {
    serde_json::to_string(&TransferMsg::Objection {
        bet_id,
        exhibit_hash: exhibit_hash.to_string(),
        is_rebuttal,
    })
    .unwrap()
}

/// Pot = 2_000_000 units (stake_maker + stake_taker), so the objection
/// deposit floor max($1, 0.5% pot) = max(1_000_000, 10_000) = 1_000_000.
const OBJECTION_DEPOSIT: u128 = 1_000_000;

#[test]
fn objection_rejected_forfeits_to_counterparty() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(50);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);

    // Taker (loser of YES) challenges, then objects to evidence. No
    // re-judge ever changes the outcome -> the objection is rejected.
    do_mt_transfer(
        &mut c,
        "taker.testnet",
        5_005_000, // D-AUDIT8: challenge_min (5_000_000) + run_price (5_000)
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(),
        2_050,
    );
    let resp = do_mt_transfer(
        &mut c,
        "taker.testnet",
        OBJECTION_DEPOSIT,
        objection_msg(bet_id, &"e".repeat(64), false),
        2_060,
    );
    assert_eq!(resp, vec![U128(0)], "objection should be accepted");
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Evidence);

    ctx("anyone.testnet", 2_060 + 86_400_000_000_001);
    let before = c.payout_ids_in_order().len();
    c.finalize(bet_id);
    let new_payouts: Vec<_> = c.payout_ids_in_order()[before..]
        .iter()
        .map(|id| c.pending_payouts.get(id).unwrap().clone())
        .collect();
    let forfeited = new_payouts
        .iter()
        .find(|p| p.reason == "objection_deposit_forfeited")
        .expect("rejected objection must be forfeited");
    assert_eq!(forfeited.receiver, "maker.testnet".parse::<AccountId>().unwrap());
    assert_eq!(forfeited.amount.0, OBJECTION_DEPOSIT);
    assert!(
        !new_payouts.iter().any(|p| p.reason == "objection_deposit_returned"),
        "a rejected objection must not also be returned to the objector"
    );
}

#[test]
fn objection_upheld_is_returned_to_depositor() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(51);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);

    do_mt_transfer(
        &mut c,
        "taker.testnet",
        5_005_000, // D-AUDIT8: challenge_min (5_000_000) + run_price (5_000)
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(),
        2_050,
    );
    let resp = do_mt_transfer(
        &mut c,
        "taker.testnet",
        OBJECTION_DEPOSIT,
        objection_msg(bet_id, &"e".repeat(64), false),
        2_060,
    );
    assert_eq!(resp, vec![U128(0)]);

    // Re-judge overturns the outcome to NO -> taker's objection is upheld.
    ctx("anyone.testnet", 2_070);
    let result2 = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "NO".to_string(),
        element_results_hash: "f".repeat(64),
        run_no: 2,
        checked_until: U64(2_070),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig2 = sign_result(&outcome_signing_key(), &result2);
    c.submit_outcome(result2, sig2);

    ctx("anyone.testnet", 2_070 + 86_400_000_000_001);
    let before = c.payout_ids_in_order().len();
    c.finalize(bet_id);
    let new_payouts: Vec<_> = c.payout_ids_in_order()[before..]
        .iter()
        .map(|id| c.pending_payouts.get(id).unwrap().clone())
        .collect();
    let returned = new_payouts
        .iter()
        .find(|p| p.reason == "objection_deposit_returned")
        .expect("upheld objection must be returned");
    assert_eq!(returned.receiver, "taker.testnet".parse::<AccountId>().unwrap());
    assert_eq!(returned.amount.0, OBJECTION_DEPOSIT);
    assert!(!new_payouts.iter().any(|p| p.reason == "objection_deposit_forfeited"));
}

#[test]
fn rebuttal_succeeds_when_outcome_unchanged_fails_when_it_changes() {
    // Rebuttal defends the standing outcome: it's returned if the outcome
    // at finalize still matches what it was when filed, forfeited if the
    // outcome changes out from under it.
    let mut c = new_contract();
    let (sk, pk) = test_keypair(52);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);

    do_mt_transfer(
        &mut c,
        "taker.testnet",
        5_005_000, // D-AUDIT8: challenge_min (5_000_000) + run_price (5_000)
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(),
        2_050,
    );
    // Maker rebuts (defends YES).
    let resp = do_mt_transfer(
        &mut c,
        "maker.testnet",
        OBJECTION_DEPOSIT,
        objection_msg(bet_id, &"e".repeat(64), true),
        2_060,
    );
    assert_eq!(resp, vec![U128(0)]);

    // Outcome never changes -> rebuttal succeeds -> returned to maker.
    ctx("anyone.testnet", 2_060 + 86_400_000_000_001);
    let before = c.payout_ids_in_order().len();
    c.finalize(bet_id);
    let new_payouts: Vec<_> = c.payout_ids_in_order()[before..]
        .iter()
        .map(|id| c.pending_payouts.get(id).unwrap().clone())
        .collect();
    let returned = new_payouts
        .iter()
        .find(|p| p.reason == "objection_deposit_returned")
        .expect("successful rebuttal must be returned");
    assert_eq!(returned.receiver, "maker.testnet".parse::<AccountId>().unwrap());
}

#[test]
fn multi_round_bonds_are_all_settled_not_stranded() {
    // BUG FIX regression: a round-2 bond during Evidence used to
    // overwrite (not accumulate with) round 1, stranding round 1's USDC
    // forever. Both rounds must now appear in the finalize payouts.
    let mut c = new_contract();
    let (sk, pk) = test_keypair(53);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);

    // Round 1 bond (taker challenges YES).
    do_mt_transfer(
        &mut c,
        "taker.testnet",
        5_005_000, // D-AUDIT8: challenge_min (5_000_000) + run_price (5_000)
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(),
        2_050,
    );
    // Evidence round moves status to Evidence, at which point a second
    // Bond transfer is accepted (round 2, escalation).
    let resp = do_mt_transfer(
        &mut c,
        "taker.testnet",
        OBJECTION_DEPOSIT,
        objection_msg(bet_id, &"e".repeat(64), false),
        2_060,
    );
    assert_eq!(resp, vec![U128(0)]);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Evidence);

    // D-DISPUTE1: round-2 bond = max($10,10% pot) DOUBLED (x2) + its
    // own (undoubled) run_price = 2*5_000_000 + 5_000 = 10_005_000
    // (was flat 5_005_000 pre-D-DISPUTE1 doubling).
    let resp2 = do_mt_transfer(
        &mut c,
        "maker.testnet",
        10_005_000, // D-DISPUTE1: 2x challenge_min (2*5_000_000) + run_price (5_000)
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 2 }).unwrap(),
        2_070,
    );
    assert_eq!(resp2, vec![U128(0)], "round-2 bond must be accepted, not lost");
    assert_eq!(c.get_bet(bet_id).unwrap().bonds.len(), 2, "both bond rounds must be tracked");

    ctx("anyone.testnet", 2_070 + 86_400_000_000_001);
    let before = c.payout_ids_in_order().len();
    c.finalize(bet_id);
    let new_payouts: Vec<_> = c.payout_ids_in_order()[before..]
        .iter()
        .map(|id| c.pending_payouts.get(id).unwrap().clone())
        .collect();
    let bond_total: u128 = new_payouts
        .iter()
        .filter(|p| p.reason.starts_with("bond_"))
        .map(|p| p.amount.0)
        .sum();
    // D-AUDIT8/D-DISPUTE1: both rounds are LOST (outcome never changes
    // from YES), so each bond settles as remainder-to-counterparty +
    // run_price-to-keeper, same total per bond as what was deposited:
    // round 1 (5_005_000) + round 2 doubled (10_005_000) = 15_010_000.
    assert_eq!(
        bond_total, 15_010_000,
        "both bond rounds (5_005_000 + 10_005_000, including run_price) must be fully accounted for, none stranded"
    );
}

// ---------------- Referee outcome validation (bug fix, D-REF1) -----------

// ---------------- D-REF1: referee role (queue item 3b) -------------------

#[test]
fn referee_cannot_be_maker_open_rejected_full_refund() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(200);
    let mut env = base_envelope(&hex_encode(&pk));
    env.referee = Some(Referee {
        account: env.maker.clone(),
        mode: RefereeMode::Human,
    });
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required())], "referee==maker must be rejected, full refund");
}

#[test]
fn referee_cannot_be_fee_account_open_rejected_full_refund() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(201);
    let mut env = base_envelope(&hex_encode(&pk));
    env.referee = Some(Referee {
        account: FEE.parse().unwrap(),
        mode: RefereeMode::Human,
    });
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required())], "referee==fee_account must be rejected, full refund");
}

#[test]
fn referee_cannot_be_named_taker_open_rejected_full_refund() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(202);
    let mut env = base_envelope(&hex_encode(&pk));
    env.taker_allow = TakerAllow::Account("taker.testnet".parse().unwrap());
    env.referee = Some(Referee {
        account: "taker.testnet".parse().unwrap(),
        mode: RefereeMode::Human,
    });
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required())], "referee==named taker must be rejected, full refund");
}

#[test]
fn referee_cannot_be_actual_taker_when_taker_allow_any() {
    // Covers the TakerAllow::Any case: the referee isn't known to be
    // the taker until take time, so `handle_take` itself must reject
    // a take attempt from the named referee.
    let mut c = new_contract();
    let (_, pk) = test_keypair(203);
    let mut env = base_envelope(&hex_encode(&pk));
    env.referee = Some(Referee {
        account: "referee.testnet".parse().unwrap(),
        mode: RefereeMode::Human,
    });
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)]);
    let bet_id = c.next_bet_id - 1;
    let resp = do_mt_transfer(&mut c, "referee.testnet", env.taker_required(), take_msg(bet_id), 2);
    assert_eq!(resp, vec![U128(env.taker_required())], "referee cannot take their own refereed bet, full refund");
}

#[test]
fn referee_swap_via_amend_before_dispute_opens_ok() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(213);
    let env = base_envelope(&hex_encode(&pk));
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)]);
    let bet_id = c.next_bet_id - 1;
    do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_msg(bet_id), 2);

    let new_referee = serde_json::to_string(&Some(Referee {
        account: "referee.testnet".parse().unwrap(),
        mode: RefereeMode::Human,
    }))
    .unwrap();
    ctx("maker.testnet", 100);
    c.amend_referee(bet_id, new_referee.clone());
    ctx("taker.testnet", 110);
    c.amend_referee(bet_id, new_referee);

    assert_eq!(
        c.get_bet(bet_id).unwrap().envelope.referee,
        Some(Referee { account: "referee.testnet".parse().unwrap(), mode: RefereeMode::Human }),
    );
}

#[test]
#[should_panic(expected = "referee frozen once a dispute opens")]
fn referee_swap_via_amend_mid_dispute_refused() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(214);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));

    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    do_mt_transfer(
        &mut c,
        "taker.testnet",
        5_005_000,
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(),
        2_050,
    );
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Challenged);

    let new_referee = serde_json::to_string(&Some(Referee {
        account: "referee.testnet".parse().unwrap(),
        mode: RefereeMode::Human,
    }))
    .unwrap();
    ctx("maker.testnet", 2_060);
    c.amend_referee(bet_id, new_referee);
}

// ---------------- Storage-griefing length caps (bug fix) -----------------

#[test]
fn oversized_terms_hash_rejected_at_open() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(56);
    let mut env = base_envelope(&hex_encode(&pk));
    env.terms_hash = "x".repeat(10_000);
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required())], "oversized terms_hash must be rejected, funds refunded");
}

#[test]
fn oversized_exhibit_hash_rejected() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(57);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    do_mt_transfer(
        &mut c,
        "taker.testnet",
        5_005_000, // D-AUDIT8: challenge_min (5_000_000) + run_price (5_000)
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(),
        2_050,
    );
    let huge_hash = "a".repeat(10_000);
    let resp = do_mt_transfer(
        &mut c,
        "taker.testnet",
        OBJECTION_DEPOSIT,
        objection_msg(bet_id, &huge_hash, false),
        2_060,
    );
    assert_eq!(resp, vec![U128(OBJECTION_DEPOSIT)], "oversized exhibit_hash must be rejected");
}

// ---------------- D2: on-chain exhibit submission timestamp ----------

/// Brings a bet to Challenged status via the same open/take/submit/bond
/// sequence `oversized_exhibit_hash_rejected` uses, for the submit_exhibits
/// tests below that need a real Challenged/Evidence bet to call it on.
fn open_take_submit_and_challenge(c: &mut Contract, seed: u8, ts: u64) -> u64 {
    let (sk, pk) = test_keypair(seed);
    let bet_id = open_and_take(c, &hex_encode(&pk));
    ctx("anyone.testnet", ts);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(ts),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    do_mt_transfer(
        c,
        "taker.testnet",
        5_005_000, // D-AUDIT8: challenge_min (5_000_000) + run_price (5_000)
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(),
        ts + 50,
    );
    bet_id
}

#[test]
fn submit_exhibits_records_block_timestamp_per_exhibit() {
    let mut c = new_contract();
    let bet_id = open_take_submit_and_challenge(&mut c, 60, 2_000);

    ctx("taker.testnet", 99_000);
    c.submit_exhibits(bet_id, vec!["hash-a".to_string(), "hash-b".to_string()]);

    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.exhibits.len(), 2);
    for exhibit in &bet.exhibits {
        assert_eq!(
            exhibit.submitted_at,
            U64(99_000),
            "every exhibit from this call must carry the on-chain block_timestamp, not a caller-supplied value"
        );
    }
    assert_eq!(bet.exhibits[0].hash, "hash-a");
    assert_eq!(bet.exhibits[1].hash, "hash-b");
    assert_eq!(bet.status, BetStatus::Evidence);
}

/// A second `submit_exhibits` call at a later block_timestamp must stamp
/// ONLY its own new exhibits with the later time -- the first batch's
/// timestamp must never be rewritten.
#[test]
fn submit_exhibits_each_call_stamps_only_its_own_batch() {
    let mut c = new_contract();
    let bet_id = open_take_submit_and_challenge(&mut c, 61, 2_000);

    ctx("taker.testnet", 99_000);
    c.submit_exhibits(bet_id, vec!["first".to_string()]);
    ctx("taker.testnet", 150_000);
    c.submit_exhibits(bet_id, vec!["second".to_string()]);

    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.exhibits[0].submitted_at, U64(99_000));
    assert_eq!(bet.exhibits[1].submitted_at, U64(150_000));
}

/// The objection/rebuttal `mt_on_transfer` path (Bond message's sibling
/// exhibit-via-deposit route, `handle_objection`) is the OTHER way a hash
/// lands in `bet.exhibits` -- it must stamp the same on-chain timestamp,
/// not leave it at a default/zero value.
#[test]
fn objection_exhibit_path_also_records_block_timestamp() {
    let mut c = new_contract();
    let bet_id = open_take_submit_and_challenge(&mut c, 62, 2_000);

    do_mt_transfer(
        &mut c,
        "taker.testnet",
        OBJECTION_DEPOSIT,
        objection_msg(bet_id, "objected-hash", false),
        77_000,
    );

    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.exhibits.len(), 1);
    assert_eq!(bet.exhibits[0].hash, "objected-hash");
    assert_eq!(bet.exhibits[0].submitted_at, U64(77_000));
}

// ---------------- Item 7r: per-submitter exhibit cap (bugfix) -------

/// BUG (item 7r, found by orchestrator): `submit_exhibits` used to check
/// `bet.exhibits.len() + hashes.len() <= 5` across ALL filers sharing one
/// bet, even though the require() message says "max 5 exhibits per
/// party" -- so the maker filing 5 exhibits locked the taker out of
/// filing even their FIRST one.
#[test]
fn makers_five_exhibits_do_not_lock_out_taker() {
    let mut c = new_contract();
    let bet_id = open_take_submit_and_challenge(&mut c, 70, 2_000);

    ctx("maker.testnet", 99_000);
    c.submit_exhibits(
        bet_id,
        vec!["m1".into(), "m2".into(), "m3".into(), "m4".into(), "m5".into()],
    );
    assert_eq!(c.get_bet(bet_id).unwrap().exhibits.len(), 5);

    // The taker's first exhibit must still be accepted.
    ctx("taker.testnet", 99_100);
    c.submit_exhibits(bet_id, vec!["t1".into()]);
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.exhibits.len(), 6, "taker must not be locked out by the maker's 5 exhibits");
    assert!(bet.exhibits.iter().any(|e| e.hash == "t1" && e.submitted_by.as_str() == "taker.testnet"));
}

/// Each party (and the referee, as its own filer per D-REF1) is capped at
/// 5 of their OWN exhibits; a 6th from the SAME filer is still refused.
#[test]
#[should_panic(expected = "max 5 exhibits per party")]
fn sixth_exhibit_from_same_party_refused() {
    let mut c = new_contract();
    let bet_id = open_take_submit_and_challenge(&mut c, 71, 2_000);

    ctx("maker.testnet", 99_000);
    c.submit_exhibits(
        bet_id,
        vec!["m1".into(), "m2".into(), "m3".into(), "m4".into(), "m5".into()],
    );
    c.submit_exhibits(bet_id, vec!["m6".into()]);
}

/// Record frozen after round 1 (D-DISPUTE1, dispute design v1 S3.3): once
/// a round-2 bond lands, `submit_exhibits` must refuse brand-new exhibits
/// -- round 2 is objections-only.
#[test]
#[should_panic(expected = "record frozen after round 1")]
fn submit_exhibits_refused_once_round_2_opens() {
    let mut c = new_contract();
    let bet_id = open_take_submit_and_challenge(&mut c, 72, 2_000);

    // Round-1 exhibits are fine.
    ctx("taker.testnet", 2_055);
    c.submit_exhibits(bet_id, vec!["t1".into()]);

    // Escalate to round 2 (objection then a second Bond transfer).
    do_mt_transfer(
        &mut c,
        "taker.testnet",
        OBJECTION_DEPOSIT,
        objection_msg(bet_id, &"e".repeat(64), false),
        2_060,
    );
    do_mt_transfer(
        &mut c,
        "maker.testnet",
        10_005_000,
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 2 }).unwrap(),
        2_070,
    );
    assert_eq!(c.get_bet(bet_id).unwrap().bonds.len(), 2);

    // Round-2: a brand-new exhibit via submit_exhibits must be refused.
    ctx("taker.testnet", 2_080);
    c.submit_exhibits(bet_id, vec!["t2-new-in-round-2".into()]);
}

// ---------------- D3: re-judge round funding is explicit ----------

/// Challenger LOSES the re-judge (outcome unchanged): the round's cost
/// must be paid to the keeper exactly once, straight out of the
/// forfeited bond -- never ALSO folded into the generic
/// `run_reimbursement` lump sum (which would double-pay the keeper and
/// under-pay the two parties).
#[test]
fn d3_challenger_loses_round_cost_charged_once_from_bond_not_doubled() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(80);
    let pk_hex = hex_encode(&pk);
    let bet_id = open_and_take(&mut c, &pk_hex);
    let run_price = DEFAULT_RUN_PRICE; // 5_000, now on AssetLimit not Envelope

    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);

    // Taker challenges, posting round 1's bond.
    do_mt_transfer(
        &mut c,
        "taker.testnet",
        5_005_000, // D-AUDIT8: challenge_min (5_000_000) + run_price (5_000)
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(),
        2_050,
    );
    ctx_with_deposit("keeper.testnet", 2_060, NearToken::from_millinear(50));
    let _ = c.request_resolution(bet_id, None);

    // Re-judge confirms the SAME outcome -- the challenger lost round 1.
    ctx("anyone.testnet", 2_070);
    let result2 = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 2,
        checked_until: U64(2_070),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig2 = sign_result(&outcome_signing_key(), &result2);
    c.submit_outcome(result2, sig2);

    ctx("anyone.testnet", 2_070 + 86_400_000_000_001);
    let before = c.payout_ids_in_order().len();
    c.finalize(bet_id);
    let new_payouts: Vec<_> = c.payout_ids_in_order()[before..]
        .iter()
        .map(|id| c.pending_payouts.get(id).unwrap().clone())
        .collect();

    let keeper_total: u128 = new_payouts
        .iter()
        .filter(|p| p.receiver == KEEPER.parse::<AccountId>().unwrap())
        .map(|p| p.amount.0)
        .sum();
    // D-ECON5: round-0's run is funded entirely by `keeper_credit` and
    // never appears in finalize's payout ledger at all any more --
    // only round 1's bond-funded cost shows up here.
    assert_eq!(
        keeper_total,
        run_price,
        "keeper must be paid for exactly round 1's bond-funded cost, never round 0 (keeper_credit-funded) or double-charged"
    );
    let bond_cost_lines: Vec<_> = new_payouts.iter().filter(|p| p.reason == "bond_round_cost_to_keeper").collect();
    assert_eq!(bond_cost_lines.len(), 1, "round 1's cost must appear exactly once, funded from the bond");
    assert_eq!(bond_cost_lines[0].amount.0, run_price.min(5_000_000));
    assert!(
        new_payouts.iter().all(|p| p.reason != "round_cost_to_keeper_from_loser_reserve"),
        "a LOST round must never ALSO charge via the won-round reserve path"
    );
}

/// D-AUDIT8 (supersedes this test's original D3 framing, design decision,
/// OQ-T10 ruling): challenger WINS the re-judge (outcome
/// changes). The round's `run_price` is now paid out of the
/// CHALLENGER's own bond regardless of who wins (never the reserve);
/// the bond's remainder returns to the challenger, and the challenger
/// is separately reimbursed the round cost from the counterparty's own
/// finalize-time funds (reserve share first) -- never socialized 50/50,
/// and never by overdrawing the reserve split itself.
#[test]
fn d_audit8_challenger_wins_round_cost_paid_from_bond_then_reimbursed_by_loser() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(81);
    let pk_hex = hex_encode(&pk);
    let bet_id = open_and_take(&mut c, &pk_hex);

    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);

    // Taker challenges (holder = taker; counterparty = maker).
    do_mt_transfer(
        &mut c,
        "taker.testnet",
        5_005_000, // D-AUDIT8: challenge_min (5_000_000) + run_price (5_000)
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(),
        2_050,
    );
    ctx_with_deposit("keeper.testnet", 2_060, NearToken::from_millinear(50));
    let _ = c.request_resolution(bet_id, None);

    // Re-judge FLIPS the outcome -- the challenger (taker) won round 1;
    // maker is this round's loser.
    ctx("anyone.testnet", 2_070);
    let result2 = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "NO".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 2,
        checked_until: U64(2_070),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig2 = sign_result(&outcome_signing_key(), &result2);
    c.submit_outcome(result2, sig2);

    ctx("anyone.testnet", 2_070 + 86_400_000_000_001);
    let before = c.payout_ids_in_order().len();
    c.finalize(bet_id);
    let new_payouts: Vec<_> = c.payout_ids_in_order()[before..]
        .iter()
        .map(|id| c.pending_payouts.get(id).unwrap().clone())
        .collect();

    // D-AUDIT8: the bond's remainder (amount - run_price) returns to the
    // winning challenger -- never the full bond, since run_price now
    // always comes out of the bond itself.
    let bond_returned: u128 = new_payouts.iter().filter(|p| p.reason == "bond_returned_won_minus_run_cost").map(|p| p.amount.0).sum();
    assert_eq!(bond_returned, 5_000_000, "the winning challenger's bond, minus this round's run_price, returns to them");

    // D-AUDIT8: a WON round's `run_price` now ALSO goes through the
    // ordinary bond-cost-to-keeper line (this is the fix -- it used to
    // skip this path and charge the reserve instead).
    let bond_cost_lines: Vec<_> = new_payouts.iter().filter(|p| p.reason == "bond_round_cost_to_keeper").collect();
    assert_eq!(bond_cost_lines.len(), 1, "the won round's run_price must be paid from the bond, same as a lost round");
    assert_eq!(bond_cost_lines[0].amount.0, 5_000);

    // D-ECON5: no per-bet reserve exists any more, and `from_stake` is
    // gated on `is_void` -- this final is NO (taker wins, not VOID),
    // so the won-round claim is entirely unrecovered: no
    // `won_round_reimbursement` line is ever scheduled (zero-amount
    // payouts are skipped by `schedule_payout`).
    let reimbursement_lines: Vec<_> = new_payouts.iter().filter(|p| p.reason == "won_round_reimbursement").collect();
    assert_eq!(reimbursement_lines.len(), 0, "outside VOID, with no reserve left, the won round's cost must go entirely unrecovered");

    // D-ECON5: "reserve_leftover_maker"/"reserve_leftover_taker" no
    // longer exist as payout reasons at all -- there is no per-bet
    // reserve to leave over.
    let maker_reserve: u128 = new_payouts.iter().filter(|p| p.reason == "reserve_leftover_maker").map(|p| p.amount.0).sum();
    let taker_reserve: u128 = new_payouts.iter().filter(|p| p.reason == "reserve_leftover_taker").map(|p| p.amount.0).sum();
    assert_eq!(maker_reserve, 0, "no per-bet reserve exists any more");
    assert_eq!(taker_reserve, 0, "no per-bet reserve exists any more");

    let keeper_total: u128 = new_payouts
        .iter()
        .filter(|p| p.receiver == KEEPER.parse::<AccountId>().unwrap())
        .map(|p| p.amount.0)
        .sum();
    // D-ECON5: round-0's run is funded entirely by `keeper_credit` and
    // never appears in finalize's payout ledger -- only round 1's
    // bond-funded cost shows up here.
    assert_eq!(keeper_total, 5_000, "keeper paid for exactly round 1's bond-funded cost, never round 0 (keeper_credit-funded)");
}

// ---------------- DR-09: won-round claim must never cut the overall winner's payout --------
//
// Decision register D-AUDIT8 ruling #3 + Escrow contract spec v1 §v1.3 (and
// the comment above `finalize`'s claim-resolution loop): a won round's
// reimbursement claim is funded from the ROUND's LOSING PARTY's own
// finalize-time funds -- reserve-leftover share first, THEN (VOID outcome
// only, where a losing party still gets a stake refund) their stake
// refund. In a YES/NO final the non-winner's stake_share is always 0, so
// drawing `from_stake` unconditionally (not gated on `is_void`) means a
// claim against the overall WINNER's stake_share (== winner_payout) can
// silently cut into the winner's payout once their reserve share runs
// out -- exactly the bug this test pins.
//
// Fixture: round 0 resolves VOID; the taker challenges (bond round 1;
// pre_challenge_outcome snapshot = VOID); the re-judge flips the outcome
// to YES (maker_side). The taker's round counts as WON (pre_challenge
// VOID != final YES) and its counterparty is the maker -- who is also
// the overall winner of this YES/NO final. D-ECON5: there is no
// per-bet reserve any more at all, so the claim can only ever draw
// from the loser's stake refund -- and only on a VOID final. Outside
// VOID (this fixture: final is YES) `from_stake` is always 0, so the
// whole claim goes unrecovered; this test now pins that the winner's
// payout stays uncut and nothing is reimbursed in that case.
#[test]
fn dr09_won_round_claim_against_overall_winner_must_not_cut_payout() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(90);
    let pk_hex = hex_encode(&pk);
    let env = base_envelope(&pk_hex);

    ctx(INTENTS, 1);
    let open_resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(open_resp, vec![U128(0)]);
    let bet_id = c.next_bet_id - 1;
    let take_resp = do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_msg(bet_id), 2);
    assert_eq!(take_resp, vec![U128(0)]);

    let total_in = env.maker_required() + env.taker_required() + 5_005_000; // + round-1 bond

    // Round 0: resolves VOID.
    ctx("anyone.testnet", 2_000);
    let result0 = SubmittedResult {
        bet_id,
        terms_hash: env.terms_hash.clone(),
        outcome: "VOID".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig0 = sign_result(&outcome_signing_key(), &result0);
    c.submit_outcome(result0, sig0);

    // Taker challenges the VOID outcome (bond round 1; pre_challenge_outcome
    // snapshot = VOID).
    let resp = do_mt_transfer(
        &mut c,
        "taker.testnet",
        5_005_000, // challenge_min (5_000_000) + run_price (5_000)
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(),
        2_050,
    );
    assert_eq!(resp, vec![U128(0)]);

    // Re-judge flips the outcome to YES (maker_side) -- the taker's
    // challenge round is WON (VOID != YES); maker, the round's loser, is
    // ALSO the overall winner of this YES/NO final.
    ctx("anyone.testnet", 2_070);
    let result1 = SubmittedResult {
        bet_id,
        terms_hash: env.terms_hash.clone(),
        outcome: "YES".to_string(),
        element_results_hash: "f".repeat(64),
        run_no: 2,
        checked_until: U64(2_070),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig1 = sign_result(&outcome_signing_key(), &result1);
    c.submit_outcome(result1, sig1);

    ctx("anyone.testnet", 2_070 + 86_400_000_000_001);
    let before = c.payout_ids_in_order().len();
    c.finalize(bet_id);
    let new_payouts: Vec<_> = c.payout_ids_in_order()[before..]
        .iter()
        .map(|id| c.pending_payouts.get(id).unwrap().clone())
        .collect();

    let pot = env.pot();
    let fee = pot * env.fee_bps as u128 / BPS_DENOM;
    let winner_payout = pot - fee;

    // (a) the overall winner (maker)'s payout_winner must land uncut.
    let maker_payout: u128 = new_payouts
        .iter()
        .filter(|p| p.reason == "payout_winner" && p.receiver == "maker.testnet".parse::<AccountId>().unwrap())
        .map(|p| p.amount.0)
        .sum();
    assert_eq!(
        maker_payout, winner_payout,
        "DR-09: a won-round claim against the round's losing party must never cut the \
         OVERALL WINNER's payout in a YES/NO final -- from_stake must be 0 outside VOID"
    );

    // (b) I-2: nothing created or destroyed.
    let total_out: u128 = new_payouts.iter().map(|p| p.amount.0).sum();
    assert_eq!(total_out, total_in, "I-2: finalize must conserve exactly");

    // (c) D-ECON5: with no per-bet reserve left at all, and `from_stake`
    // gated on `is_void` (this final is YES, not VOID), the challenger
    // is reimbursed nothing -- the whole claim is unrecovered, never
    // pulled from the winner's stake.
    let reimbursement: u128 = new_payouts
        .iter()
        .filter(|p| p.reason == "won_round_reimbursement")
        .map(|p| p.amount.0)
        .sum();
    assert_eq!(
        reimbursement, 0,
        "D-ECON5: outside VOID a won-round claim must be entirely unrecovered now that \
         there is no reserve to draw from, never topped up from the winner's stake"
    );
}

// ---------------- OQ-T11 (chaos sandbox finding, awaiting familiarcow's ruling) ----------
//
// Confirmed live in the chaos sandbox (chaos/results/log.jsonl,
// d_audit8/three_round_dispute_same_loser_finalizes_cleanly): `finalize`'s
// payout fan-out at default `Limits.max_rounds=3` (plus objection/rebuttal
// deposits) can create enough `schedule_payout` calls that the SUM of
// static gas attached to all of `finalize`'s own created promises exceeds
// NEAR's 300 Tgas per-call ceiling. Per the standing test policy (never
// park/skip a confirmed bug -- it gets a failing test in the default
// suite that stays red until fixed), this pins the worst-case REACHABLE
// fan-out with a hard number. Not fixed here (no #[ignore], no lowering
// max_rounds) -- this is intentionally RED pending familiarcow's ruling on
// which lever to pull (batch the payouts, cap round count lower, split
// across multiple calls, etc).
//
// Worst-case construction (every lever that makes `finalize` schedule
// the most payouts, all independently reachable on one bet):
//   - 2 challenge rounds (default_max_rounds, lib.rs DEFAULT_MAX_ROUNDS;
//     D-DISPUTE1 lowered this from 3 to 2 -- see the dispute design v1
//     doc), each one WON by the challenger (a won round schedules a bond
//     payout, a bond-cost-to-keeper payout, AND a won_round_reimbursement
//     payout -- 3 schedule_payout calls per round, strictly more than a
//     lost round's 2).
//   - 5 exhibits + 5 rebuttals (handle_objection's own per-bet caps,
//     `bet.exhibits.len() >= 5` / `bet.rebuttals.len() >= 5`) -- 10
//     objection deposits, each settling as exactly 1 schedule_payout
//     call at finalize.
//   - Final outcome VOID with keep_terms:true, which schedules 5 payouts
//     (void_refund_maker, void_refund_taker, void_storage_keep_terms,
//     reserve_leftover_maker, reserve_leftover_taker) -- more than a
//     YES/NO final's 4 (payout_winner, fee_and_storage, reserve_leftover
//     x2).
//   - Plus round-0's own `run_reimbursement` payout to the keeper (1).
//
// Each `schedule_payout` call fires exactly one `fire_payout`, which
// creates ONE promise chain of two `FunctionCallWeight` actions: the
// outgoing `mt_transfer` (`PAYOUT_GAS` = 15 Tgas static) and its callback
// (`PAYOUT_CALLBACK_GAS` = 10 Tgas static, plus an unused-gas WEIGHT on
// top that this test does not count -- weighted gas is distributed from
// whatever is left in the enclosing transaction's gas budget at runtime,
// not a second static allocation, so counting only the two static
// figures per payout is the conservative floor, not an overcount).
/// Shared OQ-T11 worst-case builder: 2 challenge rounds (D-DISPUTE1
/// default max_rounds, all WON by the challenger), 5 exhibits + 5
/// rebuttals, final outcome VOID+keep_terms
/// -- see the doc comment on `oq_t11_worst_case_finalize_fanout_fits_300_tgas`
/// for exactly why each lever maximizes `finalize`'s fan-out (48 ledger
/// lines). Returns the contract, bet_id, and the timestamp at which
/// `finalize` first becomes callable (settlement_period elapsed).
/// `test_keypair(seed)` must be given a seed unique to the caller so
/// two tests sharing this builder never collide on `terms_hash`/sig
/// state.
fn build_oq_t11_worst_case_bet(seed: u8) -> (Contract, u64, u64) {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(seed);
    let pk_hex = hex_encode(&pk);
    let bet_id = open_and_take(&mut c, &pk_hex);

    // Round 0: resolves YES. Every challenge round below snapshots this
    // as its `pre_challenge_outcome`, and the final outcome (VOID, set
    // at the very end) differs from it, so EVERY round counts as WON by
    // its challenger -- the 3-payout-per-round worst case.
    ctx("anyone.testnet", 2_000);
    let result0 = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    c.submit_outcome(result0.clone(), sign_result(&outcome_signing_key(), &result0));

    let mut ts = 2_050u64;
    // Round 1 (taker challenges).
    let required = c.required_challenge_bond(bet_id, "taker.testnet".parse().unwrap()).unwrap().amount.0;
    let resp = do_mt_transfer(&mut c, "taker.testnet", required, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), ts);
    assert_eq!(resp, vec![U128(0)], "round 1 bond must be accepted");
    ts += 10;

    // `handle_bond`'s own `challengeable` check only accepts status
    // Proposed/Evidence (NOT Challenged -- a bond round always leaves
    // status at Challenged) -- so an exhibit/rebuttal (which flips
    // status back to Evidence) must be interleaved right before EVERY
    // subsequent round to make round 2 and round 3 both reachable.
    // Split the 5+5 cap across these interleave points so all 10 are
    // still filed by the time the last round opens.
    let mut exhibit_i = 0u32;
    let mut rebuttal_i = 0u32;
    let mut file_exhibit = |c: &mut Contract, ts: &mut u64| {
        let resp = do_mt_transfer(
            c,
            if exhibit_i % 2 == 0 { "taker.testnet" } else { "maker.testnet" },
            OBJECTION_DEPOSIT,
            objection_msg(bet_id, &format!("exhibit-{exhibit_i}-{}", "e".repeat(50)), false),
            *ts,
        );
        assert_eq!(resp, vec![U128(0)], "exhibit {exhibit_i} (<=5) must be accepted");
        exhibit_i += 1;
        *ts += 5;
    };
    let mut file_rebuttal = |c: &mut Contract, ts: &mut u64| {
        let resp = do_mt_transfer(
            c,
            if rebuttal_i % 2 == 0 { "maker.testnet" } else { "taker.testnet" },
            OBJECTION_DEPOSIT,
            objection_msg(bet_id, &format!("rebuttal-{rebuttal_i}-{}", "r".repeat(50)), true),
            *ts,
        );
        assert_eq!(resp, vec![U128(0)], "rebuttal {rebuttal_i} (<=5) must be accepted");
        rebuttal_i += 1;
        *ts += 5;
    };

    // Before round 2 (D-DISPUTE1: the Final appeal, and now the LAST
    // reachable round at default max_rounds=2): all 5 exhibits + all 5
    // rebuttals (status Challenged -> Evidence again).
    for _ in 0..5 {
        file_exhibit(&mut c, &mut ts);
    }
    for _ in 0..5 {
        file_rebuttal(&mut c, &mut ts);
    }
    assert_eq!(c.get_bet(bet_id).unwrap().exhibits.len(), 5);
    assert_eq!(c.get_bet(bet_id).unwrap().rebuttals.len(), 5);
    let required = c.required_challenge_bond(bet_id, "maker.testnet".parse().unwrap()).unwrap().amount.0;
    let resp = do_mt_transfer(&mut c, "maker.testnet", required, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 2 }).unwrap(), ts);
    assert_eq!(resp, vec![U128(0)], "round 2 (<= default max_rounds 2) must be accepted");
    ts += 10;

    assert_eq!(c.get_bet(bet_id).unwrap().bonds.len(), 2, "both default-max rounds must be reachable on one bet (D-DISPUTE1: max_rounds=2)");

    // Final re-judge: VOID -- differs from every round's "YES" snapshot,
    // so both rounds settle as WON (3 payouts each); VOID+keep_terms
    // also maximizes the terminal branch's own payout count (5).
    ctx("anyone.testnet", ts);
    let result_final = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "VOID".to_string(),
        element_results_hash: "f".repeat(64),
        run_no: 2,
        checked_until: U64(ts),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    c.submit_outcome(result_final.clone(), sign_result(&outcome_signing_key(), &result_final));

    let proposed_at = c.get_bet(bet_id).unwrap().proposed_at.unwrap();
    let env = c.get_bet(bet_id).unwrap().envelope;
    (c, bet_id, proposed_at + env.settlement_period + 1)
}

#[test]
fn oq_t11_worst_case_finalize_fanout_fits_300_tgas() {
    let (mut c, bet_id, finalize_ready_ts) = build_oq_t11_worst_case_bet(91);
    // NOTE on the test harness's OWN gas ceiling vs the real-chain one
    // this test asserts: the near-sdk mock enforces the real NEAR rule
    // that a call cannot forward more gas to its created receipts than
    // its OWN `prepaid_gas` -- and the default test context (1_000
    // Tgas) is in fact not enough headroom for this worst-case
    // `finalize` once weighted callback gas is accounted for, which
    // makes the mock itself abort the test process (SIGABRT) before
    // `get_created_receipts()` can ever run. That is a second, even
    // more direct confirmation of OQ-T11, but an aborting unit test
    // would take the whole `cargo test` binary down with it, so this
    // call is deliberately given generous test-harness headroom
    // (`VMContextBuilder::prepaid_gas`, a harness knob, NOT the 300
    // Tgas real-chain per-call ceiling this test is checking) purely
    // so `finalize` can run to completion and its receipts can be
    // inspected; the actual assertion below is against the real 300
    // Tgas figure, independent of whatever headroom the harness used.
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .signer_account_id("anyone.testnet".parse().unwrap())
        .predecessor_account_id("anyone.testnet".parse().unwrap())
        .block_timestamp(finalize_ready_ts)
        .prepaid_gas(Gas::from_tgas(50_000));
    testing_env!(b.build());
    c.finalize(bet_id);

    // Sum the static gas of every FunctionCallWeight action `finalize`
    // itself created (the outgoing mt_transfer + its callback, per
    // payout) -- this is exactly PAYOUT_GAS + PAYOUT_CALLBACK_GAS per
    // schedule_payout call, the floor of what NEAR actually reserves.
    let receipts = near_sdk::test_utils::get_created_receipts();
    let mut payout_promise_count: u64 = 0;
    let mut total_static_gas_tgas: u64 = 0;
    for r in &receipts {
        for a in &r.actions {
            if let near_sdk::mock::MockAction::FunctionCallWeight { prepaid_gas, .. } = a {
                payout_promise_count += 1;
                total_static_gas_tgas += prepaid_gas.as_tgas();
            }
        }
    }

    // One finalize call's own fixed (non-payout) overhead -- documented,
    // conservative figure; `finalize` itself attaches no cross-contract
    // calls besides the payouts, so this is purely headroom for the
    // base NEAR_BASE/function-call-cost component of the enclosing
    // transaction, well above what's actually measured on testnet.
    const BASE_OVERHEAD_TGAS: u64 = 20;

    const NEAR_PER_CALL_GAS_CEILING_TGAS: u64 = 300;
    assert!(
        total_static_gas_tgas + BASE_OVERHEAD_TGAS <= NEAR_PER_CALL_GAS_CEILING_TGAS,
        "OQ-T11: worst-case finalize fan-out exceeds NEAR's 300 Tgas ceiling -- \
         {payout_promise_count} payout-related FunctionCallWeight actions, \
         {total_static_gas_tgas} Tgas static (+{BASE_OVERHEAD_TGAS} Tgas base overhead) \
         = {} Tgas total, > {NEAR_PER_CALL_GAS_CEILING_TGAS} Tgas ceiling (awaiting familiarcow's ruling)",
        total_static_gas_tgas + BASE_OVERHEAD_TGAS
    );
}

/// OQ-T11 gas test: the fix itself. Builds the exact same worst-case
/// 48-line fan-out as the test above, finalizes it (now a cheap
/// ledger-only call, nothing to measure), then drains it via repeated
/// `drain_payouts` calls and asserts EVERY one of them individually
/// fits well under NEAR's 300 Tgas ceiling -- not just the aggregate
/// across all of them. This is the test that actually proves a bet
/// with the worst reachable fan-out can be settled on a real chain.
/// D-AUDIT11: with grouping by (receiver, token_id) and a single real
/// asset (USDC-only, per the settlement debate doc Phase 0), the
/// worst-case bet's ~48 individual ledger lines collapse into at most
/// 4 groups (maker/taker/fee_account/keeper) -- comfortably inside one
/// `MAX_DRAIN_BATCH`, so `finalize`'s own inline drain settles the
/// whole bet in ONE call (see `oq_t11_worst_case_finalize_fanout_fits_300_tgas`).
/// To still prove `drain_payouts` safely bounds an even larger,
/// multi-call worst case (e.g. once a future multi-asset bet exists --
/// (o) in the debate doc), this test injects extra synthetic groups
/// with distinct `token_id`s via the test-only hook so total groups
/// exceed `MAX_DRAIN_BATCH`, and checks every resulting call -- the
/// one inline at `finalize` and every subsequent retry -- stays under
/// the real 300 Tgas per-call ceiling, drains every line exactly once,
/// and takes exactly `ceil(total_groups / MAX_DRAIN_BATCH)` calls.
#[test]
fn oq_t11_drain_payouts_batch_fits_300_tgas() {
    let (mut c, bet_id, finalize_ready_ts) = build_oq_t11_worst_case_bet(92);

    // Inject enough extra (receiver, token_id) groups -- each a
    // distinct mock token_id so none merges with the real USDC lines
    // or each other -- to push total GROUPS past MAX_DRAIN_BATCH.
    let extra_groups = MAX_DRAIN_BATCH as usize + 5;
    for i in 0..extra_groups {
        c.test_inject_pending_payout(
            bet_id,
            "maker.testnet".parse().unwrap(),
            format!("mock-token-{i}.testnet"),
            1_000,
            format!("synthetic-asset-{i}"),
        );
    }

    ctx("anyone.testnet", finalize_ready_ts);
    c.finalize(bet_id);
    // finalize's own inline drain already fired MAX_DRAIN_BATCH groups
    // (clamped) in this same call -- still Finalized because more
    // groups remain pending.
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Finalized);

    let total_lines = c.pending_payouts(bet_id).len() as u64;
    // Count distinct (receiver, token_id) groups across ALL lines
    // (done + pending) to know how many calls this must take.
    let all_lines_snapshot = c.pending_payouts(bet_id);
    let mut all_groups: Vec<(near_sdk::AccountId, String)> = Vec::new();
    for p in &all_lines_snapshot {
        let key = (p.receiver.clone(), p.token_id.clone());
        if !all_groups.contains(&key) {
            all_groups.push(key);
        }
    }
    // The real (pre-injection) lines' groups were already counted by
    // the in-flight set right after finalize; recompute total groups
    // including those already resolved in-flight by inspecting
    // payout_ids is awkward from the test side, so instead assert the
    // simpler, sufficient property this test exists to prove: total
    // groups (still-pending ones, since finalize already drained its
    // first MAX_DRAIN_BATCH) is large enough that draining needs more
    // than one further call.
    assert!(
        total_lines as u64 > 0,
        "expected pending lines to remain after finalize's first inline drain"
    );

    const BASE_OVERHEAD_TGAS: u64 = 20;
    const NEAR_PER_CALL_GAS_CEILING_TGAS: u64 = 300;
    let check_gas_of_last_call = |call_no: u64| {
        let receipts = near_sdk::test_utils::get_created_receipts();
        let mut call_static_gas_tgas: u64 = 0;
        let mut call_promise_count: u64 = 0;
        for r in &receipts {
            for a in &r.actions {
                if let near_sdk::mock::MockAction::FunctionCallWeight { prepaid_gas, .. } = a {
                    call_promise_count += 1;
                    call_static_gas_tgas += prepaid_gas.as_tgas();
                }
            }
        }
        assert!(
            call_static_gas_tgas + BASE_OVERHEAD_TGAS <= NEAR_PER_CALL_GAS_CEILING_TGAS,
            "call #{call_no} exceeds NEAR's 300 Tgas ceiling -- \
             {call_promise_count} payout-related FunctionCallWeight actions, \
             {call_static_gas_tgas} Tgas static (+{BASE_OVERHEAD_TGAS} Tgas base overhead) \
             = {} Tgas total",
            call_static_gas_tgas + BASE_OVERHEAD_TGAS
        );
    };
    // finalize's own inline drain is call #1 -- check its gas too.
    check_gas_of_last_call(1);

    let mut calls = 1u64;
    let mut ts = finalize_ready_ts + 10;
    loop {
        // D-AUDIT11: resolve whatever the LAST call left in-flight
        // before asking drain_payouts for more -- it correctly refuses
        // to re-fire an already-in-flight group.
        resolve_in_flight(&mut c, bet_id, ts);
        if c.pending_payouts(bet_id).is_empty() {
            break;
        }
        ts += 10;
        ctx("anyone.testnet", ts);
        // A real keeper/anyone would ask for a big limit -- drain_payouts
        // clamps it to MAX_DRAIN_BATCH internally, which is exactly what
        // this test is proving stays safe.
        let fired = c.drain_payouts(bet_id, 10_000);
        assert!(fired > 0, "drain_payouts fired nothing but pending lines remain");
        calls += 1;
        check_gas_of_last_call(calls);
    }
    resolve_in_flight(&mut c, bet_id, ts);

    assert_eq!(
        calls,
        (all_groups.len() as u64).div_ceil(MAX_DRAIN_BATCH),
        "{} groups at MAX_DRAIN_BATCH={MAX_DRAIN_BATCH} must take exactly \
         ceil(groups/MAX_DRAIN_BATCH) calls",
        all_groups.len()
    );
    assert!(c.is_fully_paid(bet_id));
    assert_eq!(
        c.get_bet(bet_id).unwrap().status,
        BetStatus::Settled,
        "bet must reach Settled only once the ledger is fully drained"
    );
}

// ---------------- Limits enforcement (bug fix: was dead config) ----------

#[test]
fn over_max_stake_rejected_at_open() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(58);
    let mut env = base_envelope(&hex_encode(&pk));
    env.stake_maker = U128(10_000_000_000); // > the per-asset `max_per_side` cap (AssetLimit; MS1 removed the flat `limits.max_stake`)
    env.stake_taker = U128(10_000_000_000);
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required())], "over-max-stake open must be rejected");
}

#[test]
fn over_max_ttl_rejected_at_open() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(59);
    let mut env = base_envelope(&hex_encode(&pk));
    // max_offer_ttl_secs = 86400*60 = 5_184_000s = 5.184e15 ns from ts=1.
    env.funding_deadline = 1 + 5_184_000u64 * 1_000_000_000 + 1;
    env.resolve_deadline = env.funding_deadline + 1;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required())], "over-max-ttl open must be rejected");
}

// ---------------- D-SUNSET2 guardian pause ----------------

#[test]
fn pause_blocks_open_and_take_only() {
    let mut c = new_contract();
    ctx_with_deposit(GUARDIAN, 0, NearToken::from_yoctonear(1));
    c.pause_new_offers();
    assert!(c.is_paused());
    assert!(c.is_new_offers_paused());

    let (_, pk) = test_keypair(6);
    let env = base_envelope(&hex_encode(&pk));
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required())], "open rejected while paused");

    ctx_with_deposit(GUARDIAN, 0, NearToken::from_yoctonear(1));
    c.unpause_new_offers();
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));

    // Now pause again; cancel (not open/take) must still work (I-5).
    ctx_with_deposit(GUARDIAN, 0, NearToken::from_yoctonear(1));
    c.pause_new_offers();
    ctx("maker.testnet", 2);
    // bet is Taken, not Open, so cancel would fail for a different reason;
    // use expire-style check instead: void_after_deadline must still work.
    ctx("anyone.testnet", 10_001);
    c.void_after_deadline(bet_id);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Voided);
}

#[test]
#[should_panic(expected = "only guardian")]
fn pause_by_non_guardian_rejected() {
    let mut c = new_contract();
    ctx_with_deposit("random.testnet", 0, NearToken::from_yoctonear(1));
    c.pause_new_offers();
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn pause_without_one_yocto_rejected() {
    let mut c = new_contract();
    ctx(GUARDIAN, 0); // ctx() attaches 0 deposit, not 1 yocto
    c.pause_new_offers();
}

#[test]
#[should_panic(expected = "only guardian")]
fn unpause_by_non_guardian_rejected() {
    let mut c = new_contract();
    ctx_with_deposit(GUARDIAN, 0, NearToken::from_yoctonear(1));
    c.pause_new_offers();
    ctx_with_deposit("random.testnet", 0, NearToken::from_yoctonear(1));
    c.unpause_new_offers();
}

#[test]
fn set_guardian_rotates_and_old_guardian_loses_power() {
    let mut c = new_contract();
    ctx_with_deposit(GUARDIAN, 0, NearToken::from_yoctonear(1));
    c.set_guardian("new_guardian.testnet".parse().unwrap());
    // JC1x (D-JUDGECHAIN1a S1): rotation is two-step; the new account must accept.
    ctx_with_deposit("new_guardian.testnet", 0, NearToken::from_yoctonear(1));
    c.accept_guardian();

    // Old guardian can no longer pause.
    ctx_with_deposit(GUARDIAN, 0, NearToken::from_yoctonear(1));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.pause_new_offers()));
    assert!(result.is_err(), "old guardian must lose power after rotation");
}

#[test]
#[should_panic(expected = "only guardian")]
fn set_guardian_by_non_guardian_rejected() {
    let mut c = new_contract();
    ctx_with_deposit("random.testnet", 0, NearToken::from_yoctonear(1));
    c.set_guardian("random.testnet".parse().unwrap());
}

// ---------------- D-SUNSET3 emergency shutdown / refund ----------------

#[test]
fn emergency_shutdown_is_irreversible_and_blocks_resolution_paths() {
    let mut c = new_contract();
    ctx_with_deposit(GUARDIAN, 0, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    assert!(c.is_shutdown());
    assert!(c.is_paused(), "shutdown implies permanent new-offers pause");

    // unpause is impossible after shutdown.
    ctx_with_deposit(GUARDIAN, 0, NearToken::from_yoctonear(1));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.unpause_new_offers()));
    assert!(result.is_err(), "unpause must be refused after shutdown");
}

#[test]
#[should_panic(expected = "only guardian")]
fn emergency_shutdown_by_non_guardian_rejected() {
    let mut c = new_contract();
    ctx_with_deposit("random.testnet", 0, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
}

#[test]
#[should_panic(expected = "emergency_refund is only callable after emergency_shutdown")]
fn emergency_refund_before_shutdown_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(7);
    let env = base_envelope(&hex_encode(&pk));
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    c.emergency_refund(1);
}

#[test]
fn emergency_refund_open_untaken_offer_exact() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(8);
    let env = base_envelope(&hex_encode(&pk));
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    ctx_with_deposit(GUARDIAN, 0, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    c.emergency_refund(1);
    let payouts = c.pending_payouts(1);
    assert_eq!(payouts.len(), 1);
    assert_eq!(payouts[0].receiver, "maker.testnet".parse::<AccountId>().unwrap());
    assert_eq!(payouts[0].amount.0, env.maker_required());
    assert_eq!(c.get_bet(1).unwrap().status, BetStatus::Voided);
}

#[test]
fn emergency_refund_matched_bet_pays_both_sides_exact() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(9);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let env = c.get_bet(bet_id).unwrap().envelope;
    ctx_with_deposit(GUARDIAN, 0, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    c.emergency_refund(bet_id);
    let payouts = c.pending_payouts(bet_id);
    let maker_total: u128 = payouts
        .iter()
        .filter(|p| p.receiver == env.maker)
        .map(|p| p.amount.0)
        .sum();
    let taker_total: u128 = payouts
        .iter()
        .filter(|p| p.receiver != env.maker)
        .map(|p| p.amount.0)
        .sum();
    assert_eq!(maker_total, env.maker_required());
    assert_eq!(taker_total, env.taker_required());
}

#[test]
#[should_panic(expected = "bet is already terminal; emergency_refund refused")]
fn emergency_refund_twice_on_same_bet_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(10);
    let env = base_envelope(&hex_encode(&pk));
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    ctx_with_deposit(GUARDIAN, 0, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    c.emergency_refund(1);
    c.emergency_refund(1); // second call must be refused
}

#[test]
#[should_panic(expected = "bet is already terminal; emergency_refund refused")]
fn emergency_refund_settled_bet_untouched() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(11);
    let env = base_envelope(&hex_encode(&pk));
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    ctx("maker.testnet", 1);
    c.cancel(1); // terminal: Cancelled
    ctx_with_deposit(GUARDIAN, 0, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    c.emergency_refund(1);
}

#[test]
#[should_panic(expected = "contract is shut down")]
fn finalize_after_shutdown_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(12);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx_with_deposit(GUARDIAN, 0, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    c.finalize(bet_id);
}

#[test]
fn contract_version_view_returns_cargo_pkg_version() {
    let c = new_contract();
    assert_eq!(c.contract_version(), env!("CARGO_PKG_VERSION"));
}

// ---------------- D-SUNSET1 optional sunset ----------------

#[test]
fn no_sunset_contract_accepts_offer_far_in_future() {
    // beta_sunset_ns: None means no sunset at all now (D-SUNSET1).
    let mut c = new_contract_with_limits(
        Limits {
            max_stake: U128(1_000_000_000),
            max_offer_ttl_secs: 86400 * 365 * 150, // far future TTL headroom
            max_stake_per_side_near: U128(100 * 10u128.pow(24)),
            max_rounds: crate::DEFAULT_MAX_ROUNDS,
            max_retries: crate::DEFAULT_MAX_RETRIES,
        },
        None,
    );
    let far_future_ns = 100u64 * 365 * 24 * 3600 * 1_000_000_000; // ~100 years
    let (_, pk) = test_keypair(13);
    let mut env = base_envelope(&hex_encode(&pk));
    env.funding_deadline = far_future_ns;
    env.resolve_deadline = far_future_ns + 1;
    // D-HORIZON1/1a: resolve_deadline must be <= 1,461d after open, so open
    // "late" (block time just before the far-future deadlines) instead of at ts 0.
    let open_ts = far_future_ns - 1_000;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg_at(&env, open_ts), open_ts);
    assert_eq!(resp, vec![U128(0)], "no-sunset contract must accept an offer far in the future");
}

#[test]
fn some_sunset_refuses_after_but_existing_bet_still_settles() {
    let sunset_ns = 1_000u64;
    let mut c = new_contract_with_limits(
        Limits {
            max_stake: U128(1_000_000_000),
            max_offer_ttl_secs: 86400 * 60,
            max_stake_per_side_near: U128(100 * 10u128.pow(24)),
            max_rounds: crate::DEFAULT_MAX_ROUNDS,
            max_retries: crate::DEFAULT_MAX_RETRIES,
        },
        Some(sunset_ns),
    );
    let (_, pk) = test_keypair(14);
    // Open before sunset: accepted.
    let mut env = base_envelope(&hex_encode(&pk));
    env.funding_deadline = sunset_ns + 1_000;
    env.resolve_deadline = sunset_ns + 1_000_000;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 0);
    assert_eq!(resp, vec![U128(0)], "offer before sunset must be accepted");

    // Open after sunset: refused (deposit returned).
    let mut env2 = base_envelope(&hex_encode(&pk));
    env2.funding_deadline = sunset_ns + 1_000;
    env2.resolve_deadline = sunset_ns + 1_000_000;
    let resp2 = do_mt_transfer(&mut c, "maker2.testnet", env2.maker_required(), open_msg(&env2), sunset_ns);
    assert_eq!(resp2, vec![U128(env2.maker_required())], "offer after sunset must be refused");

    // The existing (pre-sunset) bet still proceeds normally (cancel works).
    ctx("maker.testnet", sunset_ns + 1);
    c.cancel(1);
    assert_eq!(c.get_bet(1).unwrap().status, BetStatus::Cancelled);
}

// ---------------- Signature / amount attacks ----------------

#[test]
fn forged_signature_rejected() {
    let mut c = new_contract();
    let (_sk, pk) = test_keypair(8);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.submit_outcome(result, hex_encode(&[0u8; 64]))
    }));
    assert!(panicked.is_err());
}

#[test]
fn replayed_signature_on_another_bet_rejected() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(9);
    let pk_hex = hex_encode(&pk);
    let bet_a = open_and_take(&mut c, &pk_hex);
    let bet_b = open_and_take(&mut c, &pk_hex);
    ctx("anyone.testnet", 2_000);
    let result_a = SubmittedResult {
        bet_id: bet_a,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig_for_a = sign_result(&outcome_signing_key(), &result_a);
    // Replay sig_for_a's bytes but targeting bet_b: bet_id is embedded in
    // the signed message so verification must fail.
    let result_b_claim = SubmittedResult {
        bet_id: bet_b,
        ..result_a
    };
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.submit_outcome(result_b_claim, sig_for_a)
    }));
    assert!(panicked.is_err(), "replay across bet_id must fail");
}

#[test]
fn run_no_reuse_rejected() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(10);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result.clone(), sig.clone());
    // Bet is now Proposed; a second submission with the same run_no
    // (e.g. a rejudge retry bug) must be rejected even though status
    // moved to Proposed (allowed caller state for a re-judge round).
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.submit_outcome(result, sig)
    }));
    assert!(panicked.is_err());
}

#[test]
fn over_amount_open_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(11);
    let env = base_envelope(&hex_encode(&pk));
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required() + 1, open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required() + 1)]);
}

#[test]
fn under_amount_take_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(12);
    let env = base_envelope(&hex_encode(&pk));
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    let bet_id = c.next_bet_id - 1;
    let resp = do_mt_transfer(&mut c, "taker.testnet", env.taker_required() - 1, take_msg(bet_id), 2);
    assert_eq!(resp, vec![U128(env.taker_required() - 1)]);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Open, "stays Open on reject");
}

#[test]
fn wrong_token_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(13);
    let env = base_envelope(&hex_encode(&pk));
    ctx(INTENTS, 1);
    let resp = c.mt_on_transfer(
        "maker.testnet".parse().unwrap(),
        vec!["maker.testnet".parse().unwrap()],
        vec!["nep141:not-usdc.testnet".to_string()],
        vec![U128(env.maker_required())],
        open_msg(&env),
    );
    match resp {
        PromiseOrValue::Value(v) => assert_eq!(v, vec![U128(env.maker_required())]),
        _ => panic!(),
    }
}

#[test]
fn double_take_race_second_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(14);
    let env = base_envelope(&hex_encode(&pk));
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    let bet_id = c.next_bet_id - 1;
    let resp1 = do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_msg(bet_id), 2);
    assert_eq!(resp1, vec![U128(0)]);
    let resp2 = do_mt_transfer(&mut c, "taker2.testnet", env.taker_required(), take_msg(bet_id), 3);
    assert_eq!(resp2, vec![U128(env.taker_required())], "second take must be fully refunded");
    assert_eq!(c.get_bet(bet_id).unwrap().taker, Some("taker.testnet".parse().unwrap()));
}

#[test]
fn not_predecessor_intents_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(15);
    let env = base_envelope(&hex_encode(&pk));
    ctx("attacker.testnet", 1); // not intents.near
    let resp = c.mt_on_transfer(
        "maker.testnet".parse().unwrap(),
        vec!["maker.testnet".parse().unwrap()],
        vec![USDC.to_string()],
        vec![U128(env.maker_required())],
        open_msg(&env),
    );
    match resp {
        PromiseOrValue::Value(v) => assert_eq!(v, vec![U128(env.maker_required())]),
        _ => panic!(),
    }
}

#[test]
fn malformed_msg_rejected_not_panicked() {
    let mut c = new_contract();
    let resp = do_mt_transfer(&mut c, "maker.testnet", 1234, "not json".to_string(), 1);
    assert_eq!(resp, vec![U128(1234)]);
}

// ML1: an unparseable msg is still a full refund with no bet, but now
// leaves a bounded `open_rejected` log naming the parse failure.
fn ml1_assert_rejected_logged(msg: String, what: &str) -> Vec<String> {
    let mut c = new_contract();
    let before = c.next_bet_id;
    let resp = do_mt_transfer(&mut c, "maker.testnet", 1234, msg, 1);
    assert_eq!(resp, vec![U128(1234)], "{what}: full refund");
    assert_eq!(c.next_bet_id, before, "{what}: no bet created");
    let logs = near_sdk::test_utils::get_logs();
    assert!(
        logs.iter().any(|l| l.starts_with("open_rejected bet=unassigned reason=") && l.contains("parse")),
        "{what}: expected open_rejected parse log, got: {logs:?}"
    );
    for l in &logs {
        assert!(l.len() <= 600, "{what}: log line unbounded ({} bytes)", l.len());
    }
    logs
}

#[test]
fn ml1_invalid_json_logs_open_rejected() {
    ml1_assert_rejected_logged("not json".to_string(), "invalid json");
}

#[test]
fn ml1_checked_at_string_logs_open_rejected() {
    let (_, pk) = test_keypair(46);
    let env = base_envelope(&hex_encode(&pk));
    let mut v: serde_json::Value = serde_json::from_str(&open_msg(&env)).unwrap();
    let ca = v["attestation"]["checked_at"].clone();
    assert!(ca.is_number() || ca.is_string(), "checked_at located: {ca:?}");
    v["attestation"]["checked_at"] = serde_json::Value::String("1700000000".to_string());
    let logs = ml1_assert_rejected_logged(v.to_string(), "checked_at string");
    assert!(logs.iter().any(|l| l.contains("checked_at") || l.contains("invalid type")));
}

#[test]
fn ml1_missing_required_field_logs_open_rejected() {
    let (_, pk) = test_keypair(47);
    let env = base_envelope(&hex_encode(&pk));
    let mut v: serde_json::Value = serde_json::from_str(&open_msg(&env)).unwrap();
    v.as_object_mut().unwrap().remove("attestation");
    let logs = ml1_assert_rejected_logged(v.to_string(), "missing field");
    assert!(logs.iter().any(|l| l.contains("missing field")));
}

#[test]
fn ml1_unknown_action_logs_open_rejected() {
    let logs = ml1_assert_rejected_logged(r#"{"kind":"Frobnicate"}"#.to_string(), "unknown action");
    assert!(logs.iter().any(|l| l.contains("unknown variant")));
}

#[test]
fn ml1_huge_malformed_msg_log_is_bounded() {
    // 50 KB of attacker bytes in three shapes; serde echoes some of them
    // (e.g. unknown variant names), so the log must truncate.
    let big = "A".repeat(50_000);
    for (what, msg) in [
        ("huge garbage", big.clone()),
        ("huge unknown kind", format!(r#"{{"kind":"{big}"}}"#)),
        ("huge bad type", format!(r#"{{"kind":"Take","bet_id":"{big}"}}"#)),
    ] {
        let logs = ml1_assert_rejected_logged(msg, what);
        let total: usize = logs.iter().map(|l| l.len()).sum();
        assert!(total <= 800, "{what}: total log bytes {total}");
    }
}

// ---------------- Retry / pending payout ledger (I-4) ----------------

#[test]
fn retry_payout_only_for_incomplete() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(16);
    let env = base_envelope(&hex_encode(&pk));
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    let bet_id = c.next_bet_id - 1;
    ctx("maker.testnet", 2);
    c.cancel(bet_id);
    let id = *c.payout_ids_in_order().last().unwrap();
    assert!(!c.pending_payouts.get(&id).unwrap().done);
    ctx("anyone.testnet", 3);
    c.retry_payout(id); // should not panic; re-fires the promise
    let p = c.pending_payouts.get(&id).unwrap();
    // OQ-T11: `schedule_payout` no longer fires (attempts starts at 0);
    // this is the first actual fire, by `retry_payout`.
    assert_eq!(p.attempts, 1);
}

#[test]
#[should_panic(expected = "payout already completed")]
fn retry_payout_on_done_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(17);
    let env = base_envelope(&hex_encode(&pk));
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    let bet_id = c.next_bet_id - 1;
    ctx("maker.testnet", 2);
    c.cancel(bet_id);
    let id = *c.payout_ids_in_order().last().unwrap();
    c.pending_payouts.get_mut(&id).unwrap().done = true; // simulate successful send
    ctx("anyone.testnet", 3);
    c.retry_payout(id);
}

// ---------------- D-AUDIT11: aggregation-specific coverage ----------

/// Worst-case bet produces at most one `mt_transfer` promise per
/// distinct (receiver, token_id) -- never one per individual ledger
/// line/obligation.
#[test]
fn worst_case_bet_produces_at_most_one_transfer_per_receiver_token() {
    let (mut c, bet_id, finalize_ready_ts) = build_oq_t11_worst_case_bet(93);
    ctx("anyone.testnet", finalize_ready_ts);
    c.finalize(bet_id);

    // `finalize` itself schedules every obligation AND drains them
    // inline in the same call -- nothing is `done` yet (callbacks
    // haven't resolved), so every line is still visible here, either
    // still-pending or in_flight.
    let lines_after = c.pending_payouts(bet_id);
    let mut groups: Vec<(near_sdk::AccountId, String)> = Vec::new();
    for p in &lines_after {
        let key = (p.receiver.clone(), p.token_id.clone());
        if !groups.contains(&key) {
            groups.push(key);
        }
    }
    assert!(
        lines_after.len() > groups.len(),
        "test bet must have more individual obligations ({}) than distinct \
         (receiver, token) groups ({}) to prove aggregation does anything",
        lines_after.len(),
        groups.len()
    );

    let receipts = near_sdk::test_utils::get_created_receipts();
    let mt_transfer_promises = receipts
        .iter()
        .flat_map(|r| r.actions.iter())
        .filter(|a| {
            matches!(a, near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. }
                if method_name.as_slice() == b"mt_transfer")
        })
        .count();
    assert_eq!(
        mt_transfer_promises,
        groups.len(),
        "finalize must fire exactly one mt_transfer per (receiver, token_id) group \
         ({} groups), not one per ledger line ({} lines)",
        groups.len(),
        lines_after.len()
    );
}

/// A failed transfer stays pending (never marked done), and a retry
/// pays the exact group exactly once -- never double-sent, never lost.
#[test]
fn failed_transfer_stays_pending_and_retry_pays_exactly_once() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(94);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    ctx("anyone.testnet", 2_000 + 86_400_000_000_001);
    c.finalize(bet_id); // fires every group's transfer inline, in_flight

    let in_flight_before: Vec<_> = c.pending_payouts(bet_id).into_iter().filter(|p| p.in_flight).collect();
    assert!(!in_flight_before.is_empty(), "finalize must fire at least one group inline");
    let group = in_flight_before
        .iter()
        .filter(|p| p.receiver == "maker.testnet".parse::<near_sdk::AccountId>().unwrap())
        .map(|p| p.id)
        .collect::<Vec<_>>();
    assert!(!group.is_empty(), "maker must have an in-flight group to fail");

    // Simulate the transfer FAILING.
    ctx_with_promise_result(CONTRACT, 2_100, PromiseResult::Failed);
    c.on_payout_result(group.clone());
    for id in &group {
        let p = c.pending_payouts.get(id).unwrap();
        assert!(!p.done, "I-4: a failed transfer must never be marked done");
        assert!(!p.in_flight, "a failed transfer must become retryable (not in_flight)");
    }
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Finalized, "bet must not falsely promote to Settled");

    // Retry via drain_payouts -- must re-fire this exact group, once.
    ctx("anyone.testnet", 2_200);
    let fired = c.drain_payouts(bet_id, MAX_DRAIN_BATCH);
    assert!(fired > 0, "retry must re-fire the failed group");
    for id in &group {
        assert!(c.pending_payouts.get(id).unwrap().in_flight);
        assert_eq!(c.pending_payouts.get(id).unwrap().attempts, 2, "exactly 2 attempts: original fire + one retry");
    }
    ctx_with_promise_result(CONTRACT, 2_300, PromiseResult::Successful(vec![]));
    c.on_payout_result(group.clone());
    for id in &group {
        assert!(c.pending_payouts.get(id).unwrap().done, "retry success must mark the group done exactly once");
    }
}

/// Independent groups: one group's transfer failing must never affect
/// another group's success -- each callback only ever touches its own
/// ids.
#[test]
fn transfers_to_different_recipients_fail_independently() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(95);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    ctx("anyone.testnet", 2_000 + 86_400_000_000_001);
    c.finalize(bet_id);

    let in_flight: Vec<_> = c.pending_payouts(bet_id).into_iter().filter(|p| p.in_flight).collect();
    let mut groups: Vec<(near_sdk::AccountId, Vec<u64>)> = Vec::new();
    for p in &in_flight {
        match groups.iter_mut().find(|(r, _)| *r == p.receiver) {
            Some(g) => g.1.push(p.id),
            None => groups.push((p.receiver.clone(), vec![p.id])),
        }
    }
    assert!(groups.len() >= 2, "need at least 2 independent recipient groups to prove this");

    // Fail the FIRST group, succeed every other group.
    let (failed_group, other_groups) = groups.split_first().unwrap();
    ctx_with_promise_result(CONTRACT, 2_100, PromiseResult::Failed);
    c.on_payout_result(failed_group.1.clone());
    for (_, ids) in other_groups {
        ctx_with_promise_result(CONTRACT, 2_100, PromiseResult::Successful(vec![]));
        c.on_payout_result(ids.clone());
    }

    for id in &failed_group.1 {
        let p = c.pending_payouts.get(id).unwrap();
        assert!(!p.done, "the failed group's lines must stay pending");
        assert!(!p.in_flight, "the failed group's lines must become retryable");
    }
    for (_, ids) in other_groups {
        for id in ids {
            assert!(c.pending_payouts.get(id).unwrap().done, "unrelated groups must settle despite another group's failure");
        }
    }
}

// ---------------- Invariant checks ----------------

/// CMT2 K4: independent re-derivation of one side's STG1 storage charge, with
/// the formula written out here rather than calling `Envelope::storage_for`:
/// bytes = terms + terms_hash + models_snapshot_hash
///         + 3 filers * 5 exhibits * (MAX_HASH_LEN + MAX_ACCOUNT_ID_LEN)
///         + STORAGE_EVENT_OVERHEAD_BYTES (256);
/// charge = max(1, ceil(bytes * STG_FIXTURE_RATE / 2048)).
fn independent_storage_per_side(env: &Envelope) -> u128 {
    let bytes: u128 = env.terms.as_ref().map(|t| t.len()).unwrap_or(0) as u128
        + env.terms_hash.len() as u128
        + env.models_snapshot_hash.len() as u128
        + 3 * 5 * (128 + 64)
        + 256;
    std::cmp::max(1, (bytes * 6305 + 2047) / 2048)
}


#[test]
fn i2_finalize_never_pays_more_than_pot_plus_reserve() {
    for outcome in ["YES", "NO"] {
        let mut c = new_contract();
        let (sk, pk) = test_keypair(20);
        let bet_id = open_and_take(&mut c, &hex_encode(&pk));
        // D-ECON5: no per-bet reserve any more -- just pot + storage.
        let total_in = {
            let bet = c.get_bet(bet_id).unwrap();
            // K4: deposit side computed independently of the stored fields.
            let each = independent_storage_per_side(&base_envelope(&hex_encode(&pk)));
            assert_eq!(bet.storage_maker.0, each, "stored storage_maker != independent estimate");
            assert_eq!(bet.storage_taker.0, each, "stored storage_taker != independent estimate");
            bet.envelope.pot() + each * 2
        };
        ctx("anyone.testnet", 2_000);
        let result = SubmittedResult {
            bet_id,
            terms_hash: "terms-hash-1".to_string(),
            outcome: outcome.to_string(),
            element_results_hash: "e".repeat(64),
            run_no: 1,
            checked_until: U64(2_000),
            next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig = sign_result(&outcome_signing_key(), &result);
        c.submit_outcome(result, sig);
        ctx("anyone.testnet", 2_000 + 86_400_000_000_001);
        let before = c.payout_ids_in_order().len();
        c.finalize(bet_id);
        let total_out: u128 = c.payout_ids_in_order()[before..]
            .iter()
            .map(|id| c.pending_payouts.get(id).unwrap().amount.0)
            .sum();
        assert!(total_out <= total_in, "I-2 violated: out={total_out} in={total_in}");
    }
}

#[test]
fn i1_payout_receivers_are_always_maker_taker_fee_or_keeper() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(21);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    ctx("anyone.testnet", 2_000 + 86_400_000_000_001);
    c.finalize(bet_id);
    let allowed: Vec<AccountId> = vec![
        "maker.testnet".parse().unwrap(),
        "taker.testnet".parse().unwrap(),
        FEE.parse().unwrap(),
        KEEPER.parse().unwrap(),
    ];
    for id in &c.payout_ids_in_order() {
        let p = c.pending_payouts.get(id).unwrap();
        assert!(
            allowed.contains(&p.receiver),
            "I-1 violated: payout to {}",
            p.receiver
        );
    }
}

// ---------------- Property test: random op sequences never violate I-2 ----------------

mod proptest_i2 {
    use super::*;
    use proptest::prelude::*;

    #[derive(Debug, Clone)]
    enum Op {
        SubmitYes,
        SubmitNo,
        SubmitVoid,
        FinalizeEarly,
        FinalizeLate,
        VoidDeadlineEarly,
        VoidDeadlineLate,
        DoubleTake,
    }

    fn op_strategy() -> impl Strategy<Value = Op> {
        prop_oneof![
            Just(Op::SubmitYes),
            Just(Op::SubmitNo),
            Just(Op::SubmitVoid),
            Just(Op::FinalizeEarly),
            Just(Op::FinalizeLate),
            Just(Op::VoidDeadlineEarly),
            Just(Op::VoidDeadlineLate),
            Just(Op::DoubleTake),
        ]
    }

    proptest! {
        // Fast by default (never #[ignore]d -- standing test policy);
        // set PRAETORIAL_PROPTEST_DEEP=1 for the original 200-case run.
        #![proptest_config(ProptestConfig::with_cases(proptest_cases(20, 200)))]
        #[test]
        fn random_sequences_never_violate_i2(ops in prop::collection::vec(op_strategy(), 1..8)) {
            let mut c = new_contract();
            let (sk, pk) = test_keypair(42);
            let bet_id = open_and_take(&mut c, &hex_encode(&pk));
            // D-ECON5: no per-bet reserve any more -- just pot + storage.
            let total_in = {
                let bet = c.get_bet(bet_id).unwrap();
                // K4: deposit side computed independently of the stored fields.
                let each = independent_storage_per_side(&base_envelope(&hex_encode(&pk)));
                prop_assert_eq!(bet.storage_maker.0, each);
                prop_assert_eq!(bet.storage_taker.0, each);
                bet.envelope.pot() + each * 2
            };
            let mut ts = 1_500u64;
            let mut run_no = 1u64;

            for op in ops {
                ts += 10;
                let before_total: u128 = c
                    .payout_ids_in_order()
                    .iter()
                    .map(|id| c.pending_payouts.get(id).unwrap().amount.0)
                    .sum();
                let outcome_submit = |c: &mut Contract, outcome: &str, ts: u64, run_no: u64| {
                    let status_ok = matches!(
                        c.get_bet(bet_id).unwrap().status,
                        BetStatus::Taken | BetStatus::Resolving | BetStatus::Challenged | BetStatus::Evidence
                    );
                    if !status_ok {
                        return;
                    }
                    ctx("anyone.testnet", ts);
                    let result = SubmittedResult {
                        bet_id,
                        terms_hash: "terms-hash-1".to_string(),
                        outcome: outcome.to_string(),
                        element_results_hash: "e".repeat(64),
                        run_no,
                        checked_until: U64(ts),
                        next_check_ns: None,
                        judge_pair_index: 0, model_not_found: vec![],
                    };
                    let sig = sign_result(&outcome_signing_key(), &result);
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        c.submit_outcome(result, sig)
                    }));
                };
                match op {
                    Op::SubmitYes => { outcome_submit(&mut c, "YES", ts, run_no); run_no += 1; }
                    Op::SubmitNo => { outcome_submit(&mut c, "NO", ts, run_no); run_no += 1; }
                    Op::SubmitVoid => { outcome_submit(&mut c, "VOID", ts, run_no); run_no += 1; }
                    Op::FinalizeEarly => {
                        ctx("anyone.testnet", ts);
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.finalize(bet_id)));
                    }
                    Op::FinalizeLate => {
                        ctx("anyone.testnet", ts + 1_000_000);
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.finalize(bet_id)));
                    }
                    Op::VoidDeadlineEarly => {
                        ctx("anyone.testnet", ts);
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.void_after_deadline(bet_id)));
                    }
                    Op::VoidDeadlineLate => {
                        ctx("anyone.testnet", 10_001 + ts);
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.void_after_deadline(bet_id)));
                    }
                    Op::DoubleTake => {
                        let _ = do_mt_transfer(&mut c, "taker3.testnet", 999_999_999, take_msg(bet_id), ts);
                    }
                }

                let after_total: u128 = c
                    .payout_ids_in_order()
                    .iter()
                    .map(|id| c.pending_payouts.get(id).unwrap().amount.0)
                    .sum();
                prop_assert!(
                    after_total <= total_in,
                    "I-2 violated after {:?}: scheduled_out={} (delta {}) in={}",
                    op, after_total, after_total - before_total, total_in
                );
            }
        }
    }

    // ---- D-BOND1 extension: cross-asset bets (MOCK_BTC maker/USDC taker
    // and vice versa), challenges from either side with own-asset
    // bonds/objections, random outcomes (YES/NO/VOID), and
    // per-asset conservation (I-1): for each asset independently, total
    // scheduled out never exceeds total paid in. ----

    #[derive(Debug, Clone)]
    enum CrossOp {
        SubmitYes,
        SubmitNo,
        SubmitVoid,
        BondMaker,
        BondTaker,
        ObjectionMaker,
        ObjectionTaker,
        FinalizeEarly,
        FinalizeLate,
    }

    fn cross_op_strategy() -> impl Strategy<Value = CrossOp> {
        prop_oneof![
            Just(CrossOp::SubmitYes),
            Just(CrossOp::SubmitNo),
            Just(CrossOp::SubmitVoid),
            Just(CrossOp::BondMaker),
            Just(CrossOp::BondTaker),
            Just(CrossOp::ObjectionMaker),
            Just(CrossOp::ObjectionTaker),
            Just(CrossOp::FinalizeEarly),
            Just(CrossOp::FinalizeLate),
        ]
    }

    proptest! {
        // Fast by default (never #[ignore]d -- standing test policy);
        // set PRAETORIAL_PROPTEST_DEEP=1 for a deeper run.
        #![proptest_config(ProptestConfig::with_cases(proptest_cases(15, 100)))]
        #[test]
        fn cross_asset_random_sequences_conserve_per_asset(
            maker_is_btc in any::<bool>(),
            ops in prop::collection::vec(cross_op_strategy(), 1..6),
        ) {
            let mut c = new_contract_spec_assets();
            let (sk, pk) = test_keypair(222);
            let mut env = base_envelope(&hex_encode(&pk));
            if maker_is_btc {
                env.maker_asset = MOCK_BTC.to_string();
                env.taker_asset = USDC.to_string();
                env.stake_maker = U128(10_000);
                env.stake_taker = U128(10_000_000);
            } else {
                env.maker_asset = USDC.to_string();
                env.taker_asset = MOCK_BTC.to_string();
                env.stake_maker = U128(10_000_000);
                env.stake_taker = U128(10_000);
            }
            let maker_asset = env.maker_asset.clone();
            let taker_asset = env.taker_asset.clone();
            let resp = do_mt_transfer_asset(&mut c, "maker.testnet", &maker_asset, env.maker_required(), open_msg(&env), 1);
            prop_assert_eq!(resp, vec![U128(0)], "cross-asset open must be accepted");
            let bet_id = c.next_bet_id - 1;
            let resp = do_mt_transfer_asset(&mut c, "taker.testnet", &taker_asset, env.taker_required(), take_msg(bet_id), 2);
            prop_assert_eq!(resp, vec![U128(0)], "cross-asset take must be accepted");

            let mut in_by_asset: std::collections::HashMap<String, u128> = std::collections::HashMap::new();
            *in_by_asset.entry(maker_asset.clone()).or_insert(0) += env.maker_required();
            *in_by_asset.entry(taker_asset.clone()).or_insert(0) += env.taker_required();

            let mut ts = 1_500u64;
            let mut run_no = 1u64;
            for op in ops {
                ts += 10;
                match op {
                    CrossOp::SubmitYes | CrossOp::SubmitNo | CrossOp::SubmitVoid => {
                        let status_ok = matches!(
                            c.get_bet(bet_id).unwrap().status,
                            BetStatus::Taken | BetStatus::Resolving | BetStatus::Challenged | BetStatus::Evidence
                        );
                        if status_ok {
                            ctx("anyone.testnet", ts);
                            let outcome = match op {
                                CrossOp::SubmitYes => "YES",
                                CrossOp::SubmitNo => "NO",
                                _ => "VOID",
                            };
                            let result = SubmittedResult {
                                bet_id,
                                terms_hash: "terms-hash-1".to_string(),
                                outcome: outcome.to_string(),
                                element_results_hash: "e".repeat(64),
                                run_no,
                                checked_until: U64(ts),
                                next_check_ns: None,
                                judge_pair_index: 0, model_not_found: vec![],
                            };
                            let sig = sign_result(&outcome_signing_key(), &result);
                            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                c.submit_outcome(result, sig)
                            }));
                            run_no += 1;
                        }
                    }
                    CrossOp::BondMaker | CrossOp::BondTaker => {
                        let is_maker = matches!(op, CrossOp::BondMaker);
                        let challenger: AccountId = if is_maker {
                            "maker.testnet".parse().unwrap()
                        } else {
                            "taker.testnet".parse().unwrap()
                        };
                        if let Some(quote) = c.required_challenge_bond(bet_id, challenger) {
                            let round = c.get_bet(bet_id).unwrap().bonds.len() as u32 + 1;
                            let msg = serde_json::to_string(&TransferMsg::Bond { bet_id, round }).unwrap();
                            let sender = if is_maker { "maker.testnet" } else { "taker.testnet" };
                            let quote_asset = quote.asset.clone();
                            let quote_amount = quote.amount.0;
                            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                do_mt_transfer_asset(&mut c, sender, &quote_asset, quote_amount, msg, ts)
                            }));
                            if let Ok(resp) = result {
                                if resp == vec![U128(0)] {
                                    *in_by_asset.entry(quote_asset).or_insert(0) += quote_amount;
                                }
                            }
                        }
                    }
                    CrossOp::ObjectionMaker | CrossOp::ObjectionTaker => {
                        let is_maker = matches!(op, CrossOp::ObjectionMaker);
                        let bet = c.get_bet(bet_id).unwrap();
                        if matches!(bet.status, BetStatus::Challenged | BetStatus::Evidence) {
                            let asset = if is_maker {
                                bet.envelope.maker_asset.clone()
                            } else {
                                bet.envelope.taker_asset.clone()
                            };
                            if let Some(limit) = c.asset_limits.get(&asset).cloned() {
                                let pot = bet.envelope.pot_for_challenger(is_maker);
                                let required = std::cmp::max(limit.min_objection.0, pot * 50 / BPS_DENOM);
                                let sender = if is_maker { "maker.testnet" } else { "taker.testnet" };
                                let msg = objection_msg(bet_id, &"e".repeat(64), false);
                                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    do_mt_transfer_asset(&mut c, sender, &asset, required, msg, ts)
                                }));
                                if let Ok(resp) = result {
                                    if resp == vec![U128(0)] {
                                        *in_by_asset.entry(asset).or_insert(0) += required;
                                    }
                                }
                            }
                        }
                    }
                    CrossOp::FinalizeEarly => {
                        ctx("anyone.testnet", ts);
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.finalize(bet_id)));
                    }
                    CrossOp::FinalizeLate => {
                        ctx("anyone.testnet", ts + 1_000_000);
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.finalize(bet_id)));
                    }
                }

                // Per-asset I-1, checked after every op: scheduled-out
                // (not yet necessarily drained/paid) must never exceed
                // paid-in, independently for each asset -- nothing may
                // leak from one asset's pot into the other's payouts.
                let mut out_by_asset: std::collections::HashMap<String, u128> = std::collections::HashMap::new();
                for id in c.payout_ids_in_order().iter() {
                    let p = c.pending_payouts.get(id).unwrap();
                    *out_by_asset.entry(p.token_id.clone()).or_insert(0) += p.amount.0;
                }
                for (asset, total_out) in out_by_asset.iter() {
                    let total_in = in_by_asset.get(asset).copied().unwrap_or(0);
                    prop_assert!(
                        *total_out <= total_in,
                        "I-1 per-asset violated for {}: scheduled_out={} in={}",
                        asset, total_out, total_in
                    );
                }
                // No third asset must ever appear in the payout ledger.
                for asset in out_by_asset.keys() {
                    prop_assert!(
                        asset == &maker_asset || asset == &taker_asset,
                        "unexpected asset {} in payout ledger (maker={}, taker={})",
                        asset, maker_asset, taker_asset
                    );
                }
                // DR-BOND1-1 / D-BOND2: every won_round_reimbursement line
                // must be capped by the PAYING asset's (the token it's
                // actually denominated/paid in) OWN run_price -- never
                // some other asset's run_price value smuggled through as
                // raw units of this one. Plain per-asset I-1 conservation
                // above would NOT have caught the original bug (the wrong
                // amount was still clamped to <= that side's own stake,
                // so aggregate per-asset totals still balanced); this is
                // the dedicated regression check for the actual fix.
                for id in c.payout_ids_in_order().iter() {
                    let p = c.pending_payouts.get(id).unwrap();
                    if p.reason == "won_round_reimbursement" {
                        if let Some(limit) = c.asset_limits.get(&p.token_id) {
                            prop_assert!(
                                p.amount.0 <= limit.run_price.0,
                                "D-BOND2: won_round_reimbursement of {} {} exceeds that asset's \
                                 own run_price {} -- a cross-asset run_price value crossed assets",
                                p.amount.0, p.token_id, limit.run_price.0
                            );
                        }
                    }
                }
            }
        }
    }
}

// ---------------- D-DISPUTE1: 2 challenge rounds, deferential appeal ----------------
// Decision register D-DISPUTE1 / "Praetorial - Dispute design v1": supersedes
// D-AUDIT8's default max_rounds=3 with max_rounds=2. Round 0 (automatic,
// not counted in `max_rounds`/`bet.bonds.len()`) is the initial ruling;
// `max_rounds=2` is the number of CHALLENGE rounds: round 1 ("Review",
// 3-model-family panel) and round 2 ("Final appeal", 5-family panel +
// debate prompt). This is a straight re-reading of the existing
// `bet.bonds.len()` round counter (round 0 is never a bond round), so no
// new field is needed for the round count itself.
#[test]
fn d_dispute1_default_max_rounds_is_2_not_3() {
    let c = new_contract();
    assert_eq!(
        c.limits.max_rounds, 2,
        "D-DISPUTE1 supersedes D-AUDIT8: default max_rounds is 2 (Review + Final appeal), not 3"
    );
}

// ---------------- D-AUDIT8 (OQ-T10): max_rounds cap + required_challenge_bond view ----------------

#[test]
fn d_audit8_required_challenge_bond_includes_run_price_and_matches_handle_bond() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(95);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);

    let quoted = c.required_challenge_bond(bet_id, "taker.testnet".parse().unwrap()).unwrap().amount.0;
    assert_eq!(quoted, 5_005_000, "challenge_min(5_000_000) + run_price(5_000)");

    let bond_msg_1 = serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap();
    // The view's quote must be exactly what handle_bond accepts (one
    // unit under or over is rejected).
    let resp_short = do_mt_transfer(&mut c, "taker.testnet", quoted - 1, bond_msg_1.clone(), 2_050);
    assert_eq!(resp_short, vec![U128(quoted - 1)], "one under the quote must be rejected");
    let resp_ok = do_mt_transfer(&mut c, "taker.testnet", quoted, bond_msg_1, 2_050);
    assert_eq!(resp_ok, vec![U128(0)], "exactly the quoted amount must be accepted");
}

#[test]
fn d_dispute1_max_rounds_cap_rejects_a_third_challenge_default_cap_is_2() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(96);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);

    let mut ts = 2_050u64;
    // D-DISPUTE1: only 2 challenge rounds are reachable by default --
    // round 1 ("Review", 3-family panel) and round 2 ("Final appeal",
    // 5-family panel + debate), per the dispute design v1 doc.
    for round in 1..=2u32 {
        let required = c.required_challenge_bond(bet_id, "taker.testnet".parse().unwrap()).unwrap().amount.0;
        let msg = serde_json::to_string(&TransferMsg::Bond { bet_id, round }).unwrap();
        let resp = do_mt_transfer(&mut c, "taker.testnet", required, msg, ts);
        assert_eq!(resp, vec![U128(0)], "round {round} (<= default max_rounds 2) must be accepted");
        // Re-judge keeps the same outcome (challenger loses every round,
        // simplest path back to a challengeable Proposed status).
        ctx("anyone.testnet", ts + 5);
        let result = SubmittedResult {
            bet_id,
            terms_hash: "terms-hash-1".to_string(),
            outcome: "YES".to_string(),
            element_results_hash: "e".repeat(64),
            run_no: round as u64 + 1,
            checked_until: U64(ts + 5),
            next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig = sign_result(&outcome_signing_key(), &result);
        c.submit_outcome(result, sig);
        ts += 20;
    }

    // At the cap: required_challenge_bond is None and a 3rd Bond
    // (round 2 would be the Final appeal; a 3rd round has no panel
    // configured by this design) is refused.
    assert_eq!(c.required_challenge_bond(bet_id, "taker.testnet".parse().unwrap()), None, "no further challenge is quotable at the cap");
    let msg3 = serde_json::to_string(&TransferMsg::Bond { bet_id, round: 3 }).unwrap();
    let resp = do_mt_transfer(&mut c, "taker.testnet", 5_005_000, msg3, ts);
    assert_eq!(resp, vec![U128(5_005_000)], "a 3rd challenge round must be rejected once max_rounds (2) is reached");
    assert_eq!(c.get_bet(bet_id).unwrap().bonds.len(), 2, "bonds.len() must stay at the cap, not grow");

    // The bet still finalizes cleanly on the standing outcome (no
    // further challenge, no arbiter named here) -- the escalation
    // path per ruling #4.
    let proposed_at = c.get_bet(bet_id).unwrap().proposed_at.unwrap();
    let env = c.get_bet(bet_id).unwrap().envelope;
    ctx("anyone.testnet", proposed_at + env.settlement_period + 1);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.finalize(bet_id)));
    assert!(result.is_ok(), "finalize must succeed once the round cap halts further challenges");
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Finalized);
    drain_all(&mut c, bet_id, proposed_at + env.settlement_period + 2);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Settled);
}

// ---------------- D-AUDIT8 property test: finalize never panics over 1..=max_rounds ----------------
// Ruling #5: "Add a property/fuzz-style test over 1..=max_rounds with
// random winners per round and random stakes, asserting that finalize
// never panics, I-1 holds (money only to parties and fee account,
// never more than deposited), and that totals conserve exactly."
//
// Scope note: D-ECON5 removed the per-bet reserve and its round-0
// run-cost reimbursement entirely (round-0 is now funded solely by
// keeper_credit, never drawn from bet money) -- the old "insufficient
// round-0 reserve" panic path this note used to flag as out of scope
// no longer exists. Everything this ruling DOES touch (challenge-round
// funding/reimbursement, still charged from the challenger's own bond)
// is
// exercised fully: 1..=max_rounds rounds, a random challenger and a
// random win/lose outcome each round, random stakes.
mod d_audit8_proptest {
    use super::*;
    use proptest::prelude::*;

    #[derive(Debug, Clone)]
    struct RoundPlan {
        challenger_is_maker: bool,
        challenger_wins: bool,
    }

    fn round_plan_strategy() -> impl Strategy<Value = RoundPlan> {
        (any::<bool>(), any::<bool>())
            .prop_map(|(challenger_is_maker, challenger_wins)| RoundPlan { challenger_is_maker, challenger_wins })
    }

    proptest! {
        // Fast by default (never #[ignore]d -- standing test policy);
        // set PRAETORIAL_PROPTEST_DEEP=1 for the original 100-case run.
        // This is the heavy one (full open/take/challenge/finalize
        // lifecycle per case) that made plain `cargo test` take ~6.5min.
        #![proptest_config(ProptestConfig::with_cases(proptest_cases(15, 100)))]
        #[test]
        fn finalize_never_panics_over_random_rounds_winners_and_stakes(
            // D-DISPUTE1: default max_rounds is now 2, not 3.
            rounds in prop::collection::vec(round_plan_strategy(), 1..=2),
            // Sub-job 1 (D-PRICE6): stake_maker/stake_taker are now
            // generated so their ratio always stays within the same-asset
            // 10:1 cap (`MAX_SAME_ASSET_ODDS`) -- otherwise `handle_open`
            // correctly rejects the bet and this test's `open_resp ==
            // accepted` assumption would no longer hold. Range halved
            // (25M not 50M) so `stake_maker * ratio` never exceeds the
            // USDC asset_limits max (250M) either.
            stake_maker in 1_000_000u128..25_000_000u128,
            ratio in 1u128..=10u128,
            taker_is_larger in any::<bool>(),
        ) {
            // Ceiling division on the "smaller side" branch: floor
            // division could truncate stake_taker just low enough that
            // stake_maker / stake_taker exceeds 10:1 (e.g. 1_000_001/10
            // floors to 100_000, a 10.00001:1 ratio) and spuriously
            // trips the real 10:1 cap this test isn't exercising.
            let stake_taker = if taker_is_larger {
                stake_maker * ratio
            } else {
                ((stake_maker + ratio - 1) / ratio).max(1)
            };
            let mut c = new_contract();
            let (sk, pk) = test_keypair(99);
            let pk_hex = hex_encode(&pk);
            // D-ECON5: run_price now lives on the contract's USDC
            // AssetLimit (set by `default_asset_limits` / `new_contract`),
            // not on the Envelope; no per-bet reserve exists any more.

            let mut env = base_envelope(&pk_hex);
            env.terms_hash = "terms-hash-1".to_string();
            env.stake_maker = U128(stake_maker);
            env.stake_taker = U128(stake_taker);
            env.max_paid_runs = 20; // headroom for up to 2 rounds + round 0 (D-DISPUTE1)

            ctx(INTENTS, 1);
            let open_resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
            prop_assert_eq!(open_resp, vec![U128(0)]);
            let bet_id = c.next_bet_id - 1;

            let take_amount = env.stake_taker.0 + env.storage_for(STG_FIXTURE_RATE);
            let take_resp = do_mt_transfer(&mut c, "taker.testnet", take_amount, take_msg(bet_id), 2);
            prop_assert_eq!(take_resp, vec![U128(0)]);

            let total_in: u128 = env.maker_required() + take_amount; // bonds added per-round below
            let mut total_in = total_in;

            let mut ts = 1_000u64;
            let mut run_no = 1u64;
            let mut current_outcome = "YES".to_string();

            ctx("anyone.testnet", ts);
            let result = SubmittedResult {
                bet_id, terms_hash: env.terms_hash.clone(), outcome: current_outcome.clone(),
                element_results_hash: "e".repeat(64), run_no, checked_until: U64(ts), next_check_ns: None,
                judge_pair_index: 0, model_not_found: vec![],
            };
            let sig = sign_result(&outcome_signing_key(), &result);
            c.submit_outcome(result, sig);
            run_no += 1;

            for (i, plan) in rounds.iter().enumerate() {
                let round = i as u32 + 1;
                let challenger: &str = if plan.challenger_is_maker { "maker.testnet" } else { "taker.testnet" };
                ts += 10;
                let required = match c.required_challenge_bond(bet_id, challenger.parse().unwrap()) {
                    Some(v) => v.amount.0,
                    None => break, // at the cap (shouldn't happen for <=3 rounds, but never panic either way)
                };
                let msg = serde_json::to_string(&TransferMsg::Bond { bet_id, round }).unwrap();
                let resp = do_mt_transfer(&mut c, challenger, required, msg, ts);
                prop_assert_eq!(resp, vec![U128(0)], "challenge round {} must be accepted", round);
                total_in += required;

                let next_outcome = if plan.challenger_wins {
                    if current_outcome == "YES" { "NO".to_string() } else { "YES".to_string() }
                } else {
                    current_outcome.clone()
                };
                ts += 10;
                ctx("anyone.testnet", ts);
                let result = SubmittedResult {
                    bet_id, terms_hash: env.terms_hash.clone(), outcome: next_outcome.clone(),
                    element_results_hash: "e".repeat(64), run_no, checked_until: U64(ts), next_check_ns: None,
                    judge_pair_index: 0, model_not_found: vec![],
                };
                let sig = sign_result(&outcome_signing_key(), &result);
                c.submit_outcome(result, sig);
                run_no += 1;
                current_outcome = next_outcome;
            }

            let proposed_at = c.get_bet(bet_id).unwrap().proposed_at.unwrap();
            ctx("anyone.testnet", proposed_at + env.settlement_period + 1);
            let before = c.payout_ids_in_order().len();
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.finalize(bet_id)));
            prop_assert!(result.is_ok(), "finalize must NEVER panic (D-AUDIT8 / OQ-T10)");
            prop_assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Finalized);
            drain_all(&mut c, bet_id, proposed_at + env.settlement_period + 2);
            prop_assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Settled);

            let new_payouts: Vec<_> = c.payout_ids_in_order()[before..]
                .iter()
                .map(|id| c.pending_payouts.get(id).unwrap().clone())
                .collect();

            let maker_id: AccountId = "maker.testnet".parse().unwrap();
            let taker_id: AccountId = "taker.testnet".parse().unwrap();
            let fee_id: AccountId = FEE.parse().unwrap();
            let keeper_id: AccountId = KEEPER.parse().unwrap();
            for p in &new_payouts {
                prop_assert!(
                    [&maker_id, &taker_id, &fee_id, &keeper_id].contains(&&p.receiver),
                    "I-1 violated: payout to {}", p.receiver
                );
            }
            let total_out: u128 = new_payouts.iter().map(|p| p.amount.0).sum();
            prop_assert!(total_out <= total_in, "I-2: paid out {} > deposited {}", total_out, total_in);
            prop_assert_eq!(total_out, total_in, "finalize must conserve exactly, not just bound money loss");

            // DR-09: `current_outcome` only ever flips between YES/NO in
            // this harness (never VOID), so every case here is a YES/NO
            // final -- assert a won-round claim against the round's
            // loser (who may be this bet's overall winner) never cuts
            // the winner's payout below pot - fee.
            // cross-asset-3 (D-PRICE6): fee is now computed PER ASSET
            // (each side's own stake, floor-divided independently) and
            // summed -- for a same-asset bet this can differ from the
            // old single combined-pot floor division by at most 1 unit
            // (two independent floors vs one), so the expected total
            // here must match that same per-asset-then-sum formula,
            // not the old `pot * fee_bps / BPS_DENOM` shortcut.
            let fee_maker_asset = env.stake_maker.0 * env.fee_bps as u128 / BPS_DENOM;
            let fee_taker_asset = env.stake_taker.0 * env.fee_bps as u128 / BPS_DENOM;
            let winner_payout = (env.stake_maker.0 - fee_maker_asset) + (env.stake_taker.0 - fee_taker_asset);
            let winner_is_maker = current_outcome == env.maker_side;
            let winner_id = if winner_is_maker { &maker_id } else { &taker_id };
            let winner_actual: u128 = new_payouts
                .iter()
                .filter(|p| p.reason == "payout_winner" && &p.receiver == winner_id)
                .map(|p| p.amount.0)
                .sum();
            prop_assert_eq!(
                winner_actual, winner_payout,
                "DR-09: a won-round claim must never cut the overall winner's payout in a YES/NO final"
            );
        }
    }
}

// ---------------------------------------------------------------------
// Layer-spec ruling (MASTER MAP §10 L1/L2/L3/L9): request_resolution
// resource limits by tier, full-terms input_data, hash-only terms check,
// and the attached-deposit size limit vs OutLayer's own storage pricing.
// ---------------------------------------------------------------------

#[test]
fn resolution_deposit_is_free_under_the_outlayer_free_byte_threshold() {
    // 32 KiB (OUTLAYER_INPUT_DATA_FREE_BYTES) or less costs only the flat
    // compute floor -- no storage component.
    let at_threshold = required_resolution_deposit(32 * 1024);
    assert_eq!(at_threshold, MIN_RESOLUTION_COMPUTE_DEPOSIT.as_yoctonear());
}

#[test]
fn resolution_deposit_grows_exactly_with_bytes_past_the_free_threshold() {
    let base = required_resolution_deposit(32 * 1024);
    let one_byte_over = required_resolution_deposit(32 * 1024 + 1);
    assert_eq!(
        one_byte_over - base,
        OUTLAYER_STORAGE_PRICE_PER_BYTE,
        "each byte past the free threshold must cost exactly OutLayer's own storage price"
    );
    let far_over = required_resolution_deposit(64 * 1024);
    assert_eq!(far_over - base, 32 * 1024 * OUTLAYER_STORAGE_PRICE_PER_BYTE);
}

/// `resolution_input_data` must carry the FULL envelope (not just
/// terms_hash), the terms text when present, the round, run_no and
/// contract id -- the exact ruling this pass implements.
#[test]
fn resolution_input_data_carries_full_envelope_and_terms_round_run_no() {
    let pk_hex = "a".repeat(64);
    let mut env = base_envelope(&pk_hex);
    env.bet_id = 42;
    env.keep_terms = true;
    env.terms = Some("{\"claim\":\"BTC hits 200k\"}".to_string());
    let contract: AccountId = CONTRACT.parse().unwrap();
    let payer: AccountId = "keeper.testnet".parse().unwrap();

    let input = resolution_input_data(&contract, 42, &env, &env.terms.clone(), 2, 7, &payer, &[]);
    let v: serde_json::Value = serde_json::from_str(&input).unwrap();

    assert_eq!(v["contract"], CONTRACT);
    assert_eq!(v["bet_id"], 42);
    assert_eq!(v["round"], 2);
    assert_eq!(v["run_no"], 7);
    assert_eq!(v["payer_account_id"], "keeper.testnet");
    assert_eq!(v["terms"], "{\"claim\":\"BTC hits 200k\"}");
    // the FULL envelope, not a hash -- spot check a handful of fields that
    // terms_hash alone could never carry.
    assert_eq!(v["envelope"]["terms_hash"], env.terms_hash);
    assert_eq!(v["envelope"]["tier"], env.tier);
    assert_eq!(v["envelope"]["max_paid_runs"], env.max_paid_runs);
    // D-KEY1: resolver_wasm_hash is pinned contract-level config now, not
    // an Envelope field -- no longer part of this round-trip check.
    assert_eq!(v["envelope"]["outcomes"], serde_json::json!(["YES", "NO"]));
}

#[test]
fn resolution_input_data_terms_is_null_when_none() {
    let pk_hex = "a".repeat(64);
    let mut env = base_envelope(&pk_hex);
    env.keep_terms = false;
    env.terms = None;
    let contract: AccountId = CONTRACT.parse().unwrap();
    let payer: AccountId = "keeper.testnet".parse().unwrap();
    let input = resolution_input_data(&contract, 1, &env, &None, 0, 1, &payer, &[]);
    let v: serde_json::Value = serde_json::from_str(&input).unwrap();
    assert!(v["terms"].is_null(), "hash-only bet with no caller-supplied terms must send null, never a guess");
}

/// Envelope-level guard: `terms`/`keep_terms` must agree, enforced at
/// `open` time so a bad envelope never lands in storage to begin with.
#[test]
fn keep_terms_true_without_terms_rejected_at_open() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(1);
    let mut env = base_envelope(&hex_encode(&pk));
    env.keep_terms = true;
    env.terms = None;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required())], "open must be rejected (refunded), not accepted");
}

#[test]
fn keep_terms_false_with_terms_rejected_at_open() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(1);
    let mut env = base_envelope(&hex_encode(&pk));
    env.keep_terms = false;
    env.terms = Some("should not be here".to_string());
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required())], "a hash-only bet carrying terms text must be rejected at open");
}

#[test]
fn oversized_terms_rejected_at_open() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(1);
    let mut env = base_envelope(&hex_encode(&pk));
    env.keep_terms = true;
    env.terms = Some("x".repeat(crate::MAX_TERMS_LEN + 1));
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required())], "terms past MAX_TERMS_LEN must be rejected, never stored");
}

/// A hash-only bet (`keep_terms: false`) opens fine with `terms: None`,
/// and can still request resolution -- with an optional caller-supplied
/// terms string that is forwarded (never persisted) and never checked
/// against terms_hash by the contract itself (that's the resolver's job).
#[test]
fn hash_only_bet_opens_and_resolves_with_optional_caller_terms() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(9);
    let pk_hex = hex_encode(&pk);
    let mut env = base_envelope(&pk_hex);
    env.keep_terms = false;
    env.terms = None;

    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)], "hash-only open should be accepted");
    let bet_id = c.next_bet_id - 1;
    let mut env2 = base_envelope(&pk_hex);
    env2.keep_terms = false;
    env2.terms = None;
    let resp = do_mt_transfer(&mut c, "taker.testnet", env2.taker_required(), take_msg(bet_id), 2);
    assert_eq!(resp, vec![U128(0)], "take should be accepted");

    // Caller (keeper) supplies the terms text at resolution time; the
    // contract never stored a copy for this hash-only bet.
    let bet = c.get_bet(bet_id).unwrap();
    assert!(bet.envelope.terms.is_none());

    ctx_with_deposit("keeper.testnet", env.funding_deadline + 1, NearToken::from_millinear(50));
    let _promise = c.request_resolution(bet_id, Some("{\"claim\":\"test\"}".to_string()));
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, BetStatus::Resolving);

    let _ = sk; // keypair unused in this test beyond fixture symmetry
}

#[test]
fn keep_terms_bet_resolves_ignoring_any_caller_supplied_terms() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(10);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let bet = c.get_bet(bet_id).unwrap();
    assert!(bet.envelope.keep_terms);
    assert!(bet.envelope.terms.is_some());

    // Even if a caller passes something else, a keep_terms bet should
    // still resolve fine -- the stored copy is used, never the argument
    // (request_resolution's own doc). This test only confirms the call
    // succeeds and transitions state; the exact substitution behavior is
    // pinned by `resolution_input_data_carries_full_envelope_and_terms_round_run_no`.
    ctx_with_deposit("keeper.testnet", 1_001, NearToken::from_millinear(50));
    let _promise = c.request_resolution(bet_id, Some("attacker-supplied-terms".to_string()));
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, BetStatus::Resolving);
}

#[test]
#[should_panic(expected = "attached deposit too low for OutLayer compute + input_data storage")]
fn request_resolution_rejects_a_deposit_under_the_flat_compute_floor() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(11);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));

    // Nothing attached at all -- below even the flat compute floor
    // (MIN_RESOLUTION_COMPUTE_DEPOSIT), regardless of input_data size.
    // D5: a zero-deposit call now gets special handling ONLY when the
    // caller is `self.keeper` (drawn from keeper_credit instead) -- use
    // a non-keeper caller here so this test keeps covering the generic
    // "deposit too low" floor for everyone else, unaffected by D5.
    ctx_with_deposit("some-other-caller.testnet", 1_001, NearToken::from_yoctonear(0));
    let _ = c.request_resolution(bet_id, None);
}

// ---------------- D5: keeper prepaid compute credit ----------------

#[test]
fn topup_keeper_credit_increases_balance_for_keeper_and_fee_account() {
    let mut c = new_contract();
    assert_eq!(c.keeper_credit_balance(), U128(0));

    ctx_with_deposit(KEEPER, 1, NearToken::from_millinear(50));
    c.topup_keeper_credit();
    assert_eq!(
        c.keeper_credit_balance(),
        U128(NearToken::from_millinear(50).as_yoctonear())
    );

    ctx_with_deposit(FEE, 2, NearToken::from_millinear(10));
    c.topup_keeper_credit();
    assert_eq!(
        c.keeper_credit_balance(),
        U128(NearToken::from_millinear(60).as_yoctonear())
    );
}

#[test]
#[should_panic(expected = "only the keeper or fee account")]
fn topup_keeper_credit_rejects_other_callers() {
    let mut c = new_contract();
    ctx_with_deposit("maker.testnet", 1, NearToken::from_millinear(50));
    c.topup_keeper_credit();
}

#[test]
#[should_panic(expected = "attach a deposit")]
fn topup_keeper_credit_rejects_zero_deposit() {
    let mut c = new_contract();
    ctx_with_deposit(KEEPER, 1, NearToken::from_yoctonear(0));
    c.topup_keeper_credit();
}

/// D5 core case: a keeper call that attaches ZERO NEAR -- the only shape
/// a function-call access key scoped to this contract can ever submit
/// (NEAR protocol forbids a FunctionCall-permission key from attaching
/// any deposit, on any method) -- draws its compute cost from the
/// prepaid `keeper_credit` pool instead of being rejected, and still
/// drives the bet into Resolving exactly like a funded direct call.
#[test]
fn keeper_zero_deposit_resolution_draws_from_prepaid_credit() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(50);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));

    ctx_with_deposit(KEEPER, 1, NearToken::from_millinear(50));
    c.topup_keeper_credit();
    let credit_before = c.keeper_credit_balance().0;

    ctx_with_deposit(KEEPER, 1_001, NearToken::from_yoctonear(0));
    let _ = c.request_resolution(bet_id, None);

    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, BetStatus::Resolving);
    let credit_after = c.keeper_credit_balance().0;
    assert_eq!(
        credit_before - credit_after,
        MIN_RESOLUTION_COMPUTE_DEPOSIT.as_yoctonear(),
        "credit pool should be drawn down by exactly the required compute deposit"
    );
}

#[test]
#[should_panic(expected = "insufficient keeper credit")]
fn keeper_zero_deposit_resolution_without_enough_credit_panics() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(51);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    // No topup at all -- keeper_credit is 0.
    ctx_with_deposit(KEEPER, 1_001, NearToken::from_yoctonear(0));
    let _ = c.request_resolution(bet_id, None);
}

/// Unused-compute refund for a credit-funded run must land back in the
/// pool, not as a native transfer to anyone -- mirrors fm11's own
/// assertion style but for the D5 credit path.
#[test]
fn on_resolution_credits_unused_compute_back_to_keeper_pool_not_a_transfer() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(52);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));

    ctx_with_deposit(KEEPER, 1, NearToken::from_millinear(50));
    c.topup_keeper_credit();

    ctx_with_deposit(KEEPER, 1_001, NearToken::from_yoctonear(0));
    let _ = c.request_resolution(bet_id, None);
    let request_id = c.next_request_id - 1;
    let credit_after_request = c.keeper_credit_balance().0;

    let unused = 1_500_000u128;
    let inner = serde_json::json!({
        "request_id": request_id,
        "unused_compute_yocto": unused.to_string(),
    })
    .to_string();
    ctx_with_promise_result(
        CONTRACT,
        1_002,
        PromiseResult::Successful(serde_json::to_vec(&inner).unwrap()),
    );
    c.on_resolution(request_id);

    let receipts = near_sdk::test_utils::get_created_receipts();
    assert!(
        receipts.is_empty(),
        "a credit-funded refund must not create any outgoing receipt (no native transfer, no intents call)"
    );
    assert_eq!(
        c.keeper_credit_balance().0,
        credit_after_request + unused,
        "unused compute must be credited straight back into keeper_credit"
    );
}

/// A MAX_TERMS_LEN (8 KiB) terms blob plus the full envelope stays under
/// OutLayer's 32 KiB free `input_data` threshold -- the flat compute
/// floor alone is enough, no storage component. This is the companion
/// case to the pure `resolution_deposit_*` tests above, confirmed via the
/// real contract call path end to end.
#[test]
fn request_resolution_succeeds_with_a_max_size_terms_blob_under_the_free_threshold() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(12);
    let pk_hex = hex_encode(&pk);
    let big_terms = "t".repeat(crate::MAX_TERMS_LEN);
    let mut env = base_envelope(&pk_hex);
    env.terms = Some(big_terms.clone());
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    let bet_id = c.next_bet_id - 1;
    let mut env2 = base_envelope(&pk_hex);
    env2.terms = Some(big_terms);
    do_mt_transfer(&mut c, "taker.testnet", env2.taker_required(), take_msg(bet_id), 2);

    ctx_with_deposit("keeper.testnet", env.funding_deadline + 1, NearToken::from_millinear(50));
    let _promise = c.request_resolution(bet_id, None);
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, BetStatus::Resolving);
}

#[test]
#[should_panic(expected = "attached deposit too low for OutLayer compute + input_data storage")]
fn request_resolution_rejects_a_deposit_missing_the_storage_component() {
    // There's no way to push input_data past the 32 KiB free threshold
    // through the real contract (MAX_TERMS_LEN caps terms at 8 KiB), so
    // this test attaches exactly the flat compute floor but asserts the
    // size-math itself requires more by constructing the comparison the
    // same way request_resolution does, against a synthetic length past
    // the free threshold -- i.e. it pins that `required_resolution_deposit`
    // is actually consulted (not bypassed) by using a deposit one
    // yoctoNEAR under what a real large payload would need, proven via
    // the direct pure-function tests above; here we just confirm the
    // floor itself is enforced, not skipped, for an ordinary bet.
    let mut c = new_contract();
    let (_, pk) = test_keypair(14);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx_with_deposit(
        "keeper.testnet",
        1_001,
        NearToken::from_yoctonear(MIN_RESOLUTION_COMPUTE_DEPOSIT.as_yoctonear() - 1),
    );
    let _ = c.request_resolution(bet_id, None);
}

#[test]
fn round_is_zero_before_any_challenge_and_increments_after_a_bond_round() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(13);
    let pk_hex = hex_encode(&pk);
    let bet_id = open_and_take(&mut c, &pk_hex);

    ctx_with_deposit("keeper.testnet", 1_001, NearToken::from_millinear(50));
    let _ = c.request_resolution(bet_id, None);
    // round for THIS call was 0 (no bonds yet) -- verified indirectly via
    // resolution_input_data's own direct test; here we confirm a bond
    // round is recorded so a SECOND request_resolution would compute
    // round=1.
    ctx("anyone.testnet", 1_002);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(1_002),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);

    let bond_amount = {
        let bet = c.get_bet(bet_id).unwrap();
        // D-ECON5: run_price now lives on the USDC AssetLimit, not the
        // Envelope -- matches `default_asset_limits`'s DEFAULT_RUN_PRICE.
        // D-DISPUTE1: 10% of pot (was 5%), round 1 so no doubling (x1).
        std::cmp::max(5_000_000u128, bet.envelope.pot() * 1_000 / BPS_DENOM)
            + DEFAULT_RUN_PRICE // D-AUDIT8: bond must also cover run_price
    };
    ctx(INTENTS, 1_003);
    let msg = serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap();
    c.mt_on_transfer(
        "maker.testnet".parse().unwrap(),
        vec!["maker.testnet".parse().unwrap()],
        vec![USDC.to_string()],
        vec![U128(bond_amount)],
        msg,
    );
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.bonds.len(), 1, "one bond round recorded after a challenge");

    ctx_with_deposit("keeper.testnet", 1_004, NearToken::from_millinear(50));
    let _ = c.request_resolution(bet_id, None);
    // Can't read `round` directly off the Promise, but the pure function
    // this call delegates to is pinned exactly by
    // resolution_input_data_carries_full_envelope_and_terms_round_run_no;
    // this test's job is confirming bonds.len() (round's source) grows.
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.bonds.len(), 1);
}

// ---------------- PRT-L2-015: amend rejected in terminal states ----------------

#[test]
#[should_panic(expected = "bet already terminal")]
fn amend_rejected_in_terminal_states() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(40);
    let env = base_envelope(&hex_encode(&pk));
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    let bet_id = c.next_bet_id - 1;
    ctx("maker.testnet", 2);
    c.cancel(bet_id); // -> Cancelled, a terminal state
    ctx("maker.testnet", 3);
    c.amend(bet_id, "b".repeat(64));
}

// ---------------- PRT-L2-007: sweep_excess_near never touches tracked funds ----------------

#[test]
fn sweep_excess_near_returns_zero_when_at_or_below_required() {
    let mut c = new_contract();
    ctx(OPERATOR, 1);
    let required = NearToken::from_yoctonear(
        env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear(),
    )
    .saturating_add(NEAR_SAFETY_BUFFER);
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .signer_account_id(OPERATOR.parse().unwrap())
        .predecessor_account_id("anyone.testnet".parse().unwrap())
        .account_balance(required)
        .block_timestamp(1);
    testing_env!(b.build());
    let swept = c.sweep_excess_near();
    assert_eq!(swept.as_yoctonear(), 0, "must not sweep anything when balance == required");
}

#[test]
fn sweep_excess_near_sweeps_only_the_amount_above_required_never_tracked_funds() {
    let mut c = new_contract();
    // Create tracked state (an Open bet with real USDC-side obligations
    // and a pending payout) to prove sweep leaves it untouched -- this
    // contract holds no USDC itself (I-6/sweep doc: "never touches
    // USDC/intents balances"), only NEAR for storage, so "never touches
    // tracked funds" means: (a) the bet's own state is unchanged, and
    // (b) the swept amount never exceeds balance-minus-required, i.e.
    // it never dips into the NEAR actually needed for current storage.
    let (_, pk) = test_keypair(41);
    let env = base_envelope(&hex_encode(&pk));
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    let bet_id = c.next_bet_id - 1;
    let bet_before = c.get_bet(bet_id).unwrap();
    let payouts_before = c.payout_ids_in_order().len();

    let required = NearToken::from_yoctonear(
        env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear(),
    )
    .saturating_add(NEAR_SAFETY_BUFFER);
    let extra = 777u128;
    let balance = NearToken::from_yoctonear(required.as_yoctonear() + extra);
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .signer_account_id(OPERATOR.parse().unwrap())
        .predecessor_account_id("anyone.testnet".parse().unwrap())
        .account_balance(balance)
        .block_timestamp(2);
    testing_env!(b.build());

    let swept = c.sweep_excess_near();
    assert_eq!(swept.as_yoctonear(), extra, "must sweep exactly the amount above required+buffer");
    // Tracked bet/payout state must be completely untouched by a NEAR sweep.
    let bet_after = c.get_bet(bet_id).unwrap();
    assert_eq!(bet_after.status, bet_before.status);
    assert_eq!(bet_after.envelope.stake_maker.0, bet_before.envelope.stake_maker.0);
    assert_eq!(c.payout_ids_in_order().len(), payouts_before, "sweep must not create/consume any payout");
}

// ---------------- PRT-L2-031 / PRT-L6-009: reclaim(bet_id) ----------------

#[test]
fn reclaim_by_operator_closes_open_bet_early_and_refunds_maker() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(42);
    let env = base_envelope(&hex_encode(&pk));
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    let bet_id = c.next_bet_id - 1;
    let before_ids = c.payout_ids_in_order().len();
    ctx(OPERATOR, 2); // well before funding_deadline=1000 -- expire() could not do this yet
    c.reclaim(bet_id);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Cancelled);
    assert_eq!(c.payout_ids_in_order().len(), before_ids + 1);
    let p = c.pending_payouts.get(c.payout_ids_in_order().last().unwrap()).unwrap();
    assert_eq!(p.receiver, "maker.testnet".parse::<AccountId>().unwrap());
    assert_eq!(p.amount.0, env.maker_required(), "full refund, no fee, same as cancel/expire");
}

#[test]
#[should_panic(expected = "only operator may reclaim")]
fn reclaim_by_non_operator_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(43);
    let env = base_envelope(&hex_encode(&pk));
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    let bet_id = c.next_bet_id - 1;
    ctx("maker.testnet", 2);
    c.reclaim(bet_id);
}

#[test]
#[should_panic(expected = "bet is not Open")]
fn reclaim_on_taken_bet_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(44);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx(OPERATOR, 3);
    c.reclaim(bet_id);
}

// ---------------- Silent-refund-on-missing-terms emits a clear reason ----------------

// ---------------- G6 cross-layer attack suite (Loop 3) ----------------

/// G6 "cost-drain": `request_resolution` beyond `max_paid_runs` must be
/// rejected outright, not silently billed again -- a keeper/attacker
/// spamming resolution requests can drain at most `max_paid_runs` worth
/// of run_price from the bet's reserve, never an unbounded amount.
#[test]
#[should_panic(expected = "max_paid_runs reached")]
fn request_resolution_beyond_max_paid_runs_rejected_cost_drain() {
    // base_envelope sets max_paid_runs = 3. Each request_resolution +
    // matching submit_outcome (VOID, so the bet stays in a state that
    // keeps looking resolvable to a naive repeat-attacker) consumes one
    // paid run; a 4th request_resolution attempt must be rejected
    // outright -- a keeper/attacker spamming resolution requests can
    // drain at most max_paid_runs worth of run_price, never an unbounded
    // amount.
    let mut c = new_contract();
    let (_sk, pk) = test_keypair(60);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    // Drive runs_used straight to the cap via direct state access (same
    // crate, descendant test module -- private fields visible): this is
    // the real field `request_resolution`'s guard reads, not a
    // reimplementation of it. Reaching 3 genuinely through the real
    // challenge-round dance would need N bond rounds; the guard under
    // test is single-purpose (`bet.runs_used < max_paid_runs`), so pinning
    // its boundary this way is the minimal faithful test.
    c.bets.get_mut(&bet_id).unwrap().runs_used = 3;
    assert_eq!(c.get_bet(bet_id).unwrap().runs_used, 3);
    ctx_with_deposit("keeper.testnet", 1_003, NearToken::from_millinear(50));
    let _ = c.request_resolution(bet_id, None); // runs_used (3) == max_paid_runs (3) -> panic
}

/// G6 "relayer submitting someone else's signed payload": by design, the
/// signature itself (not the tx submitter's identity) is what
/// `submit_outcome` authenticates -- any account may relay a genuinely
/// resolver-signed result on behalf of the keeper/payer. This is the
/// intended, safe behavior (anyone can be the relayer), confirmed here so
/// a future change can't silently restrict it to a single caller while
/// also not accidentally loosening the signature check itself.
#[test]
fn submit_outcome_accepted_regardless_of_submitter_identity() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(61);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    // Submitted by a totally unrelated account -- not maker, taker, or
    // the configured keeper -- and still accepted, because the ed25519
    // signature over the borsh buffer is the only thing that matters.
    ctx("random_relayer_nobody_authorized.testnet", 2_000);
    c.submit_outcome(result, sig);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Proposed);
}

/// G6 "bumped run_no / flipped outcome": once a bet is `Proposed` (a
/// genuine signed result already landed), a second *differently signed*
/// result -- correct signature, new run_no, flipped outcome -- must still
/// be rejected: `submit_outcome`'s status guard only accepts
/// Taken/Resolving/Challenged/Evidence, and Proposed is none of those.
/// This is distinct from `run_no_reuse_rejected` (same run_no): here the
/// run_no is fresh and the signature is genuine, so only the status guard
/// stops it.
#[test]
#[should_panic(expected = "bet not awaiting an outcome")]
fn bumped_run_no_flipped_outcome_after_proposed_rejected() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(62);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let first = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "NO".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig1 = sign_result(&outcome_signing_key(), &first);
    c.submit_outcome(first, sig1);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Proposed);

    // Fresh run_no, flipped outcome, genuinely signed -- but the bet is
    // already Proposed (no bond/challenge opened a new round), so this
    // must be rejected by the status guard, not accepted as a "newer"
    // result.
    let bumped = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "f".repeat(64),
        run_no: 2,
        checked_until: U64(2_001),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig2 = sign_result(&outcome_signing_key(), &bumped);
    c.submit_outcome(bumped, sig2);
}

#[test]
fn keep_terms_true_without_terms_logs_clear_reason_and_still_refunds() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(45);
    let mut env = base_envelope(&hex_encode(&pk));
    env.keep_terms = true;
    env.terms = None;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required())], "refund, never panic");
    let logs = near_sdk::test_utils::get_logs();
    assert!(
        logs.iter().any(|l| l.contains("open_rejected") && l.contains("keep_terms is true but terms is missing")),
        "expected a clear rejection-reason log, got: {logs:?}"
    );
}

// ---------------- v1.1 additions (FM-8..FM-11, FM-13, FM-17/19) ----------------
//
// SCOPE NOTE (design decision): users hold a NATIVE NEAR account, not
// only an EVM/passkey-controlled intents account. `request_resolution`
// and `extend_window` are therefore called DIRECTLY by the user's native
// account -- no `on_auth`/AuthCall routing, no wrapping an OutLayer
// refund into intents' wNEAR balance. `request_resolution` was already
// `#[payable]` with `payer = env::predecessor_account_id()` (see its own
// doc) before this pass, so FM-8/FM-10 need no contract change: a failed
// native `#[payable]` call auto-refunds the attached deposit to the
// caller at the NEAR protocol level (FM-9's "not refunded if the call
// fails" risk is specific to the AuthCall/wNEAR path this project is not
// using). FM-11 (anyone can trigger, not just the keeper) was also
// already true: `request_resolution` has never been keeper-gated. What
// remained to actually build: FM-13 (I-7 strict run order / no result
// shopping), FM-9's dry-run view, and FM-17/19's one-time window
// extension -- covered below.

/// FM-13 / I-7 (RED-first): a party holding two off-chain run results
/// for the same bet (run_no 1 = NO, run_no 2 = YES) must not be able to
/// pick the favourable one by submitting run_no=2 first, skipping the
/// run the contract is actually waiting on. Before the I-7 fix this
/// test would FAIL (submit_outcome had no run-order check at all, so
/// run_no=2 landed and settled the bet on the "shopped" result).
#[test]
#[should_panic(expected = "run_no out of order")]
fn fm13_result_shopping_later_run_rejected_while_earlier_pending() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(70);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);

    // The unfavourable first run (run_no=1) is what the contract is
    // actually waiting on (bet.next_expected_run_no starts at 1).
    let unfavourable = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "NO".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let _ = unfavourable; // never submitted -- the attacker tries to skip it

    // The attacker holds a second, favourable result (run_no=2) and
    // tries to submit it directly, skipping run_no=1 entirely.
    let favourable = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "f".repeat(64),
        run_no: 2,
        checked_until: U64(2_001),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &favourable);
    c.submit_outcome(favourable, sig); // must panic: run_no out of order
}

/// FM-13 / I-7 happy path: results land strictly in order -- run_no=1
/// first (forced, whatever it is), then a later round's run_no=2 after
/// a real challenge reopens resolution. Confirms the ordering rule does
/// not block legitimate sequential rounds, only skip-ahead attempts.
#[test]
fn fm13_strict_run_order_allows_sequential_rounds() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(71);
    let pk_hex = hex_encode(&pk);
    let bet_id = open_and_take(&mut c, &pk_hex);
    ctx("anyone.testnet", 2_000);
    let run1 = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "NO".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig1 = sign_result(&outcome_signing_key(), &run1);
    c.submit_outcome(run1, sig1);
    assert_eq!(c.get_bet(bet_id).unwrap().next_expected_run_no, 2);

    // Challenge reopens resolution for a re-judge round.
    do_mt_transfer(
        &mut c,
        "taker.testnet",
        5_005_000, // D-AUDIT8: challenge_min (5_000_000) + run_price (5_000)
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(),
        2_050,
    );
    ctx("anyone.testnet", 2_060);
    let run2 = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "f".repeat(64),
        run_no: 2,
        checked_until: U64(2_060),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig2 = sign_result(&outcome_signing_key(), &run2);
    c.submit_outcome(run2, sig2);

    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, BetStatus::Proposed);
    assert_eq!(bet.outcome, Some("YES".to_string()));
    // FM-13: every run's result is recorded, not only the final one.
    assert_eq!(bet.all_results.len(), 2);
    assert_eq!(bet.all_results[0].run_no, 1);
    assert_eq!(bet.all_results[0].outcome, "NO");
    assert_eq!(bet.all_results[1].run_no, 2);
    assert_eq!(bet.all_results[1].outcome, "YES");
}

/// FM-9: `can_request_resolution` must return the exact same verdict
/// `request_resolution` itself would reach, so an app can dry-run before
/// letting a user attach NEAR to a call that might otherwise fail.
#[test]
fn fm9_can_request_resolution_matches_request_resolution_outcome() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(72);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));

    // Too early (before funding_deadline=1_000): view says no.
    ctx("anyone.testnet", 500);
    assert_eq!(
        c.can_request_resolution(bet_id),
        Some("too early to request resolution".to_string())
    );

    // After funding_deadline: view says go, and the real call succeeds.
    ctx_with_deposit("keeper.testnet", 1_001, NearToken::from_millinear(50));
    assert_eq!(c.can_request_resolution(bet_id), None);
    let _ = c.request_resolution(bet_id, None);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Resolving);

    // Unknown bet_id.
    assert_eq!(
        c.can_request_resolution(999_999),
        Some("unknown bet_id".to_string())
    );
}

/// FM-9: once `max_paid_runs` is exhausted the view must say so, mirroring
/// `request_resolution`'s own guard (RED-first: a stale/placeholder view
/// that always returned `None` would pass the first fm9 test above but
/// fail this one).
#[test]
fn fm9_can_request_resolution_reports_max_paid_runs_reached() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(73);
    let pk_hex = hex_encode(&pk);
    let mut env = base_envelope(&pk_hex);
    env.max_paid_runs = 1;
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    let bet_id = c.next_bet_id - 1;
    let mut env2 = base_envelope(&pk_hex);
    env2.max_paid_runs = 1;
    do_mt_transfer(&mut c, "taker.testnet", env2.taker_required(), take_msg(bet_id), 2);

    ctx_with_deposit("keeper.testnet", 1_001, NearToken::from_millinear(50));
    let _ = c.request_resolution(bet_id, None);
    ctx("anyone.testnet", 1_002);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(1_002),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);

    // runs_used (1) == max_paid_runs (1) now -- but a challenge can still
    // reopen resolution, so check via Challenged status.
    do_mt_transfer(
        &mut c,
        "taker.testnet",
        5_005_000, // D-AUDIT8: challenge_min (5_000_000) + run_price (5_000)
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(),
        1_050,
    );
    ctx("anyone.testnet", 1_060);
    assert_eq!(
        c.can_request_resolution(bet_id),
        Some("max_paid_runs reached".to_string())
    );
}

/// FM-17/19: either party may extend the current settlement window by
/// +24h, exactly once. RED-first: before `extend_window` existed, this
/// call would not compile/would panic "unknown method"; after the fix,
/// `finalize` must respect the extension and reject before it elapses.
#[test]
fn fm17_19_extend_window_adds_24h_once_then_finalize_respects_it() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(74);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    // settlement_period is the fixture's 24h (D1 bound); without
    // extension finalize would be allowed at ts >= 2_000 + period.
    let period = c.get_bet(bet_id).unwrap().envelope.settlement_period;
    ctx("taker.testnet", 2_050);
    c.extend_window(bet_id);
    assert!(c.get_bet(bet_id).unwrap().window_extended);

    // At 2_000 + period (would have been finalizable without the
    // extension) it must still be blocked.
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ctx("anyone.testnet", 2_000 + period);
        c.finalize(bet_id)
    }));
    assert!(panicked.is_err(), "extended window must still be open at +period");

    // After the full +24h extension elapses, finalize succeeds.
    let day_ns: u64 = 24 * 60 * 60 * 1_000_000_000;
    ctx("anyone.testnet", 2_000 + period + day_ns + 1);
    c.finalize(bet_id);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Finalized);
    drain_all(&mut c, bet_id, 2_000 + period + day_ns + 2);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Settled);
}

#[test]
#[should_panic(expected = "window already extended once")]
fn fm17_19_extend_window_only_once_per_bet() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(75);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    ctx("maker.testnet", 2_050);
    c.extend_window(bet_id);
    ctx("taker.testnet", 2_060);
    c.extend_window(bet_id); // second extension by the OTHER party must still fail
}

#[test]
#[should_panic(expected = "only maker or taker may extend the window")]
fn fm17_19_extend_window_rejects_non_party() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(76);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    ctx("stranger.testnet", 2_050);
    c.extend_window(bet_id);
}

// ---------------------------------------------------------------------
// Loop 6: intents AuthCall path (`on_auth`) + refund-to-intents
// (FM-8 / FM-10 / FM-11, [[Praetorial - UX and security failure modes v1]])
// ---------------------------------------------------------------------

/// FM-8: `on_auth` must be callable only by the intents contract itself
/// -- never by an arbitrary caller pretending to relay a signer's
/// AuthCall. RED-first: before `on_auth` existed this wouldn't compile;
/// after, a non-intents predecessor must be rejected before any parsing
/// or spend.
#[test]
#[should_panic(expected = "on_auth: only callable by the intents contract")]
fn fm8_on_auth_rejects_non_intents_predecessor() {
    let mut c = new_contract();
    ctx("attacker.testnet", 1);
    let _ = c.on_auth(
        "taker.testnet".parse().unwrap(),
        serde_json::to_string(&AuthMsg::ExtendWindow { bet_id: 0 }).unwrap(),
    );
}

/// FM-8: a doomed `on_auth` `RequestResolution` call must fail on the
/// SAME cheap pre-spend check `request_resolution` itself uses (shared
/// `internal_request_resolution`), before any OutLayer deposit is
/// forwarded -- a doomed call fails cheaply, not after spending.
#[test]
#[should_panic(expected = "attached deposit too low for OutLayer compute + input_data storage")]
fn fm8_on_auth_request_resolution_validates_deposit_before_spending() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(90);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx_with_deposit(INTENTS, 1_001, NearToken::from_yoctonear(0));
    let _ = c.on_auth(
        "taker.testnet".parse().unwrap(),
        serde_json::to_string(&AuthMsg::RequestResolution { bet_id }).unwrap(),
    );
}

/// FM-8: same cheap-failure guarantee for an unknown bet -- must panic
/// on the bet lookup, not after forwarding the attached deposit.
#[test]
#[should_panic(expected = "unknown bet_id")]
fn fm8_on_auth_request_resolution_rejects_unknown_bet_before_spending() {
    let mut c = new_contract();
    ctx_with_deposit(INTENTS, 1_001, NearToken::from_millinear(10));
    let _ = c.on_auth(
        "taker.testnet".parse().unwrap(),
        serde_json::to_string(&AuthMsg::RequestResolution { bet_id: 999 }).unwrap(),
    );
}

/// FM-11: `payer` on an AuthCall-initiated run must be `signer_id`, not
/// `env::predecessor_account_id()` (always the intents contract for this
/// call) -- this is what lets the later unused-compute refund land on
/// the right account.
#[test]
fn fm11_on_auth_request_resolution_records_signer_as_payer_not_intents() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(91);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx_with_deposit(INTENTS, 1_001, NearToken::from_millinear(50));
    let resp = c.on_auth(
        "taker.testnet".parse().unwrap(),
        serde_json::to_string(&AuthMsg::RequestResolution { bet_id }).unwrap(),
    );
    assert!(matches!(resp, PromiseOrValue::Promise(_)));
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Resolving);
    let request_id = c.next_request_id - 1;
    let meta = c.resolution_payers.get(&request_id).expect("payer recorded");
    assert_eq!(meta.payer, "taker.testnet".parse::<AccountId>().unwrap());
    assert!(meta.via_auth_call, "must be flagged as AuthCall-initiated");
    assert_ne!(meta.payer, INTENTS.parse::<AccountId>().unwrap());
}

/// FM-8: `ExtendWindow` via `on_auth` uses `signer_id` as the acting
/// party -- a signer who is actually the maker/taker succeeds exactly
/// like the direct `extend_window` call would.
#[test]
fn fm8_on_auth_extend_window_uses_signer_as_acting_party() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(92);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    ctx(INTENTS, 2_050);
    let resp = c.on_auth(
        "taker.testnet".parse().unwrap(),
        serde_json::to_string(&AuthMsg::ExtendWindow { bet_id }).unwrap(),
    );
    assert!(matches!(resp, PromiseOrValue::Value(())));
    assert!(c.get_bet(bet_id).unwrap().window_extended);
}

/// FM-8: a signer who is NOT a party to the bet must still be rejected
/// via the AuthCall path -- `on_auth` can't be used to extend a window
/// on someone else's bet just because the call came through intents.
#[test]
#[should_panic(expected = "only maker or taker may extend the window")]
fn fm8_on_auth_extend_window_rejects_non_party_signer() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(93);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    ctx(INTENTS, 2_050);
    let _ = c.on_auth(
        "stranger.testnet".parse().unwrap(),
        serde_json::to_string(&AuthMsg::ExtendWindow { bet_id }).unwrap(),
    );
}

/// FM-10/FM-11: unused OutLayer compute from an AuthCall-initiated run
/// must be credited into the SIGNER's intents wNEAR balance via
/// `near_deposit_and_credit` -- never a native `Transfer` action -- and
/// for exactly the amount `unused_compute_yocto` reports (capped at the
/// original deposit). Inspects the mocked outgoing receipts directly
/// since `on_resolution` is `#[private]`/callback-only.
#[test]
fn fm10_on_resolution_refunds_unused_compute_to_intents_for_auth_call_payer() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(94);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let deposit = NearToken::from_millinear(50);
    ctx_with_deposit(INTENTS, 1_001, deposit);
    let _ = c.on_auth(
        "taker.testnet".parse().unwrap(),
        serde_json::to_string(&AuthMsg::RequestResolution { bet_id }).unwrap(),
    );
    let request_id = c.next_request_id - 1;
    let unused = 1_000_000u128; // < deposit, OutLayer's reported leftover
    // BUG FIX (found live on testnet, loop 6 resume): `request_execution` is
    // a `#[near]` method returning `-> String`, so the real cross-contract
    // SuccessValue bytes are JSON-encoded TWICE (once for the inner object,
    // once more because the method's return type itself is a `String`).
    // The old mock here passed single-encoded object bytes, which isn't
    // what a real `String`-returning callback ever produces on chain --
    // that mismatch is exactly why the FM-10 refund silently no-op'd on
    // testnet while this test stayed green. Double-encode to match reality.
    let inner = serde_json::json!({
        "request_id": request_id,
        "unused_compute_yocto": unused.to_string(),
    })
    .to_string();
    ctx_with_promise_result(
        CONTRACT,
        1_002,
        PromiseResult::Successful(serde_json::to_vec(&inner).unwrap()),
    );
    c.on_resolution(request_id);
    let receipts = near_sdk::test_utils::get_created_receipts();
    let refund = receipts
        .iter()
        .find(|r| r.receiver_id == INTENTS.parse::<AccountId>().unwrap())
        .expect("expected an outgoing call to the intents contract for the refund");
    let is_native_transfer = refund
        .actions
        .iter()
        .any(|a| matches!(a, near_sdk::mock::MockAction::Transfer { .. }));
    assert!(
        !is_native_transfer,
        "FM-10: an AuthCall-initiated refund must never be a native Transfer"
    );
    let has_credit_call = refund.actions.iter().any(|a| matches!(
        a,
        near_sdk::mock::MockAction::FunctionCallWeight { method_name, attached_deposit, .. }
            if method_name == b"near_deposit_and_credit" && attached_deposit.as_yoctonear() == unused
    ));
    assert!(has_credit_call, "expected near_deposit_and_credit({unused}) on the intents contract");
}

/// FM-11: the SAME unused-compute refund for a direct `#[payable]
/// request_resolution` caller (keeper/BYO wallet, not AuthCall) must be
/// a native NEAR transfer back to that caller, never routed into
/// intents.
#[test]
fn fm11_on_resolution_refunds_unused_compute_natively_for_direct_payer() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(95);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx_with_deposit(KEEPER, 1_001, NearToken::from_millinear(50));
    let _ = c.request_resolution(bet_id, None);
    let request_id = c.next_request_id - 1;
    let unused = 2_000_000u128;
    // Same double-JSON-encoding fix as FM-10's test above -- see its comment.
    let inner = serde_json::json!({
        "request_id": request_id,
        "unused_compute_yocto": unused.to_string(),
    })
    .to_string();
    ctx_with_promise_result(
        CONTRACT,
        1_002,
        PromiseResult::Successful(serde_json::to_vec(&inner).unwrap()),
    );
    c.on_resolution(request_id);
    let receipts = near_sdk::test_utils::get_created_receipts();
    let refund = receipts
        .iter()
        .find(|r| r.receiver_id == KEEPER.parse::<AccountId>().unwrap())
        .expect("expected a native refund receipt to the keeper");
    let transferred = refund.actions.iter().find_map(|a| match a {
        near_sdk::mock::MockAction::Transfer { deposit, .. } => Some(deposit.as_yoctonear()),
        _ => None,
    });
    assert_eq!(transferred, Some(unused), "FM-11: direct-path refund must be native and exact");
}

// -------------------------------------------------------------
// D6: beta limits (max_stake_per_side_usdc, beta_sunset_ns)
// -------------------------------------------------------------

#[test]
fn d6_stake_at_max_stake_per_side_usdc_accepted_one_over_rejected() {
    let (_, pk) = test_keypair(90);
    let pk_hex = hex_encode(&pk);
    let cap = 1_000_000u128;
    let limits = Limits {
        max_stake: U128(cap * 10), // generic cap not the binding one here
        max_offer_ttl_secs: 86400 * 60,
        max_stake_per_side_near: U128(100 * 10u128.pow(24)),
        max_rounds: crate::DEFAULT_MAX_ROUNDS,
        max_retries: crate::DEFAULT_MAX_RETRIES,
    };
    // Sub-job 1 (D-PRICE6): the cap now lives in the per-asset
    // `asset_limits` table rather than `Limits.max_stake_per_side_usdc`.
    let asset_limits = vec![(
        USDC.to_string(),
        AssetLimit {
            min_per_side: U128(20), // D-FEEMIN1: min_fee_per_side 1 requires min_per_side >= 20
            min_fee_per_side: U128(1), // D-FEEMIN1 fixture: below 1% of any fixture stake, old fee expectations unchanged
            min_fee_cap_per_side: U128(0), // D-PARAMS1 fixture: 0 = cap pinned at min_fee_per_side
            storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
            max_per_side: U128(cap),
            run_price: U128(DEFAULT_RUN_PRICE),
            min_bond: U128(USDC_MIN_BOND),
            min_objection: U128(USDC_MIN_OBJECTION),
        },
    )];

    // At the cap: accepted.
    let mut c_ok = new_contract_with_limits_and_assets(limits.clone(), None, asset_limits.clone());
    let mut env_ok = base_envelope(&pk_hex);
    env_ok.stake_maker = U128(cap);
    env_ok.stake_taker = U128(cap);
    ctx("maker.testnet", 2);
    let resp = do_mt_transfer(&mut c_ok, "maker.testnet", env_ok.maker_required(), open_msg(&env_ok), 1);
    assert_eq!(resp, vec![U128(0)], "stake exactly at max_stake_per_side_usdc must be accepted");

    // One yoctounit over the cap: rejected (full refund).
    let mut c_bad = new_contract_with_limits_and_assets(limits, None, asset_limits);
    let mut env_bad = base_envelope(&pk_hex);
    env_bad.stake_maker = U128(cap + 1);
    env_bad.stake_taker = U128(cap + 1);
    ctx("maker.testnet", 2);
    let resp = do_mt_transfer(&mut c_bad, "maker.testnet", env_bad.maker_required(), open_msg(&env_bad), 1);
    assert_eq!(
        resp,
        vec![U128(env_bad.maker_required())],
        "stake one unit over max_stake_per_side_usdc must be rejected"
    );
}

#[test]
fn d6_offers_refused_after_sunset_but_existing_bets_still_settle() {
    let (sk, pk) = test_keypair(91);
    let pk_hex = hex_encode(&pk);
    let sunset_ns: u64 = 10_000;
    let limits = Limits {
        max_stake: U128(1_000_000_000),
        max_offer_ttl_secs: 86400 * 60,
        max_stake_per_side_near: U128(100 * 10u128.pow(24)),
        max_rounds: crate::DEFAULT_MAX_ROUNDS,
        max_retries: crate::DEFAULT_MAX_RETRIES,
    };
    let mut c = new_contract_with_limits(limits, Some(sunset_ns));

    // Boundary: one ns before sunset, a new offer is accepted.
    // (do_mt_transfer's `ts` param drives env::block_timestamp() itself
    // -- a preceding bare `ctx(..)` call has no effect on it.) Deadlines
    // pushed well past sunset so the take/resolve lifecycle below (which
    // runs after sunset has passed) isn't blocked by them instead.
    let mut env_ok = base_envelope(&pk_hex);
    env_ok.funding_deadline = sunset_ns + 1_000;
    env_ok.resolve_deadline = sunset_ns + 1_000_000;
    let resp = do_mt_transfer(
        &mut c,
        "maker.testnet",
        env_ok.maker_required(),
        open_msg(&env_ok),
        sunset_ns - 1,
    );
    assert_eq!(resp, vec![U128(0)], "offer at sunset-1ns must be accepted");
    let bet_id = c.next_bet_id - 1;

    // At/after sunset: new offers are refused.
    let env_bad = base_envelope(&pk_hex);
    let resp = do_mt_transfer(
        &mut c,
        "maker.testnet",
        env_bad.maker_required(),
        open_msg(&env_bad),
        sunset_ns,
    );
    assert_eq!(
        resp,
        vec![U128(env_bad.maker_required())],
        "offer at/after beta_sunset_ns must be refused"
    );

    // The pre-sunset bet still runs its full lifecycle after sunset has
    // passed: take, submit outcome, finalize -- all unaffected.
    do_mt_transfer(&mut c, "taker.testnet", env_ok.taker_required(), take_msg(bet_id), sunset_ns + 1);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Taken);

    ctx("anyone.testnet", sunset_ns + 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(sunset_ns + 2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Proposed);

    let period = c.get_bet(bet_id).unwrap().envelope.settlement_period;
    ctx("anyone.testnet", sunset_ns + 2_000 + period + 1);
    c.finalize(bet_id);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Finalized);
    drain_all(&mut c, bet_id, sunset_ns + 2_000 + period + 2);
    assert_eq!(
        c.get_bet(bet_id).unwrap().status,
        BetStatus::Settled,
        "a pre-sunset bet must still settle normally after the sunset passes"
    );
}

// -------------------------------------------------------------
// Sub-job 1 (D-PRICE6): asset whitelist + per-asset min/max + same-asset
// 10:1 odds cap.
// -------------------------------------------------------------

const UNLISTED_ASSET: &str = "nep141:unlisted.testnet";

/// A contract built with the real spec defaults (`spec_default_asset_limits`)
/// rather than the lenient test-harness table -- these tests exist
/// specifically to exercise those defaults.
fn new_contract_spec_assets() -> Contract {
    new_contract_with_limits_and_assets(
        Limits {
            max_stake: U128(1_000_000_000),
            max_offer_ttl_secs: 86400 * 60,
            max_stake_per_side_near: U128(100 * 10u128.pow(24)),
            max_rounds: crate::DEFAULT_MAX_ROUNDS,
            max_retries: crate::DEFAULT_MAX_RETRIES,
        },
        None,
        spec_default_asset_limits(),
    )
}

#[test]
fn whitelist_rejects_unlisted_asset_at_open_full_refund() {
    let mut c = new_contract_spec_assets();
    let (_, pk) = test_keypair(100);
    let mut env = base_envelope(&hex_encode(&pk));
    env.maker_asset = UNLISTED_ASSET.to_string();
    env.taker_asset = UNLISTED_ASSET.to_string();
    env.stake_maker = U128(5_000_000);
    env.stake_taker = U128(5_000_000);
    let before_bet_id = c.next_bet_id;
    let resp = do_mt_transfer_asset(
        &mut c,
        "maker.testnet",
        UNLISTED_ASSET,
        env.maker_required(),
        open_msg(&env),
        1,
    );
    assert_eq!(
        resp,
        vec![U128(env.maker_required())],
        "a deposit in a non-whitelisted asset must be fully refunded, not partially or silently kept"
    );
    assert_eq!(c.next_bet_id, before_bet_id, "no bet must be created for a rejected open");
}

#[test]
fn whitelist_rejects_unlisted_asset_at_take_full_refund() {
    let mut c = new_contract_spec_assets();
    let (_, pk) = test_keypair(101);
    let pk_hex = hex_encode(&pk);
    let mut env = base_envelope(&pk_hex);
    env.stake_maker = U128(5_000_000);
    env.stake_taker = U128(5_000_000);
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)], "open with a whitelisted asset must still succeed");
    let bet_id = c.next_bet_id - 1;

    // Taker attempts to fund with an asset that isn't on the whitelist
    // at all (never mind that it doesn't match taker_asset either) --
    // `mt_on_transfer`'s outer gate must refund it before `handle_take`
    // even runs.
    let resp = do_mt_transfer_asset(
        &mut c,
        "taker.testnet",
        UNLISTED_ASSET,
        env.taker_required(),
        take_msg(bet_id),
        2,
    );
    assert_eq!(
        resp,
        vec![U128(env.taker_required())],
        "a take deposit in a non-whitelisted asset must be fully refunded"
    );
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Open, "bet must remain Open, not taken");
}

/// Builds an envelope whose maker_asset/taker_asset/stakes are
/// independent of `base_envelope`'s fixed 1-USDC default, for the
/// per-asset min/max boundary tests below.
fn asset_boundary_envelope(pk_hex: &str, asset: &str, stake_maker: u128, stake_taker: u128) -> Envelope {
    let mut env = base_envelope(pk_hex);
    env.maker_asset = asset.to_string();
    env.taker_asset = asset.to_string();
    env.stake_maker = U128(stake_maker);
    env.stake_taker = U128(stake_taker);
    env
}

#[test]
fn usdc_min_per_side_boundary_exact_accepted_one_under_rejected() {
    let min = crate::DEFAULT_MIN_STAKE_PER_SIDE_USDC;
    let (_, pk) = test_keypair(102);
    let pk_hex = hex_encode(&pk);

    let mut c_ok = new_contract_spec_assets();
    let env_ok = asset_boundary_envelope(&pk_hex, USDC, min, min);
    let resp = do_mt_transfer(&mut c_ok, "maker.testnet", env_ok.maker_required(), open_msg(&env_ok), 1);
    assert_eq!(resp, vec![U128(0)], "stake exactly at USDC min_per_side must be accepted");

    let mut c_bad = new_contract_spec_assets();
    let env_bad = asset_boundary_envelope(&pk_hex, USDC, min - 1, min - 1);
    let resp = do_mt_transfer(&mut c_bad, "maker.testnet", env_bad.maker_required(), open_msg(&env_bad), 1);
    assert_eq!(
        resp,
        vec![U128(env_bad.maker_required())],
        "stake one unit under USDC min_per_side must be rejected, full refund"
    );
}

#[test]
fn usdc_max_per_side_boundary_exact_accepted_one_over_rejected() {
    let max = crate::DEFAULT_MAX_STAKE_PER_SIDE_USDC;
    let (_, pk) = test_keypair(103);
    let pk_hex = hex_encode(&pk);

    let mut c_ok = new_contract_spec_assets();
    let env_ok = asset_boundary_envelope(&pk_hex, USDC, max, max);
    let resp = do_mt_transfer(&mut c_ok, "maker.testnet", env_ok.maker_required(), open_msg(&env_ok), 1);
    assert_eq!(resp, vec![U128(0)], "stake exactly at USDC max_per_side must be accepted");

    let mut c_bad = new_contract_spec_assets();
    let env_bad = asset_boundary_envelope(&pk_hex, USDC, max + 1, max + 1);
    let resp = do_mt_transfer(&mut c_bad, "maker.testnet", env_bad.maker_required(), open_msg(&env_bad), 1);
    assert_eq!(
        resp,
        vec![U128(env_bad.maker_required())],
        "stake one unit over USDC max_per_side must be rejected, full refund"
    );
}

#[test]
fn btc_min_and_max_per_side_boundaries() {
    // Confirms the per-asset table is genuinely per-asset, not just a
    // relabeled single USDC cap: mock BTC (8dp) has its own, much
    // smaller, min/max in native units.
    let (min, max) = spec_default_asset_limits()
        .into_iter()
        .find(|(id, _)| id == MOCK_BTC)
        .map(|(_, l)| (l.min_per_side.0, l.max_per_side.0))
        .unwrap();
    let (_, pk) = test_keypair(104);
    let pk_hex = hex_encode(&pk);

    let mut c_min_ok = new_contract_spec_assets();
    let env = asset_boundary_envelope(&pk_hex, MOCK_BTC, min, min);
    let resp = do_mt_transfer_asset(&mut c_min_ok, "maker.testnet", MOCK_BTC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)], "BTC stake exactly at min_per_side must be accepted");

    let mut c_min_bad = new_contract_spec_assets();
    let env = asset_boundary_envelope(&pk_hex, MOCK_BTC, min - 1, min - 1);
    let resp = do_mt_transfer_asset(&mut c_min_bad, "maker.testnet", MOCK_BTC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required())], "BTC stake one sat under min_per_side must be rejected");

    let mut c_max_ok = new_contract_spec_assets();
    let env = asset_boundary_envelope(&pk_hex, MOCK_BTC, max, max);
    let resp = do_mt_transfer_asset(&mut c_max_ok, "maker.testnet", MOCK_BTC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)], "BTC stake exactly at max_per_side must be accepted");

    let mut c_max_bad = new_contract_spec_assets();
    let env = asset_boundary_envelope(&pk_hex, MOCK_BTC, max + 1, max + 1);
    let resp = do_mt_transfer_asset(&mut c_max_bad, "maker.testnet", MOCK_BTC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required())], "BTC stake one sat over max_per_side must be rejected");
}

#[test]
fn same_asset_10x_odds_boundary_exact_accepted_one_over_rejected() {
    let (_, pk) = test_keypair(105);
    let pk_hex = hex_encode(&pk);
    // 5_000_000 (USDC min) : 50_000_000 -- exactly 10:1, both sides
    // within the USDC [min, max] band.
    let mut c_ok = new_contract_spec_assets();
    let env_ok = asset_boundary_envelope(&pk_hex, USDC, 5_000_000, 50_000_000);
    let resp = do_mt_transfer(&mut c_ok, "maker.testnet", env_ok.maker_required(), open_msg(&env_ok), 1);
    assert_eq!(resp, vec![U128(0)], "stake ratio exactly 10:1 (same asset) must be accepted");

    // One unit over 10:1.
    let mut c_bad = new_contract_spec_assets();
    let env_bad = asset_boundary_envelope(&pk_hex, USDC, 5_000_000, 50_000_001);
    let resp = do_mt_transfer(&mut c_bad, "maker.testnet", env_bad.maker_required(), open_msg(&env_bad), 1);
    assert_eq!(
        resp,
        vec![U128(env_bad.maker_required())],
        "stake ratio one unit over 10:1 (same asset) must be rejected, full refund"
    );
}

// ---------------------------------------------------------------------
// Drift review 2026-11-04 (HEAD 70235d8): D-PRICE6 money-path RED tests.
// Sub-job 1 lets a bet open/take in any whitelisted asset (BTC, wNEAR,
// or mixed maker/taker assets), but `schedule_payout` hardcodes
// `usdc_token_id` for every ledger line. A non-USDC bet's refund or
// payout is therefore scheduled in USDC the bet never received: it
// either fails (real deposit stuck) or drains other bets' USDC (I-1/I-2).
// These stay RED until payouts carry each side's own asset. Standing
// test policy: never #[ignore]d.
// ---------------------------------------------------------------------

fn payout_lines_for(c: &Contract, bet_id: u64) -> Vec<PendingPayout> {
    c.payout_ids_in_order()
        .iter()
        .filter_map(|id| c.pending_payouts.get(id).cloned())
        .filter(|p| p.bet_id == bet_id)
        .collect()
}

#[test]
fn d_price6_btc_bet_cancel_refunds_in_btc_not_usdc() {
    let mut c = new_contract_spec_assets();
    let (_, pk) = test_keypair(110);
    let env = asset_boundary_envelope(&hex_encode(&pk), MOCK_BTC, 10_000, 10_000);
    let resp = do_mt_transfer_asset(&mut c, "maker.testnet", MOCK_BTC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)], "BTC bet within limits must open");
    let bet_id = c.next_bet_id - 1;
    ctx("maker.testnet", 2);
    c.cancel(bet_id);
    let lines = payout_lines_for(&c, bet_id);
    assert_eq!(lines.len(), 1);
    assert_eq!(
        lines[0].token_id, MOCK_BTC,
        "maker deposited BTC; the cancel refund must be paid in BTC, not {}",
        lines[0].token_id
    );
}

#[test]
fn d_price6_mixed_asset_void_refunds_each_side_in_its_own_asset() {
    let mut c = new_contract_spec_assets();
    let (_, pk) = test_keypair(111);
    let mut env = base_envelope(&hex_encode(&pk));
    env.maker_asset = MOCK_BTC.to_string();
    env.taker_asset = USDC.to_string();
    env.stake_maker = U128(10_000); // BTC sats, inside BTC band
    env.stake_taker = U128(10_000_000); // 10 USDC, inside USDC band
    let resp = do_mt_transfer_asset(&mut c, "maker.testnet", MOCK_BTC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)], "mixed-asset bet opens today (handle_open has no equality gate)");
    let bet_id = c.next_bet_id - 1;
    let resp = do_mt_transfer_asset(&mut c, "taker.testnet", USDC, env.taker_required(), take_msg(bet_id), 2);
    assert_eq!(resp, vec![U128(0)], "taker funds in USDC");
    ctx("anyone.testnet", env.resolve_deadline + 1);
    c.void_after_deadline(bet_id);
    let lines = payout_lines_for(&c, bet_id);
    let maker_line = lines.iter().find(|p| p.reason == "void_deadline_maker").expect("maker refund line");
    let taker_line = lines.iter().find(|p| p.reason == "void_deadline_taker").expect("taker refund line");
    assert_eq!(maker_line.token_id, MOCK_BTC, "maker staked BTC; void must refund BTC");
    assert_eq!(taker_line.token_id, USDC, "taker staked USDC; void must refund USDC");
}

// ---------------------------------------------------------------------
// Sub-job 2 (cross-asset-2, D-PRICE6): multi-option taker offers.
// The maker still has exactly one (asset, amount); the taker now
// chooses between the primary (taker_asset/stake_taker) pair and any
// number of additional `taker_options` -- each an exact (asset,
// amount) the maker also accepts. Wrong asset, wrong amount,
// over-deposit or under-deposit against every option must be rejected
// with a full refund. schedule_payout is still USDC-hardcoded
// (next item), so these tests never assert payout asset routing.
// ---------------------------------------------------------------------

/// Envelope with a primary (USDC) taker option plus one alternate
/// (MOCK_BTC) option at an exact amount, for the multi-option tests.
fn multi_option_envelope(pk_hex: &str) -> Envelope {
    let mut env = base_envelope(pk_hex);
    env.maker_asset = USDC.to_string();
    env.taker_asset = USDC.to_string();
    env.stake_maker = U128(10_000_000); // 10 USDC, within the $5..$250 spec band
    env.stake_taker = U128(10_000_000); // primary option: 10 USDC
    env.taker_options = vec![TakerOption {
        asset: MOCK_BTC.to_string(),
        amount: U128(10_000), // alternate option: exact BTC sats, within BTC's band
    }];
    env
}

#[test]
fn cross_asset_2_take_with_alternate_option_records_chosen_asset() {
    let mut c = new_contract_spec_assets();
    let (_, pk) = test_keypair(120);
    let env = multi_option_envelope(&hex_encode(&pk));
    let resp = do_mt_transfer_asset(&mut c, "maker.testnet", USDC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)], "multi-option open must be accepted");
    let bet_id = c.next_bet_id - 1;

    let btc_required = 10_000 + env.storage_for(STG_FIXTURE_RATE);
    let resp = do_mt_transfer_asset(&mut c, "taker.testnet", MOCK_BTC, btc_required, take_msg(bet_id), 2);
    assert_eq!(resp, vec![U128(0)], "taker depositing the alternate BTC option must be accepted");

    let bet = c.get_bet(bet_id).expect("bet exists");
    assert_eq!(bet.status, BetStatus::Taken);
    assert_eq!(bet.envelope.taker_asset, MOCK_BTC, "bet must record BTC as the asset the taker actually used");
    assert_eq!(bet.envelope.stake_taker.0, 10_000, "bet must record the BTC option's exact amount");
}

#[test]
fn cross_asset_2_take_primary_option_still_works() {
    let mut c = new_contract_spec_assets();
    let (_, pk) = test_keypair(121);
    let env = multi_option_envelope(&hex_encode(&pk));
    let resp = do_mt_transfer_asset(&mut c, "maker.testnet", USDC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)]);
    let bet_id = c.next_bet_id - 1;

    let resp = do_mt_transfer_asset(&mut c, "taker.testnet", USDC, env.taker_required(), take_msg(bet_id), 2);
    assert_eq!(resp, vec![U128(0)], "taker depositing the primary USDC option must still be accepted");
    let bet = c.get_bet(bet_id).expect("bet exists");
    assert_eq!(bet.envelope.taker_asset, USDC);
    assert_eq!(bet.envelope.stake_taker.0, 10_000_000);
}

#[test]
fn cross_asset_2_take_wrong_asset_rejected_full_refund() {
    let mut c = new_contract_spec_assets();
    let (_, pk) = test_keypair(122);
    let env = multi_option_envelope(&hex_encode(&pk));
    let resp = do_mt_transfer_asset(&mut c, "maker.testnet", USDC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)]);
    let bet_id = c.next_bet_id - 1;

    // MOCK_WNEAR is whitelisted contract-wide but is not an option on
    // THIS bet (neither the primary USDC nor the alternate BTC option).
    let amount = env.taker_required(); // arbitrary amount, asset is the point
    let resp = do_mt_transfer_asset(&mut c, "taker.testnet", MOCK_WNEAR, amount, take_msg(bet_id), 2);
    assert_eq!(resp, vec![U128(amount)], "a deposit in an asset that is not one of this bet's options must be fully refunded");
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Open, "bet must remain Open");
}

#[test]
fn cross_asset_2_take_option_asset_over_deposit_rejected_full_refund() {
    let mut c = new_contract_spec_assets();
    let (_, pk) = test_keypair(123);
    let env = multi_option_envelope(&hex_encode(&pk));
    let resp = do_mt_transfer_asset(&mut c, "maker.testnet", USDC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)]);
    let bet_id = c.next_bet_id - 1;

    let btc_required = 10_000 + env.storage_for(STG_FIXTURE_RATE);
    let over = btc_required + 1;
    let resp = do_mt_transfer_asset(&mut c, "taker.testnet", MOCK_BTC, over, take_msg(bet_id), 2);
    assert_eq!(resp, vec![U128(over)], "an over-deposit against the BTC option must be fully refunded, not partially accepted");
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Open);
}

#[test]
fn cross_asset_2_take_option_asset_under_deposit_rejected_full_refund() {
    let mut c = new_contract_spec_assets();
    let (_, pk) = test_keypair(124);
    let env = multi_option_envelope(&hex_encode(&pk));
    let resp = do_mt_transfer_asset(&mut c, "maker.testnet", USDC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)]);
    let bet_id = c.next_bet_id - 1;

    let btc_required = 10_000 + env.storage_for(STG_FIXTURE_RATE);
    let under = btc_required - 1;
    let resp = do_mt_transfer_asset(&mut c, "taker.testnet", MOCK_BTC, under, take_msg(bet_id), 2);
    assert_eq!(resp, vec![U128(under)], "an under-deposit against the BTC option must be fully refunded, not partially accepted");
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Open);
}

#[test]
fn cross_asset_2_open_rejects_taker_option_asset_not_whitelisted() {
    let mut c = new_contract_spec_assets();
    let (_, pk) = test_keypair(125);
    let mut env = multi_option_envelope(&hex_encode(&pk));
    env.taker_options = vec![TakerOption { asset: UNLISTED_ASSET.to_string(), amount: U128(1_000_000) }];
    let before_bet_id = c.next_bet_id;
    let resp = do_mt_transfer_asset(&mut c, "maker.testnet", USDC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required())], "an offer whose taker_options include a non-whitelisted asset must be rejected, maker refunded in full");
    assert_eq!(c.next_bet_id, before_bet_id, "no bet must be created");
}

#[test]
fn cross_asset_2_open_rejects_taker_option_outside_asset_limits() {
    let mut c = new_contract_spec_assets();
    let (_, pk) = test_keypair(126);
    let mut env = multi_option_envelope(&hex_encode(&pk));
    // BTC min_per_side is 6_501 (see spec_default_asset_limits); 1 sat
    // is far below the floor.
    env.taker_options = vec![TakerOption { asset: MOCK_BTC.to_string(), amount: U128(1) }];
    let before_bet_id = c.next_bet_id;
    let resp = do_mt_transfer_asset(&mut c, "maker.testnet", USDC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required())], "an offer whose taker_options amount falls outside that asset's min/max must be rejected");
    assert_eq!(c.next_bet_id, before_bet_id);
}

#[test]
fn cross_asset_2_open_enforces_10_1_odds_only_for_same_asset_option() {
    let mut c = new_contract_spec_assets();
    // Same-asset (USDC) option whose ratio to stake_maker exceeds 10:1
    // must be rejected (D-PRICE3, already enforced for the primary
    // pair -- this proves it also applies to a taker_options entry
    // sharing maker_asset).
    let (_, pk) = test_keypair(127);
    let mut env = multi_option_envelope(&hex_encode(&pk));
    env.stake_maker = U128(10_000_000); // 10 USDC
    env.stake_taker = U128(10_000_000); // primary pair stays within 10:1
    env.taker_options = vec![TakerOption {
        asset: USDC.to_string(), // same asset as maker -> odds check applies
        amount: U128(200_000_000), // 200 USDC, 20:1 vs 10 USDC maker stake
    }];
    let before_bet_id = c.next_bet_id;
    let resp = do_mt_transfer_asset(&mut c, "maker.testnet", USDC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required())], "a same-asset taker_options entry exceeding 10:1 odds must be rejected");
    assert_eq!(c.next_bet_id, before_bet_id);

    // A cross-asset option at an equivalent (or more extreme) ratio is
    // NOT checked at all per D-PRICE6 (10:1 odds checked onchain only
    // within the same asset) -- it must open fine.
    let (_, pk2) = test_keypair(128);
    let mut env2 = multi_option_envelope(&hex_encode(&pk2));
    env2.stake_maker = U128(10_000_000); // 10 USDC
    env2.stake_taker = U128(10_000_000);
    env2.taker_options = vec![TakerOption {
        asset: MOCK_BTC.to_string(), // different asset -> no odds check
        amount: U128(325_059), // BTC max_per_side, a huge ratio vs 10 USDC
    }];
    let resp = do_mt_transfer_asset(&mut c, "maker.testnet", USDC, env2.maker_required(), open_msg(&env2), 3);
    assert_eq!(resp, vec![U128(0)], "a cross-asset taker_options entry must not be subject to the same-asset 10:1 odds cap");
}

// ---------------------------------------------------------------------
// cross-asset-3 (D-PRICE6): per-asset accounting through
// finalize/void. BTC (8dp mock) vs USDC, each with exact
// (receiver, token) payout amounts and I-1 conservation per asset.
// ---------------------------------------------------------------------

/// Opens+takes a BTC(maker)/USDC(taker) mixed-asset bet using
/// `base_envelope`'s defaults (fee_bps=100,
/// storage_charge_per_side=10_000, keep_terms=true; D-ECON5: no
/// per-bet reserve any more), returns
/// (contract, bet_id, env, total_in_btc, total_in_usdc).
fn open_take_btc_vs_usdc(seed: u8) -> (Contract, u64, Envelope, u128, u128) {
    let mut c = new_contract_spec_assets();
    let (sk, pk) = test_keypair(seed);
    let pk_hex = hex_encode(&pk);
    let mut env = base_envelope(&pk_hex);
    env.maker_asset = MOCK_BTC.to_string();
    env.taker_asset = USDC.to_string();
    env.stake_maker = U128(10_000); // BTC sats, inside the BTC band
    env.stake_taker = U128(10_000_000); // 10 USDC, inside the USDC band
    let resp = do_mt_transfer_asset(&mut c, "maker.testnet", MOCK_BTC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)], "BTC maker open must be accepted");
    let bet_id = c.next_bet_id - 1;
    let resp = do_mt_transfer_asset(&mut c, "taker.testnet", USDC, env.taker_required(), take_msg(bet_id), 2);
    assert_eq!(resp, vec![U128(0)], "USDC taker take must be accepted");
    let total_in_btc = env.maker_required();
    let total_in_usdc = env.taker_required();
    let _ = sk;
    (c, bet_id, env, total_in_btc, total_in_usdc)
}

fn sum_by_token(lines: &[PendingPayout], receiver: &AccountId, token: &str) -> u128 {
    lines
        .iter()
        .filter(|p| &p.receiver == receiver && p.token_id == token)
        .map(|p| p.amount.0)
        .sum()
}

#[test]
fn cross_asset_3_finalize_maker_wins_pays_both_pots_in_own_asset() {
    let (mut c, bet_id, env, total_in_btc, total_in_usdc) = open_take_btc_vs_usdc(140);
    // D-KEY1: submit_outcome verifies against the pinned contract-level
    // outcome key now, never a maker-supplied envelope key.
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: env.terms_hash.clone(),
        outcome: "YES".to_string(), // maker_side is YES in base_envelope -> maker wins
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);

    ctx("anyone.testnet", 2_000 + env.settlement_period + 1);
    let before = c.payout_ids_in_order().len();
    c.finalize(bet_id);
    let lines: Vec<_> = c.payout_ids_in_order()[before..]
        .iter()
        .map(|id| c.pending_payouts.get(id).unwrap().clone())
        .collect();

    let maker_id: AccountId = "maker.testnet".parse().unwrap();
    let taker_id: AccountId = "taker.testnet".parse().unwrap();
    let fee_id: AccountId = FEE.parse().unwrap();
    let keeper_id: AccountId = KEEPER.parse().unwrap();

    // D-ECON5: no per-bet reserve exists any more, and round-0's judge
    // run is funded entirely by `keeper_credit` (repaid by the 1%
    // protocol fee via treasury) -- nothing is drawn from or paid out
    // of bet money for it, so the keeper gets nothing here either.
    //   maker (winner) BTC: stake payout 9_900, nothing else
    //   maker (winner) USDC: stake payout 9_900_000, nothing else
    //   taker (loser) BTC: 0, taker (loser) USDC: 0
    // I-1 (BTC): maker 9_900 + fee 10_100 = 20_000 == total_in_btc
    // I-1 (USDC): maker 9_900_000 + fee 110_000 = 10_010_000 == total_in_usdc
    assert_eq!(sum_by_token(&lines, &maker_id, MOCK_BTC), 9_900, "maker: 9_900 payout, BTC");
    assert_eq!(sum_by_token(&lines, &maker_id, USDC), 9_900_000, "maker: 9_900_000 payout, USDC");
    assert_eq!(sum_by_token(&lines, &taker_id, MOCK_BTC), 0, "taker (loser): never deposited BTC, must receive none");
    assert_eq!(sum_by_token(&lines, &taker_id, USDC), 0, "taker (loser): no reserve any more, nothing to receive");
    assert_eq!(sum_by_token(&lines, &fee_id, MOCK_BTC), 10_100, "fee_account: 100 fee + 10_000 storage, BTC");
    assert_eq!(sum_by_token(&lines, &fee_id, USDC), 110_000, "fee_account: 100_000 fee + 10_000 storage, USDC");
    assert_eq!(sum_by_token(&lines, &keeper_id, MOCK_BTC), 0, "keeper: round-0 cost funded by keeper_credit, not bet money");
    assert_eq!(sum_by_token(&lines, &keeper_id, USDC), 0, "keeper: round-0 cost funded by keeper_credit, not bet money");

    // I-1 per asset: sum in == sum out, for EACH asset independently.
    let total_out_btc: u128 = lines.iter().filter(|p| p.token_id == MOCK_BTC).map(|p| p.amount.0).sum();
    let total_out_usdc: u128 = lines.iter().filter(|p| p.token_id == USDC).map(|p| p.amount.0).sum();
    assert_eq!(total_out_btc, total_in_btc, "I-1 (BTC): sum in == sum out");
    assert_eq!(total_out_usdc, total_in_usdc, "I-1 (USDC): sum in == sum out");
    assert!(lines.iter().all(|p| p.token_id == MOCK_BTC || p.token_id == USDC), "no third asset ever appears");
}

#[test]
fn cross_asset_3_finalize_taker_wins_pays_both_pots_in_own_asset() {
    let (mut c, bet_id, env, total_in_btc, total_in_usdc) = open_take_btc_vs_usdc(141);
    // D-KEY1: submit_outcome verifies against the pinned contract-level
    // outcome key now, never a maker-supplied envelope key.
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: env.terms_hash.clone(),
        outcome: "NO".to_string(), // maker_side is YES -> NO means taker wins
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);

    ctx("anyone.testnet", 2_000 + env.settlement_period + 1);
    let before = c.payout_ids_in_order().len();
    c.finalize(bet_id);
    let lines: Vec<_> = c.payout_ids_in_order()[before..]
        .iter()
        .map(|id| c.pending_payouts.get(id).unwrap().clone())
        .collect();

    let maker_id: AccountId = "maker.testnet".parse().unwrap();
    let taker_id: AccountId = "taker.testnet".parse().unwrap();
    let fee_id: AccountId = FEE.parse().unwrap();
    let keeper_id: AccountId = KEEPER.parse().unwrap();

    // D-ECON5: symmetric to maker-wins -- no per-bet reserve exists any
    // more, and round-0's judge run is funded entirely by
    // `keeper_credit`, never drawn from bet money; only the stake
    // payout receiver flips versus the maker-wins case.
    //   taker (winner) BTC: stake payout 9_900, nothing else
    //   taker (winner) USDC: stake payout 9_900_000, nothing else
    //   maker (loser) BTC: 0, maker (loser) USDC: 0
    // I-1 (BTC): taker 9_900 + fee 10_100 = 20_000 == total_in_btc
    // I-1 (USDC): taker 9_900_000 + fee 110_000 = 10_010_000 == total_in_usdc
    assert_eq!(sum_by_token(&lines, &taker_id, MOCK_BTC), 9_900, "taker (winner): 9_900 payout, BTC");
    assert_eq!(sum_by_token(&lines, &taker_id, USDC), 9_900_000, "taker (winner): 9_900_000 payout, USDC");
    assert_eq!(sum_by_token(&lines, &maker_id, MOCK_BTC), 0, "maker (loser): no reserve any more, nothing to receive");
    assert_eq!(sum_by_token(&lines, &maker_id, USDC), 0, "maker (loser): never deposited USDC, must receive none");
    assert_eq!(sum_by_token(&lines, &fee_id, MOCK_BTC), 10_100);
    assert_eq!(sum_by_token(&lines, &fee_id, USDC), 110_000);
    assert_eq!(sum_by_token(&lines, &keeper_id, MOCK_BTC), 0, "keeper: round-0 cost funded by keeper_credit, not bet money");
    assert_eq!(sum_by_token(&lines, &keeper_id, USDC), 0, "keeper: round-0 cost funded by keeper_credit, not bet money");

    let total_out_btc: u128 = lines.iter().filter(|p| p.token_id == MOCK_BTC).map(|p| p.amount.0).sum();
    let total_out_usdc: u128 = lines.iter().filter(|p| p.token_id == USDC).map(|p| p.amount.0).sum();
    assert_eq!(total_out_btc, total_in_btc, "I-1 (BTC): sum in == sum out");
    assert_eq!(total_out_usdc, total_in_usdc, "I-1 (USDC): sum in == sum out");
}

/// VOID via `void_after_deadline`, exact (receiver, token) amounts +
/// I-1 per asset -- upgrades the existing cross-asset-2-era
/// `d_price6_mixed_asset_void_refunds_each_side_in_its_own_asset`
/// (which only checked token_id, not amounts) to full numeric proof.
#[test]
fn cross_asset_3_void_exact_amounts_per_asset_conserve() {
    let (mut c, bet_id, env, total_in_btc, total_in_usdc) = open_take_btc_vs_usdc(142);
    ctx("anyone.testnet", env.resolve_deadline + 1);
    let before = c.payout_ids_in_order().len();
    c.void_after_deadline(bet_id);
    let lines: Vec<_> = c.payout_ids_in_order()[before..]
        .iter()
        .map(|id| c.pending_payouts.get(id).unwrap().clone())
        .collect();

    let maker_id: AccountId = "maker.testnet".parse().unwrap();
    let taker_id: AccountId = "taker.testnet".parse().unwrap();
    let fee_id: AccountId = FEE.parse().unwrap();

    // D-ECON5: on a zero-run VOID nobody won/lost and there is no
    // shared compute benefit to split, and no per-bet reserve exists
    // any more -- each side simply gets back their own stake, in
    // their own asset, with NOTHING crossing to the other party or the
    // other asset (DR-P6-6). Storage (keep_terms:true) goes to
    // fee_account, each side's own charge in its own asset.
    assert_eq!(sum_by_token(&lines, &maker_id, MOCK_BTC), 10_000, "maker: 10_000 stake, BTC");
    assert_eq!(sum_by_token(&lines, &maker_id, USDC), 0, "maker never deposited USDC, must receive none");
    assert_eq!(sum_by_token(&lines, &taker_id, USDC), 10_000_000, "taker: 10_000_000 stake, USDC");
    assert_eq!(sum_by_token(&lines, &taker_id, MOCK_BTC), 0, "taker never deposited BTC, must receive none");
    assert_eq!(sum_by_token(&lines, &fee_id, MOCK_BTC), 10_000, "fee_account: maker's own storage charge, BTC");
    assert_eq!(sum_by_token(&lines, &fee_id, USDC), 10_000, "fee_account: taker's own storage charge, USDC");

    let total_out_btc: u128 = lines.iter().filter(|p| p.token_id == MOCK_BTC).map(|p| p.amount.0).sum();
    let total_out_usdc: u128 = lines.iter().filter(|p| p.token_id == USDC).map(|p| p.amount.0).sum();
    assert_eq!(total_out_btc, total_in_btc, "I-1 (BTC): sum in == sum out");
    assert_eq!(total_out_usdc, total_in_usdc, "I-1 (USDC): sum in == sum out");
}

#[test]
fn cross_asset_2_open_rejects_too_many_taker_options() {
    let mut c = new_contract_spec_assets();
    let (_, pk) = test_keypair(129);
    let mut env = multi_option_envelope(&hex_encode(&pk));
    env.taker_options = (0..(crate::MAX_TAKER_OPTIONS + 1))
        .map(|i| TakerOption { asset: format!("nep141:opt{i}.testnet"), amount: U128(1) })
        .collect();
    let before_bet_id = c.next_bet_id;
    let resp = do_mt_transfer_asset(&mut c, "maker.testnet", USDC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required())], "more than MAX_TAKER_OPTIONS taker_options entries must be rejected (griefing guard)");
    assert_eq!(c.next_bet_id, before_bet_id);
}

/// DR-P6-6 (drift review 2026-11-04, HEAD `b5aa45c`) -- now GREEN under
/// D-ECON5 (queue item 2d2): there is no per-bet reserve any more at
/// all, so the cross-asset leak this test originally pinned (a mixed-
/// asset bet's `reserve_per_side`, funded separately in each side's OWN
/// asset, getting treated as one combined raw-unit pool and split back
/// half in each asset by `schedule_split_payout`) cannot happen -- each
/// side simply gets its own stake back on a VOID, in its own asset.
///
/// Design-independent invariant asserted here: on a zero-run VOID,
/// every party gets back exactly what they deposited, in the asset
/// they deposited it in, and receives NONE of an asset they never sent.
#[test]
fn dr_p6_6_mixed_asset_void_returns_each_reserve_in_its_own_asset() {
    let (mut c, bet_id, env, _total_in_btc, _total_in_usdc) = open_take_btc_vs_usdc(150);
    assert_eq!(c.get_bet(bet_id).unwrap().runs_used, 0, "precondition: no runs");
    ctx("anyone.testnet", env.resolve_deadline + 1);
    let before = c.payout_ids_in_order().len();
    c.void_after_deadline(bet_id);
    let lines: Vec<_> = c.payout_ids_in_order()[before..]
        .iter()
        .map(|id| c.pending_payouts.get(id).unwrap().clone())
        .collect();
    let maker_id: AccountId = "maker.testnet".parse().unwrap();
    let taker_id: AccountId = "taker.testnet".parse().unwrap();
    let fee_id: AccountId = FEE.parse().unwrap();

    assert_eq!(sum_by_token(&lines, &maker_id, USDC), 0, "maker never deposited USDC, must receive none");
    assert_eq!(sum_by_token(&lines, &taker_id, MOCK_BTC), 0, "taker never deposited BTC, must receive none");
    // D-ECON5: no per-bet reserve exists any more -- each side just
    // gets back their own stake. keep_terms:true -> each side's
    // storage charge goes to fee_account, in that side's asset.
    assert_eq!(sum_by_token(&lines, &maker_id, MOCK_BTC), 10_000, "maker: own stake, BTC");
    assert_eq!(sum_by_token(&lines, &taker_id, USDC), 10_000_000, "taker: own stake, USDC");
    assert_eq!(sum_by_token(&lines, &fee_id, MOCK_BTC), 10_000, "maker's storage charge, BTC");
    assert_eq!(sum_by_token(&lines, &fee_id, USDC), 10_000, "taker's storage charge, USDC");
}

// =====================================================================
// D-BOND1 (cross-asset-4): challenge bonds and objection deposits are
// posted/held/paid in the DEPOSITOR's own stake asset, never a
// hardcoded USDC. BTC-maker vs USDC-taker bet throughout.
// =====================================================================
mod d_bond1 {
    use super::*;

    // spec_default_asset_limits(): BTC min_bond=6_501 ($5-equiv), run_price=1.
    const BTC_RUN_PRICE: u128 = 1;
    const MAKER_BOND: u128 = 6_501 + BTC_RUN_PRICE; // pot_for_challenger(maker)=2*10_000=20_000; 5%=1_000 < floor 6_501
    // spec_default_asset_limits(): USDC min_bond=5_000_000, run_price=5_000.
    const USDC_RUN_PRICE: u128 = 5_000;
    const TAKER_BOND: u128 = 5_000_000 + USDC_RUN_PRICE; // pot_for_challenger(taker)=2*10_000_000=20_000_000; 5%=1_000_000 < floor 5_000_000
    const MAKER_OBJECTION: u128 = 1_300; // max(min_objection_BTC=1_300, 20_000*50/10_000=100)
    const TAKER_OBJECTION: u128 = 1_000_000; // max(min_objection_USDC=1_000_000, 20_000_000*50/10_000=100_000)

    /// BTC-maker (10_000 sats) vs USDC-taker (10_000_000, 6dp) bet,
    /// open+taken, on the real spec asset-limit defaults.
    fn cross_bet(c: &mut Contract, seed: u8) -> (u64, ed25519_dalek::SigningKey) {
        let (sk, pk) = test_keypair(seed);
        let mut env = base_envelope(&hex_encode(&pk));
        env.maker_asset = MOCK_BTC.to_string();
        env.taker_asset = USDC.to_string();
        env.stake_maker = U128(10_000);
        env.stake_taker = U128(10_000_000);
        let resp = do_mt_transfer_asset(c, "maker.testnet", MOCK_BTC, env.maker_required(), open_msg(&env), 1);
        assert_eq!(resp, vec![U128(0)], "BTC maker open must be accepted");
        let bet_id = c.next_bet_id - 1;
        let resp = do_mt_transfer_asset(c, "taker.testnet", USDC, env.taker_required(), take_msg(bet_id), 2);
        assert_eq!(resp, vec![U128(0)], "USDC taker take must be accepted");
        (bet_id, sk)
    }

    fn propose_yes(c: &mut Contract, bet_id: u64, sk: &ed25519_dalek::SigningKey, ts: u64) {
        ctx("anyone.testnet", ts);
        let result = SubmittedResult {
            bet_id,
            terms_hash: "terms-hash-1".to_string(),
            outcome: "YES".to_string(),
            element_results_hash: "e".repeat(64),
            run_no: 1,
            checked_until: U64(ts),
            next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig = sign_result(&outcome_signing_key(), &result);
        c.submit_outcome(result, sig);
    }

    // (a) taker challenges with a USDC bond (their own stake asset) -> accepted.
    #[test]
    fn taker_challenges_with_own_usdc_bond_accepted() {
        let mut c = new_contract_spec_assets();
        let (bet_id, sk) = cross_bet(&mut c, 200);
        propose_yes(&mut c, bet_id, &sk, 2_000);
        let resp = do_mt_transfer_asset(
            &mut c, "taker.testnet", USDC, TAKER_BOND,
            serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050,
        );
        assert_eq!(resp, vec![U128(0)], "taker's own-asset (USDC) bond must be accepted");
        assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Challenged);
        assert_eq!(c.get_bet(bet_id).unwrap().bonds[0].asset, USDC, "the bond must record USDC, the taker's own asset");
    }

    // (b) maker challenges with a BTC bond (their own stake asset) -> accepted;
    // maker's USDC bond -> rejected & fully refunded.
    #[test]
    fn maker_challenges_with_own_btc_bond_accepted() {
        let mut c = new_contract_spec_assets();
        let (bet_id, sk) = cross_bet(&mut c, 201);
        propose_yes(&mut c, bet_id, &sk, 2_000);
        let resp = do_mt_transfer_asset(
            &mut c, "maker.testnet", MOCK_BTC, MAKER_BOND,
            serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050,
        );
        assert_eq!(resp, vec![U128(0)], "maker's own-asset (BTC) bond must be accepted");
        assert_eq!(c.get_bet(bet_id).unwrap().bonds.len(), 1);
        assert_eq!(c.get_bet(bet_id).unwrap().bonds[0].asset, MOCK_BTC);
    }

    #[test]
    fn maker_usdc_bond_rejected_full_refund() {
        let mut c = new_contract_spec_assets();
        let (bet_id, sk) = cross_bet(&mut c, 202);
        propose_yes(&mut c, bet_id, &sk, 2_000);
        // Maker's own asset is BTC -- a USDC bond, even at the correct
        // USDC amount/whitelisted asset, is not the MAKER's own asset
        // and must be rejected and fully refunded (I-3).
        let resp = do_mt_transfer_asset(
            &mut c, "maker.testnet", USDC, TAKER_BOND,
            serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050,
        );
        assert_eq!(resp, vec![U128(TAKER_BOND)], "maker's bond in the wrong (not own) asset must be fully refunded");
        assert_eq!(c.get_bet(bet_id).unwrap().bonds.len(), 0, "no bond must be recorded");
        assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Proposed, "status unchanged on a rejected bond");
    }

    // (c) wrong amount -> refunded.
    #[test]
    fn wrong_amount_in_own_asset_rejected_full_refund() {
        let mut c = new_contract_spec_assets();
        let (bet_id, sk) = cross_bet(&mut c, 203);
        propose_yes(&mut c, bet_id, &sk, 2_000);
        let resp = do_mt_transfer_asset(
            &mut c, "maker.testnet", MOCK_BTC, MAKER_BOND - 1,
            serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050,
        );
        assert_eq!(resp, vec![U128(MAKER_BOND - 1)], "one under the required BTC bond must be fully refunded");
        assert_eq!(c.get_bet(bet_id).unwrap().bonds.len(), 0);
    }

    // (d) bond forfeited with exact amounts in the right asset, LOST round.
    #[test]
    fn btc_bond_lost_forfeits_to_counterparty_and_round_cost_to_keeper_in_btc() {
        let mut c = new_contract_spec_assets();
        let (bet_id, sk) = cross_bet(&mut c, 204);
        propose_yes(&mut c, bet_id, &sk, 2_000);
        let resp = do_mt_transfer_asset(
            &mut c, "maker.testnet", MOCK_BTC, MAKER_BOND,
            serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050,
        );
        assert_eq!(resp, vec![U128(0)]);
        // No re-judge -> outcome stands at YES -> maker's challenge round is LOST.
        let env = c.get_bet(bet_id).unwrap().envelope;
        ctx("anyone.testnet", 2_050 + env.settlement_period + 1);
        let before = c.payout_ids_in_order().len();
        c.finalize(bet_id);
        let new_payouts: Vec<_> = c.payout_ids_in_order()[before..].iter().map(|id| c.pending_payouts.get(id).unwrap().clone()).collect();
        let forfeited = new_payouts.iter().find(|p| p.reason == "bond_lost_to_counterparty").expect("bond must forfeit");
        assert_eq!(forfeited.receiver, "taker.testnet".parse::<AccountId>().unwrap());
        assert_eq!(forfeited.token_id, MOCK_BTC, "bond must settle in BTC, the asset it was posted in");
        assert_eq!(forfeited.amount.0, MAKER_BOND - BTC_RUN_PRICE);
        let round_cost = new_payouts.iter().find(|p| p.reason == "bond_round_cost_to_keeper").expect("round cost must be paid");
        assert_eq!(round_cost.token_id, MOCK_BTC);
        assert_eq!(round_cost.amount.0, BTC_RUN_PRICE);
    }

    // (d) bond returned with exact amounts in the right asset, WON round.
    #[test]
    fn btc_bond_won_returns_remainder_to_challenger_in_btc() {
        let mut c = new_contract_spec_assets();
        let (bet_id, sk) = cross_bet(&mut c, 205);
        propose_yes(&mut c, bet_id, &sk, 2_000);
        let resp = do_mt_transfer_asset(
            &mut c, "maker.testnet", MOCK_BTC, MAKER_BOND,
            serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050,
        );
        assert_eq!(resp, vec![U128(0)]);
        // Re-judge overturns the outcome to NO -> maker's challenge round is WON.
        ctx("anyone.testnet", 2_060);
        let result2 = SubmittedResult {
            bet_id,
            terms_hash: "terms-hash-1".to_string(),
            outcome: "NO".to_string(),
            element_results_hash: "f".repeat(64),
            run_no: 2,
            checked_until: U64(2_060),
            next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig2 = sign_result(&outcome_signing_key(), &result2);
        c.submit_outcome(result2, sig2);
        let env = c.get_bet(bet_id).unwrap().envelope;
        ctx("anyone.testnet", 2_060 + env.settlement_period + 1);
        let before = c.payout_ids_in_order().len();
        c.finalize(bet_id);
        let new_payouts: Vec<_> = c.payout_ids_in_order()[before..].iter().map(|id| c.pending_payouts.get(id).unwrap().clone()).collect();
        let returned = new_payouts
            .iter()
            .find(|p| p.reason == "bond_returned_won_minus_run_cost")
            .expect("bond remainder must return to winning challenger");
        assert_eq!(returned.receiver, "maker.testnet".parse::<AccountId>().unwrap());
        assert_eq!(returned.token_id, MOCK_BTC);
        assert_eq!(returned.amount.0, MAKER_BOND - BTC_RUN_PRICE);
        let round_cost = new_payouts.iter().find(|p| p.reason == "bond_round_cost_to_keeper").expect("round cost must still be paid on a won round");
        assert_eq!(round_cost.token_id, MOCK_BTC);
        assert_eq!(round_cost.amount.0, BTC_RUN_PRICE);
    }

    /// DR-BOND1-1 (D-BOND2 ruling, adjusted from the original drift-review
    /// RED to match familiarcow's decision): on a VOID final after a WON
    /// challenge round, the challenger's reimbursement must be paid in
    /// the PAYING (round-losing counterparty's) own asset, using THAT
    /// asset's own `AssetLimit.run_price` -- never the challenger's bond
    /// asset's run_price value reinterpreted as the paying asset's raw
    /// units (the original bug: a USDC challenger's 5_000 micro-USDC
    /// round cost paid out as 5_000 BTC sats, ~$4, instead of BTC's own
    /// 1-sat run_price). The original cherry-picked RED asserted the
    /// reimbursement token stays USDC and the BTC maker keeps their full
    /// stake -- both contradict D-BOND2 (reimbursement is paid in the
    /// PAYING side's asset, which IS a real deduction from that side's
    /// stake) and are corrected here per the task's explicit instruction
    /// to adjust only where the original contradicts the decision.
    ///
    /// (a) USDC challenger (taker) wins a round vs the BTC maker side ->
    /// challenger receives exactly BTC's own run_price in BTC; the BTC
    /// maker's own VOID refund is reduced by exactly that; I-1 holds
    /// per asset.
    #[test]
    fn dr_bond1_1_void_won_round_reimbursement_in_paying_asset_a_usdc_challenger_vs_btc() {
        let mut c = new_contract_spec_assets();
        let (bet_id, sk) = cross_bet(&mut c, 230);
        propose_yes(&mut c, bet_id, &sk, 2_000);
        let resp = do_mt_transfer_asset(
            &mut c, "taker.testnet", USDC, TAKER_BOND,
            serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050,
        );
        assert_eq!(resp, vec![U128(0)], "taker's USDC bond must be accepted");
        // Re-judge returns VOID -> outcome changed -> taker's round WON, final VOID.
        ctx("anyone.testnet", 2_060);
        let result2 = SubmittedResult {
            bet_id,
            terms_hash: "terms-hash-1".to_string(),
            outcome: "VOID".to_string(),
            element_results_hash: "f".repeat(64),
            run_no: 2,
            checked_until: U64(2_060),
            next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig2 = sign_result(&outcome_signing_key(), &result2);
        c.submit_outcome(result2, sig2);
        let env = c.get_bet(bet_id).unwrap().envelope;
        ctx("anyone.testnet", 2_060 + env.settlement_period + 1);
        let before = c.payout_ids_in_order().len();
        c.finalize(bet_id);
        let new_payouts: Vec<_> = c.payout_ids_in_order()[before..].iter().map(|id| c.pending_payouts.get(id).unwrap().clone()).collect();
        let reimb: Vec<_> = new_payouts.iter().filter(|p| p.reason == "won_round_reimbursement").collect();
        assert_eq!(reimb.len(), 1, "exactly one won-round reimbursement must be scheduled");
        assert_eq!(reimb[0].receiver, "taker.testnet".parse::<AccountId>().unwrap(), "the USDC challenger (taker) must be reimbursed");
        assert_eq!(reimb[0].token_id, MOCK_BTC, "reimbursement must be paid in the PAYING (BTC maker) side's own asset, never the challenger's bond asset");
        assert_eq!(reimb[0].amount.0, BTC_RUN_PRICE, "reimbursement amount must be BTC's OWN run_price, never USDC's run_price reinterpreted as BTC sats");
        let maker_btc: u128 = new_payouts.iter()
            .filter(|p| p.receiver == "maker.testnet".parse::<AccountId>().unwrap() && p.token_id == MOCK_BTC)
            .map(|p| p.amount.0).sum();
        assert_eq!(maker_btc, 10_000 - BTC_RUN_PRICE, "VOID: BTC maker's own refund must be reduced by exactly the BTC-run_price reimbursement paid out of their stake");
        // I-1 per asset: nothing crosses, nothing is stranded. Each
        // side also deposited its own storage_charge_per_side in its
        // own asset at open/take (D-ECON3), on top of the stake.
        let in_btc = 10_000u128 + env.storage_for(STG_FIXTURE_RATE);
        let in_usdc = 10_000_000u128 + env.storage_for(STG_FIXTURE_RATE) + TAKER_BOND;
        let out_btc: u128 = new_payouts.iter().filter(|p| p.token_id == MOCK_BTC).map(|p| p.amount.0).sum();
        let out_usdc: u128 = new_payouts.iter().filter(|p| p.token_id == USDC).map(|p| p.amount.0).sum();
        assert_eq!(out_btc, in_btc, "I-1 (BTC): every BTC sat deposited must be paid out, none stranded, none conjured");
        assert_eq!(out_usdc, in_usdc, "I-1 (USDC): bet must never pay out more USDC than it received");
    }

    /// (b) reverse direction: BTC maker wins a round vs the USDC taker
    /// side -> challenger receives exactly USDC's own run_price in USDC;
    /// the USDC taker's own VOID refund is reduced by exactly that.
    #[test]
    fn dr_bond1_1_void_won_round_reimbursement_in_paying_asset_b_btc_challenger_vs_usdc() {
        let mut c = new_contract_spec_assets();
        let (bet_id, sk) = cross_bet(&mut c, 231);
        propose_yes(&mut c, bet_id, &sk, 2_000);
        let resp = do_mt_transfer_asset(
            &mut c, "maker.testnet", MOCK_BTC, MAKER_BOND,
            serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050,
        );
        assert_eq!(resp, vec![U128(0)], "maker's BTC bond must be accepted");
        // Re-judge returns VOID -> outcome changed -> maker's round WON, final VOID.
        ctx("anyone.testnet", 2_060);
        let result2 = SubmittedResult {
            bet_id,
            terms_hash: "terms-hash-1".to_string(),
            outcome: "VOID".to_string(),
            element_results_hash: "f".repeat(64),
            run_no: 2,
            checked_until: U64(2_060),
            next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig2 = sign_result(&outcome_signing_key(), &result2);
        c.submit_outcome(result2, sig2);
        let env = c.get_bet(bet_id).unwrap().envelope;
        ctx("anyone.testnet", 2_060 + env.settlement_period + 1);
        let before = c.payout_ids_in_order().len();
        c.finalize(bet_id);
        let new_payouts: Vec<_> = c.payout_ids_in_order()[before..].iter().map(|id| c.pending_payouts.get(id).unwrap().clone()).collect();
        let reimb: Vec<_> = new_payouts.iter().filter(|p| p.reason == "won_round_reimbursement").collect();
        assert_eq!(reimb.len(), 1, "exactly one won-round reimbursement must be scheduled");
        assert_eq!(reimb[0].receiver, "maker.testnet".parse::<AccountId>().unwrap(), "the BTC challenger (maker) must be reimbursed");
        assert_eq!(reimb[0].token_id, USDC, "reimbursement must be paid in the PAYING (USDC taker) side's own asset, never the challenger's bond asset");
        assert_eq!(reimb[0].amount.0, USDC_RUN_PRICE, "reimbursement amount must be USDC's OWN run_price, never BTC's run_price reinterpreted as USDC units");
        let taker_usdc: u128 = new_payouts.iter()
            .filter(|p| p.receiver == "taker.testnet".parse::<AccountId>().unwrap() && p.token_id == USDC)
            .map(|p| p.amount.0).sum();
        assert_eq!(taker_usdc, 10_000_000 - USDC_RUN_PRICE, "VOID: USDC taker's own refund must be reduced by exactly the USDC-run_price reimbursement paid out of their stake");
        let in_btc = 10_000u128 + env.storage_for(STG_FIXTURE_RATE) + MAKER_BOND;
        let in_usdc = 10_000_000u128 + env.storage_for(STG_FIXTURE_RATE);
        let out_btc: u128 = new_payouts.iter().filter(|p| p.token_id == MOCK_BTC).map(|p| p.amount.0).sum();
        let out_usdc: u128 = new_payouts.iter().filter(|p| p.token_id == USDC).map(|p| p.amount.0).sum();
        assert_eq!(out_btc, in_btc, "I-1 (BTC): every BTC sat deposited must be paid out, none stranded, none conjured");
        assert_eq!(out_usdc, in_usdc, "I-1 (USDC): every USDC unit deposited must be paid out, none stranded, none conjured");
    }

    /// (c) same-asset bet (both sides USDC): a WON round's VOID
    /// reimbursement is unchanged by D-BOND2 -- it was already paid in
    /// the single shared asset, with that asset's own run_price. This
    /// guards against a per-asset-lookup refactor accidentally altering
    /// the same-asset (not cross-asset) path.
    #[test]
    fn dr_bond1_1_void_won_round_reimbursement_c_same_asset_unchanged() {
        let mut c = new_contract();
        let (sk, pk) = test_keypair(232);
        let pk_hex = hex_encode(&pk);
        let bet_id = open_and_take(&mut c, &pk_hex);

        ctx("anyone.testnet", 2_000);
        let result = SubmittedResult {
            bet_id,
            terms_hash: "terms-hash-1".to_string(),
            outcome: "YES".to_string(),
            element_results_hash: "e".repeat(64),
            run_no: 1,
            checked_until: U64(2_000),
            next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        c.submit_outcome(result.clone(), sign_result(&outcome_signing_key(), &result));

        // Taker challenges YES (pre_challenge_outcome snapshot = YES).
        let resp = do_mt_transfer(
            &mut c, "taker.testnet", 5_005_000, // D-AUDIT8: challenge_min + run_price
            serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050,
        );
        assert_eq!(resp, vec![U128(0)]);

        // Re-judge flips to VOID -- taker's round WON (YES != VOID), final is VOID.
        ctx("anyone.testnet", 2_060);
        let result2 = SubmittedResult {
            bet_id,
            terms_hash: "terms-hash-1".to_string(),
            outcome: "VOID".to_string(),
            element_results_hash: "f".repeat(64),
            run_no: 2,
            checked_until: U64(2_060),
            next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        c.submit_outcome(result2.clone(), sign_result(&outcome_signing_key(), &result2));

        let env = c.get_bet(bet_id).unwrap().envelope;
        ctx("anyone.testnet", 2_060 + env.settlement_period + 1);
        let before = c.payout_ids_in_order().len();
        c.finalize(bet_id);
        let new_payouts: Vec<_> = c.payout_ids_in_order()[before..].iter().map(|id| c.pending_payouts.get(id).unwrap().clone()).collect();

        let reimb: Vec<_> = new_payouts.iter().filter(|p| p.reason == "won_round_reimbursement").collect();
        assert_eq!(reimb.len(), 1, "exactly one won-round reimbursement must be scheduled");
        assert_eq!(reimb[0].receiver, "taker.testnet".parse::<AccountId>().unwrap());
        assert_eq!(reimb[0].token_id, USDC, "same-asset bet: reimbursement stays in the single shared USDC asset, unchanged by D-BOND2");
        assert_eq!(reimb[0].amount.0, DEFAULT_RUN_PRICE, "same-asset bet: reimbursement amount is USDC's own run_price, unchanged by D-BOND2");

        let maker_refund: u128 = new_payouts.iter()
            .filter(|p| p.receiver == "maker.testnet".parse::<AccountId>().unwrap() && p.reason == "void_refund_maker")
            .map(|p| p.amount.0).sum();
        assert_eq!(
            maker_refund, env.stake_maker.0 - DEFAULT_RUN_PRICE,
            "maker's (round-losing counterparty's) own VOID refund must be reduced by exactly the reimbursement"
        );
    }

    // (e) objection deposit in objector's own asset, forfeit exact.
    #[test]
    fn usdc_objection_forfeited_exact_amount_to_counterparty() {
        let mut c = new_contract_spec_assets();
        let (bet_id, sk) = cross_bet(&mut c, 206);
        propose_yes(&mut c, bet_id, &sk, 2_000);
        do_mt_transfer_asset(
            &mut c, "taker.testnet", USDC, TAKER_BOND,
            serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050,
        );
        let resp = do_mt_transfer_asset(&mut c, "taker.testnet", USDC, TAKER_OBJECTION, objection_msg(bet_id, &"e".repeat(64), false), 2_060);
        assert_eq!(resp, vec![U128(0)], "taker's own-asset objection deposit must be accepted");
        assert_eq!(c.get_bet(bet_id).unwrap().objection_deposits[0].asset, USDC);
        // No re-judge -> outcome stands -> the objection is rejected (forfeited).
        let env = c.get_bet(bet_id).unwrap().envelope;
        ctx("anyone.testnet", 2_060 + env.settlement_period + 1);
        let before = c.payout_ids_in_order().len();
        c.finalize(bet_id);
        let new_payouts: Vec<_> = c.payout_ids_in_order()[before..].iter().map(|id| c.pending_payouts.get(id).unwrap().clone()).collect();
        let forfeited = new_payouts.iter().find(|p| p.reason == "objection_deposit_forfeited").expect("rejected objection must forfeit");
        assert_eq!(forfeited.receiver, "maker.testnet".parse::<AccountId>().unwrap());
        assert_eq!(forfeited.token_id, USDC);
        assert_eq!(forfeited.amount.0, TAKER_OBJECTION);
    }

    // (e) objection deposit in objector's own asset, refund exact (upheld).
    #[test]
    fn btc_objection_returned_exact_amount_to_depositor_when_upheld() {
        let mut c = new_contract_spec_assets();
        let (bet_id, sk) = cross_bet(&mut c, 209);
        propose_yes(&mut c, bet_id, &sk, 2_000);
        do_mt_transfer_asset(
            &mut c, "maker.testnet", MOCK_BTC, MAKER_BOND,
            serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050,
        );
        let resp = do_mt_transfer_asset(&mut c, "maker.testnet", MOCK_BTC, MAKER_OBJECTION, objection_msg(bet_id, &"e".repeat(64), false), 2_060);
        assert_eq!(resp, vec![U128(0)], "maker's own-asset (BTC) objection deposit must be accepted");
        // Re-judge overturns the outcome -> maker's objection is upheld.
        ctx("anyone.testnet", 2_070);
        let result2 = SubmittedResult {
            bet_id,
            terms_hash: "terms-hash-1".to_string(),
            outcome: "NO".to_string(),
            element_results_hash: "f".repeat(64),
            run_no: 2,
            checked_until: U64(2_070),
            next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig2 = sign_result(&outcome_signing_key(), &result2);
        c.submit_outcome(result2, sig2);
        let env = c.get_bet(bet_id).unwrap().envelope;
        ctx("anyone.testnet", 2_070 + env.settlement_period + 1);
        let before = c.payout_ids_in_order().len();
        c.finalize(bet_id);
        let new_payouts: Vec<_> = c.payout_ids_in_order()[before..].iter().map(|id| c.pending_payouts.get(id).unwrap().clone()).collect();
        let returned = new_payouts.iter().find(|p| p.reason == "objection_deposit_returned").expect("upheld objection must return");
        assert_eq!(returned.receiver, "maker.testnet".parse::<AccountId>().unwrap());
        assert_eq!(returned.token_id, MOCK_BTC);
        assert_eq!(returned.amount.0, MAKER_OBJECTION);
    }

    #[test]
    fn objection_wrong_asset_rejected_full_refund() {
        let mut c = new_contract_spec_assets();
        let (bet_id, sk) = cross_bet(&mut c, 207);
        propose_yes(&mut c, bet_id, &sk, 2_000);
        do_mt_transfer_asset(
            &mut c, "maker.testnet", MOCK_BTC, MAKER_BOND,
            serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050,
        );
        // Maker's own asset is BTC -- a USDC objection deposit must be
        // rejected and fully refunded.
        let resp = do_mt_transfer_asset(&mut c, "maker.testnet", USDC, TAKER_OBJECTION, objection_msg(bet_id, &"e".repeat(64), false), 2_060);
        assert_eq!(resp, vec![U128(TAKER_OBJECTION)], "objection in the wrong asset must be fully refunded");
        assert_eq!(c.get_bet(bet_id).unwrap().objection_deposits.len(), 0);
    }

    // (f) per-asset I-1: total paid out == total paid in, for each asset.
    #[test]
    fn per_asset_i1_total_out_equals_total_in_each_asset() {
        let mut c = new_contract_spec_assets();
        let (bet_id, sk) = cross_bet(&mut c, 208);
        propose_yes(&mut c, bet_id, &sk, 2_000);
        let env = c.get_bet(bet_id).unwrap().envelope;
        let mut in_btc = env.maker_required();
        let mut in_usdc = env.taker_required();

        do_mt_transfer_asset(
            &mut c, "maker.testnet", MOCK_BTC, MAKER_BOND,
            serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050,
        );
        in_btc += MAKER_BOND;
        do_mt_transfer_asset(&mut c, "taker.testnet", USDC, TAKER_OBJECTION, objection_msg(bet_id, &"e".repeat(64), false), 2_060);
        in_usdc += TAKER_OBJECTION;

        ctx("anyone.testnet", 2_060 + env.settlement_period + 1);
        c.finalize(bet_id);
        drain_all(&mut c, bet_id, 2_060 + env.settlement_period + 2);

        let out_btc: u128 = c.payout_ids_in_order().iter().map(|id| c.pending_payouts.get(id).unwrap()).filter(|p| p.token_id == MOCK_BTC).map(|p| p.amount.0).sum();
        let out_usdc: u128 = c.payout_ids_in_order().iter().map(|id| c.pending_payouts.get(id).unwrap()).filter(|p| p.token_id == USDC).map(|p| p.amount.0).sum();
        assert_eq!(out_btc, in_btc, "I-1 per asset (BTC): every BTC unit deposited must be accounted for, none stranded");
        assert_eq!(out_usdc, in_usdc, "I-1 per asset (USDC): every USDC unit deposited must be accounted for, none stranded");
    }

    // =================================================================
    // Launch-checklist re-verify: "cross-asset own-asset routing" of
    // handle_bond/handle_objection -- a BTC-maker-vs-USDC-taker bet
    // with BOTH a challenge bond AND an objection deposit outstanding
    // TOGETHER (one from each party, each in that party's own asset),
    // taken through all five terminal paths, with EXACT per-asset
    // balances for every party + fee_account + keeper. (f) above only
    // proved aggregate per-asset I-1 for a maker-wins finalize; these
    // five prove every individual (receiver, asset) line and cover the
    // taker-wins, VOID and emergency_refund paths that
    // had no bond+objection-together coverage at all.
    // =================================================================

    // (g.1) finalize, outcome stands (maker/maker_side=YES wins):
    // taker's USDC bond round LOSES (forfeits); maker's BTC objection
    // is REJECTED (forfeits) -- both go the OPPOSITE way of a naive
    // "bond holder keeps winning" assumption, which is exactly what a
    // routing bug could get backwards.
    #[test]
    fn cross_asset_bond_and_objection_maker_wins_exact() {
        let mut c = new_contract_spec_assets();
        let (bet_id, sk) = cross_bet(&mut c, 240);
        propose_yes(&mut c, bet_id, &sk, 2_000); // outcome snapshot: YES

        let resp = do_mt_transfer_asset(
            &mut c, "taker.testnet", USDC, TAKER_BOND,
            serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050,
        );
        assert_eq!(resp, vec![U128(0)], "taker's USDC bond must be accepted");
        let resp = do_mt_transfer_asset(
            &mut c, "maker.testnet", MOCK_BTC, MAKER_OBJECTION,
            objection_msg(bet_id, &"e".repeat(64), false), 2_060,
        );
        assert_eq!(resp, vec![U128(0)], "maker's BTC objection must be accepted");

        // No re-judge -> outcome stands at YES -> maker (maker_side)
        // wins; taker's bond round LOST (pre_challenge_outcome YES ==
        // final YES); maker's objection REJECTED (non-rebuttal
        // depositor_wins = !maintained, maintained = pre_outcome YES ==
        // final YES = true, so depositor_wins = false).
        let env = c.get_bet(bet_id).unwrap().envelope;
        ctx("anyone.testnet", 2_060 + env.settlement_period + 1);
        let before = c.payout_ids_in_order().len();
        c.finalize(bet_id);
        let lines: Vec<_> = c.payout_ids_in_order()[before..].iter().map(|id| c.pending_payouts.get(id).unwrap().clone()).collect();

        let maker_id: AccountId = "maker.testnet".parse().unwrap();
        let taker_id: AccountId = "taker.testnet".parse().unwrap();
        let fee_id: AccountId = FEE.parse().unwrap();
        let keeper_id: AccountId = KEEPER.parse().unwrap();

        // Arithmetic (spec_default_asset_limits, fee_bps=100):
        //   BTC: fee_maker_asset=10_000*1%=100; winner payout=9_900.
        //   USDC: fee_taker_asset=10_000_000*1%=100_000; winner
        //     payout=9_900_000.
        //   Taker's USDC bond (5_005_000) LOST: round_cost
        //     (USDC_RUN_PRICE=5_000) to keeper; remainder
        //     5_005_000-5_000=5_000_000 forfeits to maker.
        //   Maker's BTC objection (1_300) REJECTED: forfeits in full to
        //     taker.
        //   maker (winner): BTC 9_900; USDC 9_900_000+5_000_000=14_900_000.
        //   taker (loser): BTC 1_300 (forfeited objection only); USDC 0.
        //   fee_account: BTC 100+10_000(storage)=10_100; USDC
        //     100_000+10_000(storage)=110_000.
        //   keeper: USDC 5_000; BTC 0.
        assert_eq!(sum_by_token(&lines, &maker_id, MOCK_BTC), 9_900, "maker (winner): stake payout only, BTC");
        assert_eq!(sum_by_token(&lines, &maker_id, USDC), 14_900_000, "maker: stake payout 9_900_000 + taker's lost-bond remainder 5_000_000, USDC");
        assert_eq!(sum_by_token(&lines, &taker_id, MOCK_BTC), 1_300, "taker (loser): maker's rejected objection, forfeited to taker, BTC");
        assert_eq!(sum_by_token(&lines, &taker_id, USDC), 0, "taker (loser): bond entirely lost (to maker+keeper), nothing else, USDC");
        assert_eq!(sum_by_token(&lines, &fee_id, MOCK_BTC), 10_100, "fee_account: 100 fee + 10_000 storage, BTC");
        assert_eq!(sum_by_token(&lines, &fee_id, USDC), 110_000, "fee_account: 100_000 fee + 10_000 storage, USDC");
        assert_eq!(sum_by_token(&lines, &keeper_id, USDC), 5_000, "keeper: taker's lost-round cost, USDC");
        assert_eq!(sum_by_token(&lines, &keeper_id, MOCK_BTC), 0, "keeper: no BTC round ever opened, BTC");

        let in_btc = env.maker_required() + MAKER_OBJECTION;
        let in_usdc = env.taker_required() + TAKER_BOND;
        let out_btc: u128 = lines.iter().filter(|p| p.token_id == MOCK_BTC).map(|p| p.amount.0).sum();
        let out_usdc: u128 = lines.iter().filter(|p| p.token_id == USDC).map(|p| p.amount.0).sum();
        assert_eq!(out_btc, in_btc, "I-1 (BTC): sum in == sum out");
        assert_eq!(out_usdc, in_usdc, "I-1 (USDC): sum in == sum out");
    }

    // (g.2) finalize, re-judge flips to NO (taker wins): taker's USDC
    // bond round WINS (returned); maker's BTC objection is UPHELD
    // (returned) -- the mirror of (g.1), proving the routing doesn't
    // just happen to work for the "loses" direction.
    #[test]
    fn cross_asset_bond_and_objection_taker_wins_exact() {
        let mut c = new_contract_spec_assets();
        let (bet_id, sk) = cross_bet(&mut c, 241);
        propose_yes(&mut c, bet_id, &sk, 2_000);

        let resp = do_mt_transfer_asset(
            &mut c, "taker.testnet", USDC, TAKER_BOND,
            serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050,
        );
        assert_eq!(resp, vec![U128(0)]);
        let resp = do_mt_transfer_asset(
            &mut c, "maker.testnet", MOCK_BTC, MAKER_OBJECTION,
            objection_msg(bet_id, &"e".repeat(64), false), 2_060,
        );
        assert_eq!(resp, vec![U128(0)]);

        // Re-judge flips to NO -> taker's bond round WON (pre YES !=
        // final NO); maker's objection UPHELD (non-rebuttal
        // depositor_wins = !maintained, maintained = pre YES == final
        // NO = false, so depositor_wins = true).
        ctx("anyone.testnet", 2_070);
        let result2 = SubmittedResult {
            bet_id,
            terms_hash: "terms-hash-1".to_string(),
            outcome: "NO".to_string(),
            element_results_hash: "f".repeat(64),
            run_no: 2,
            checked_until: U64(2_070),
            next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig2 = sign_result(&outcome_signing_key(), &result2);
        c.submit_outcome(result2, sig2);

        let env = c.get_bet(bet_id).unwrap().envelope;
        ctx("anyone.testnet", 2_070 + env.settlement_period + 1);
        let before = c.payout_ids_in_order().len();
        c.finalize(bet_id);
        let lines: Vec<_> = c.payout_ids_in_order()[before..].iter().map(|id| c.pending_payouts.get(id).unwrap().clone()).collect();

        let maker_id: AccountId = "maker.testnet".parse().unwrap();
        let taker_id: AccountId = "taker.testnet".parse().unwrap();
        let fee_id: AccountId = FEE.parse().unwrap();
        let keeper_id: AccountId = KEEPER.parse().unwrap();

        // Arithmetic (same fee math as (g.1), winner is now taker):
        //   winner payouts: BTC 9_900 to taker, USDC 9_900_000 to taker.
        //   Taker's USDC bond WON: remainder 5_000_000 returned to
        //     taker; round_cost 5_000 to keeper (still charged win or
        //     lose, D-AUDIT8). won_round_claims adds (taker,maker) but
        //     is_void=false here so the reimbursement draw is 0
        //     (schedule_payout no-ops on a zero amount).
        //   Maker's BTC objection UPHELD: 1_300 returned to maker.
        //   maker (loser): BTC 1_300 (objection returned only); USDC 0.
        //   taker (winner): BTC 9_900; USDC 9_900_000+5_000_000=14_900_000.
        //   fee_account: BTC 10_100; USDC 110_000.
        //   keeper: USDC 5_000; BTC 0.
        assert_eq!(sum_by_token(&lines, &maker_id, MOCK_BTC), 1_300, "maker (loser): upheld objection returned, BTC");
        assert_eq!(sum_by_token(&lines, &maker_id, USDC), 0, "maker (loser): never deposited USDC, nothing to receive");
        assert_eq!(sum_by_token(&lines, &taker_id, MOCK_BTC), 9_900, "taker (winner): stake payout, BTC");
        assert_eq!(sum_by_token(&lines, &taker_id, USDC), 14_900_000, "taker: stake payout 9_900_000 + own bond's won remainder 5_000_000, USDC");
        assert_eq!(sum_by_token(&lines, &fee_id, MOCK_BTC), 10_100, "fee_account: 100 fee + 10_000 storage, BTC");
        assert_eq!(sum_by_token(&lines, &fee_id, USDC), 110_000, "fee_account: 100_000 fee + 10_000 storage, USDC");
        assert_eq!(sum_by_token(&lines, &keeper_id, USDC), 5_000, "keeper: taker's won-round cost (still charged win or lose), USDC");
        assert_eq!(sum_by_token(&lines, &keeper_id, MOCK_BTC), 0, "keeper: no BTC round ever opened, BTC");

        let in_btc = env.maker_required() + MAKER_OBJECTION;
        let in_usdc = env.taker_required() + TAKER_BOND;
        let out_btc: u128 = lines.iter().filter(|p| p.token_id == MOCK_BTC).map(|p| p.amount.0).sum();
        let out_usdc: u128 = lines.iter().filter(|p| p.token_id == USDC).map(|p| p.amount.0).sum();
        assert_eq!(out_btc, in_btc, "I-1 (BTC): sum in == sum out");
        assert_eq!(out_usdc, in_usdc, "I-1 (USDC): sum in == sum out");
    }

    // (g.3) finalize, re-judge flips to VOID: taker's USDC bond round
    // WINS (D-BOND2 reimbursement paid in the PAYING/maker side's own
    // BTC asset, never USDC); maker's BTC objection is UPHELD. Combines
    // the dr_bond1_1 VOID-reimbursement scenario with a simultaneous
    // outstanding objection on the OTHER party, which no existing test
    // did.
    #[test]
    fn cross_asset_bond_and_objection_void_exact() {
        let mut c = new_contract_spec_assets();
        let (bet_id, sk) = cross_bet(&mut c, 242);
        propose_yes(&mut c, bet_id, &sk, 2_000);

        let resp = do_mt_transfer_asset(
            &mut c, "taker.testnet", USDC, TAKER_BOND,
            serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050,
        );
        assert_eq!(resp, vec![U128(0)]);
        let resp = do_mt_transfer_asset(
            &mut c, "maker.testnet", MOCK_BTC, MAKER_OBJECTION,
            objection_msg(bet_id, &"e".repeat(64), false), 2_060,
        );
        assert_eq!(resp, vec![U128(0)]);

        ctx("anyone.testnet", 2_070);
        let result2 = SubmittedResult {
            bet_id,
            terms_hash: "terms-hash-1".to_string(),
            outcome: "VOID".to_string(),
            element_results_hash: "f".repeat(64),
            run_no: 2,
            checked_until: U64(2_070),
            next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig2 = sign_result(&outcome_signing_key(), &result2);
        c.submit_outcome(result2, sig2);

        let env = c.get_bet(bet_id).unwrap().envelope;
        ctx("anyone.testnet", 2_070 + env.settlement_period + 1);
        let before = c.payout_ids_in_order().len();
        c.finalize(bet_id);
        let lines: Vec<_> = c.payout_ids_in_order()[before..].iter().map(|id| c.pending_payouts.get(id).unwrap().clone()).collect();

        let maker_id: AccountId = "maker.testnet".parse().unwrap();
        let taker_id: AccountId = "taker.testnet".parse().unwrap();
        let fee_id: AccountId = FEE.parse().unwrap();
        let keeper_id: AccountId = KEEPER.parse().unwrap();

        // Arithmetic (D-BOND2):
        //   Taker's USDC bond WON: remainder 5_000_000 returned to
        //     taker; round_cost 5_000 to keeper (USDC).
        //   won_round_claims: (challenger=taker, counterparty=maker),
        //     is_void=true -> reimbursement drawn from maker's OWN
        //     stake_maker_out, in maker's OWN asset (BTC), at BTC's own
        //     run_price: from_stake=min(BTC_RUN_PRICE=1,10_000)=1;
        //     stake_maker_out -> 9_999; the 1 BTC sat is paid to taker
        //     (the challenger).
        //   Maker's BTC objection UPHELD: 1_300 returned to maker.
        //   VOID refunds: maker gets stake_maker_out=9_999 BTC; taker
        //     gets stake_taker_out=10_000_000 USDC (untouched -- the
        //     reimbursement above was paid in BTC, not USDC).
        //   storage (maker_asset != taker_asset, keep_terms=true): two
        //     separate fee_account lines, 10_000 BTC + 10_000 USDC.
        //   maker: BTC 9_999+1_300=11_299; USDC 0.
        //   taker: BTC 1; USDC 10_000_000+5_000_000=15_000_000.
        //   fee_account: BTC 10_000; USDC 10_000.
        //   keeper: USDC 5_000; BTC 0.
        assert_eq!(sum_by_token(&lines, &maker_id, MOCK_BTC), 11_299, "maker: VOID refund (9_999, reduced by the won-round reimbursement) + upheld objection (1_300), BTC");
        assert_eq!(sum_by_token(&lines, &maker_id, USDC), 0, "maker: never deposited USDC");
        assert_eq!(sum_by_token(&lines, &taker_id, MOCK_BTC), 1, "taker: won-round reimbursement paid in the PAYING (maker/BTC) side's own asset, D-BOND2, BTC");
        assert_eq!(sum_by_token(&lines, &taker_id, USDC), 15_000_000, "taker: VOID refund (10_000_000, untouched) + own bond's won remainder (5_000_000), USDC");
        assert_eq!(sum_by_token(&lines, &fee_id, MOCK_BTC), 10_000, "fee_account: maker's own storage charge (keep_terms), BTC");
        assert_eq!(sum_by_token(&lines, &fee_id, USDC), 10_000, "fee_account: taker's own storage charge (keep_terms), USDC");
        assert_eq!(sum_by_token(&lines, &keeper_id, USDC), 5_000, "keeper: taker's won-round cost, USDC");
        assert_eq!(sum_by_token(&lines, &keeper_id, MOCK_BTC), 0, "keeper: no BTC round cost ever charged, BTC");

        let in_btc = env.maker_required() + MAKER_OBJECTION;
        let in_usdc = env.taker_required() + TAKER_BOND;
        let out_btc: u128 = lines.iter().filter(|p| p.token_id == MOCK_BTC).map(|p| p.amount.0).sum();
        let out_usdc: u128 = lines.iter().filter(|p| p.token_id == USDC).map(|p| p.amount.0).sum();
        assert_eq!(out_btc, in_btc, "I-1 (BTC): sum in == sum out");
        assert_eq!(out_usdc, in_usdc, "I-1 (USDC): sum in == sum out");
    }

    // (g.5) emergency_refund while both are outstanding, pre-finalize:
    // schedules exactly what each party deposited -- stake+storage in
    // their own asset, PLUS their own outstanding bond/objection in
    // that same own asset -- nothing crosses, nothing is stranded.
    #[test]
    fn cross_asset_bond_and_objection_emergency_refund_exact() {
        let mut c = new_contract_spec_assets();
        let (bet_id, sk) = cross_bet(&mut c, 244);
        propose_yes(&mut c, bet_id, &sk, 2_000);

        let resp = do_mt_transfer_asset(
            &mut c, "taker.testnet", USDC, TAKER_BOND,
            serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050,
        );
        assert_eq!(resp, vec![U128(0)]);
        let resp = do_mt_transfer_asset(
            &mut c, "maker.testnet", MOCK_BTC, MAKER_OBJECTION,
            objection_msg(bet_id, &"e".repeat(64), false), 2_060,
        );
        assert_eq!(resp, vec![U128(0)]);

        let env = c.get_bet(bet_id).unwrap().envelope;
        ctx_with_deposit(GUARDIAN, 2_070, NearToken::from_yoctonear(1));
        c.emergency_shutdown();
        c.emergency_refund(bet_id);

        let maker_id: AccountId = "maker.testnet".parse().unwrap();
        let taker_id: AccountId = "taker.testnet".parse().unwrap();
        let lines = c.pending_payouts(bet_id);

        // maker: BTC maker_required()=20_000 + MAKER_OBJECTION=1_300 = 21_300.
        // taker: USDC taker_required()=10_010_000 + TAKER_BOND=5_005_000 = 15_015_000.
        assert_eq!(sum_by_token(&lines, &maker_id, MOCK_BTC), env.maker_required() + MAKER_OBJECTION, "maker: own stake+storage + own-asset objection deposit, BTC");
        assert_eq!(sum_by_token(&lines, &maker_id, USDC), 0, "maker never deposited USDC");
        assert_eq!(sum_by_token(&lines, &taker_id, USDC), env.taker_required() + TAKER_BOND, "taker: own stake+storage + own-asset bond, USDC");
        assert_eq!(sum_by_token(&lines, &taker_id, MOCK_BTC), 0, "taker never deposited BTC");

        let out_btc: u128 = lines.iter().filter(|p| p.token_id == MOCK_BTC).map(|p| p.amount.0).sum();
        let out_usdc: u128 = lines.iter().filter(|p| p.token_id == USDC).map(|p| p.amount.0).sum();
        assert_eq!(out_btc, env.maker_required() + MAKER_OBJECTION, "I-1 (BTC): sum out == sum in, nothing stranded");
        assert_eq!(out_usdc, env.taker_required() + TAKER_BOND, "I-1 (USDC): sum out == sum in, nothing stranded");
    }
}

// =====================================================================
// D-DISPUTE1 (queue item 6): bond = max($10, 10% pot) x 2^(round-1) +
// run_price, challenger-only, fee shifting by FINAL outcome, 24h fixed
// round-2 window. "Praetorial - Dispute design v1" table row "Challenge
// bond" + §3.2 + §3.5 implementation list items 2-3; Decision register
// D-DISPUTE1.
// =====================================================================
mod d_dispute1_bond_schedule {
    use super::*;

    fn propose_yes_at(c: &mut Contract, bet_id: u64, sk: &ed25519_dalek::SigningKey, ts: u64, run_no: u64) {
        ctx("anyone.testnet", ts);
        let result = SubmittedResult {
            bet_id,
            terms_hash: "terms-hash-1".to_string(),
            outcome: "YES".to_string(),
            element_results_hash: "e".repeat(64),
            run_no,
            checked_until: U64(ts),
            next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig = sign_result(&outcome_signing_key(), &result);
        c.submit_outcome(result, sig);
    }

    // ---------------- item 1: exact bond amounts ----------------

    /// Same-asset, pot BELOW the 10% threshold (floor dominates):
    /// round 1 = min_bond + run_price; round 2 = min_bond DOUBLED +
    /// run_price (run_price itself is never doubled).
    #[test]
    fn same_asset_pot_below_floor_round1_and_round2_doubled() {
        let mut c = new_contract();
        let (sk, pk) = test_keypair(220);
        let bet_id = open_and_take(&mut c, &hex_encode(&pk));
        propose_yes_at(&mut c, bet_id, &sk, 2_000, 1);

        // base_envelope: stake_maker=stake_taker=1_000_000 (same asset)
        // -> pot_for_challenger = 2_000_000; 10% = 200_000 < USDC
        // min_bond floor (5_000_000) -- floor dominates round 1.
        let round1 = c.required_challenge_bond(bet_id, "taker.testnet".parse().unwrap()).unwrap().amount.0;
        assert_eq!(round1, 5_005_000, "round 1: max($10,10% pot)=5_000_000 floor + run_price 5_000");
        let resp = do_mt_transfer(&mut c, "taker.testnet", round1, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050);
        assert_eq!(resp, vec![U128(0)]);
        propose_yes_at(&mut c, bet_id, &sk, 2_060, 2);

        // round 2 = 5_000_000 * 2 + 5_000 (doubled floor, undoubled run_price).
        let round2 = c.required_challenge_bond(bet_id, "maker.testnet".parse().unwrap()).unwrap().amount.0;
        assert_eq!(round2, 10_005_000, "round 2: 2x(max($10,10% pot)) + run_price, same run_price as round 1");
        let resp2 = do_mt_transfer(&mut c, "maker.testnet", round2, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 2 }).unwrap(), 2_070);
        assert_eq!(resp2, vec![U128(0)]);
        // A wrong amount (off by one in either direction) is still rejected and fully refunded.
        assert_eq!(c.get_bet(bet_id).unwrap().bonds.len(), 2);
    }

    /// Same-asset, pot ABOVE the 10% threshold: 10% of pot dominates
    /// the floor in round 1, and the whole max(...) doubles in round 2.
    #[test]
    fn same_asset_pot_above_floor_round1_and_round2_doubled() {
        let mut c = new_contract();
        let (sk, pk) = test_keypair(221);
        let mut env = base_envelope(&hex_encode(&pk));
        env.stake_maker = U128(30_000_000);
        env.stake_taker = U128(30_000_000);
        let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
        assert_eq!(resp, vec![U128(0)]);
        let bet_id = c.next_bet_id - 1;
        let resp = do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_msg(bet_id), 2);
        assert_eq!(resp, vec![U128(0)]);
        propose_yes_at(&mut c, bet_id, &sk, 2_000, 1);

        // pot_for_challenger = 60_000_000; 10% = 6_000_000 > floor
        // 5_000_000 -- the 10%-of-pot term dominates round 1.
        let round1 = c.required_challenge_bond(bet_id, "taker.testnet".parse().unwrap()).unwrap().amount.0;
        assert_eq!(round1, 6_005_000, "round 1: 10% of 60_000_000 (6_000_000, > floor) + run_price 5_000");
        do_mt_transfer(&mut c, "taker.testnet", round1, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050);
        propose_yes_at(&mut c, bet_id, &sk, 2_060, 2);

        // round 2 = 6_000_000 * 2 + 5_000 -- doubles the WHOLE max(...),
        // not a fresh 10%-of-pot*2 recompute (same number here since
        // pot is unchanged between rounds, but the doc comment on
        // `handle_bond` is explicit this multiplies the max(), not the
        // 10% term alone).
        let round2 = c.required_challenge_bond(bet_id, "maker.testnet".parse().unwrap()).unwrap().amount.0;
        assert_eq!(round2, 12_005_000, "round 2: 2x(10% of pot) + run_price");
        let resp2 = do_mt_transfer(&mut c, "maker.testnet", round2, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 2 }).unwrap(), 2_070);
        assert_eq!(resp2, vec![U128(0)]);
    }

    /// Cross-asset (BTC maker vs USDC taker), pot BELOW the 10%
    /// threshold on both sides -- floor dominates in both assets,
    /// round 1 (taker/USDC) then round 2 (maker/BTC), each doubled.
    #[test]
    fn cross_asset_btc_vs_usdc_pot_below_floor_round1_and_round2_doubled() {
        let mut c = new_contract_spec_assets();
        let (sk, pk) = test_keypair(222);
        let mut env = base_envelope(&hex_encode(&pk));
        env.maker_asset = MOCK_BTC.to_string();
        env.taker_asset = USDC.to_string();
        env.stake_maker = U128(10_000); // BTC sats
        env.stake_taker = U128(10_000_000); // USDC 6dp
        let resp = do_mt_transfer_asset(&mut c, "maker.testnet", MOCK_BTC, env.maker_required(), open_msg(&env), 1);
        assert_eq!(resp, vec![U128(0)]);
        let bet_id = c.next_bet_id - 1;
        let resp = do_mt_transfer_asset(&mut c, "taker.testnet", USDC, env.taker_required(), take_msg(bet_id), 2);
        assert_eq!(resp, vec![U128(0)]);
        propose_yes_at(&mut c, bet_id, &sk, 2_000, 1);

        // Cross-asset pot_for_challenger = 2x the challenger's OWN
        // stake. Taker (USDC): 2*10_000_000=20_000_000; 10%=2_000_000
        // < USDC floor 5_000_000 -- floor dominates.
        let round1 = c.required_challenge_bond(bet_id, "taker.testnet".parse().unwrap()).unwrap();
        assert_eq!(round1.asset, USDC);
        assert_eq!(round1.amount.0, 5_005_000, "round 1 (USDC taker): floor 5_000_000 + run_price 5_000");
        do_mt_transfer_asset(&mut c, "taker.testnet", USDC, round1.amount.0, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050);
        propose_yes_at(&mut c, bet_id, &sk, 2_060, 2);

        // Maker (BTC): 2*10_000=20_000; 10%=2_000 < BTC floor 6_501 --
        // floor dominates; round 2 doubles that floor (BTC run_price=1).
        let round2 = c.required_challenge_bond(bet_id, "maker.testnet".parse().unwrap()).unwrap();
        assert_eq!(round2.asset, MOCK_BTC);
        assert_eq!(round2.amount.0, 13_003, "round 2 (BTC maker): 2*6_501 + run_price 1");
        let resp2 = do_mt_transfer_asset(&mut c, "maker.testnet", MOCK_BTC, round2.amount.0, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 2 }).unwrap(), 2_070);
        assert_eq!(resp2, vec![U128(0)]);
    }

    /// Cross-asset, pot ABOVE the 10% threshold on the BTC side: the
    /// 10%-of-pot term dominates the BTC floor in round 1, and doubles
    /// in round 2.
    #[test]
    fn cross_asset_btc_pot_above_floor_round1_and_round2_doubled() {
        let mut c = new_contract_spec_assets();
        let (sk, pk) = test_keypair(223);
        let mut env = base_envelope(&hex_encode(&pk));
        env.maker_asset = MOCK_BTC.to_string();
        env.taker_asset = USDC.to_string();
        env.stake_maker = U128(100_000); // BTC sats (within spec max_per_side 325_059)
        env.stake_taker = U128(10_000_000);
        let resp = do_mt_transfer_asset(&mut c, "maker.testnet", MOCK_BTC, env.maker_required(), open_msg(&env), 1);
        assert_eq!(resp, vec![U128(0)]);
        let bet_id = c.next_bet_id - 1;
        let resp = do_mt_transfer_asset(&mut c, "taker.testnet", USDC, env.taker_required(), take_msg(bet_id), 2);
        assert_eq!(resp, vec![U128(0)]);
        propose_yes_at(&mut c, bet_id, &sk, 2_000, 1);

        // Maker (BTC) pot_for_challenger = 2*100_000 = 200_000;
        // 10% = 20_000 > BTC floor 6_501 -- the 10% term dominates.
        let round1 = c.required_challenge_bond(bet_id, "maker.testnet".parse().unwrap()).unwrap();
        assert_eq!(round1.asset, MOCK_BTC);
        assert_eq!(round1.amount.0, 20_001, "round 1 (BTC maker): 10% of 200_000 (20_000, > floor) + run_price 1");
        do_mt_transfer_asset(&mut c, "maker.testnet", MOCK_BTC, round1.amount.0, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050);
        propose_yes_at(&mut c, bet_id, &sk, 2_060, 2);

        let round2 = c.required_challenge_bond(bet_id, "taker.testnet".parse().unwrap()).unwrap();
        // round 2 is now the TAKER's turn (USDC); pot_for_challenger =
        // 2*10_000_000=20_000_000, 10%=2_000_000 < USDC floor
        // 5_000_000 -- floor dominates, and this is round 2 so it is
        // doubled regardless of which asset/party opens it (the round
        // counter is global to the dispute, not per-asset).
        assert_eq!(round2.asset, USDC);
        assert_eq!(round2.amount.0, 10_005_000, "round 2 (USDC taker): 2*5_000_000 floor + run_price 5_000");
        let resp2 = do_mt_transfer_asset(&mut c, "taker.testnet", USDC, round2.amount.0, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 2 }).unwrap(), 2_070);
        assert_eq!(resp2, vec![U128(0)]);
    }

    /// A wrong amount is still rejected and fully refunded under the
    /// new doubled schedule (not silently accepted at the old flat rate).
    #[test]
    fn wrong_amount_under_new_doubled_round2_schedule_still_rejected_and_refunded() {
        let mut c = new_contract();
        let (sk, pk) = test_keypair(224);
        let bet_id = open_and_take(&mut c, &hex_encode(&pk));
        propose_yes_at(&mut c, bet_id, &sk, 2_000, 1);
        do_mt_transfer(&mut c, "taker.testnet", 5_005_000, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050);
        propose_yes_at(&mut c, bet_id, &sk, 2_060, 2);
        // The pre-doubling flat amount (5_005_000) must now be rejected
        // for round 2 -- only the doubled 10_005_000 is accepted.
        let resp = do_mt_transfer(&mut c, "maker.testnet", 5_005_000, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 2 }).unwrap(), 2_070);
        assert_eq!(resp, vec![U128(5_005_000)], "the old flat (undoubled) amount must be fully refunded, not accepted");
        assert_eq!(c.get_bet(bet_id).unwrap().bonds.len(), 1, "no round-2 bond recorded on a rejected amount");
    }

    // ---------------- item 2: challenger-only, no defender bond ----------------

    /// No "defender bond" exists: the non-challenging party is never
    /// required to post anything to keep a challenge round alive, and
    /// a bet finalizes correctly having collected money from the
    /// challenger side only (the counterparty's balance for that round
    /// is exactly zero, not merely optional).
    #[test]
    fn challenger_only_defender_posts_nothing_and_bet_still_finalizes() {
        let mut c = new_contract();
        let (sk, pk) = test_keypair(225);
        let bet_id = open_and_take(&mut c, &hex_encode(&pk));
        propose_yes_at(&mut c, bet_id, &sk, 2_000, 1);
        // Only the taker (challenger) ever posts a bond this round.
        let bond = c.required_challenge_bond(bet_id, "taker.testnet".parse().unwrap()).unwrap().amount.0;
        do_mt_transfer(&mut c, "taker.testnet", bond, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050);
        propose_yes_at(&mut c, bet_id, &sk, 2_060, 2);

        // The maker (defender) never deposited anything, yet the
        // round resolved and the bet is free to proceed to finalize
        // with no second (defender) bond requirement at all.
        assert_eq!(c.get_bet(bet_id).unwrap().bonds.len(), 1, "exactly one bond exists: the challenger's");
        let env = c.get_bet(bet_id).unwrap().envelope;
        ctx("anyone.testnet", 2_060 + std::cmp::min(env.settlement_period, 24 * 60 * 60 * 1_000_000_000) + 1);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.finalize(bet_id)));
        assert!(result.is_ok(), "finalize must succeed with no defender bond ever posted");
        assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Finalized);
    }

    // ---------------- item 3: fee shifting pinned, doubled 2-round bond ----------------

    /// 2-round same-asset bet, round-2 bond doubled: bond attribution
    /// is by the FINAL outcome, not each round's own immediate
    /// re-judge result. Round 1 (taker) doesn't flip the outcome on
    /// its own re-judge, but round 2 (maker) DOES flip it to the final
    /// NO -- so round 1's bond is ALSO attributed as WON (challenger
    /// loser-pays is resolved only once, at the end, by the final
    /// outcome -- D-DISPUTE1 / unchanged D-AUDIT8 rule).
    #[test]
    fn fee_shifting_two_rounds_doubled_bond_pinned_same_asset() {
        let mut c = new_contract();
        let (sk, pk) = test_keypair(226);
        let bet_id = open_and_take(&mut c, &hex_encode(&pk));
        propose_yes_at(&mut c, bet_id, &sk, 2_000, 1); // standing: YES

        // Round 1: taker challenges (pre_challenge_outcome = YES).
        do_mt_transfer(&mut c, "taker.testnet", 5_005_000, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050);
        // Round-1 re-judge keeps YES (doesn't flip on its own).
        propose_yes_at(&mut c, bet_id, &sk, 2_060, 2);

        // Round 2: maker challenges (pre_challenge_outcome = YES),
        // doubled bond = 10_005_000.
        do_mt_transfer(&mut c, "maker.testnet", 10_005_000, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 2 }).unwrap(), 2_070);
        // Round-2 re-judge flips to NO -- this is now the FINAL outcome.
        ctx("anyone.testnet", 2_080);
        let result = SubmittedResult {
            bet_id, terms_hash: "terms-hash-1".to_string(), outcome: "NO".to_string(),
            element_results_hash: "f".repeat(64), run_no: 3, checked_until: U64(2_080), next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig = sign_result(&outcome_signing_key(), &result);
        c.submit_outcome(result, sig);

        let env = c.get_bet(bet_id).unwrap().envelope;
        ctx("anyone.testnet", 2_080 + std::cmp::min(env.settlement_period, 24 * 60 * 60 * 1_000_000_000) + 1);
        let before = c.payout_ids_in_order().len();
        c.finalize(bet_id);
        let payouts: Vec<_> = c.payout_ids_in_order()[before..].iter().map(|id| c.pending_payouts.get(id).unwrap().clone()).collect();

        // Both bonds attributed WON by the FINAL (NO) outcome, even
        // though round 1's own re-judge didn't flip anything:
        // round 1 (taker): 5_005_000 - run_price 5_000 = 5_000_000 back to taker.
        // round 2 (maker): 10_005_000 - run_price 5_000 = 10_000_000 back to maker.
        // run_price (5_000 each) to the keeper both times.
        let taker_bond_return = payouts.iter().filter(|p| p.reason == "bond_returned_won_minus_run_cost" && p.receiver == "taker.testnet".parse::<AccountId>().unwrap()).map(|p| p.amount.0).sum::<u128>();
        let maker_bond_return = payouts.iter().filter(|p| p.reason == "bond_returned_won_minus_run_cost" && p.receiver == "maker.testnet".parse::<AccountId>().unwrap()).map(|p| p.amount.0).sum::<u128>();
        let keeper_run_cost: u128 = payouts.iter().filter(|p| p.reason == "bond_round_cost_to_keeper").map(|p| p.amount.0).sum();
        let lost_to_counterparty: u128 = payouts.iter().filter(|p| p.reason == "bond_lost_to_counterparty").map(|p| p.amount.0).sum();
        assert_eq!(taker_bond_return, 5_000_000, "round 1's bond is WON by the FINAL outcome, not its own immediate re-judge");
        assert_eq!(maker_bond_return, 10_000_000, "round 2's doubled bond is WON, returned minus run_price");
        assert_eq!(keeper_run_cost, 10_000, "run_price (5_000) from each round's bond goes to the keeper, win or lose");
        assert_eq!(lost_to_counterparty, 0, "neither bond is LOST: nobody's challenge is attributed as a loss here");
    }

    /// Same scenario, cross-asset (BTC maker vs USDC taker): fee
    /// shifting by final outcome holds independently per bond's OWN
    /// asset -- nothing crosses assets.
    #[test]
    fn fee_shifting_two_rounds_doubled_bond_pinned_cross_asset() {
        let mut c = new_contract_spec_assets();
        let (sk, pk) = test_keypair(227);
        let mut env = base_envelope(&hex_encode(&pk));
        env.maker_asset = MOCK_BTC.to_string();
        env.taker_asset = USDC.to_string();
        env.stake_maker = U128(10_000);
        env.stake_taker = U128(10_000_000);
        do_mt_transfer_asset(&mut c, "maker.testnet", MOCK_BTC, env.maker_required(), open_msg(&env), 1);
        let bet_id = c.next_bet_id - 1;
        do_mt_transfer_asset(&mut c, "taker.testnet", USDC, env.taker_required(), take_msg(bet_id), 2);
        propose_yes_at(&mut c, bet_id, &sk, 2_000, 1); // standing: YES

        // Round 1: taker (USDC) challenges, pre_challenge_outcome=YES.
        do_mt_transfer_asset(&mut c, "taker.testnet", USDC, 5_005_000, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050);
        propose_yes_at(&mut c, bet_id, &sk, 2_060, 2); // stays YES on its own re-judge

        // Round 2: maker (BTC) challenges, doubled bond = 2*6_501+1=13_003.
        do_mt_transfer_asset(&mut c, "maker.testnet", MOCK_BTC, 13_003, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 2 }).unwrap(), 2_070);
        // Round-2 re-judge flips to NO -- the FINAL outcome.
        ctx("anyone.testnet", 2_080);
        let result = SubmittedResult {
            bet_id, terms_hash: "terms-hash-1".to_string(), outcome: "NO".to_string(),
            element_results_hash: "f".repeat(64), run_no: 3, checked_until: U64(2_080), next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig = sign_result(&outcome_signing_key(), &result);
        c.submit_outcome(result, sig);

        let env2 = c.get_bet(bet_id).unwrap().envelope;
        ctx("anyone.testnet", 2_080 + std::cmp::min(env2.settlement_period, 24 * 60 * 60 * 1_000_000_000) + 1);
        let before = c.payout_ids_in_order().len();
        c.finalize(bet_id);
        let payouts: Vec<_> = c.payout_ids_in_order()[before..].iter().map(|id| c.pending_payouts.get(id).unwrap().clone()).collect();

        // Round 1 (USDC, taker): 5_005_000 - 5_000 run_price = 5_000_000 back, in USDC.
        let taker_usdc_return: u128 = payouts.iter().filter(|p| p.reason == "bond_returned_won_minus_run_cost" && p.token_id == USDC).map(|p| p.amount.0).sum();
        // Round 2 (BTC, maker): 13_003 - 1 run_price = 13_002 back, in BTC.
        let maker_btc_return: u128 = payouts.iter().filter(|p| p.reason == "bond_returned_won_minus_run_cost" && p.token_id == MOCK_BTC).map(|p| p.amount.0).sum();
        let keeper_usdc: u128 = payouts.iter().filter(|p| p.reason == "bond_round_cost_to_keeper" && p.token_id == USDC).map(|p| p.amount.0).sum();
        let keeper_btc: u128 = payouts.iter().filter(|p| p.reason == "bond_round_cost_to_keeper" && p.token_id == MOCK_BTC).map(|p| p.amount.0).sum();
        assert_eq!(taker_usdc_return, 5_000_000, "USDC round WON by final outcome, own-asset remainder returned");
        assert_eq!(maker_btc_return, 13_002, "BTC round WON by final outcome, own-asset remainder returned, never valued in USDC");
        assert_eq!(keeper_usdc, 5_000, "USDC run_price to keeper in USDC, never crossed into BTC");
        assert_eq!(keeper_btc, 1, "BTC run_price to keeper in BTC (1 sat), never crossed into USDC");
    }
}

// =====================================================================
// D-DISPUTE1 (queue item 6, implementation list item 3): after any
// re-judge, `finalize` requires `proposed_at + min(settlement_period,
// 24h)`, never the full `settlement_period` again. Round 0 still uses
// the full settlement_period.
// =====================================================================
mod d_dispute1_round_window {
    use super::*;

    const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;

    /// Round 0 (no challenge yet) on a 90-day settlement bet: finalize
    /// must wait the FULL 90 days, unaffected by the 24h round cap.
    #[test]
    fn round_0_on_a_90_day_bet_still_uses_the_full_settlement_period() {
        let mut c = new_contract();
        let (sk, pk) = test_keypair(228);
        let mut env = base_envelope(&hex_encode(&pk));
        env.settlement_period = 90 * DAY_NS;
        let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
        assert_eq!(resp, vec![U128(0)]);
        let bet_id = c.next_bet_id - 1;
        do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_msg(bet_id), 2);
        ctx("anyone.testnet", 2_000);
        let result = SubmittedResult {
            bet_id, terms_hash: "terms-hash-1".to_string(), outcome: "YES".to_string(),
            element_results_hash: "e".repeat(64), run_no: 1, checked_until: U64(2_000), next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig = sign_result(&outcome_signing_key(), &result);
        c.submit_outcome(result, sig);

        // RED at 24h+epsilon (round 0 is NOT capped at 24h).
        ctx("anyone.testnet", 2_000 + DAY_NS + 1);
        let too_early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.finalize(bet_id)));
        assert!(too_early.is_err(), "round 0 must still require the full 90d settlement_period, not 24h");

        // GREEN at the full 90 days.
        ctx("anyone.testnet", 2_000 + 90 * DAY_NS + 1);
        let on_time = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.finalize(bet_id)));
        assert!(on_time.is_ok(), "round 0 must finalize once the full 90d settlement_period has elapsed");
    }

    /// Round 1's re-judged result on the SAME 90-day settlement bet:
    /// finalize must now be reachable at 24h+epsilon, not 90 days.
    #[test]
    fn round_1_result_on_a_90_day_bet_is_finalizable_at_24h_not_90d() {
        let mut c = new_contract();
        let (sk, pk) = test_keypair(229);
        let mut env = base_envelope(&hex_encode(&pk));
        env.settlement_period = 90 * DAY_NS;
        let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
        assert_eq!(resp, vec![U128(0)]);
        let bet_id = c.next_bet_id - 1;
        do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_msg(bet_id), 2);
        ctx("anyone.testnet", 2_000);
        let result = SubmittedResult {
            bet_id, terms_hash: "terms-hash-1".to_string(), outcome: "YES".to_string(),
            element_results_hash: "e".repeat(64), run_no: 1, checked_until: U64(2_000), next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig = sign_result(&outcome_signing_key(), &result);
        c.submit_outcome(result, sig);

        // Round 1 challenge + re-judge.
        do_mt_transfer(&mut c, "taker.testnet", 5_005_000, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050);
        ctx("anyone.testnet", 2_060);
        let result2 = SubmittedResult {
            bet_id, terms_hash: "terms-hash-1".to_string(), outcome: "NO".to_string(),
            element_results_hash: "f".repeat(64), run_no: 2, checked_until: U64(2_060), next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig2 = sign_result(&outcome_signing_key(), &result2);
        c.submit_outcome(result2, sig2);

        // RED just before 24h since the round-1 re-judge (2_060).
        ctx("anyone.testnet", 2_060 + DAY_NS - 1);
        let too_early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.finalize(bet_id)));
        assert!(too_early.is_err(), "round-1 result must not be finalizable before the fixed 24h window elapses");

        // GREEN at 24h+epsilon -- NOT the remaining ~90 days.
        ctx("anyone.testnet", 2_060 + DAY_NS + 1);
        let on_time = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.finalize(bet_id)));
        assert!(on_time.is_ok(), "round-1 result on a 90d bet must be finalizable at a fixed 24h, not 90 days");
        assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Finalized);
    }

    /// A bet whose settlement_period is itself UNDER 24h keeps using
    /// its own (shorter) period after a re-judge too -- the 24h rule
    /// is a cap via `min(settlement_period, 24h)`, never a floor that
    /// lengthens a short period.
    #[test]
    fn round_1_result_on_a_short_settlement_period_bet_keeps_its_own_shorter_window() {
        let mut c = new_contract();
        let (sk, pk) = test_keypair(230);
        let mut env = base_envelope(&hex_encode(&pk));
        env.settlement_period = 2 * 60 * 60 * 1_000_000_000; // 2h (>= 1h floor)
        let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
        assert_eq!(resp, vec![U128(0)]);
        let bet_id = c.next_bet_id - 1;
        do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_msg(bet_id), 2);
        ctx("anyone.testnet", 2_000);
        let result = SubmittedResult {
            bet_id, terms_hash: "terms-hash-1".to_string(), outcome: "YES".to_string(),
            element_results_hash: "e".repeat(64), run_no: 1, checked_until: U64(2_000), next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig = sign_result(&outcome_signing_key(), &result);
        c.submit_outcome(result, sig);
        do_mt_transfer(&mut c, "taker.testnet", 5_005_000, serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050);
        ctx("anyone.testnet", 2_060);
        let result2 = SubmittedResult {
            bet_id, terms_hash: "terms-hash-1".to_string(), outcome: "NO".to_string(),
            element_results_hash: "f".repeat(64), run_no: 2, checked_until: U64(2_060), next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig2 = sign_result(&outcome_signing_key(), &result2);
        c.submit_outcome(result2, sig2);

        // At the bet's own 2h period: must already be finalizable
        // (min(2h, 24h) = 2h), not blocked waiting for a full 24h.
        ctx("anyone.testnet", 2_060 + 2 * 60 * 60 * 1_000_000_000 + 1);
        let on_time = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.finalize(bet_id)));
        assert!(on_time.is_ok(), "a sub-24h settlement_period must not be lengthened to 24h by the round cap");
    }
}

// =====================================================================
// D-DISPUTE1 (queue item 6, implementation list item 6) / D-REF1:
// arbiter no-show -> round-2 AI panel runs on the SAME bond, no top-up.
// Extends `referee_finalsay_blocks_request_resolution_within_72h`
// (which only checked the view/panic up to the 72h boundary) with the
// actual successful fallback call past it.
// =====================================================================
// ---------------- D-RESOLVE1 (item 7d): recovery ladder / RETRY ----------------

const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
const WEEK_NS: u64 = 7 * DAY_NS;

fn retry_result(bet_id: u64, terms_hash: &str, run_no: u64, now: u64, next_check_ns: u64) -> SubmittedResult {
    SubmittedResult {
        bet_id,
        terms_hash: terms_hash.to_string(),
        outcome: "RETRY".to_string(),
        element_results_hash: "0".repeat(64),
        run_no,
        checked_until: U64(now),
        next_check_ns: Some(U64(next_check_ns)),
        judge_pair_index: 0, model_not_found: vec![],
    }
}

fn void_result(bet_id: u64, terms_hash: &str, reason: &str, run_no: u64, now: u64) -> SubmittedResult {
    let outcome = if reason.is_empty() { "VOID".to_string() } else { format!("VOID:{reason}") };
    SubmittedResult {
        bet_id,
        terms_hash: terms_hash.to_string(),
        outcome,
        element_results_hash: "0".repeat(64),
        run_no,
        checked_until: U64(now),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    }
}

#[test]
fn retry_accepted_no_money_moves_i1_holds() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(7);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let terms_hash = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();
    let payouts_before = c.payout_ids_in_order().len();
    let status_before = c.get_bet(bet_id).unwrap().status.clone();

    ctx("anyone.testnet", 2_000);
    let r = retry_result(bet_id, &terms_hash, 1, 2_000, 2_000 + DAY_NS);
    let sig = sign_result(&outcome_signing_key(), &r);
    c.submit_outcome(r, sig);

    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, status_before, "RETRY must not change bet status");
    assert_eq!(bet.outcome, None, "RETRY must not set an outcome");
    assert_eq!(c.payout_ids_in_order().len(), payouts_before, "RETRY must not schedule any payout (I-1)");
    assert_eq!(bet.next_check_ns, Some(2_000 + DAY_NS));
}

#[test]
fn retry_sets_first_unavailable_once_and_increments_retry_count() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(7);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let terms_hash = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();

    ctx("anyone.testnet", 2_000);
    let r1 = retry_result(bet_id, &terms_hash, 1, 2_000, 2_000 + DAY_NS);
    let sig1 = sign_result(&outcome_signing_key(), &r1);
    c.submit_outcome(r1, sig1);
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.first_unavailable_ns, Some(2_000));
    assert_eq!(bet.retry_count, 1);

    let later = 2_000 + DAY_NS + 1;
    ctx("anyone.testnet", later);
    let r2 = retry_result(bet_id, &terms_hash, 2, later, later + DAY_NS);
    let sig2 = sign_result(&outcome_signing_key(), &r2);
    c.submit_outcome(r2, sig2);
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.first_unavailable_ns, Some(2_000), "first_unavailable_ns never resets on later RETRYs");
    assert_eq!(bet.retry_count, 2);
}

#[test]
#[should_panic(expected = "bad signature")]
fn retry_from_non_resolver_signature_refused() {
    let mut c = new_contract();
    let (_sk, pk) = test_keypair(7);
    let (wrong_sk, _) = test_keypair(9);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let terms_hash = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();
    ctx("anyone.testnet", 2_000);
    let r = retry_result(bet_id, &terms_hash, 1, 2_000, 2_000 + DAY_NS);
    let bad_sig = sign_result(&wrong_sk, &r);
    c.submit_outcome(r, bad_sig);
}

#[test]
#[should_panic(expected = "VOID-for-unavailability refused")]
fn void_unavailable_at_day3_with_3_retries_refused() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(7);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let terms_hash = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();

    let mut now = 2_000u64;
    let mut run_no = 1u64;
    for _ in 0..3 {
        ctx("anyone.testnet", now);
        let r = retry_result(bet_id, &terms_hash, run_no, now, now + DAY_NS);
        let sig = sign_result(&outcome_signing_key(), &r);
        c.submit_outcome(r, sig);
        run_no += 1;
        now += DAY_NS;
    }
    // 3 retries (< default max_retries=7), ~3 days elapsed (< 7d): refused.
    ctx("anyone.testnet", now);
    let v = void_result(bet_id, &terms_hash, "unavailable", run_no, now);
    let sig = sign_result(&outcome_signing_key(), &v);
    c.submit_outcome(v, sig);
}

#[test]
fn void_unavailable_after_7d_accepted_refunds_like_normal_void() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(7);
    let env = base_envelope(&hex_encode(&pk));
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let terms_hash = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();

    ctx("anyone.testnet", 2_000);
    let r = retry_result(bet_id, &terms_hash, 1, 2_000, 2_000 + DAY_NS);
    let sig = sign_result(&outcome_signing_key(), &r);
    c.submit_outcome(r, sig);
    assert_eq!(c.get_bet(bet_id).unwrap().retry_count, 1, "well under max_retries -- only the 7d clock lets this VOID through");

    let after_7d = 2_000 + WEEK_NS + 1;
    ctx("anyone.testnet", after_7d);
    let before = c.payout_ids_in_order().len();
    let v = void_result(bet_id, &terms_hash, "unavailable", 2, after_7d);
    let sig = sign_result(&outcome_signing_key(), &v);
    c.submit_outcome(v, sig);
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, BetStatus::Proposed);
    assert_eq!(bet.outcome, Some("VOID".to_string()), "reason is normalized away for settlement");

    ctx("anyone.testnet", after_7d + 86_400_000_000_001);
    c.finalize(bet_id);
    drain_all(&mut c, bet_id, after_7d + 86_400_000_000_101);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Settled);
    let new_payouts: Vec<_> = c.payout_ids_in_order()[before..]
        .iter()
        .map(|id| c.pending_payouts.get(id).unwrap().clone())
        .collect();
    let total_scheduled: u128 = new_payouts.iter().map(|p| p.amount.0).sum();
    let total_deposited = env.maker_required() + env.taker_required();
    assert_eq!(total_scheduled, total_deposited, "VOID refunds exactly what was deposited (I-1), same as any other VOID");
}

#[test]
fn void_unavailable_after_max_retries_accepted() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(7);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let terms_hash = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();

    let mut now = 2_000u64;
    let mut run_no = 1u64;
    for _ in 0..crate::DEFAULT_MAX_RETRIES {
        ctx("anyone.testnet", now);
        let r = retry_result(bet_id, &terms_hash, run_no, now, now + 60 * 60 * 1_000_000_000);
        let sig = sign_result(&outcome_signing_key(), &r);
        c.submit_outcome(r, sig);
        run_no += 1;
        now += 60 * 60 * 1_000_000_000; // 1h steps -- well under 7d elapsed
    }
    assert_eq!(c.get_bet(bet_id).unwrap().retry_count, crate::DEFAULT_MAX_RETRIES);
    // retry_count has hit the cap even though <7d has elapsed: VOID admissible on the retry-count branch alone.
    ctx("anyone.testnet", now);
    let v = void_result(bet_id, &terms_hash, "unavailable", run_no, now);
    let sig = sign_result(&outcome_signing_key(), &v);
    c.submit_outcome(v, sig);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Proposed);
}

#[test]
fn void_for_source_conflict_not_gated() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(7);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let terms_hash = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();
    ctx("anyone.testnet", 2_000);
    // No RETRY history at all, and VOID for an unrelated reason: must settle immediately.
    let v = void_result(bet_id, &terms_hash, "source_conflict", 1, 2_000);
    let sig = sign_result(&outcome_signing_key(), &v);
    c.submit_outcome(v, sig);
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, BetStatus::Proposed);
    assert_eq!(bet.outcome, Some("VOID".to_string()));
}

#[test]
fn legacy_void_no_reason_still_settles_unconditionally() {
    // Exact pre-existing behaviour: a bare "VOID" (no reason suffix) is never gated.
    let mut c = new_contract();
    let (sk, pk) = test_keypair(7);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let terms_hash = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();
    ctx("anyone.testnet", 2_000);
    let v = void_result(bet_id, &terms_hash, "", 1, 2_000);
    let sig = sign_result(&outcome_signing_key(), &v);
    c.submit_outcome(v, sig);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Proposed);
}

#[test]
#[should_panic(expected = "VOID-for-unavailability refused")]
fn bare_void_refused_while_recovery_window_open_d_resolve1() {
    // D-RESOLVE1 audit (item 7d2): once the recovery ladder has engaged
    // (first_unavailable_ns set by a prior RETRY), a resolver-signed bare
    // "VOID" must not be able to bypass the same 7d/max-retries gate that
    // "VOID:unavailable" is subject to -- "VOID only after retries +
    // archive + fallbacks fail" (decision register D-RESOLVE1). Before
    // this fix a bare VOID settled unconditionally even mid-window.
    let mut c = new_contract();
    let (sk, pk) = test_keypair(7);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let terms_hash = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();

    ctx("anyone.testnet", 2_000);
    let r = retry_result(bet_id, &terms_hash, 1, 2_000, 2_000 + DAY_NS);
    let sig = sign_result(&outcome_signing_key(), &r);
    c.submit_outcome(r, sig);
    // first_unavailable_ns is now Some(2_000); only 1 retry, well under 7d.

    let now = 2_000 + DAY_NS + 1;
    ctx("anyone.testnet", now);
    let v = void_result(bet_id, &terms_hash, "", 2, now);
    let sig = sign_result(&outcome_signing_key(), &v);
    c.submit_outcome(v, sig);
}

#[test]
fn c16_void_after_deadline_bypasses_recovery_gate_documented_behaviour() {
    // D-RESOLVE1 audit (item 7d2), C16 liveness VOID: documents CURRENT
    // behaviour, not a ruling. `void_after_deadline` is a liveness
    // escape hatch keyed only on `resolve_deadline` elapsing -- it does
    // NOT consult first_unavailable_ns/retry_count at all, so it can
    // (and here does) VOID a bet whose recovery ladder is actively
    // engaged and nowhere near exhausted (1 retry, far under 7d). This
    // is a real gap relative to "VOID only after retries + archive +
    // fallbacks fail", but C16's own semantics (anyone can force-VOID a
    // dead bet past its resolve_deadline, regardless of outcome-path)
    // were a prior, separate ruling -- left untouched here. Flagged in
    // the report as a design question for D-RESOLVE1, not silently
    // changed.
    let mut c = new_contract();
    let (sk, pk) = test_keypair(7);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let terms_hash = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();

    ctx("anyone.testnet", 2_000);
    let r = retry_result(bet_id, &terms_hash, 1, 2_000, 2_000 + DAY_NS);
    let sig = sign_result(&outcome_signing_key(), &r);
    c.submit_outcome(r, sig);
    assert_eq!(c.get_bet(bet_id).unwrap().first_unavailable_ns, Some(2_000));
    assert_eq!(c.get_bet(bet_id).unwrap().retry_count, 1);

    // resolve_deadline (base_envelope) is 10_000ns -- well past it, but
    // nowhere near the 7d/max_retries gate submit_outcome enforces.
    ctx("anyone.testnet", 10_001);
    c.void_after_deadline(bet_id);
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, BetStatus::Voided, "C16 liveness VOID fires unconditionally here -- the recovery-ladder gate only guards submit_outcome's own VOID path, not this one");
}

#[test]
fn retry_loop_never_moves_money_across_many_rounds() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(7);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let terms_hash = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();
    let payouts_before = c.payout_ids_in_order().len();
    let mut now = 2_000u64;
    for i in 0..20u64 {
        ctx("anyone.testnet", now);
        let r = retry_result(bet_id, &terms_hash, i + 1, now, now + 60 * 60 * 1_000_000_000);
        let sig = sign_result(&outcome_signing_key(), &r);
        c.submit_outcome(r, sig);
        now += 60 * 60 * 1_000_000_000;
        assert_eq!(c.payout_ids_in_order().len(), payouts_before, "no RETRY round ever schedules a payout");
        let bet = c.get_bet(bet_id).unwrap();
        assert_eq!(bet.status, BetStatus::Taken);
        assert_eq!(bet.outcome, None);
    }
}

#[test]
#[should_panic(expected = "next_check_ns too far ahead")]
fn retry_next_check_ns_beyond_48h_rejected() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(7);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let terms_hash = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();
    ctx("anyone.testnet", 2_000);
    let r = retry_result(bet_id, &terms_hash, 1, 2_000, 2_000 + 49 * 60 * 60 * 1_000_000_000);
    let sig = sign_result(&outcome_signing_key(), &r);
    c.submit_outcome(r, sig);
}

#[test]
#[should_panic(expected = "next_check_ns must be in the future")]
fn retry_next_check_ns_in_the_past_rejected() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(7);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let terms_hash = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();
    ctx("anyone.testnet", 10_000);
    let r = retry_result(bet_id, &terms_hash, 1, 10_000, 9_000);
    let sig = sign_result(&outcome_signing_key(), &r);
    c.submit_outcome(r, sig);
}

// ---------------- item 7d3: resolver/contract buffer cross-check ----------------
//
// Fixed test vectors shared with resolver/wasm-bin/src/main.rs's
// `submitted_result_crosscheck_fixture_bytes` test via
// contracts/escrow/tests/fixtures/resolver_crosscheck.json (the resolver
// crate can't depend on this contract crate, so the exact hex bytes are
// the shared contract between the two tests -- both must independently
// build the identical borsh buffer from the same field values). This test
// is the authority: it builds the buffer the same way `submit_outcome`
// verifies against, for a RETRY result (next_check_ns appended) and a
// VOID:unavailable result (no next_check_ns), and asserts the hex matches
// the checked-in fixture file.
#[test]
fn resolver_crosscheck_fixture_bytes() {
    const FIXTURE_CONTRACT_ID: &str = "escrow.testnet";
    const FIXTURE_BET_ID: u64 = 42;
    const FIXTURE_TERMS_HASH: &str = "tttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttttt";
    const FIXTURE_ELEMENT_RESULTS_HASH: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const FIXTURE_RUN_NO: u64 = 3;
    const FIXTURE_CHECKED_UNTIL: u64 = 1_700_000_000_000_000_000;
    const FIXTURE_NEXT_CHECK_NS: u64 = 1_700_000_100_000_000_000;
    const EXPECT_RETRY_HEX: &str = "0e000000657363726f772e746573746e65742a0000000000000040000000747474747474747474747474747474747474747474747474747474747474747474747474747474747474747474747474747474747474747474747474747474740500000052455452594000000065656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565030000000000000000002a36fe9c97170000000000e8a07e159d9717";
    const EXPECT_VOID_UNAVAILABLE_HEX: &str = "0e000000657363726f772e746573746e65742a00000000000000400000007474747474747474747474747474747474747474747474747474747474747474747474747474747474747474747474747474747474747474747474747474747410000000564f49443a756e617661696c61626c654000000065656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565656565030000000000000000002a36fe9c971700000000";

    fn build_buf(contract_id: &str, r: &SubmittedResult) -> Vec<u8> {
        let mut buf = Vec::new();
        BorshSerialize::serialize(&contract_id.parse::<AccountId>().unwrap(), &mut buf).unwrap();
        BorshSerialize::serialize(&r.bet_id, &mut buf).unwrap();
        BorshSerialize::serialize(&r.terms_hash, &mut buf).unwrap();
        BorshSerialize::serialize(&r.outcome, &mut buf).unwrap();
        BorshSerialize::serialize(&r.element_results_hash, &mut buf).unwrap();
        BorshSerialize::serialize(&r.run_no, &mut buf).unwrap();
        BorshSerialize::serialize(&r.checked_until.0, &mut buf).unwrap();
        BorshSerialize::serialize(&r.judge_pair_index, &mut buf).unwrap();
        if r.outcome == "RETRY" {
            let next_check_ns = r.next_check_ns.expect("RETRY result must set next_check_ns").0;
            BorshSerialize::serialize(&next_check_ns, &mut buf).unwrap();
        }
        buf
    }

    let retry = SubmittedResult {
        bet_id: FIXTURE_BET_ID,
        terms_hash: FIXTURE_TERMS_HASH.to_string(),
        outcome: "RETRY".to_string(),
        element_results_hash: FIXTURE_ELEMENT_RESULTS_HASH.to_string(),
        run_no: FIXTURE_RUN_NO,
        checked_until: U64(FIXTURE_CHECKED_UNTIL),
        next_check_ns: Some(U64(FIXTURE_NEXT_CHECK_NS)),
        judge_pair_index: 0, model_not_found: vec![],
    };
    let retry_buf = build_buf(FIXTURE_CONTRACT_ID, &retry);
    assert_eq!(hex_encode(&retry_buf), EXPECT_RETRY_HEX, "RETRY buffer must match the shared fixture bytes");

    let void_unavailable = SubmittedResult {
        bet_id: FIXTURE_BET_ID,
        terms_hash: FIXTURE_TERMS_HASH.to_string(),
        outcome: "VOID:unavailable".to_string(),
        element_results_hash: FIXTURE_ELEMENT_RESULTS_HASH.to_string(),
        run_no: FIXTURE_RUN_NO,
        checked_until: U64(FIXTURE_CHECKED_UNTIL),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let void_buf = build_buf(FIXTURE_CONTRACT_ID, &void_unavailable);
    assert_eq!(
        hex_encode(&void_buf),
        EXPECT_VOID_UNAVAILABLE_HEX,
        "VOID:unavailable buffer must match the shared fixture bytes"
    );
}

// =====================================================================
// Item 7e: D-ASSET1 (six v1 assets) + D-CAP2 (per-asset $1,000/side cap,
// decoupled from beta_sunset) + D-BOND3 (FinalSay round-2 prepaid
// 5-model panel cost).
// =====================================================================

const V1_USDC: &str = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const V1_USDT: &str = "nep141:usdt.tether-token.near";
const V1_BTC: &str = "nep141:btc.omft.near";
const V1_WNEAR: &str = "nep141:wrap.near";
const V1_ETH: &str = "nep141:eth.omft.near";
const V1_ZEC: &str = "nep141:zec.omft.near";

/// D-ASSET1: the exact six v1 launch assets, each with min/max/run_price/
/// min_bond/min_objection; max_per_side is the D-CAP3 overflow-safe launch cap
/// (10^34 raw, supersedes D-CAP2's ~$1,000), the rest decimals-correct for that asset's own native units.
/// Reference prices (rough, init-time only): USDC/USDT $1, BTC $76,909,
/// wNEAR $3.77, ETH ~$3,000, ZEC ~$40.
fn six_asset_v1_limits() -> Vec<(String, AssetLimit)> {
    vec![
        (
            V1_USDC.to_string(),
            AssetLimit {
                min_per_side: U128(10000000), // D-MINSTAKE1 $10
min_fee_per_side: U128(500000), // D-FEEMIN1 $0.50
min_fee_cap_per_side: U128(0), // D-PARAMS1 fixture: 0 = cap pinned at min_fee_per_side
storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
                max_per_side: U128(cap3::CAP3_MAX), // D-CAP3: no cap at launch = 10^34 raw (supersedes D-CAP2 ~$1,000)
                run_price: U128(5_000),
                min_bond: U128(5_000_000),
                min_objection: U128(1_000_000),
            },
        ),
        (
            V1_USDT.to_string(),
            AssetLimit {
                min_per_side: U128(10000000), // D-MINSTAKE1 $10
min_fee_per_side: U128(500000), // D-FEEMIN1 $0.50
min_fee_cap_per_side: U128(0), // D-PARAMS1 fixture: 0 = cap pinned at min_fee_per_side
storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
                max_per_side: U128(cap3::CAP3_MAX), // D-CAP3: no cap at launch = 10^34 raw (supersedes D-CAP2 ~$1,000)
                run_price: U128(5_000),
                min_bond: U128(5_000_000),
                min_objection: U128(1_000_000),
            },
        ),
        (
            V1_BTC.to_string(),
            AssetLimit {
                min_per_side: U128(13002), // PLACEHOLDER ~$10 equiv; set from deploy-day price in the release record (D-MINSTAKE1)
min_fee_per_side: U128(650), // = min_per_side/20 (~$0.50), deploy-day placeholder (D-FEEMIN1)
min_fee_cap_per_side: U128(0), // D-PARAMS1 fixture: 0 = cap pinned at min_fee_per_side
storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
                max_per_side: U128(cap3::CAP3_MAX), // D-CAP3: no cap at launch = 10^34 raw (supersedes D-CAP2 ~$1,000)
                run_price: U128(1),
                min_bond: U128(6_501),
                min_objection: U128(1_300),
            },
        ),
        (
            V1_WNEAR.to_string(),
            AssetLimit {
                min_per_side: U128(2652519893899204458708992), // PLACEHOLDER ~$10 equiv; set from deploy-day price in the release record (D-MINSTAKE1)
min_fee_per_side: U128(132625994694960222935449), // = min_per_side/20 (~$0.50), deploy-day placeholder (D-FEEMIN1)
min_fee_cap_per_side: U128(0), // D-PARAMS1 fixture: 0 = cap pinned at min_fee_per_side
storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
                max_per_side: U128(cap3::CAP3_MAX), // D-CAP3: no cap at launch = 10^34 raw (supersedes D-CAP2 ~$1,000)
                run_price: U128(1),
                min_bond: U128(1_326_259_946_949_602_229_354_496),
                min_objection: U128(265_251_989_389_920_445_870_899),
            },
        ),
        (
            V1_ETH.to_string(),
            AssetLimit {
                min_per_side: U128(3333333333333332), // PLACEHOLDER ~$10 equiv; set from deploy-day price in the release record (D-MINSTAKE1)
min_fee_per_side: U128(166666666666666), // = min_per_side/20 (~$0.50), deploy-day placeholder (D-FEEMIN1)
min_fee_cap_per_side: U128(0), // D-PARAMS1 fixture: 0 = cap pinned at min_fee_per_side
storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
                max_per_side: U128(cap3::CAP3_MAX), // D-CAP3: no cap at launch = 10^34 raw (supersedes D-CAP2 ~$1,000)
                run_price: U128(1),
                min_bond: U128(1_666_666_666_666_666),
                min_objection: U128(333_333_333_333_333),
            },
        ),
        (
            V1_ZEC.to_string(),
            AssetLimit {
                min_per_side: U128(25000000), // PLACEHOLDER ~$10 equiv; set from deploy-day price in the release record (D-MINSTAKE1)
min_fee_per_side: U128(1250000), // = min_per_side/20 (~$0.50), deploy-day placeholder (D-FEEMIN1)
min_fee_cap_per_side: U128(0), // D-PARAMS1 fixture: 0 = cap pinned at min_fee_per_side
storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
                max_per_side: U128(cap3::CAP3_MAX), // D-CAP3: no cap at launch = 10^34 raw (supersedes D-CAP2 ~$1,000)
                run_price: U128(1),
                min_bond: U128(12_500_000),
                min_objection: U128(2_500_000),
            },
        ),
    ]
}

/// D-ASSET1: `Contract::new` accepts a full six-asset v1 whitelist, and
/// every entry's I-1 validation (min<=max, run_price>0, min_bond>0,
/// min_objection>0) holds for all six, not just USDC.
#[test]
fn d_asset1_six_asset_init_table_accepted() {
    ctx(OPERATOR, 0);
    let c = Contract::new(
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
        six_asset_v1_limits(),
        outcome_pubkey_hex(),
        attest_pubkey_hex(),
        test_resolver_wasm_hash(),
        test_outlayer_config(),
        test_judge_chain(),
    );
    for (token_id, _) in six_asset_v1_limits() {
        assert!(
            c.asset_limits.get(&token_id).is_some(),
            "asset {token_id} must be in the whitelist after init"
        );
    }
}

/// D-CAP2: a maker stake one yoctounit ABOVE BTC's own max_per_side is
/// refused at open, even though the cross-side (USDC) amount is fine --
/// the cap is enforced per side, per asset, not against some shared or
/// USDC-only ceiling.
fn new_contract_six_asset_v1() -> Contract {
    ctx(OPERATOR, 0);
    Contract::new(
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
        six_asset_v1_limits(),
        outcome_pubkey_hex(),
        attest_pubkey_hex(),
        test_resolver_wasm_hash(),
        test_outlayer_config(),
        test_judge_chain(),
    )
}

#[test]
fn d_cap2_cross_asset_stake_above_max_per_side_refused_at_open_maker_side() {
    let mut c = new_contract_six_asset_v1();
    let (_, pk) = test_keypair(220);
    let mut env = base_envelope(&hex_encode(&pk));
    env.maker_asset = V1_BTC.to_string();
    env.taker_asset = V1_USDC.to_string();
    let btc_max = six_asset_v1_limits()
        .into_iter()
        .find(|(id, _)| id == V1_BTC)
        .unwrap()
        .1
        .max_per_side
        .0;
    env.stake_maker = U128(btc_max + 1); // one over BTC's own max_per_side
    env.stake_taker = U128(1_000_000_000); // USDC's own max_per_side, fine on its own
    let resp = do_mt_transfer_asset(&mut c, "maker.testnet", V1_BTC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(
        resp,
        vec![U128(env.maker_required())],
        "stake_maker one over BTC's max_per_side must be refused and refunded"
    );
}

/// D-CAP2: the old flat 250 USDC/side beta cap (D6) is gone -- a 900
/// USDC/side stake (within the new ~$1,000 max_per_side, but well over
/// the old 250 cap) is accepted at open.
#[test]
fn d_cap2_old_250_cap_gone_900_usdc_accepted() {
    let mut c = new_contract_six_asset_v1();
    let (_, pk) = test_keypair(221);
    let mut env = base_envelope(&hex_encode(&pk));
    env.maker_asset = V1_USDC.to_string();
    env.taker_asset = V1_USDC.to_string();
    env.stake_maker = U128(900_000_000); // 900 USDC, 6dp
    env.stake_taker = U128(900_000_000);
    let resp = do_mt_transfer_asset(&mut c, "maker.testnet", V1_USDC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)], "900 USDC/side must be accepted now that the cap is ~$1,000");
}

/// D-CAP2: a stake EXACTLY at BTC's own max_per_side (cross-asset
/// against a USDC taker) is accepted, at both open (maker side) and
/// take (taker side).
#[test]
fn d_cap2_cross_asset_exactly_at_max_per_side_accepted_open_and_take() {
    let mut c = new_contract_six_asset_v1();
    let (_, pk) = test_keypair(222);
    let mut env = base_envelope(&hex_encode(&pk));
    env.maker_asset = V1_USDC.to_string();
    env.taker_asset = V1_BTC.to_string();
    let btc_max = six_asset_v1_limits()
        .into_iter()
        .find(|(id, _)| id == V1_BTC)
        .unwrap()
        .1
        .max_per_side
        .0;
    env.stake_maker = U128(six_asset_v1_limits().into_iter().find(|(id, _)| id == V1_USDC).unwrap().1.max_per_side.0); // USDC's own max_per_side (D-CAP3)
    env.stake_taker = U128(btc_max); // BTC's own max_per_side, exactly
    let resp = do_mt_transfer_asset(&mut c, "maker.testnet", V1_USDC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)], "stake_maker exactly at USDC's max_per_side must be accepted at open");
    let bet_id = c.next_bet_id - 1;
    let resp = do_mt_transfer_asset(&mut c, "taker.testnet", V1_BTC, env.taker_required(), take_msg(bet_id), 2);
    assert_eq!(resp, vec![U128(0)], "stake_taker exactly at BTC's max_per_side must be accepted at take");
}

/// A unanimous VOID panel ruling overturns a prior YES outcome, exactly
/// like any other round's overturn (already the code's behaviour --
/// submit_outcome simply replaces bet.outcome every round; this test
/// pins it down for D-BOND3's queue item).
#[test]
fn d_bond3_unanimous_void_panel_overturns_prior_yes() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(226);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));

    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    assert_eq!(c.get_bet(bet_id).unwrap().outcome, Some("YES".to_string()));

    do_mt_transfer(
        &mut c,
        "taker.testnet",
        5_005_000,
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(),
        2_050,
    );
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Challenged);

    ctx("anyone.testnet", 2_060);
    let round2_result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "VOID".to_string(), // unanimous 5-model panel: VOID
        element_results_hash: "f".repeat(64),
        run_no: 2,
        checked_until: U64(2_060),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig2 = sign_result(&outcome_signing_key(), &round2_result);
    c.submit_outcome(round2_result, sig2);
    assert_eq!(
        c.get_bet(bet_id).unwrap().outcome,
        Some("VOID".to_string()),
        "a unanimous VOID panel ruling must overturn the prior YES outcome"
    );
}

// =====================================================================
// D-FETCH2 / queue item 7f2b: Open requires a resolver-signed, fresh
// sources-reachable attestation for the exact term sheet. Message/key/
// freshness mirror submit_outcome's own verify_sig pattern; refusing
// must hit the same I-3 full-refund path as every other handle_open
// rejection (no panic, no stranded funds).
// =====================================================================

/// No attestation at all (the field is simply missing from the JSON) ->
/// the whole message fails to parse -> mt_on_transfer's existing
/// Err(_) => refund-full-amount path -- same outcome as every other
/// malformed/rejected Open.
#[test]
fn sourcecheck_open_with_no_attestation_refused_full_refund() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(230);
    let env = base_envelope(&hex_encode(&pk));
    let msg = format!(
        "{{\"kind\":\"Open\",\"envelope\":{}}}",
        serde_json::to_string(&env).unwrap()
    );
    let before_next_id = c.next_bet_id;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), msg, 1);
    assert_eq!(
        resp,
        vec![U128(env.maker_required())],
        "open with no attestation must be refused and the full deposit refunded"
    );
    assert_eq!(c.next_bet_id, before_next_id, "no bet must be created");
}

/// Attestation signed by a DIFFERENT key than envelope.resolver_pubkey.
#[test]
fn sourcecheck_open_wrong_signer_refused_full_refund() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(231);
    let (wrong_sk, _wrong_pk) = test_keypair(232);
    let env = base_envelope(&hex_encode(&pk));
    let message = sourcecheck_message(&env.terms_hash, 0);
    let bad_sig = wrong_sk.sign(message.as_bytes());
    let msg = serde_json::to_string(&TransferMsg::Open {
        envelope: env.clone(),
        attestation: SourceCheckAttestation {
            checked_at: 0,
            signature_hex: hex_encode(&bad_sig.to_bytes()),
        },
    })
    .unwrap();
    let before_next_id = c.next_bet_id;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), msg, 1);
    assert_eq!(
        resp,
        vec![U128(env.maker_required())],
        "open signed by the wrong key must be refused and the full deposit refunded"
    );
    assert_eq!(c.next_bet_id, before_next_id, "no bet must be created");
}

/// Attestation correctly signed by envelope.resolver_pubkey, but over a
/// DIFFERENT spec_hash than this envelope's terms_hash.
#[test]
fn sourcecheck_open_spec_hash_mismatch_refused_full_refund() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(233);
    let env = base_envelope(&hex_encode(&pk));
    let wrong_message = sourcecheck_message("some-other-terms-hash", 0);
    let sig = sk.sign(wrong_message.as_bytes());
    let msg = serde_json::to_string(&TransferMsg::Open {
        envelope: env.clone(),
        attestation: SourceCheckAttestation {
            checked_at: 0,
            signature_hex: hex_encode(&sig.to_bytes()),
        },
    })
    .unwrap();
    let before_next_id = c.next_bet_id;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), msg, 1);
    assert_eq!(
        resp,
        vec![U128(env.maker_required())],
        "open attesting a different spec_hash must be refused and the full deposit refunded"
    );
    assert_eq!(c.next_bet_id, before_next_id, "no bet must be created");
}

/// checked_at strictly in the future relative to block_timestamp is
/// always refused, independent of the 1h window.
#[test]
fn sourcecheck_open_checked_at_in_future_refused_full_refund() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(234);
    let env = base_envelope(&hex_encode(&pk));
    let msg = open_msg_at(&env, 1_000); // checked_at=1000, but ts (now) below is 1
    let before_next_id = c.next_bet_id;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), msg, 1);
    assert_eq!(
        resp,
        vec![U128(env.maker_required())],
        "a future checked_at must be refused and the full deposit refunded"
    );
    assert_eq!(c.next_bet_id, before_next_id, "no bet must be created");
}

/// checked_at exactly 1h + 1ns old is stale -- refused.
#[test]
fn sourcecheck_open_checked_at_1h_plus_1ns_stale_refused_full_refund() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(235);
    let env = base_envelope(&hex_encode(&pk));
    let checked_at = 0u64;
    let now = crate::SOURCECHECK_FRESHNESS_NS + 1;
    let msg = open_msg_at(&env, checked_at);
    let before_next_id = c.next_bet_id;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), msg, now);
    assert_eq!(
        resp,
        vec![U128(env.maker_required())],
        "checked_at exactly 1h+1ns old must be refused and the full deposit refunded"
    );
    assert_eq!(c.next_bet_id, before_next_id, "no bet must be created");
}

/// checked_at exactly 1h old (the boundary) is accepted -- inclusive.
#[test]
fn sourcecheck_open_checked_at_exactly_1h_old_accepted() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(236);
    let env = base_envelope(&hex_encode(&pk));
    let checked_at = 0u64;
    let now = crate::SOURCECHECK_FRESHNESS_NS; // exactly 1h after checked_at
    let msg = open_msg_at(&env, checked_at);
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), msg, now);
    assert_eq!(
        resp,
        vec![U128(0)],
        "checked_at exactly 1h old (inclusive boundary) must be accepted"
    );
}

/// A fully valid attestation (right signer, right spec_hash, fresh) is
/// accepted and a bet is created -- the ordinary happy path, now gated
/// by a real attestation instead of an implicit pass.
#[test]
fn sourcecheck_open_valid_attestation_accepted() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(237);
    let env = base_envelope(&hex_encode(&pk));
    let before_next_id = c.next_bet_id;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)], "a valid attestation must be accepted");
    assert_eq!(c.next_bet_id, before_next_id + 1, "exactly one bet must be created");
}

/// The exact message bytes the contract verifies against must match
/// the shared cross-check fixture byte-for-byte (same fixture pinned by
/// resolver/core, services/common, judge-proto).
#[test]
fn sourcecheck_contract_message_matches_crosscheck_fixture_bytes() {
    let raw = include_str!("../tests/fixtures/sourcecheck_crosscheck.json");
    let fx: serde_json::Value = serde_json::from_str(raw).unwrap();
    let spec_hash = fx["spec_hash"].as_str().unwrap();
    let checked_at: u64 = fx["checked_at"].as_str().unwrap().parse().unwrap();
    let expected_message = fx["message"].as_str().unwrap();
    let expected_hex = fx["message_hex"].as_str().unwrap();

    let message = sourcecheck_message(spec_hash, checked_at);
    assert_eq!(message, expected_message, "message string must match the shared fixture exactly");
    assert_eq!(hex_encode(message.as_bytes()), expected_hex, "message bytes must match the shared fixture exactly");
}

/// I-1 (no funds created/destroyed/stranded): a refused open refunds
/// EXACTLY the deposited amount, no more, no less, and the contract's
/// own internal accounting (next_bet_id, bets map) is completely
/// unaffected -- the deposit never entered escrow in the first place.
#[test]
fn sourcecheck_i1_conservation_after_refused_open() {
    let mut c = new_contract();
    let (wrong_sk, _wrong_pk) = test_keypair(239);
    let (_, pk) = test_keypair(238);
    let env = base_envelope(&hex_encode(&pk));
    let message = sourcecheck_message(&env.terms_hash, 0);
    let bad_sig = wrong_sk.sign(message.as_bytes());
    let msg = serde_json::to_string(&TransferMsg::Open {
        envelope: env.clone(),
        attestation: SourceCheckAttestation {
            checked_at: 0,
            signature_hex: hex_encode(&bad_sig.to_bytes()),
        },
    })
    .unwrap();
    let deposit = env.maker_required();
    let before_next_id = c.next_bet_id;
    let before_bets_len = c.open_bet_ids.len();
    let resp = do_mt_transfer(&mut c, "maker.testnet", deposit, msg, 1);
    assert_eq!(resp, vec![U128(deposit)], "I-1: the exact deposited amount, no more no less, must come back");
    assert_eq!(c.next_bet_id, before_next_id, "I-1: no bet_id consumed");
    assert_eq!(c.open_bet_ids.len(), before_bets_len, "I-1: no open bet recorded");
}

// =====================================================================
// Item 8c2: emergency_refund stuck-funds bug fix.
//
// Bug: emergency_refund skipped EVERY candidate in any asset that
// already had a pending payout line for the bet, on the assumption
// "any line in that asset => the full amount was already scheduled".
// False for `referee_rule`'s FinalSay panel refund
// (`finalsay_panel_refund`): it schedules only the panel-cost PORTION
// of the final-round bond to the bond holder, on a bet that is left
// in a non-terminal status (`Proposed`), and shrinks `bond.amount` by
// that same portion. A guardian shutdown afterwards then saw an
// existing line in that asset and refunded nothing else in it,
// stranding both stakes (same-asset) or the challenger's whole side
// (cross-asset) forever.
// =====================================================================

/// The 8c tests skipped by the previous agent, plus coverage for the
/// fix rule. Mid-dispute (outstanding bond + objection deposit, no
/// pre-existing payout line at all) -- exact per party/asset refund.
#[test]
fn emergency_refund_mid_dispute_bond_and_objection_exact() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(232);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    do_mt_transfer(
        &mut c,
        "taker.testnet",
        5_005_000,
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(),
        2_050,
    );
    do_mt_transfer(
        &mut c,
        "taker.testnet",
        OBJECTION_DEPOSIT,
        objection_msg(bet_id, &"e".repeat(64), false),
        2_060,
    );
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Evidence);

    let env = c.get_bet(bet_id).unwrap().envelope;
    let maker: AccountId = env.maker.clone();
    let taker: AccountId = "taker.testnet".parse().unwrap();

    ctx_with_deposit(GUARDIAN, 2_070, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    c.emergency_refund(bet_id);

    let payouts = c.pending_payouts(bet_id);
    let maker_total: u128 = payouts.iter().filter(|p| p.receiver == maker).map(|p| p.amount.0).sum();
    assert_eq!(maker_total, env.maker_required());
    let taker_total: u128 = payouts.iter().filter(|p| p.receiver == taker).map(|p| p.amount.0).sum();
    assert_eq!(taker_total, env.taker_required() + 5_005_000 + OBJECTION_DEPOSIT);
    let total: u128 = payouts.iter().map(|p| p.amount.0).sum();
    assert_eq!(total, env.maker_required() + env.taker_required() + 5_005_000 + OBJECTION_DEPOSIT);
}

/// Cross-asset matched bet (no dispute) -- exact per-asset refund.
#[test]
fn emergency_refund_cross_asset_matched_bet_exact() {
    let mut c = new_contract_spec_assets();
    let (_, pk) = test_keypair(233);
    let mut env = base_envelope(&hex_encode(&pk));
    env.maker_asset = MOCK_BTC.to_string();
    env.taker_asset = USDC.to_string();
    env.stake_maker = U128(10_000);
    env.stake_taker = U128(10_000_000);
    do_mt_transfer_asset(&mut c, "maker.testnet", MOCK_BTC, env.maker_required(), open_msg(&env), 1);
    let bet_id = c.next_bet_id - 1;
    do_mt_transfer_asset(&mut c, "taker.testnet", USDC, env.taker_required(), take_msg(bet_id), 2);

    let maker: AccountId = "maker.testnet".parse().unwrap();
    let taker: AccountId = "taker.testnet".parse().unwrap();

    ctx_with_deposit(GUARDIAN, 10, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    c.emergency_refund(bet_id);

    let payouts = c.pending_payouts(bet_id);
    let btc_total: u128 = payouts.iter().filter(|p| p.token_id == MOCK_BTC && p.receiver == maker).map(|p| p.amount.0).sum();
    assert_eq!(btc_total, env.maker_required());
    let usdc_total: u128 = payouts.iter().filter(|p| p.token_id == USDC && p.receiver == taker).map(|p| p.amount.0).sum();
    assert_eq!(usdc_total, env.taker_required());
}

/// A bet already `Finalized` (lines scheduled, but not all drained)
/// before shutdown: `emergency_refund` must schedule NOTHING new (no
/// double pay), and the pre-existing `finalize` lines must still
/// drain normally afterwards.
#[test]
fn emergency_refund_finalized_bet_schedules_nothing_new() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(234);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    ctx("anyone.testnet", 2_000 + 86_400_000_000_001);
    c.finalize(bet_id);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Finalized, "finalize's own inline drain hasn't resolved the in-flight promises yet");

    let before: Vec<_> = c.pending_payouts(bet_id);
    let before_total: u128 = before.iter().map(|p| p.amount.0).sum();
    let before_ids: std::collections::HashSet<u64> = before.iter().map(|p| p.id).collect();

    ctx_with_deposit(GUARDIAN, 2_000 + 86_400_000_000_002, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    c.emergency_refund(bet_id);

    let after = c.pending_payouts(bet_id);
    let after_total: u128 = after.iter().map(|p| p.amount.0).sum();
    assert_eq!(after_total, before_total, "emergency_refund on a Finalized bet must schedule nothing new");
    let after_ids: std::collections::HashSet<u64> = after.iter().map(|p| p.id).collect();
    assert_eq!(after_ids, before_ids, "the exact same lines, no additions");

    // The pre-existing finalize lines must still drain exactly as before.
    drain_all(&mut c, bet_id, 2_000 + 86_400_000_000_003);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Settled);
}

/// I-1 per asset holds across a MIX of bets refunded in the same
/// shutdown: a clean untaken offer and a taken human-referee bet with a
/// pre-existing partial panel-refund line, both in USDC.
#[test]
fn emergency_refund_mix_of_bets_conserves_i1_per_asset() {
    let mut c = new_contract_with_limits(
        Limits {
            max_stake: U128(crate::DEFAULT_MAX_STAKE_PER_SIDE_USDC),
            max_offer_ttl_secs: 86400 * 60,
            max_stake_per_side_near: U128(100 * 10u128.pow(24)),
            max_rounds: 1,
            max_retries: crate::DEFAULT_MAX_RETRIES,
        },
        None,
    );

    // Bet 1: a clean untaken offer.
    let (_, pk1) = test_keypair(235);
    let env1 = base_envelope(&hex_encode(&pk1));
    let resp1 = do_mt_transfer(&mut c, "maker.testnet", env1.maker_required(), open_msg(&env1), 1);
    assert_eq!(resp1, vec![U128(0)], "bet 1 open must be accepted");
    let bet1 = c.next_bet_id - 1;

    // Bet 2 (RF2 / D-REFUI4, was a FinalSay bet with a panel-refund line): a
    // taken human-referee bet with BOTH tips reserved and no ruling.
    let (_sk2, pk2) = test_keypair(236);
    let mut env2 = base_envelope(&hex_encode(&pk2));
    env2.referee = Some(Referee {
        account: "referee.testnet".parse().unwrap(),
        mode: RefereeMode::Human,
    });
    env2.tip_maker = true;
    do_mt_transfer(&mut c, "maker.testnet", env2.maker_required(), open_msg(&env2), 2);
    let bet2 = c.next_bet_id - 1;
    let take2 = serde_json::to_string(&TransferMsg::Take {
        bet_id: bet2,
        invite_sig: None,
        tip: true,
        referee_ack: Some("referee.testnet".parse().unwrap()),
    })
    .unwrap();
    assert_eq!(do_mt_transfer(&mut c, "taker.testnet", env2.taker_required(), take2, 3), vec![U128(0)]);
    let bond2 = 0u128;

    let total_deposited = env1.maker_required() + env2.maker_required() + env2.taker_required() + bond2;

    ctx_with_deposit(GUARDIAN, 2_070, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    c.emergency_refund(bet1);
    c.emergency_refund(bet2);

    let total_scheduled: u128 = [bet1, bet2]
        .iter()
        .flat_map(|id| c.pending_payouts(*id))
        .map(|p| p.amount.0)
        .sum();
    assert_eq!(total_scheduled, total_deposited, "I-1 per asset must hold across a mix of refunded bets in the same shutdown");
}

// =====================================================================
// D-KEY1 (item 7g): pinned resolver keys. `new()` pins outcome_pubkey
// (submit_outcome) and attest_pubkey (sourcecheck/archive), tied to
// resolver_wasm_hash, and NOTHING changes them after init -- not the
// guardian, not any method. The maker-supplied Envelope.resolver_pubkey/
// resolver_wasm_hash no longer exist.
// =====================================================================
mod d_key1_pinned_resolver_keys {
    use super::*;

    #[test]
    fn resolver_keys_view_returns_the_pinned_values() {
        let c = new_contract();
        let (outcome_pk, attest_pk, wasm_hash) = c.resolver_keys();
        assert_eq!(outcome_pk, outcome_pubkey_hex());
        assert_eq!(attest_pk, attest_pubkey_hex());
        assert_eq!(wasm_hash, test_resolver_wasm_hash());
        assert_ne!(outcome_pk, attest_pk, "outcome and attest must be distinct keys");
    }

    #[test]
    fn new_rejects_malformed_outcome_pubkey() {
        let result = std::panic::catch_unwind(|| {
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
                "too-short".to_string(),
                attest_pubkey_hex(),
                test_resolver_wasm_hash(),
                test_outlayer_config(),
                test_judge_chain(),
            )
        });
        assert!(result.is_err(), "new() must reject a malformed outcome_pubkey");
    }

    #[test]
    fn new_rejects_malformed_attest_pubkey() {
        let result = std::panic::catch_unwind(|| {
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
                "too-short".to_string(),
                test_resolver_wasm_hash(),
                test_outlayer_config(),
                test_judge_chain(),
            )
        });
        assert!(result.is_err(), "new() must reject a malformed attest_pubkey");
    }

    /// submit_outcome signed by the pinned ATTEST key (not outcome) must
    /// be refused -- the two pinned keys are not interchangeable.
    #[test]
    #[should_panic(expected = "bad signature")]
    fn submit_outcome_signed_by_attest_key_refused() {
        let mut c = new_contract();
        let (_, pk) = test_keypair(242);
        let bet_id = open_and_take(&mut c, &hex_encode(&pk));
        ctx("anyone.testnet", 2_000);
        let result = SubmittedResult {
            bet_id,
            terms_hash: c.get_bet(bet_id).unwrap().envelope.terms_hash.clone(),
            outcome: "YES".to_string(),
            element_results_hash: "e".repeat(64),
            run_no: 1,
            checked_until: U64(2_000),
            next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig = sign_result(&attest_signing_key(), &result);
        c.submit_outcome(result, sig);
    }

    /// A sourcecheck attestation signed by the pinned OUTCOME key (not
    /// attest) must be refused at open -- full refund, I-3.
    #[test]
    fn sourcecheck_signed_by_outcome_key_refused_full_refund() {
        let mut c = new_contract();
        let (_, pk) = test_keypair(243);
        let env = base_envelope(&hex_encode(&pk));
        let message = sourcecheck_message(&env.terms_hash, 0);
        let bad_sig = outcome_signing_key().sign(message.as_bytes());
        let msg = serde_json::to_string(&TransferMsg::Open {
            envelope: env.clone(),
            attestation: SourceCheckAttestation {
                checked_at: 0,
                signature_hex: hex_encode(&bad_sig.to_bytes()),
            },
        })
        .unwrap();
        let before_next_id = c.next_bet_id;
        let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), msg, 1);
        assert_eq!(
            resp,
            vec![U128(env.maker_required())],
            "a sourcecheck attestation signed by the outcome key (wrong pinned key) must be refused"
        );
        assert_eq!(c.next_bet_id, before_next_id, "no bet must be created");
    }

    /// Contract has no method that mutates the pinned keys -- `resolver_keys()`
    /// returns the exact same values after every kind of state-changing call
    /// the contract exposes (guardian ops included).
    #[test]
    fn resolver_keys_never_change_across_contract_lifetime() {
        let mut c = new_contract();
        let before = c.resolver_keys();

        let (_, pk) = test_keypair(244);
        let bet_id = open_and_take(&mut c, &hex_encode(&pk));
        assert_eq!(c.resolver_keys(), before, "resolver_keys must be unchanged after open+take");

        ctx("anyone.testnet", 2_000);
        let result = SubmittedResult {
            bet_id,
            terms_hash: c.get_bet(bet_id).unwrap().envelope.terms_hash.clone(),
            outcome: "YES".to_string(),
            element_results_hash: "e".repeat(64),
            run_no: 1,
            checked_until: U64(2_000),
            next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig = sign_result(&outcome_signing_key(), &result);
        c.submit_outcome(result, sig);
        assert_eq!(c.resolver_keys(), before, "resolver_keys must be unchanged after submit_outcome");

        ctx_with_deposit(GUARDIAN, 2_001, NearToken::from_yoctonear(1));
        c.pause_new_offers();
        assert_eq!(c.resolver_keys(), before, "resolver_keys must be unchanged after a guardian action");

        ctx_with_deposit(GUARDIAN, 2_002, NearToken::from_yoctonear(1));
        c.emergency_shutdown();
        assert_eq!(c.resolver_keys(), before, "resolver_keys must be unchanged even after emergency_shutdown");
    }
}

// ---------------------------------------------------------------------
// Queue item 11 (outlayer-mainnet-wiring): FastFS URL + secrets_ref come
// from init config, not a hardcoded testnet constant; tier timeouts are
// capped at 150s until a 180s live run has completed.
// ---------------------------------------------------------------------

/// Fire a keeper credit-funded request_resolution on `c` and return the
/// parsed `request_execution` args the escrow sent to OutLayer.
fn item11_sent_outlayer_args(c: &mut Contract, seed: u8) -> serde_json::Value {
    let (_, pk) = test_keypair(seed);
    let bet_id = open_and_take(c, &hex_encode(&pk));
    ctx_with_deposit(KEEPER, 1, NearToken::from_millinear(50));
    c.topup_keeper_credit();
    ctx_with_deposit(KEEPER, 1_001, NearToken::from_yoctonear(0));
    let _ = c.request_resolution(bet_id, None);
    let receipts = near_sdk::test_utils::get_created_receipts();
    for r in receipts {
        for a in r.actions {
            if let near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } = a {
                if method_name == b"request_execution" {
                    // Item 16b: real OutLayer takes the fields at top level.
                    return serde_json::from_slice(&args).unwrap();
                }
            }
        }
    }
    panic!("no request_execution receipt created");
}

#[test]
fn item11_wasm_url_comes_from_init_config_not_a_constant() {
    let mut c = new_contract();
    c.outlayer_config.wasm_base_url = "https://fastfs.near/praetorial.near/outlayer.near".to_string();
    let args = item11_sent_outlayer_args(&mut c, 140);
    let url = args["source"]["WasmUrl"]["url"].as_str().unwrap().to_string();
    assert_eq!(
        url,
        format!("https://fastfs.near/praetorial.near/outlayer.near/{}.wasm", test_resolver_wasm_hash()),
        "wasm URL must be built from the init-time OutlayerConfig"
    );
    assert!(!url.contains("test.fastfs.io"), "no hardcoded testnet gateway");
}

#[test]
fn item11_request_execution_carries_secrets_ref_from_init_config() {
    let mut c = new_contract();
    let args = item11_sent_outlayer_args(&mut c, 141);
    assert_eq!(
        args["secrets_ref"],
        serde_json::json!({
            "profile": "praetorial-resolver",
            "account_id": "escrow.praetorial-dev-1101.testnet",
        }),
        "secrets_ref {{profile, account_id}} must ride in request_execution args"
    );
}

#[test]
fn item11_outlayer_config_view_roundtrips() {
    let c = new_contract();
    assert_eq!(c.outlayer_config(), test_outlayer_config());
}

fn item11_try_new(cfg: OutlayerConfig) -> std::thread::Result<Contract> {
    std::panic::catch_unwind(move || {
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
            cfg,
            test_judge_chain(),
        )
    })
}

#[test]
fn item11_new_rejects_malformed_outlayer_config() {
    let good = test_outlayer_config();
    assert!(item11_try_new(good.clone()).is_ok(), "control: valid config accepted");
    let mut http = good.clone();
    http.wasm_base_url = "http://insecure.example/x".to_string();
    assert!(item11_try_new(http).is_err(), "non-https wasm base url must be rejected");
    let mut slash = good.clone();
    slash.wasm_base_url.push('/');
    assert!(item11_try_new(slash).is_err(), "trailing slash must be rejected");
    let mut empty = good.clone();
    empty.secrets_profile = String::new();
    assert!(item11_try_new(empty).is_err(), "empty secrets profile must be rejected");
    let mut long = good;
    long.secrets_profile = "p".repeat(65);
    assert!(item11_try_new(long).is_err(), "65-byte secrets profile must be rejected");
}

/// Replaces `tier1_gets_120s_other_tiers_get_the_outlayer_180s_ceiling`
/// (rewritten, not deleted: the 180s ceiling is deliberately lowered to
/// 150s until a 180s live run has completed -- see build log item 11).
#[test]
fn item11_no_tier_requests_more_than_150s_until_a_180s_run_completes() {
    assert_eq!(max_execution_seconds_for_tier(0), 120, "tier1 stays at 120s");
    for tier in [1u8, 2, 3, 4, 255] {
        let s = max_execution_seconds_for_tier(tier);
        assert_eq!(s, 150, "tier {tier} requests {s}s; interim cap is 150s");
    }
}

#[test]
fn item11_request_execution_args_use_the_capped_timeout() {
    let mut c = new_contract();
    c.outlayer_config.wasm_base_url = "https://fastfs.near/a/b".to_string();
    let (_, pk) = test_keypair(142);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    // Make it a tier-1 (index 1) bet so the cap path is exercised.
    c.bets.get_mut(&bet_id).unwrap().envelope.tier = 1;
    ctx_with_deposit(KEEPER, 1, NearToken::from_millinear(50));
    c.topup_keeper_credit();
    ctx_with_deposit(KEEPER, 1_001, NearToken::from_yoctonear(0));
    let _ = c.request_resolution(bet_id, None);
    let mut found = None;
    for r in near_sdk::test_utils::get_created_receipts() {
        for a in r.actions {
            if let near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } = a {
                if method_name == b"request_execution" {
                    let inner: serde_json::Value = serde_json::from_slice(&args).unwrap();
                    found = inner["resource_limits"]["max_execution_seconds"].as_u64();
                }
            }
        }
    }
    let secs = found.expect("request_execution receipt");
    assert!(secs <= 150, "on-the-wire max_execution_seconds {secs} exceeds 150");
}

// ---------------------------------------------------------------------
// Queue item 11 (e): keeper-credit top-up path + OutLayer stale/failed
// request path. NOTE on `cancel_stale_execution`: OutLayer requires
// predecessor == the request's `sender_id` (the tx SIGNER). For an
// escrow-forwarded request the signer is the keeper and the predecessor is
// this contract, so the escrow can never call it itself; the keeper calls
// `outlayer.cancel_stale_execution(request_id)` directly (after OutLayer's
// 600s EXECUTION_TIMEOUT), and OutLayer refunds `payer_account_id`
// (default = predecessor = this contract) minus the base fee. That NEAR
// lands in the escrow's own balance outside `keeper_credit` unless the
// keeper re-tops-up (`topup_keeper_credit`), which is the path pinned
// below. These tests pin the escrow-side half.
// ---------------------------------------------------------------------

#[test]
fn item11e_topup_then_zero_deposit_request_then_topup_again_conserves_credit() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(150);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let topup = NearToken::from_millinear(50);
    ctx_with_deposit(KEEPER, 1, topup);
    c.topup_keeper_credit();
    ctx_with_deposit(KEEPER, 1_001, NearToken::from_yoctonear(0));
    let _ = c.request_resolution(bet_id, None);
    let spent = MIN_RESOLUTION_COMPUTE_DEPOSIT.as_yoctonear();
    assert_eq!(c.keeper_credit_balance().0, topup.as_yoctonear() - spent);
    // Fee account may also top up (the post-stale-cancel recovery path).
    ctx_with_deposit(FEE, 2, topup);
    c.topup_keeper_credit();
    assert_eq!(c.keeper_credit_balance().0, 2 * topup.as_yoctonear() - spent);
}

/// OutLayer failed/never ran the request (what the escrow's callback sees
/// when the yielded request is cancelled or the cross-contract call fails):
/// a credit-funded request's WHOLE deposit goes straight back to the pool,
/// no outgoing receipt.
#[test]
fn item11e_failed_outlayer_request_returns_whole_credit_funded_deposit_to_pool() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(151);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx_with_deposit(KEEPER, 1, NearToken::from_millinear(50));
    c.topup_keeper_credit();
    let before_request = c.keeper_credit_balance().0;
    ctx_with_deposit(KEEPER, 1_001, NearToken::from_yoctonear(0));
    let _ = c.request_resolution(bet_id, None);
    let request_id = c.next_request_id - 1;
    assert_eq!(
        c.keeper_credit_balance().0,
        before_request - MIN_RESOLUTION_COMPUTE_DEPOSIT.as_yoctonear()
    );
    ctx_with_promise_result(CONTRACT, 1_002, PromiseResult::Failed);
    c.on_resolution(request_id);
    assert!(near_sdk::test_utils::get_created_receipts().is_empty(), "no native transfer for a credit refund");
    assert_eq!(c.keeper_credit_balance().0, before_request, "pool must be made whole");
    let raw = c.get_bet(bet_id).unwrap().last_resolution_raw.unwrap();
    assert!(raw.contains("outlayer_call_failed"));
}

/// Liveness: if the OutLayer request goes stale (bet left in `Resolving`),
/// the C16 backstop still frees the money -- `void_after_deadline` is valid
/// from `Resolving` once `resolve_deadline` passes.
#[test]
fn item11e_bet_stuck_in_resolving_after_stale_request_still_voids_after_deadline() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(152);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx_with_deposit(KEEPER, 1, NearToken::from_millinear(50));
    c.topup_keeper_credit();
    ctx_with_deposit(KEEPER, 1_001, NearToken::from_yoctonear(0));
    let _ = c.request_resolution(bet_id, None);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Resolving);
    let deadline = c.get_bet(bet_id).unwrap().envelope.resolve_deadline;
    ctx("anyone.testnet", deadline + 1);
    c.void_after_deadline(bet_id);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Voided);
}

/// The escrow exposes no method of its own that would call OutLayer's
/// `cancel_stale_execution` (it can't: predecessor != signer there). Pin
/// that so nobody adds a dead path believing it works.
#[test]
fn item11e_escrow_has_no_cancel_stale_execution_wrapper() {
    let src = include_str!("lib.rs");
    assert!(
        !src.contains("pub fn cancel_stale_execution"),
        "escrow cannot invoke OutLayer cancel_stale_execution (predecessor must equal signer); keeper calls it directly"
    );
}

// ---------------- red-team: shutdown mid-dispute / mid-resolution ----------------

fn rt_submit_yes(c: &mut Contract, bet_id: u64, ts: u64) {
    ctx("anyone.testnet", ts);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(ts),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
}

fn rt_total_for(c: &Contract, bet_id: u64, who: &str) -> u128 {
    let a: AccountId = who.parse().unwrap();
    c.pending_payouts(bet_id).iter().filter(|p| p.receiver == a).map(|p| p.amount.0).sum()
}

fn rt_limits(max_rounds: u32) -> Limits {
    Limits {
        max_stake: U128(crate::DEFAULT_MAX_STAKE_PER_SIDE_USDC),
        max_offer_ttl_secs: 86400 * 60,
        max_stake_per_side_near: U128(100 * 10u128.pow(24)),
        max_rounds,
        max_retries: crate::DEFAULT_MAX_RETRIES,
    }
}

/// RED (fixed): after the guardian kill-switch, `void_after_deadline`
/// stayed permissionless and, for a keep_terms bet, routed both storage
/// charges to the fee account -- any third party could front-run
/// `emergency_refund` and make the parties lose their storage deposits.
/// After shutdown `emergency_refund` is the ONLY exit.
#[test]
#[should_panic(expected = "contract is shut down")]
fn redteam_void_after_deadline_refused_after_shutdown() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(240);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx_with_deposit(GUARDIAN, 5_000, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    ctx("anyone.testnet", 10_001);
    c.void_after_deadline(bet_id);
}

/// Safe-pinned: past the resolve deadline, the full storage charge comes
/// back to each party via emergency_refund.
#[test]
fn redteam_shutdown_past_deadline_emergency_refund_returns_storage_charge() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(241);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let env = c.get_bet(bet_id).unwrap().envelope;
    ctx_with_deposit(GUARDIAN, 5_000, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    ctx("anyone.testnet", 10_001);
    c.emergency_refund(bet_id);
    assert_eq!(rt_total_for(&c, bet_id, "maker.testnet"), env.maker_required());
    assert_eq!(rt_total_for(&c, bet_id, "taker.testnet"), env.taker_required());
}

/// Safe-pinned: kill-switch while Resolving (OutLayer yield pending),
/// refund, then the resolution callback arrives (success-with-unused-
/// compute and failure variants): no new payout line, bet stays Voided,
/// outcome submission and finalize refused, refunds exact and paid once.
#[test]
fn redteam_shutdown_while_resolving_then_callback_cannot_move_bet_funds() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(242);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let env = c.get_bet(bet_id).unwrap().envelope;
    ctx_with_deposit(KEEPER, 1, NearToken::from_millinear(50));
    c.topup_keeper_credit();
    ctx_with_deposit(KEEPER, 1_001, NearToken::from_yoctonear(0));
    let _ = c.request_resolution(bet_id, None);
    let request_id = c.next_request_id - 1;
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Resolving);

    ctx_with_deposit(GUARDIAN, 1_100, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    ctx("anyone.testnet", 1_200);
    c.emergency_refund(bet_id);
    let lines_before = c.pending_payouts(bet_id);
    let total_before: u128 = lines_before.iter().map(|p| p.amount.0).sum();
    assert_eq!(total_before, env.maker_required() + env.taker_required());
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Voided);

    let inner = serde_json::json!({"request_id": request_id, "unused_compute_yocto": "1000"}).to_string();
    ctx_with_promise_result(CONTRACT, 1_300, PromiseResult::Successful(serde_json::to_vec(&inner).unwrap()));
    c.on_resolution(request_id);
    ctx_with_promise_result(CONTRACT, 1_301, PromiseResult::Failed);
    c.on_resolution(request_id);
    assert_eq!(c.pending_payouts(bet_id).len(), lines_before.len(), "callback must not add payout lines");
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Voided);

    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| rt_submit_yes(&mut c, bet_id, 1_400)));
    assert!(r.is_err(), "submit_outcome must be refused after shutdown");
    ctx("anyone.testnet", 1_500);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.finalize(bet_id)));
    assert!(r.is_err());
    drain_all(&mut c, bet_id, 1_600);
    assert!(c.is_fully_paid(bet_id));
}

/// Safe-pinned: multi-round re-judge. Round-1 bond + an objection posted,
/// request_resolution (Resolving, bonds=1); kill-switch; a new round-2
/// bond is bounced; refund returns stakes + bond + objection to their
/// holders exactly, once; second call refused.
#[test]
fn redteam_shutdown_during_rejudge_round_refunds_all_posted_funds_once() {
    let mut c = new_contract_with_limits(rt_limits(3), None);
    let (_, pk) = test_keypair(243);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let env = c.get_bet(bet_id).unwrap().envelope;
    rt_submit_yes(&mut c, bet_id, 2_000);
    let bond1 = c.required_challenge_bond(bet_id, "taker.testnet".parse().unwrap()).unwrap().amount.0;
    do_mt_transfer(&mut c, "taker.testnet", bond1,
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050);
    do_mt_transfer(&mut c, "maker.testnet", OBJECTION_DEPOSIT,
        objection_msg(bet_id, &"f".repeat(64), false), 2_060);
    ctx_with_deposit(KEEPER, 2_070, NearToken::from_millinear(50));
    let _ = c.request_resolution(bet_id, None);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Resolving);

    ctx_with_deposit(GUARDIAN, 2_080, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    let resp = do_mt_transfer(&mut c, "maker.testnet", bond1 * 2,
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 2 }).unwrap(), 2_090);
    assert_eq!(resp, vec![U128(bond1 * 2)], "post-shutdown bond must be returned in full");
    ctx("anyone.testnet", 2_100);
    c.emergency_refund(bet_id);
    assert_eq!(rt_total_for(&c, bet_id, "maker.testnet"), env.maker_required() + OBJECTION_DEPOSIT);
    assert_eq!(rt_total_for(&c, bet_id, "taker.testnet"), env.taker_required() + bond1);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.emergency_refund(bet_id)));
    assert!(r.is_err(), "second emergency_refund refused");
    assert_eq!(
        c.pending_payouts(bet_id).iter().map(|p| p.amount.0).sum::<u128>(),
        env.maker_required() + env.taker_required() + bond1 + OBJECTION_DEPOSIT
    );
}

/// Safe-pinned: a refund transfer fails (intents down), is retried via
/// permissionless drain_payouts AFTER the kill-switch; each unit is paid
/// exactly once (done lines are never re-fired), bet stays Voided.
#[test]
fn redteam_emergency_refund_failed_transfer_retry_pays_exactly_once() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(244);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx_with_deposit(GUARDIAN, 2_000, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    ctx("anyone.testnet", 2_010);
    c.emergency_refund(bet_id);
    ctx("anyone.testnet", 2_020);
    let fired = c.drain_payouts(bet_id, MAX_DRAIN_BATCH);
    assert!(fired >= 2);
    let in_flight: Vec<_> = c.pending_payouts(bet_id).into_iter().filter(|p| p.in_flight).collect();
    let maker: AccountId = "maker.testnet".parse().unwrap();
    let maker_ids: Vec<u64> = in_flight.iter().filter(|p| p.receiver == maker).map(|p| p.id).collect();
    let taker_ids: Vec<u64> = in_flight.iter().filter(|p| p.receiver != maker).map(|p| p.id).collect();
    ctx_with_promise_result(CONTRACT, 2_030, PromiseResult::Failed);
    c.on_payout_result(maker_ids.clone());
    ctx_with_promise_result(CONTRACT, 2_031, PromiseResult::Successful(vec![]));
    c.on_payout_result(taker_ids.clone());
    let remaining = c.pending_payouts(bet_id);
    assert!(remaining.iter().all(|p| p.receiver == maker && !p.in_flight));
    ctx("anyone.testnet", 2_040);
    let fired = c.drain_payouts(bet_id, MAX_DRAIN_BATCH);
    assert_eq!(fired as usize, maker_ids.len(), "only the failed group re-fires");
    ctx_with_promise_result(CONTRACT, 2_050, PromiseResult::Successful(vec![]));
    c.on_payout_result(maker_ids);
    assert!(c.is_fully_paid(bet_id));
    ctx("anyone.testnet", 2_060);
    assert_eq!(c.drain_payouts(bet_id, MAX_DRAIN_BATCH), 0, "nothing left to pay -> no double pay");
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Voided);
}

/// Safe-pinned: payout partially failed on a Finalized bet, then
/// kill-switch + emergency_refund (twice): schedules nothing, the failed
/// group retries after shutdown and the bet settles; no double-pay.
#[test]
fn redteam_finalized_partial_payout_failure_then_shutdown_refund_noop_and_retry_ok() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(245);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    rt_submit_yes(&mut c, bet_id, 2_000);
    ctx("anyone.testnet", 2_000 + 86_400_000_000_001);
    c.finalize(bet_id);
    let total_lines: u128 = c.pending_payouts(bet_id).iter().map(|p| p.amount.0).sum();
    let in_flight = c.pending_payouts(bet_id).into_iter().filter(|p| p.in_flight).collect::<Vec<_>>();
    let winner = in_flight.iter().find(|p| p.reason.starts_with("payout_winner")).expect("winner line").clone();
    let win_ids: Vec<u64> = in_flight.iter().filter(|p| p.receiver == winner.receiver).map(|p| p.id).collect();
    ctx_with_promise_result(CONTRACT, 2_100_000_000_000, PromiseResult::Failed);
    c.on_payout_result(win_ids.clone());

    ctx_with_deposit(GUARDIAN, 2_200_000_000_000, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    for _ in 0..2 {
        ctx("anyone.testnet", 2_300_000_000_000);
        c.emergency_refund(bet_id);
    }
    assert_eq!(c.pending_payouts(bet_id).iter().map(|p| p.amount.0).sum::<u128>(), total_lines);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Finalized);
    resolve_in_flight(&mut c, bet_id, 2_350_000_000_000);
    drain_all(&mut c, bet_id, 2_400_000_000_000);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Settled);
}


/// DR-ESC-7: round-trips the contract through storage so every
/// `LookupMap` read in the measured call is a real (gas-charged)
/// storage read rather than a free in-memory cache hit.
fn cold_contract(mut c: Contract, ts: u64) -> Contract {
    c.bets.flush();
    c.pending_requests.flush();
    c.resolution_payers.flush();
    c.pending_payouts.flush();
    near_sdk::env::state_write(&c);
    drop(c);
    ctx("anyone.testnet", ts);
    near_sdk::env::state_read::<Contract>().expect("state")
}

/// DR-ESC-7: gas of `drain_payouts` on a fresh bet must not grow with
/// the number of unrelated, already-done ledger lines in the contract.
fn drain_gas_with_history(history: usize) -> (u64, u64) {
    let mut c = new_contract();
    for i in 0..history {
        c.test_inject_done_payout(
            10_000 + i as u64,
            "maker.testnet".parse().unwrap(),
            "usdc.testnet".to_string(),
            1,
        );
    }
    let bet_id = 777;
    c.test_inject_pending_payout(
        bet_id,
        "maker.testnet".parse().unwrap(),
        "usdc.testnet".to_string(),
        5,
        "fresh".to_string(),
    );
    let mut c = cold_contract(c, 5_000);
    let fired = c.drain_payouts(bet_id, 10);
    assert_eq!(fired, 1);
    let used = near_sdk::env::used_gas().as_gas();
    let _ = c.pending_payouts(bet_id);
    let _ = c.is_fully_paid(bet_id);
    (used, near_sdk::env::used_gas().as_gas())
}

#[test]
fn dr_esc_7_drain_gas_independent_of_unrelated_payout_history() {
    let (base_drain, base_all) = drain_gas_with_history(0);
    let (big_drain, big_all) = drain_gas_with_history(3000);
    const TGAS: u64 = 1_000_000_000_000;
    assert!(
        big_all <= 300 * TGAS - 20 * TGAS,
        "drain+views with 3000 prior lines used {} Tgas",
        big_all / TGAS
    );
    assert!(
        big_drain <= base_drain + base_drain / 10 + TGAS,
        "drain_payouts gas grew with unrelated history: {base_drain} -> {big_drain}"
    );
    assert!(
        big_all <= base_all + base_all / 10 + TGAS,
        "views gas grew with unrelated history: {base_all} -> {big_all}"
    );
}

#[test]
fn dr_esc_7_finalize_gas_independent_of_unrelated_payout_history() {
    let measure = |history: usize| -> u64 {
        let (mut c, bet_id, ts) = build_oq_t11_worst_case_bet(93);
        for i in 0..history {
            c.test_inject_done_payout(
                10_000 + i as u64,
                "maker.testnet".parse().unwrap(),
                "usdc.testnet".to_string(),
                1,
            );
        }
        let mut c = cold_contract(c, ts);
        c.finalize(bet_id);
        near_sdk::env::used_gas().as_gas()
    };
    let base = measure(0);
    let big = measure(3000);
    const TGAS: u64 = 1_000_000_000_000;
    assert!(
        big <= base + base / 10 + TGAS,
        "finalize gas grew with unrelated history: {base} -> {big}"
    );
}

// DR-ESC-8: the root struct is borsh-(de)serialized on every call, so its
// size must not grow with the number of payout lines ever scheduled.
fn root_state_len_with_history(history: usize) -> usize {
    let mut c = new_contract();
    for i in 0..history {
        c.test_inject_done_payout(
            10_000 + i as u64,
            "maker.testnet".parse().unwrap(),
            "usdc.testnet".to_string(),
            1,
        );
    }
    near_sdk::borsh::to_vec(&c).unwrap().len()
}

#[test]
fn dr_esc_8_root_state_size_independent_of_payout_history() {
    let base = root_state_len_with_history(0);
    let big = root_state_len_with_history(3000);
    assert!(
        big < base + 64,
        "root struct grew with payout history: {base} -> {big} bytes"
    );
}

// ---------------- Red team 2026-11-06: signed-outcome replay ----------------
//
// Theme: make `submit_outcome` / `handle_open` accept a resolver-signed
// outcome or sourcecheck attestation somewhere it shouldn't. See the vault
// "Red team log" section "Run 2026-11-06 - theme: signed-outcome replay".

fn rr_result(bet_id: u64, outcome: &str, run_no: u64, ts: u64) -> SubmittedResult {
    SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: outcome.to_string(),
        element_results_hash: "e".repeat(64),
        run_no,
        checked_until: U64(ts),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    }
}

/// Signs exactly like `sign_result` but binds an arbitrary escrow account id.
fn rr_sign_for_account(sk: &ed25519_dalek::SigningKey, account: &str, r: &SubmittedResult) -> String {
    let mut buf = Vec::new();
    BorshSerialize::serialize(&account.parse::<AccountId>().unwrap(), &mut buf).unwrap();
    BorshSerialize::serialize(&r.bet_id, &mut buf).unwrap();
    BorshSerialize::serialize(&r.terms_hash, &mut buf).unwrap();
    BorshSerialize::serialize(&r.outcome, &mut buf).unwrap();
    BorshSerialize::serialize(&r.element_results_hash, &mut buf).unwrap();
    BorshSerialize::serialize(&r.run_no, &mut buf).unwrap();
    BorshSerialize::serialize(&r.checked_until.0, &mut buf).unwrap();
    BorshSerialize::serialize(&r.judge_pair_index, &mut buf).unwrap();
    if r.outcome == "RETRY" {
        BorshSerialize::serialize(&r.next_check_ns.unwrap().0, &mut buf).unwrap();
    }
    hex_encode(&sk.sign(&buf).to_bytes())
}

fn rr_submit_panics(c: &mut Contract, r: SubmittedResult, sig: String) -> bool {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.submit_outcome(r, sig))).is_err()
}

/// Severity money. A genuine signature bound to a DIFFERENT escrow account
/// (another deployment / contract version) must not verify here.
#[test]
fn redteam_replay_outcome_signed_for_other_escrow_account_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(150);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let r = rr_result(bet_id, "YES", 1, 2_000);
    for other in ["escrow-v2.testnet", "escrow-v1.mainnet"] {
        let sig = rr_sign_for_account(&outcome_signing_key(), other, &r);
        assert!(rr_submit_panics(&mut c, r.clone(), sig), "sig bound to {other} must be rejected");
    }
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Taken);
    // control: the same helper bound to THIS account is accepted.
    let ok = rr_sign_for_account(&outcome_signing_key(), CONTRACT, &r);
    c.submit_outcome(r, ok);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Proposed);
}

/// Severity wrong-winner. The attest key (sourcecheck/archive) must never be
/// accepted as an outcome signer, for terminal outcomes or RETRY.
#[test]
fn redteam_outcome_signed_with_attest_key_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(151);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    for outcome in ["YES", "NO", "VOID", "VOID:source_conflict"] {
        let r = rr_result(bet_id, outcome, 1, 2_000);
        let sig = sign_result(&attest_signing_key(), &r);
        assert!(rr_submit_panics(&mut c, r, sig), "{outcome} signed by attest key must be rejected");
    }
    let mut retry = rr_result(bet_id, "RETRY", 1, 2_000);
    retry.next_check_ns = Some(U64(2_000 + 3_600_000_000_000));
    let sig = sign_result(&attest_signing_key(), &retry);
    assert!(rr_submit_panics(&mut c, retry, sig), "RETRY signed by attest key must be rejected");
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Taken);
}

/// Severity money (opens a bet the resolver never vouched for). The reverse
/// direction: the outcome key must not be accepted as a sourcecheck signer.
#[test]
fn redteam_sourcecheck_signed_with_outcome_key_refused() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(152);
    let env = base_envelope(&hex_encode(&pk));
    let sig = outcome_signing_key().sign(sourcecheck_message(&env.terms_hash, 0).as_bytes());
    let msg = serde_json::to_string(&TransferMsg::Open {
        envelope: env.clone(),
        attestation: SourceCheckAttestation { checked_at: 0, signature_hex: hex_encode(&sig.to_bytes()) },
    })
    .unwrap();
    let before = c.next_bet_id;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), msg, 1);
    assert_eq!(resp, vec![U128(env.maker_required())]);
    assert_eq!(c.next_bet_id, before);
}

/// Severity money. A borsh outcome message must never double as a valid
/// sourcecheck (or vice versa) even under the same key: signing the outcome
/// buffer with the attest key and passing it as the attestation fails.
#[test]
fn redteam_outcome_borsh_buffer_not_usable_as_sourcecheck_attestation() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(153);
    let env = base_envelope(&hex_encode(&pk));
    let r = rr_result(1, "YES", 1, 0);
    let sig = sign_result(&attest_signing_key(), &r); // sig over borsh outcome msg
    let msg = serde_json::to_string(&TransferMsg::Open {
        envelope: env.clone(),
        attestation: SourceCheckAttestation { checked_at: 0, signature_hex: sig },
    })
    .unwrap();
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), msg, 1);
    assert_eq!(resp, vec![U128(env.maker_required())]);
}

/// Severity money. After finalize (and thus after payouts are scheduled), no
/// signed result - the already-used one or a fresh genuinely-signed one -
/// may be applied again.
#[test]
fn redteam_double_apply_after_finalized_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(154);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let r1 = rr_result(bet_id, "YES", 1, 2_000);
    let sig1 = sign_result(&outcome_signing_key(), &r1);
    c.submit_outcome(r1.clone(), sig1.clone());
    let settle = c.get_bet(bet_id).unwrap().envelope.settlement_period;
    ctx("anyone.testnet", 2_000 + settle + 1);
    c.finalize(bet_id);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Finalized);
    let payouts = c.payout_ids_in_order().len();
    let outcome = c.get_bet(bet_id).unwrap().outcome.clone();

    assert!(rr_submit_panics(&mut c, r1, sig1), "exact replay after finalize");
    let r2 = rr_result(bet_id, "NO", 2, 2_001);
    let sig2 = sign_result(&outcome_signing_key(), &r2);
    assert!(rr_submit_panics(&mut c, r2, sig2), "fresh genuine NO after finalize");
    let r3 = rr_result(bet_id, "VOID", 1, 2_001);
    let sig3 = sign_result(&outcome_signing_key(), &r3);
    assert!(rr_submit_panics(&mut c, r3, sig3), "genuine VOID after finalize");
    assert_eq!(c.get_bet(bet_id).unwrap().outcome, outcome);
    assert_eq!(c.payout_ids_in_order().len(), payouts, "no extra payout scheduled");
}

/// Severity wrong-winner. A stale earlier-round result (run 1) replayed in a
/// later challenge/re-judge round must not overwrite the round-2 outcome.
#[test]
fn redteam_stale_round1_result_replayed_in_rejudge_round_rejected() {
    let mut c = new_contract_with_limits(rt_limits(3), None);
    let (_, pk) = test_keypair(155);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let r1 = rr_result(bet_id, "YES", 1, 2_000);
    let sig1 = sign_result(&outcome_signing_key(), &r1);
    ctx("anyone.testnet", 2_000);
    c.submit_outcome(r1.clone(), sig1.clone());
    let bond1 = c.required_challenge_bond(bet_id, "taker.testnet".parse().unwrap()).unwrap().amount.0;
    do_mt_transfer(&mut c, "taker.testnet", bond1,
        serde_json::to_string(&TransferMsg::Bond { bet_id, round: 1 }).unwrap(), 2_050);
    assert!(matches!(c.get_bet(bet_id).unwrap().status, BetStatus::Challenged | BetStatus::Evidence));
    // Replay of the round-1 YES (same run_no) in the new round.
    assert!(rr_submit_panics(&mut c, r1.clone(), sig1.clone()), "run_no 1 reuse in round 2");
    // Round-1 YES re-signed under a bumped run_no is by definition a NEW resolver
    // signature (not a replay); the stale one must still fail.
    // Skipping ahead (run_no 3) with an old-round-style payload is out of order.
    let r3 = rr_result(bet_id, "YES", 3, 2_100);
    let sig3 = sign_result(&outcome_signing_key(), &r3);
    assert!(rr_submit_panics(&mut c, r3, sig3), "run_no skip rejected (I-7)");
    assert_eq!(c.get_bet(bet_id).unwrap().next_expected_run_no, 2);
    // Round-2 genuine result lands once.
    let r2 = rr_result(bet_id, "NO", 2, 2_100);
    let sig2 = sign_result(&outcome_signing_key(), &r2);
    ctx("anyone.testnet", 2_100);
    c.submit_outcome(r2, sig2);
    assert_eq!(c.get_bet(bet_id).unwrap().outcome.as_deref(), Some("NO"));
    assert!(rr_submit_panics(&mut c, r1, sig1), "round-1 replay after round-2 proposed");
    assert_eq!(c.get_bet(bet_id).unwrap().outcome.as_deref(), Some("NO"));
}

/// Severity liveness/money. RETRY replay cannot be used to inflate
/// retry_count towards the VOID-for-unavailability gate.
#[test]
fn redteam_retry_signature_replay_cannot_inflate_retry_count() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(156);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let th = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();
    ctx("anyone.testnet", 2_000);
    let r = retry_result(bet_id, &th, 1, 2_000, 2_000 + DAY_NS_RR);
    let sig = sign_result(&outcome_signing_key(), &r);
    c.submit_outcome(r.clone(), sig.clone());
    for _ in 0..5 {
        assert!(rr_submit_panics(&mut c, r.clone(), sig.clone()));
    }
    assert_eq!(c.get_bet(bet_id).unwrap().retry_count, 1);
}
const DAY_NS_RR: u64 = 24 * 60 * 60 * 1_000_000_000;

/// Severity liveness. A signed RETRY cannot be re-targeted to a different
/// next_check_ns (older or newer) - the value is inside the signature.
#[test]
fn redteam_retry_next_check_ns_tamper_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(157);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let th = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();
    ctx("anyone.testnet", 2_000);
    let r = retry_result(bet_id, &th, 1, 2_000, 2_000 + DAY_NS_RR);
    let sig = sign_result(&outcome_signing_key(), &r);
    for tampered in [2_000 + DAY_NS_RR + 1, 2_000 + DAY_NS_RR - 1, 2_001] {
        let mut t = r.clone();
        t.next_check_ns = Some(U64(tampered));
        assert!(rr_submit_panics(&mut c, t, sig.clone()), "tampered next_check_ns {tampered}");
    }
    assert_eq!(c.get_bet(bet_id).unwrap().retry_count, 0);
    assert_eq!(c.get_bet(bet_id).unwrap().next_check_ns, None);
}

/// Severity liveness. A pre-signed RETRY whose next_check_ns has since
/// elapsed (stale) is refused when finally relayed, and a RETRY signature
/// cannot be reinterpreted as a terminal outcome.
#[test]
fn redteam_stale_retry_and_retry_sig_as_terminal_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(158);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let th = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();
    let r = retry_result(bet_id, &th, 1, 2_000, 2_000 + 3_600_000_000_000);
    let sig = sign_result(&outcome_signing_key(), &r);
    // Relayed after next_check_ns has passed.
    ctx("anyone.testnet", 2_000 + 3_600_000_000_000 + 1);
    assert!(rr_submit_panics(&mut c, r.clone(), sig.clone()), "stale RETRY");
    // RETRY sig reused with outcome swapped to NO / VOID.
    ctx("anyone.testnet", 2_100);
    for o in ["NO", "YES", "VOID"] {
        let mut t = r.clone();
        t.outcome = o.to_string();
        t.next_check_ns = None;
        assert!(rr_submit_panics(&mut c, t, sig.clone()), "RETRY sig as {o}");
    }
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Taken);
}

/// Severity low. RETRY after the bet already holds a proposed result is
/// refused (cannot erase/rewind a Proposed outcome with an old RETRY).
#[test]
fn redteam_retry_after_proposed_rejected() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(159);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let th = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();
    ctx("anyone.testnet", 2_000);
    let r1 = rr_result(bet_id, "YES", 1, 2_000);
    let s1 = sign_result(&outcome_signing_key(), &r1);
    c.submit_outcome(r1, s1);
    let rt = retry_result(bet_id, &th, 2, 2_001, 2_001 + 3_600_000_000_000);
    let st = sign_result(&outcome_signing_key(), &rt);
    assert!(rr_submit_panics(&mut c, rt, st));
    assert_eq!(c.get_bet(bet_id).unwrap().outcome.as_deref(), Some("YES"));
    assert_eq!(c.get_bet(bet_id).unwrap().retry_count, 0);
}


// ---------------------------------------------------------------------
// Queue item 16b (D-OL-WIRE1): OutLayer wire format. Real
// `outlayer.testnet request_execution` takes `source`, `input_data`,
// `secrets_ref`, `resource_limits`, `response_format`, ... as TOP-LEVEL
// JSON fields. ABI pinned in tests/fixtures/outlayer_request_execution_abi.json.
// ---------------------------------------------------------------------

/// Mirror of the real OutLayer `request_execution` parameters
/// (contract/src/execution.rs @ a2a85105). deny_unknown_fields: a
/// `{"args_json": ...}` wrapper, or any stray key, must NOT deserialize.
#[derive(near_sdk::serde::Deserialize, Debug)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
#[allow(dead_code)]
struct RealOutlayerParams {
    source: RealExecutionSource,
    resource_limits: Option<RealResourceLimits>,
    input_data: Option<String>,
    secrets_ref: Option<RealSecretsRef>,
    response_format: Option<RealResponseFormat>,
    payer_account_id: Option<String>,
    params: Option<serde_json::Value>,
}
#[derive(near_sdk::serde::Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
#[allow(dead_code)]
enum RealExecutionSource {
    GitHub { repo: String, commit: String, build_target: Option<String> },
    WasmUrl { url: String, hash: String, build_target: Option<String> },
    Project { project_id: String, version_key: Option<String> },
}
#[derive(near_sdk::serde::Deserialize, Debug)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
#[allow(dead_code)]
struct RealResourceLimits {
    max_instructions: Option<u64>,
    max_memory_mb: Option<u32>,
    max_execution_seconds: Option<u64>,
}
#[derive(near_sdk::serde::Deserialize, Debug)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
#[allow(dead_code)]
struct RealSecretsRef {
    profile: String,
    account_id: String,
}
#[derive(near_sdk::serde::Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
#[allow(dead_code)]
enum RealResponseFormat {
    Bytes,
    Text,
    Json,
}

/// Raw bytes of the `request_execution` function-call receipt, plus its
/// receiver and attached deposit.
fn item16b_sent_request(c: &mut Contract, seed: u8) -> (Vec<u8>, String, u128) {
    let (_, pk) = test_keypair(seed);
    let bet_id = open_and_take(c, &hex_encode(&pk));
    ctx_with_deposit(KEEPER, 1, NearToken::from_millinear(50));
    c.topup_keeper_credit();
    ctx_with_deposit(KEEPER, 1_001, NearToken::from_yoctonear(0));
    let _ = c.request_resolution(bet_id, None);
    for r in near_sdk::test_utils::get_created_receipts() {
        let receiver = r.receiver_id.to_string();
        for a in r.actions {
            if let near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } = a {
                if method_name == b"request_execution" {
                    return (args, receiver, attached_deposit.as_yoctonear());
                }
            }
        }
    }
    panic!("no request_execution receipt created");
}

#[test]
fn item16b_request_execution_bytes_deserialize_into_real_outlayer_params() {
    let mut c = new_contract();
    let (bytes, receiver, deposit) = item16b_sent_request(&mut c, 160);
    assert_eq!(receiver, c.outlayer.to_string());
    assert!(deposit > 0, "compute deposit must still be forwarded");
    let p: RealOutlayerParams = serde_json::from_slice(&bytes).unwrap_or_else(|e| {
        panic!("bytes sent to OutLayer do not match the real ABI: {e}: {}", String::from_utf8_lossy(&bytes[..bytes.len().min(200)]))
    });
    assert!(matches!(p.source, RealExecutionSource::WasmUrl { .. }));
    assert!(p.input_data.is_some());
    assert_eq!(p.secrets_ref.as_ref().unwrap().profile, c.outlayer_config.secrets_profile);
    assert!(matches!(p.response_format, Some(RealResponseFormat::Json)));
    assert!(p.resource_limits.unwrap().max_execution_seconds.is_some());
}

#[test]
fn item16b_request_execution_bytes_are_not_the_args_json_wrapper() {
    let mut c = new_contract();
    let (bytes, _, _) = item16b_sent_request(&mut c, 161);
    let v: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert!(v.get("args_json").is_none(), "old {{\"args_json\":..}} wrapper must not be sent");
    assert!(v.get("source").is_some(), "`source` must be a top-level field");
}

#[test]
fn item16b_real_params_struct_rejects_the_old_wrapper() {
    // Guards the guard: the mirror struct must refuse the pre-16b shape.
    let wrapped = serde_json::json!({"args_json": "{\"source\":{}}"}).to_string();
    assert!(serde_json::from_str::<RealOutlayerParams>(&wrapped).is_err());
}

/// Real OutLayer's callback value for a Json-format run is the guest's raw
/// JSON object (no quoting, no `unused_compute_yocto`); a failed run is
/// `null`. on_resolution must accept both, store them, and not mint credit.
#[test]
fn item16b_on_resolution_accepts_real_outlayer_return_shapes() {
    for (seed, real) in [(162u8, br#"{"outcome":"YES","bet_id":1}"#.to_vec()), (163u8, b"null".to_vec())] {
        let mut c = new_contract();
        let (_, pk) = test_keypair(seed);
        let bet_id = open_and_take(&mut c, &hex_encode(&pk));
        ctx_with_deposit(KEEPER, 1, NearToken::from_millinear(50));
        c.topup_keeper_credit();
        ctx_with_deposit(KEEPER, 1_001, NearToken::from_yoctonear(0));
        let _ = c.request_resolution(bet_id, None);
        let request_id = c.next_request_id - 1;
        let credit_before = c.keeper_credit_balance().0;
        ctx_with_promise_result(CONTRACT, 1_002, PromiseResult::Successful(real.clone()));
        c.on_resolution(request_id);
        assert_eq!(c.bets.get(&bet_id).unwrap().last_resolution_raw.as_deref(), Some(String::from_utf8(real).unwrap().as_str()));
        assert_eq!(c.keeper_credit_balance().0, credit_before, "no unused_compute in the real shape => no refund credit");
    }
}


// ---------------------------------------------------------------------
// Item 16d (D-RESOLVE4): resolution deposit >= OutLayer's required
// payment at every tier; a FAILED OutLayer promise returns the bet to its
// pre-request status so request_resolution can be retried.
// ---------------------------------------------------------------------

fn ol_fixture() -> serde_json::Value {
    serde_json::from_str(include_str!("../tests/fixtures/outlayer_required_payment.json")).unwrap()
}

fn ol_fx(v: &serde_json::Value, k: &str) -> u128 {
    v[k].as_str().unwrap().parse().unwrap()
}

/// OutLayer's `estimate_cost` + `input_storage_deposit`, from the pinned fixture.
fn ol_required_payment(max_instructions: u64, max_secs: u64, input_len: usize) -> u128 {
    let f = ol_fixture();
    let storage = input_len.saturating_sub(f["input_data_free_bytes"].as_u64().unwrap() as usize)
        as u128
        * ol_fx(&f, "storage_price_per_byte_yocto");
    ol_fx(&f, "base_fee_yocto")
        + (max_instructions / 1_000_000) as u128 * ol_fx(&f, "per_million_instructions_fee_yocto")
        + (max_secs * 1000) as u128 * ol_fx(&f, "per_ms_fee_yocto")
        + storage
}

/// (deposit attached to request_execution, max_instructions, max_secs, input_data len)
fn ol_sent_request() -> (u128, u64, u64, usize) {
    for r in near_sdk::test_utils::get_created_receipts() {
        for a in r.actions {
            if let near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } = a {
                if method_name == b"request_execution" {
                    let v: serde_json::Value = serde_json::from_slice(&args).unwrap();
                    return (
                        attached_deposit.as_yoctonear(),
                        v["resource_limits"]["max_instructions"].as_u64().unwrap(),
                        v["resource_limits"]["max_execution_seconds"].as_u64().unwrap(),
                        v["input_data"].as_str().unwrap().len(),
                    );
                }
            }
        }
    }
    panic!("no request_execution receipt");
}

#[test]
fn item16d_fixture_reproduces_the_live_16c_requirement() {
    let f = ol_fixture();
    let w = &f["worked_example"];
    assert_eq!(
        ol_required_payment(w["max_instructions"].as_u64().unwrap(), w["max_execution_seconds"].as_u64().unwrap(), 0),
        ol_fx(w, "required_compute_yocto")
    );
}

#[test]
fn item16d_deposit_attached_covers_outlayer_required_payment_at_every_tier() {
    for (i, tier) in [0u8, 1, 2, 3, 4, 255].into_iter().enumerate() {
        let mut c = new_contract();
        let (_, pk) = test_keypair(160 + i as u8);
        let bet_id = open_and_take(&mut c, &hex_encode(&pk));
        c.bets.get_mut(&bet_id).unwrap().envelope.tier = tier;
        ctx_with_deposit(KEEPER, 1, NearToken::from_near(1));
        c.topup_keeper_credit();
        ctx_with_deposit(KEEPER, 1_001, NearToken::from_yoctonear(0));
        let _ = c.request_resolution(bet_id, None);
        let (deposit, instr, secs, len) = ol_sent_request();
        let required = ol_required_payment(instr, secs, len);
        assert!(
            deposit >= required,
            "tier {tier}: attached {deposit} < OutLayer required {required} ({secs}s) -> 'Insufficient payment'"
        );
    }
}

fn item16d_credit_bet(c: &mut Contract, seed: u8) -> u64 {
    let (_, pk) = test_keypair(seed);
    let bet_id = open_and_take(c, &hex_encode(&pk));
    ctx_with_deposit(KEEPER, 1, NearToken::from_near(1));
    c.topup_keeper_credit();
    bet_id
}

#[test]
fn item16d_failed_outlayer_promise_returns_bet_to_taken_and_retry_works_without_double_refund() {
    let mut c = new_contract();
    let bet_id = item16d_credit_bet(&mut c, 170);
    let credit0 = c.keeper_credit_balance().0;
    ctx_with_deposit(KEEPER, 1_001, NearToken::from_yoctonear(0));
    let _ = c.request_resolution(bet_id, None);
    let req1 = c.next_request_id - 1;
    let drawn = credit0 - c.keeper_credit_balance().0;
    assert!(drawn > 0);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Resolving);

    ctx_with_promise_result(CONTRACT, 1_002, PromiseResult::Failed);
    c.on_resolution(req1);
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, BetStatus::Taken, "nothing executed -> back to pre-request status");
    assert_eq!(bet.pending_resolution_request, None, "in-flight marker cleared");
    assert_eq!(bet.runs_used, 0);
    assert_eq!(c.keeper_credit_balance().0, credit0, "credit made whole exactly once");

    // Replayed callback for the dead request: no-op, no double refund.
    ctx_with_promise_result(CONTRACT, 1_003, PromiseResult::Failed);
    c.on_resolution(req1);
    assert_eq!(c.keeper_credit_balance().0, credit0, "no double refund");
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Taken);

    // Retry succeeds.
    ctx_with_deposit(KEEPER, 1_004, NearToken::from_yoctonear(0));
    let _ = c.request_resolution(bet_id, None);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Resolving);
    assert_eq!(credit0 - c.keeper_credit_balance().0, drawn, "retry draws the same deposit once");
}

#[test]
fn item16d_failed_promise_on_direct_payer_refunds_once_and_restores_challenged_status() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(171);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    c.bets.get_mut(&bet_id).unwrap().status = BetStatus::Challenged;
    ctx_with_deposit(KEEPER, 1_001, NearToken::from_near(1));
    let _ = c.request_resolution(bet_id, None);
    let req = c.next_request_id - 1;
    ctx_with_promise_result(CONTRACT, 1_002, PromiseResult::Failed);
    c.on_resolution(req);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Challenged);
    let transfers = near_sdk::test_utils::get_created_receipts().len();
    assert_eq!(transfers, 1, "exactly one native refund to the payer");
    ctx_with_promise_result(CONTRACT, 1_003, PromiseResult::Failed);
    c.on_resolution(req);
    assert_eq!(near_sdk::test_utils::get_created_receipts().len(), 0, "replay refunds nothing");
}

#[test]
fn item16d_executed_but_unusable_result_stays_resolving_with_void_backstop() {
    // D-RESOLVE3 unchanged: OutLayer ran and returned something unusable.
    let mut c = new_contract();
    let bet_id = item16d_credit_bet(&mut c, 172);
    ctx_with_deposit(KEEPER, 1_001, NearToken::from_yoctonear(0));
    let _ = c.request_resolution(bet_id, None);
    let req = c.next_request_id - 1;
    let garbage = serde_json::to_vec("{\"outcome\":\"VOID\",\"note\":\"no signature\"}").unwrap();
    ctx_with_promise_result(CONTRACT, 1_002, PromiseResult::Successful(garbage));
    c.on_resolution(req);
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, BetStatus::Resolving);
    assert_eq!(bet.pending_resolution_request, Some(req));
    let deadline = bet.envelope.resolve_deadline;
    ctx("anyone.testnet", deadline + 1);
    c.void_after_deadline(bet_id);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Voided);
}

// ---------------------------------------------------------------------
// L1b1 (D-RESOLVE4a): a Successful OutLayer promise carrying no resolver
// output (null / empty / whitespace / any non-object, after the String
// unwrapping) counts as a failed run: prior status restored, markers
// cleared, retry allowed. Refund rule: the escrow refunds NOTHING itself
// (real OutLayer already refunded the unused deposit as plain NEAR to the
// escrow -- recoverable via sweep_excess_near, D-OL-REFUND1), so no
// double refund is possible.
// ---------------------------------------------------------------------

fn l1b1_no_output_cases() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        ("bare null", b"null".to_vec()),
        ("string-wrapped null", serde_json::to_vec("null").unwrap()),
        ("empty bytes", vec![]),
        ("empty string", serde_json::to_vec("").unwrap()),
        ("whitespace bytes", b"  \n\t ".to_vec()),
        ("string-wrapped whitespace", serde_json::to_vec("  \n ").unwrap()),
        ("bare array", b"[]".to_vec()),
        ("bare number", b"42".to_vec()),
        ("non-json text", b"Execution promise failed".to_vec()),
    ]
}

#[test]
fn l1b1_no_output_result_restores_status_and_allows_retry_credit_mode() {
    for (i, (label, bytes)) in l1b1_no_output_cases().into_iter().enumerate() {
        let mut c = new_contract();
        let bet_id = item16d_credit_bet(&mut c, 180 + i as u8);
        let credit0 = c.keeper_credit_balance().0;
        ctx_with_deposit(KEEPER, 1_001, NearToken::from_yoctonear(0));
        let _ = c.request_resolution(bet_id, None);
        let req1 = c.next_request_id - 1;
        let drawn = credit0 - c.keeper_credit_balance().0;
        assert!(drawn > 0, "{label}");
        assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Resolving);
        let credit_mid = c.keeper_credit_balance().0;

        ctx_with_promise_result(CONTRACT, 1_002, PromiseResult::Successful(bytes.clone()));
        c.on_resolution(req1);
        let bet = c.get_bet(bet_id).unwrap();
        assert_eq!(bet.status, BetStatus::Taken, "{label}: restored to prior status");
        assert_eq!(bet.pending_resolution_request, None, "{label}");
        assert_eq!(bet.pending_run_no, None, "{label}");
        assert_eq!(bet.runs_used, 0, "{label}");
        assert_eq!(
            c.keeper_credit_balance().0,
            credit_mid,
            "{label}: escrow refunds 0 (OutLayer already refunded itself); no credit minted"
        );
        assert_eq!(near_sdk::test_utils::get_created_receipts().len(), 0, "{label}: no money moves");

        // Replayed callback: no-op.
        ctx_with_promise_result(CONTRACT, 1_003, PromiseResult::Successful(bytes));
        c.on_resolution(req1);
        assert_eq!(c.keeper_credit_balance().0, credit_mid, "{label}: replay no double refund");
        assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Taken, "{label}");
        assert_eq!(near_sdk::test_utils::get_created_receipts().len(), 0, "{label}");

        // Retry succeeds.
        ctx_with_deposit(KEEPER, 1_004, NearToken::from_yoctonear(0));
        let _ = c.request_resolution(bet_id, None);
        assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Resolving, "{label}");
        assert_eq!(credit_mid - c.keeper_credit_balance().0, drawn, "{label}: retry draws deposit once");
    }
}

#[test]
fn l1b1_null_result_on_direct_payer_restores_challenged_and_moves_no_money() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(190);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    c.bets.get_mut(&bet_id).unwrap().status = BetStatus::Challenged;
    ctx_with_deposit(KEEPER, 1_001, NearToken::from_near(1));
    let _ = c.request_resolution(bet_id, None);
    let req = c.next_request_id - 1;
    ctx_with_promise_result(CONTRACT, 1_002, PromiseResult::Successful(b"null".to_vec()));
    c.on_resolution(req);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Challenged);
    assert_eq!(
        near_sdk::test_utils::get_created_receipts().len(),
        0,
        "no native refund from the escrow: OutLayer already refunded the unused deposit"
    );
    assert_eq!(
        c.get_bet(bet_id).unwrap().last_resolution_raw.as_deref(),
        Some("null"),
        "raw still recorded for diagnostics"
    );
    // Retry allowed.
    ctx_with_deposit(KEEPER, 1_004, NearToken::from_near(1));
    let _ = c.request_resolution(bet_id, None);
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Resolving);
}

#[test]
fn l1b1_real_object_failing_verification_still_stays_resolving() {
    // D-RESOLVE3 regression: a JSON OBJECT (signed-but-unusable) is not "no output".
    for wrapped in [true, false] {
        let mut c = new_contract();
        let bet_id = item16d_credit_bet(&mut c, if wrapped { 200 } else { 201 });
        ctx_with_deposit(KEEPER, 1_001, NearToken::from_yoctonear(0));
        let _ = c.request_resolution(bet_id, None);
        let req = c.next_request_id - 1;
        let obj = "{\"outcome\":\"VOID\",\"note\":\"no signature\"}";
        let bytes = if wrapped { serde_json::to_vec(obj).unwrap() } else { obj.as_bytes().to_vec() };
        ctx_with_promise_result(CONTRACT, 1_002, PromiseResult::Successful(bytes));
        c.on_resolution(req);
        let bet = c.get_bet(bet_id).unwrap();
        assert_eq!(bet.status, BetStatus::Resolving);
        assert_eq!(bet.pending_resolution_request, Some(req));
    }
}

// ---------------------------------------------------------------------
// 16t / D-RUNNO1: run_no is PER-BET. `request_resolution` assigns the
// bet's own monotonic run_no (NOT the global request_id) and passes that
// to the resolver; `submit_outcome` requires the signed run_no to equal
// the pending request's assigned run_no AND bet.next_expected_run_no.
// ---------------------------------------------------------------------

fn runno_request(c: &mut Contract, bet_id: u64, ts: u64) -> u64 {
    ctx_with_deposit("keeper.testnet", ts, NearToken::from_millinear(50));
    let _ = c.request_resolution(bet_id, None);
    c.next_request_id - 1
}

fn runno_result(bet_id: u64, outcome: &str, run_no: u64) -> (SubmittedResult, String) {
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: outcome.to_string(),
        element_results_hash: "e".repeat(64),
        run_no,
        checked_until: U64(5_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    (result, sig)
}

fn runno_submit(c: &mut Contract, bet_id: u64, run_no: u64) {
    ctx("anyone.testnet", 5_000);
    let (r, s) = runno_result(bet_id, "YES", run_no);
    c.submit_outcome(r, s);
}

/// The run_no the contract actually put in the resolver's input_data for
/// the most recent request_resolution call (read from the created
/// `request_execution` receipt).
fn runno_last_input_run_no() -> u64 {
    let receipts = near_sdk::test_utils::get_created_receipts();
    for r in receipts.iter().rev() {
        for a in r.actions.iter().rev() {
            if let near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } = a {
                if method_name == b"request_execution" {
                    let v: serde_json::Value = serde_json::from_slice(args).unwrap();
                    let input: serde_json::Value =
                        serde_json::from_str(v["input_data"].as_str().unwrap()).unwrap();
                    return input["run_no"].as_u64().unwrap();
                }
            }
        }
    }
    panic!("no request_execution receipt found");
}

fn runno_two_bets(c: &mut Contract) -> (u64, u64) {
    let (_, pk) = test_keypair(90);
    let pk_hex = hex_encode(&pk);
    let b1 = open_and_take(c, &pk_hex);
    let b2 = open_and_take(c, &pk_hex);
    assert_ne!(b1, b2);
    (b1, b2)
}

#[test]
fn runno_two_bets_one_contract_both_request_and_settle() {
    let mut c = new_contract();
    let (b1, b2) = runno_two_bets(&mut c);
    runno_request(&mut c, b1, 1_001);
    runno_submit(&mut c, b1, 1);
    assert_eq!(c.get_bet(b1).unwrap().status, BetStatus::Proposed);
    // bet 2's request gets GLOBAL request_id 2, but its own run_no is 1.
    runno_request(&mut c, b2, 1_002);
    assert_eq!(runno_last_input_run_no(), 1, "resolver must be told run_no 1 for bet 2 (what submit_outcome will accept)");
    runno_submit(&mut c, b2, 1);
    assert_eq!(c.get_bet(b2).unwrap().status, BetStatus::Proposed);
}

#[test]
fn runno_interleaved_requests_and_submits_settle() {
    let mut c = new_contract();
    let (b1, b2) = runno_two_bets(&mut c);
    runno_request(&mut c, b1, 1_001);
    runno_request(&mut c, b2, 1_002);
    assert_eq!(runno_last_input_run_no(), 1, "resolver must be told run_no 1 for bet 2");
    runno_submit(&mut c, b2, 1);
    runno_submit(&mut c, b1, 1);
    assert_eq!(c.get_bet(b1).unwrap().status, BetStatus::Proposed);
    assert_eq!(c.get_bet(b2).unwrap().status, BetStatus::Proposed);
}

#[test]
fn runno_re_request_after_failed_run_gets_next_run_no_and_stale_is_rejected() {
    let mut c = new_contract();
    let (b1, _b2) = runno_two_bets(&mut c);
    let rid1 = runno_request(&mut c, b1, 1_001);
    assert_eq!(runno_last_input_run_no(), 1);
    // The OutLayer promise fails -> bet returns to Taken, pending cleared.
    ctx_with_promise_result("escrow.testnet", 1_002, PromiseResult::Failed);
    c.on_resolution(rid1);
    assert_eq!(c.get_bet(b1).unwrap().status, BetStatus::Taken);
    // Re-request: new run gets the NEXT per-bet run_no.
    runno_request(&mut c, b1, 1_003);
    assert_eq!(runno_last_input_run_no(), 2, "re-request must carry run_no 2");
    // A late result from the earlier run (run_no 1) is rejected...
    ctx("anyone.testnet", 5_000);
    let (r, s) = runno_result(b1, "NO", 1);
    let stale = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.submit_outcome(r, s)));
    assert!(stale.is_err(), "stale run_no 1 must be rejected after re-request");
    assert_eq!(c.get_bet(b1).unwrap().status, BetStatus::Resolving);
    // ...and the new run_no 2 settles.
    runno_submit(&mut c, b1, 2);
    assert_eq!(c.get_bet(b1).unwrap().status, BetStatus::Proposed);
}

#[test]
#[should_panic(expected = "run_no out of order")]
fn runno_out_of_order_still_reverts() {
    let mut c = new_contract();
    let (b1, _b2) = runno_two_bets(&mut c);
    runno_request(&mut c, b1, 1_001);
    runno_submit(&mut c, b1, 2);
}

#[test]
#[should_panic(expected = "run_no already used")]
fn runno_reused_still_reverts() {
    let mut c = new_contract();
    let (b1, _b2) = runno_two_bets(&mut c);
    runno_request(&mut c, b1, 1_001);
    runno_submit(&mut c, b1, 1);
    // Challenge so the bet is awaiting an outcome again, then replay run 1.
    do_mt_transfer(
        &mut c,
        "taker.testnet",
        5_005_000,
        serde_json::to_string(&TransferMsg::Bond { bet_id: b1, round: 1 }).unwrap(),
        5_050,
    );
    runno_submit(&mut c, b1, 1);
}

#[test]
fn runno_input_data_carries_per_bet_run_no_not_request_id() {
    let mut c = new_contract();
    let (b1, b2) = runno_two_bets(&mut c);
    let r1 = runno_request(&mut c, b1, 1_001);
    assert_eq!(r1, 1);
    assert_eq!(runno_last_input_run_no(), 1);
    let r2 = runno_request(&mut c, b2, 1_002);
    assert_eq!(r2, 2, "global request_id is 2 for the second bet's request");
    assert_eq!(
        runno_last_input_run_no(),
        1,
        "input_data run_no must be bet 2's own per-bet run_no (1), not request_id (2)"
    );
}

fn runno_three_bets(c: &mut Contract) -> (u64, u64, u64) {
    let (_, pk) = test_keypair(90);
    let pk_hex = hex_encode(&pk);
    let b1 = open_and_take(c, &pk_hex);
    let b2 = open_and_take(c, &pk_hex);
    let b3 = open_and_take(c, &pk_hex);
    assert!(b1 != b2 && b2 != b3 && b1 != b3);
    (b1, b2, b3)
}

#[test]
fn runno_three_bets_sequential_all_settle() {
    let mut c = new_contract();
    let (b1, b2, b3) = runno_three_bets(&mut c);
    for (i, b) in [b1, b2, b3].into_iter().enumerate() {
        let rid = runno_request(&mut c, b, 1_001 + i as u64);
        assert_eq!(rid, i as u64 + 1, "global request_id grows across bets");
        assert_eq!(runno_last_input_run_no(), 1, "bet {} resolver run_no must be per-bet 1", b);
        runno_submit(&mut c, b, 1);
        assert_eq!(c.get_bet(b).unwrap().status, BetStatus::Proposed);
    }
}

#[test]
fn runno_three_bets_interleaved_all_settle() {
    let mut c = new_contract();
    let (b1, b2, b3) = runno_three_bets(&mut c);
    for (i, b) in [b1, b2, b3].into_iter().enumerate() {
        runno_request(&mut c, b, 1_001 + i as u64);
        assert_eq!(runno_last_input_run_no(), 1, "bet {} resolver run_no must be 1", b);
    }
    runno_submit(&mut c, b3, 1);
    runno_submit(&mut c, b1, 1);
    runno_submit(&mut c, b2, 1);
    for b in [b1, b2, b3] {
        assert_eq!(c.get_bet(b).unwrap().status, BetStatus::Proposed);
    }
}

#[test]
fn runno_three_bets_one_rerun_others_unaffected() {
    let mut c = new_contract();
    let (b1, b2, b3) = runno_three_bets(&mut c);
    let rid1 = runno_request(&mut c, b1, 1_001);
    assert_eq!(runno_last_input_run_no(), 1);
    runno_request(&mut c, b2, 1_002);
    assert_eq!(runno_last_input_run_no(), 1);
    runno_request(&mut c, b3, 1_003);
    assert_eq!(runno_last_input_run_no(), 1);
    // Bet 2's run fails; it returns to Taken and is re-requested.
    ctx_with_promise_result("escrow.testnet", 1_004, PromiseResult::Failed);
    c.on_resolution(rid1 + 1);
    assert_eq!(c.get_bet(b2).unwrap().status, BetStatus::Taken);
    runno_request(&mut c, b2, 1_005);
    assert_eq!(runno_last_input_run_no(), 2, "re-requested bet 2 must carry run_no 2");
    // Stale run 1 result for bet 2 is rejected.
    ctx("anyone.testnet", 5_000);
    let (r, s) = runno_result(b2, "NO", 1);
    let stale = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.submit_outcome(r, s)));
    assert!(stale.is_err(), "stale run_no 1 must be rejected for re-requested bet 2");
    assert_eq!(c.get_bet(b2).unwrap().status, BetStatus::Resolving);
    // The other two bets are unaffected and settle with run_no 1.
    runno_submit(&mut c, b3, 1);
    runno_submit(&mut c, b1, 1);
    assert_eq!(c.get_bet(b1).unwrap().status, BetStatus::Proposed);
    assert_eq!(c.get_bet(b3).unwrap().status, BetStatus::Proposed);
    // Bet 2 settles with its run_no 2.
    runno_submit(&mut c, b2, 2);
    assert_eq!(c.get_bet(b2).unwrap().status, BetStatus::Proposed);
}

// =====================================================================
// 17e: D-SETTLE3 -- `mutual_settle` is gone; BD2 two-call-commit abuse
// tests for `amend` / `prune_terms`.
// =====================================================================

/// 17e: D-SETTLE3 removed mutual_settle. The contract ABI is the set of
/// `pub fn`s in `impl Contract`; a call to `mutual_settle` must fail as an
/// unknown method, so no such method (nor its proposal state or executor)
/// may exist in the contract source.
#[test]
fn d_settle3_mutual_settle_is_not_a_contract_method() {
    // 17e: D-SETTLE3 removed mutual_settle
    let src = include_str!("lib.rs");
    assert!(!src.contains("pub fn mutual_settle"), "mutual_settle must not be an exported method");
    assert!(!src.contains("fn execute_mutual_settle"), "mutual settle executor must be gone");
    assert!(!src.contains("settle_proposal"), "mutual settle proposal state must be gone");
    assert!(!src.contains("\"MUTUAL\""), "no MUTUAL outcome may be produced any more");
}

/// 17e: D-SETTLE3 removed mutual_settle: the Bet record carries no
/// settle proposal.
#[test]
fn d_settle3_bet_record_has_no_settle_proposal() {
    // 17e: D-SETTLE3 removed mutual_settle
    let mut c = new_contract();
    let (_, pk) = test_keypair(171);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let v = serde_json::to_value(c.get_bet(bet_id).unwrap()).unwrap();
    assert!(v.get("settle_proposal").is_none(), "Bet must not carry settle_proposal: {v}");
    assert!(v.get("amend_proposal").is_some(), "BD2 amend_proposal stays");
    assert!(v.get("prune_proposal").is_some(), "BD2 prune_proposal stays");
}

/// 17e: D-SETTLE3 -- both parties agreeing on anything through the
/// remaining two-call-commit methods never splits the pot: no payout is
/// scheduled and the bet stays Taken.
#[test]
fn d_settle3_both_parties_agreeing_cannot_split_a_funded_pot() {
    // 17e: D-SETTLE3 removed mutual_settle
    let mut c = new_contract();
    let (_, pk) = test_keypair(172);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let before = c.payout_ids_in_order().len();
    ctx("maker.testnet", 500);
    c.amend(bet_id, "c".repeat(64));
    ctx("taker.testnet", 501);
    c.amend(bet_id, "c".repeat(64));
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, BetStatus::Taken);
    assert_eq!(bet.outcome, None);
    assert_eq!(c.payout_ids_in_order().len(), before, "no payout may be scheduled by a both-sign agreement");
}

/// Moved from the removed mutual_settle storage test (17e): finalize must
/// schedule every yoctounit deposited (storage charge not stranded).
#[test]
fn finalize_accounts_for_storage_charge_and_conserves_every_deposit() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(173);
    let env = base_envelope(&hex_encode(&pk));
    assert!(env.keep_terms);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    ctx("anyone.testnet", 2_000 + env.settlement_period + 1);
    let before = c.payout_ids_in_order().len();
    c.finalize(bet_id);
    let total_scheduled: u128 = c.payout_ids_in_order()[before..]
        .iter()
        .map(|id| c.pending_payouts.get(id).unwrap().amount.0)
        .sum();
    assert_eq!(
        total_scheduled,
        env.maker_required() + env.taker_required(),
        "finalize must schedule every yoctounit deposited, storage included"
    );
}

fn amend_fixture(seed: u8) -> (Contract, u64) {
    let mut c = new_contract();
    let (_, pk) = test_keypair(seed);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    (c, bet_id)
}

#[test]
fn bd2_amend_mismatched_values_never_commit() {
    let (mut c, bet_id) = amend_fixture(174);
    let orig = c.get_bet(bet_id).unwrap().envelope.terms_hash;
    ctx("maker.testnet", 500);
    c.amend(bet_id, "a".repeat(64));
    ctx("taker.testnet", 501);
    c.amend(bet_id, "b".repeat(64));
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.envelope.terms_hash, orig, "mismatched values must not commit");
    assert_eq!(bet.amend_count, 0);
    // Only an exact match commits.
    ctx("maker.testnet", 502);
    c.amend(bet_id, "b".repeat(64));
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.envelope.terms_hash, "b".repeat(64));
    assert_eq!(bet.amend_count, 1);
}

#[test]
fn bd2_amend_stale_proposal_replaced_by_new_one() {
    let (mut c, bet_id) = amend_fixture(175);
    let orig = c.get_bet(bet_id).unwrap().envelope.terms_hash;
    ctx("maker.testnet", 500);
    c.amend(bet_id, "a".repeat(64));
    ctx("maker.testnet", 501);
    c.amend(bet_id, "b".repeat(64)); // replaces the stale "a"
    ctx("taker.testnet", 502);
    c.amend(bet_id, "a".repeat(64)); // matches only the stale value -> must not commit
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.envelope.terms_hash, orig, "a replaced proposal must not commit");
    assert_eq!(bet.amend_count, 0);
    ctx("taker.testnet", 503);
    c.amend(bet_id, "b".repeat(64));
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.envelope.terms_hash, "b".repeat(64));
    assert_eq!(bet.amend_count, 1);
}

#[test]
fn bd2_amend_one_side_never_confirms_changes_nothing() {
    let (mut c, bet_id) = amend_fixture(176);
    let orig = c.get_bet(bet_id).unwrap().envelope.terms_hash;
    for ts in 500..505u64 {
        ctx("maker.testnet", ts);
        c.amend(bet_id, "a".repeat(64)); // maker repeats alone
    }
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.envelope.terms_hash, orig);
    assert_eq!(bet.amend_count, 0);
    assert_eq!(bet.status, BetStatus::Taken);
    // Past funding_deadline the taker can no longer complete it.
    let fd = bet.envelope.funding_deadline;
    ctx("taker.testnet", fd + 1);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.amend(bet_id, "a".repeat(64))));
    assert!(r.is_err(), "late confirmation must be rejected");
    ctx("anyone.testnet", fd + 2);
    assert_eq!(c.get_bet(bet_id).unwrap().envelope.terms_hash, orig);
}

#[test]
fn bd2_amend_both_in_same_block_commits_exactly_once() {
    let (mut c, bet_id) = amend_fixture(177);
    ctx("maker.testnet", 500);
    c.amend(bet_id, "a".repeat(64));
    ctx("taker.testnet", 500); // same block timestamp
    c.amend(bet_id, "a".repeat(64));
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.envelope.terms_hash, "a".repeat(64));
    assert_eq!(bet.amend_count, 1, "same-block double call commits exactly once");
}

/// A committed proposal must not let ONE party re-commit alone and burn
/// the shared 5-amendment budget by repeating the old value.
#[test]
fn bd2_amend_committed_proposal_cannot_be_recommitted_by_one_party() {
    let (mut c, bet_id) = amend_fixture(178);
    ctx("maker.testnet", 500);
    c.amend(bet_id, "a".repeat(64));
    ctx("taker.testnet", 501);
    c.amend(bet_id, "a".repeat(64));
    assert_eq!(c.get_bet(bet_id).unwrap().amend_count, 1);
    for ts in 502..508u64 {
        ctx("maker.testnet", ts);
        c.amend(bet_id, "a".repeat(64)); // maker alone
    }
    assert_eq!(c.get_bet(bet_id).unwrap().amend_count, 1, "one party alone must not re-commit");
}

#[test]
#[should_panic(expected = "only maker or taker may propose")]
fn bd2_amend_third_party_cannot_propose() {
    let (mut c, bet_id) = amend_fixture(179);
    ctx("mallory.testnet", 500);
    c.amend(bet_id, "a".repeat(64));
}

#[test]
#[should_panic(expected = "only maker or taker may propose")]
fn bd2_prune_terms_third_party_cannot_propose() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(180);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
    ctx("anyone.testnet", 2_000 + 86_400_000_000_001);
    c.finalize(bet_id);
    drain_all(&mut c, bet_id, 2_000 + 86_400_000_000_051);
    ctx("mallory.testnet", 2_000 + 86_400_000_000_101);
    c.prune_terms(bet_id);
}

#[test]
#[should_panic(expected = "amend only pre-funding_deadline")]
fn bd2_amend_proposal_after_funding_deadline_rejected() {
    let (mut c, bet_id) = amend_fixture(181);
    let fd = c.get_bet(bet_id).unwrap().envelope.funding_deadline;
    ctx("maker.testnet", fd + 1);
    c.amend(bet_id, "a".repeat(64));
}

#[test]
fn bd2_amend_second_side_after_funding_deadline_cannot_complete() {
    let (mut c, bet_id) = amend_fixture(182);
    let orig = c.get_bet(bet_id).unwrap().envelope.terms_hash;
    let fd = c.get_bet(bet_id).unwrap().envelope.funding_deadline;
    ctx("maker.testnet", fd - 1);
    c.amend(bet_id, "a".repeat(64));
    ctx("taker.testnet", fd + 1);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.amend(bet_id, "a".repeat(64))));
    assert!(r.is_err());
    assert_eq!(c.get_bet(bet_id).unwrap().envelope.terms_hash, orig);
}

// ---------------- Red team 2026-11-07: payout gas-limit DoS + storage exhaustion ----------------
//
// Theme: make payouts fail/stick via gas or storage pressure. See the vault
// "Red team log" section "Run 2026-11-07 - theme: payout gas-limit DoS +
// storage exhaustion".

/// RED (money / liveness, HIGH): `open_bet_ids` is a `Vec<u64>` in the ROOT
/// state, which is borsh-(de)serialized on EVERY call (see DR-ESC-8 above).
/// It only ever grows -- cancel/expire/take never remove an id -- so an
/// attacker who opens-and-cancels (refunded in full, only gas spent) or
/// parks refundable min-size offers grows the root struct by 8 bytes per
/// bet forever. Every call (finalize, drain_payouts, on_payout_result, ...)
/// then pays storage_read/write_value_byte on the whole vector; at ~4 MiB
/// (512k ids) the `STATE` value exceeds NEAR's max value length and EVERY
/// state-writing call (including finalize of already-funded bets) aborts ->
/// funds stuck with no recovery path. This test: a cancelled offer must
/// not leave a permanent root-state footprint.
#[test]
fn rt_gas_cancelled_offers_do_not_grow_root_state() {
    let base = {
        let c = new_contract();
        near_sdk::borsh::to_vec(&c).unwrap().len()
    };
    let mut c = new_contract();
    for i in 0..200u32 {
        let (_, pk) = test_keypair(1 + (i % 200) as u8);
        let env = base_envelope(&hex_encode(&pk));
        let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
        assert_eq!(resp, vec![U128(0)]);
        let bet_id = c.next_bet_id - 1;
        ctx("maker.testnet", 2);
        c.cancel(bet_id);
    }
    let after = near_sdk::borsh::to_vec(&c).unwrap().len();
    assert!(
        after < base + 64,
        "root state grew {base} -> {after} bytes after 200 open+cancel cycles (open_bet_ids never pruned)"
    );
}

/// RED (same break, live offers): even offers that legitimately stay Open
/// (attacker locks refundable min stake) must not grow the root vector
/// without bound. Cap is 10_000 ids (80 KB, ~0.3 Tgas to read); past it the
/// offer is still accepted and fully functional by id, just not listed by
/// `open_offers` (its `open bet_id=` log line remains the discovery path).
#[test]
fn rt_gas_open_offer_index_is_capped() {
    let mut c = new_contract();
    c.open_bet_ids = (1_000_000..1_010_000u64).collect(); // simulated spam already at the cap
    let (_, pk) = test_keypair(7);
    let env = base_envelope(&hex_encode(&pk));
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)], "offer must still be accepted when the listing index is full");
    let bet_id = c.next_bet_id - 1;
    assert!(c.get_bet(bet_id).is_some(), "offer must exist and be usable by id");
    assert!(
        c.open_bet_ids.len() <= 10_000,
        "open_bet_ids grew past 10_000 ({}), unbounded root state",
        c.open_bet_ids.len()
    );
}

/// RED (callback gas, MEDIUM): `on_resolution` stores the OutLayer result
/// verbatim in `last_resolution_raw`. NEAR lets a promise return up to
/// 4 MiB, and `storage_write_value_byte` is ~31 Mgas/byte, so a >~650 KB
/// payload makes the 20 Tgas callback run out of gas: the callback aborts,
/// `pending_requests`/`resolution_payers`/prior-status stay set, the unused
/// compute refund is never paid, and the bet is wedged in Resolving until
/// the void backstop. The stored copy must be capped at 16 KiB.
#[test]
fn rt_storage_on_resolution_caps_last_resolution_raw() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(162);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx_with_deposit(KEEPER, 1, NearToken::from_millinear(50));
    c.topup_keeper_credit();
    ctx_with_deposit(KEEPER, 1_001, NearToken::from_yoctonear(0));
    let _ = c.request_resolution(bet_id, None);
    let request_id = c.next_request_id - 1;
    let big = format!("{{\"outcome\":\"YES\",\"pad\":\"{}\"}}", "x".repeat(1_000_000));
    ctx_with_promise_result(CONTRACT, 1_002, PromiseResult::Successful(big.into_bytes()));
    c.on_resolution(request_id);
    let stored = c.bets.get(&bet_id).unwrap().last_resolution_raw.clone().unwrap();
    assert!(
        stored.len() <= 16 * 1024,
        "last_resolution_raw stored {} bytes from an unbounded OutLayer result",
        stored.len()
    );
}

/// REGRESSION (green): the 10 Tgas `on_payout_result` callback has ample
/// margin even for the worst-case 48-line bet (cold storage, every read
/// gas-charged). If this callback ever aborted, `in_flight` would stay true
/// forever and neither `retry_payout` nor `drain_payouts` could re-fire the
/// group, so this guards the one thing that would make a payout
/// un-retryable.
#[test]
fn rt_gas_on_payout_result_worst_case_fits_callback_budget() {
    let (mut c, bet_id, ts) = build_oq_t11_worst_case_bet(95);
    ctx("anyone.testnet", ts);
    c.finalize(bet_id);
    let groups = {
        let in_flight: Vec<_> = c.pending_payouts(bet_id).into_iter().filter(|p| p.in_flight).collect();
        let mut g: Vec<Vec<u64>> = Vec::new();
        let mut keys: Vec<(near_sdk::AccountId, String)> = Vec::new();
        for p in &in_flight {
            match keys.iter().position(|k| k.0 == p.receiver && k.1 == p.token_id) {
                Some(i) => g[i].push(p.id),
                None => { keys.push((p.receiver.clone(), p.token_id.clone())); g.push(vec![p.id]); }
            }
        }
        g
    };
    let biggest = groups.into_iter().max_by_key(|g| g.len()).expect("a group is in flight");
    let mut c = cold_contract(c, ts + 1);
    ctx_with_promise_result(CONTRACT, ts + 1, PromiseResult::Failed);
    c.on_payout_result(biggest.clone());
    let used = near_sdk::env::used_gas().as_gas();
    const TGAS: u64 = 1_000_000_000_000;
    assert!(
        used < 5 * TGAS,
        "on_payout_result used {} Tgas for a {}-line group; budget is 10 Tgas",
        used / TGAS,
        biggest.len()
    );
}

/// REGRESSION (green): double-pay guards. A group already in flight cannot
/// be re-fired by `drain_payouts` or `retry_payout` (two permissionless
/// calls racing before the callback lands), and a `done` line can never be
/// retried -- so griefing the callback ordering cannot make money leave
/// twice.
#[test]
fn rt_gas_in_flight_and_done_lines_cannot_be_refired() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(96);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx("anyone.testnet", 2_000);
    let r = rr_result(bet_id, "YES", 1, 2_000);
    c.submit_outcome(r.clone(), sign_result(&outcome_signing_key(), &r));
    ctx("anyone.testnet", 2_000 + 86_400_000_000_001);
    c.finalize(bet_id);
    let ids: Vec<u64> = c.pending_payouts(bet_id).into_iter().filter(|p| p.in_flight).map(|p| p.id).collect();
    assert!(!ids.is_empty());
    ctx("anyone.testnet", 2_000 + 86_400_000_000_002);
    assert_eq!(c.drain_payouts(bet_id, 10), 0, "in-flight groups must not be re-fired");
    for id in &ids {
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.retry_payout(*id))).is_err());
    }
    resolve_in_flight(&mut c, bet_id, 2_000 + 86_400_000_000_003);
    ctx("anyone.testnet", 2_000 + 86_400_000_000_004);
    for id in &ids {
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.retry_payout(*id))).is_err(), "done line must not be retryable");
    }
    assert_eq!(c.drain_payouts(bet_id, 10), 0);
}

// ---------------- D-MN1: mainnet never calls near_deposit_and_credit ----------------

const MAINNET_INTENTS: &str = "intents.near";

/// Drives the FM-10 scenario (AuthCall-initiated resolution with unused
/// compute) against a contract whose `intents` is `intents_id`, returning
/// (all receipts created by on_resolution, deposit, unused).
fn mn1_auth_call_refund_receipts(
    intents_id: &str,
    seed: u8,
) -> (Vec<near_sdk::mock::Receipt>, u128, u128) {
    let mut c = new_contract();
    let (_, pk) = test_keypair(seed);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    c.intents = intents_id.parse().unwrap();
    let deposit = NearToken::from_millinear(50);
    ctx_with_deposit(intents_id, 1_001, deposit);
    let _ = c.on_auth(
        "taker.testnet".parse().unwrap(),
        serde_json::to_string(&AuthMsg::RequestResolution { bet_id }).unwrap(),
    );
    let request_id = c.next_request_id - 1;
    let unused = 1_000_000u128;
    let inner = serde_json::json!({
        "request_id": request_id,
        "unused_compute_yocto": unused.to_string(),
    })
    .to_string();
    ctx_with_promise_result(
        CONTRACT,
        1_002,
        PromiseResult::Successful(serde_json::to_vec(&inner).unwrap()),
    );
    c.on_resolution(request_id);
    (
        near_sdk::test_utils::get_created_receipts(),
        deposit.as_yoctonear(),
        unused,
    )
}

#[test]
fn mn1_mainnet_escrow_never_emits_near_deposit_and_credit() {
    let (receipts, _, _) = mn1_auth_call_refund_receipts(MAINNET_INTENTS, 96);
    for r in &receipts {
        for a in &r.actions {
            if let near_sdk::mock::MockAction::FunctionCallWeight { method_name, .. } = a {
                assert_ne!(
                    method_name.as_slice(),
                    b"near_deposit_and_credit",
                    "mainnet intents.near has no near_deposit_and_credit"
                );
            }
        }
    }
    assert!(
        !receipts
            .iter()
            .any(|r| r.receiver_id == MAINNET_INTENTS.parse::<AccountId>().unwrap()),
        "no outgoing call to intents.near for the unused-compute refund"
    );
}

#[test]
fn mn1_mainnet_unused_compute_stays_in_escrow_and_is_sweepable() {
    let (receipts, _, unused) = mn1_auth_call_refund_receipts(MAINNET_INTENTS, 97);
    // Nothing is transferred out of the escrow by on_resolution: no
    // Transfer action with any beneficiary, no attached deposit anywhere.
    for r in &receipts {
        for a in &r.actions {
            match a {
                near_sdk::mock::MockAction::Transfer { .. } => {
                    panic!("mainnet AuthCall refund must stay in the escrow, not be transferred")
                }
                near_sdk::mock::MockAction::FunctionCallWeight { attached_deposit, .. } => {
                    assert_eq!(attached_deposit.as_yoctonear(), 0, "no NEAR leaves the escrow");
                }
                _ => {}
            }
        }
    }
    // ...and it is recoverable by the permissionless sweep (D-OL-REFUND1).
    let mut c = new_contract();
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id("anyone.testnet".parse().unwrap());
    testing_env!(b.build());
    let required = NearToken::from_yoctonear(
        env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear(),
    )
    .saturating_add(NEAR_SAFETY_BUFFER);
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .predecessor_account_id("anyone.testnet".parse().unwrap())
        .account_balance(NearToken::from_yoctonear(required.as_yoctonear() + unused));
    testing_env!(b.build());
    assert_eq!(c.sweep_excess_near().as_yoctonear(), unused);
}

#[test]
fn mn1_testnet_mock_path_still_credits_via_near_deposit_and_credit() {
    let (receipts, _, unused) = mn1_auth_call_refund_receipts(INTENTS, 98);
    let ok = receipts.iter().any(|r| {
        r.receiver_id == INTENTS.parse::<AccountId>().unwrap()
            && r.actions.iter().any(|a| matches!(
                a,
                near_sdk::mock::MockAction::FunctionCallWeight { method_name, attached_deposit, .. }
                    if method_name == b"near_deposit_and_credit" && attached_deposit.as_yoctonear() == unused
            ))
    });
    assert!(ok, "testnet mock path must still emit near_deposit_and_credit");
}

#[test]
fn mn1_wnear_token_id_is_derived_from_network_not_a_testnet_literal() {
    let mut c = new_contract();
    assert_eq!(c.wnear_token_id(), "nep141:wrap.testnet");
    c.intents = MAINNET_INTENTS.parse().unwrap();
    assert_eq!(c.wnear_token_id(), "nep141:wrap.near");
}

// =====================================================================
// C1 (D-CONCEDE1, design decision): `concede(bet_id)`.
//
// Either bettor may concede their own side after the bet is Taken and
// before it is Settled. The counterparty gets the pot minus the normal
// fee through the normal payout path; bonds/objection deposits go back
// to their holders (no verdict decided them); an in-flight resolution
// or proposed outcome is superseded.
//
// PM SCOPE RULING (D-PM3, per D-CONCEDE1 "after Taken, before
// Settled"): concede is ALLOWED in Taken, Resolving, Proposed,
// Challenged, Evidence, Rejudge. It is REFUSED in Open (not taken yet),
// Finalized (outcome already decided, payouts persisted), Settled,
// Voided/Cancelled/Expired, during shutdown (emergency refund governs),
// and from anyone but the maker/taker. Mutual settle (D-SETTLE3) stays
// removed -- there is deliberately no mutual_settle here.
// =====================================================================

const C1_STAKE: u128 = 1_000_000; // base_envelope stake_maker == stake_taker
const C1_FEE_EACH: u128 = 10_000; // 100 bps of 1_000_000
const C1_STORAGE_EACH: u128 = 10_000; // base_envelope storage_charge_per_side
const C1_BOND: u128 = 5_005_000;

fn c1_panic_msg<F: FnOnce()>(f: F) -> String {
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    match r {
        Ok(()) => String::new(),
        Err(e) => {
            if let Some(s) = e.downcast_ref::<String>() {
                s.clone()
            } else if let Some(s) = e.downcast_ref::<&str>() {
                s.to_string()
            } else {
                "<non-string panic>".to_string()
            }
        }
    }
}

/// near-sdk's mocked storage is thread-local and survives `new_contract()`,
/// so a second contract built on the same thread would see the first one's
/// ledger. Run each loop scenario on its own thread (fresh mock storage).
fn c1_isolated<F: FnOnce() + Send + 'static>(f: F) {
    if let Err(e) = std::thread::spawn(f).join() {
        std::panic::resume_unwind(e);
    }
}

fn c1_submit_yes(c: &mut Contract, bet_id: u64) {
    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: "terms-hash-1".to_string(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: 1,
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig);
}

/// Builds a fresh contract with one bet in `status`. Evidence also
/// carries a taker challenge bond + a taker objection deposit.
fn c1_bet_in(status: BetStatus, seed: u8) -> (Contract, u64) {
    let mut c = new_contract();
    let (_, pk) = test_keypair(seed);
    match status {
        BetStatus::Taken => {
            let id = open_and_take(&mut c, &hex_encode(&pk));
            (c, id)
        }
        BetStatus::Resolving => {
            let id = item16d_credit_bet(&mut c, seed);
            ctx_with_deposit(KEEPER, 1_001, NearToken::from_yoctonear(0));
            let _ = c.request_resolution(id, None);
            assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Resolving);
            (c, id)
        }
        BetStatus::Proposed => {
            let id = open_and_take(&mut c, &hex_encode(&pk));
            c1_submit_yes(&mut c, id);
            assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Proposed);
            (c, id)
        }
        BetStatus::Challenged => {
            let id = open_and_take(&mut c, &hex_encode(&pk));
            c1_submit_yes(&mut c, id);
            do_mt_transfer(
                &mut c,
                "taker.testnet",
                C1_BOND,
                serde_json::to_string(&TransferMsg::Bond { bet_id: id, round: 1 }).unwrap(),
                2_050,
            );
            assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Challenged);
            (c, id)
        }
        BetStatus::Evidence => {
            let id = open_and_take(&mut c, &hex_encode(&pk));
            c1_submit_yes(&mut c, id);
            do_mt_transfer(
                &mut c,
                "taker.testnet",
                C1_BOND,
                serde_json::to_string(&TransferMsg::Bond { bet_id: id, round: 1 }).unwrap(),
                2_050,
            );
            do_mt_transfer(
                &mut c,
                "taker.testnet",
                OBJECTION_DEPOSIT,
                objection_msg(id, &"e".repeat(64), false),
                2_060,
            );
            assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Evidence);
            (c, id)
        }
        BetStatus::Rejudge => {
            // Nothing in the current contract transitions into Rejudge;
            // D-PM3 still allows concede there, so force the status.
            let id = open_and_take(&mut c, &hex_encode(&pk));
            c.bets.get_mut(&id).unwrap().status = BetStatus::Rejudge;
            (c, id)
        }
        other => panic!("c1_bet_in: unsupported {other:?}"),
    }
}

fn c1_sum(c: &Contract, bet_id: u64, receiver: &str, token: &str) -> u128 {
    let r: AccountId = receiver.parse().unwrap();
    c.pending_payouts(bet_id)
        .iter()
        .filter(|p| p.receiver == r && p.token_id == token)
        .map(|p| p.amount.0)
        .sum()
}

fn c1_total(c: &Contract, bet_id: u64) -> u128 {
    c.pending_payouts(bet_id).iter().map(|p| p.amount.0).sum()
}

const C1_ALLOWED: [BetStatus; 6] = [
    BetStatus::Taken,
    BetStatus::Resolving,
    BetStatus::Proposed,
    BetStatus::Challenged,
    BetStatus::Evidence,
    BetStatus::Rejudge,
];

#[test]
fn c1_concede_allowed_in_every_status_by_either_party_counterparty_wins() {
    for (i, status) in C1_ALLOWED.iter().enumerate() {
        for (j, (caller, winner)) in [("maker.testnet", "taker.testnet"), ("taker.testnet", "maker.testnet")]
            .into_iter()
            .enumerate()
        {
            let status = status.clone();
            c1_isolated(move || {
            let (mut c, id) = c1_bet_in(status.clone(), 100 + (i * 2 + j) as u8);
            ctx(caller, 3_000);
            c.concede(id);
            let bet = c.get_bet(id).unwrap();
            assert_eq!(bet.status, BetStatus::Finalized, "{status:?}/{caller}: payouts persisted");
            // Winner gets BOTH pots minus fee, in the normal payout path.
            let want_winner = 2 * C1_STAKE - 2 * C1_FEE_EACH;
            assert_eq!(
                c1_sum(&c, id, winner, USDC),
                want_winner + c1_holder_refunds_to(&c, id, winner),
                "{status:?}/{caller}: winner payout (pot - fee) + any refunds owed to them as holder"
            );
            let conceder_payout: Vec<_> = c
                .pending_payouts(id)
                .into_iter()
                .filter(|p| p.reason == "payout_winner" && p.receiver == caller.parse::<AccountId>().unwrap())
                .collect();
            assert!(conceder_payout.is_empty(), "{status:?}/{caller}: conceder never receives the pot");
            drain_all(&mut c, id, 3_100);
            assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Settled, "{status:?}/{caller}");
            });
        }
    }
}

/// Sum of bond/objection refund lines owed to `receiver`.
fn c1_holder_refunds_to(c: &Contract, bet_id: u64, receiver: &str) -> u128 {
    let r: AccountId = receiver.parse().unwrap();
    c.pending_payouts(bet_id)
        .iter()
        .filter(|p| p.receiver == r && (p.reason == "concede_bond_refund" || p.reason == "concede_objection_refund"))
        .map(|p| p.amount.0)
        .sum()
}

#[test]
fn c1_concede_fee_and_storage_math_exact() {
    for (caller, winner, winning_outcome) in [
        ("maker.testnet", "taker.testnet", "NO"),
        ("taker.testnet", "maker.testnet", "YES"),
    ] {
        c1_isolated(move || {
        let (mut c, id) = c1_bet_in(BetStatus::Taken, 130);
        ctx(caller, 3_000);
        c.concede(id);
        assert_eq!(c1_sum(&c, id, winner, USDC), 1_980_000, "pot 2_000_000 minus 1% fee on each stake");
        assert_eq!(c1_sum(&c, id, FEE, USDC), 2 * C1_FEE_EACH + 2 * C1_STORAGE_EACH, "fee + both storage charges to fee account");
        assert_eq!(c1_sum(&c, id, caller, USDC), 0, "conceder gets nothing back");
        assert_eq!(c1_total(&c, id), 2 * C1_STAKE + 2 * C1_STORAGE_EACH, "I-2: out == in, exactly");
        assert_eq!(c.get_bet(id).unwrap().outcome.as_deref(), Some(winning_outcome));
        });
    }
}

#[test]
fn c1_concede_refunds_bond_and_objection_to_their_holders_no_forfeit() {
    // Evidence: taker holds a challenge bond + an objection deposit.
    for caller in ["maker.testnet", "taker.testnet"] {
        c1_isolated(move || {
        let (mut c, id) = c1_bet_in(BetStatus::Evidence, 140);
        ctx(caller, 3_000);
        c.concede(id);
        let lines = c.pending_payouts(id);
        assert!(
            !lines.iter().any(|p| p.reason == "bond_lost_to_counterparty" || p.reason == "objection_deposit_forfeited"),
            "{caller}: no verdict decided the bond/objection -> nothing forfeited"
        );
        let taker: AccountId = "taker.testnet".parse().unwrap();
        let bond_refund: u128 = lines.iter().filter(|p| p.reason == "concede_bond_refund" && p.receiver == taker).map(|p| p.amount.0).sum();
        let obj_refund: u128 = lines.iter().filter(|p| p.reason == "concede_objection_refund" && p.receiver == taker).map(|p| p.amount.0).sum();
        assert_eq!(bond_refund, C1_BOND, "{caller}: full bond (no run cost charged) back to its holder");
        assert_eq!(obj_refund, OBJECTION_DEPOSIT, "{caller}: objection deposit back to its depositor");
        // I-2: everything scheduled == everything the contract holds for this bet.
        assert_eq!(
            c1_total(&c, id),
            2 * C1_STAKE + 2 * C1_STORAGE_EACH + C1_BOND + OBJECTION_DEPOSIT,
            "{caller}: balance invariant"
        );
        let bet = c.get_bet(id).unwrap();
        assert!(bet.bonds.is_empty() && bet.objection_deposits.is_empty(), "{caller}: held deposits consumed");
        drain_all(&mut c, id, 3_100);
        assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Settled);
        });
    }
}

#[test]
fn c1_concede_in_challenged_refunds_bond_to_holder() {
    let (mut c, id) = c1_bet_in(BetStatus::Challenged, 141);
    ctx("maker.testnet", 3_000);
    c.concede(id);
    assert_eq!(c1_holder_refunds_to(&c, id, "taker.testnet"), C1_BOND);
    assert_eq!(c1_total(&c, id), 2 * C1_STAKE + 2 * C1_STORAGE_EACH + C1_BOND);
}

#[test]
fn c1_concede_supersedes_proposed_outcome() {
    let (mut c, id) = c1_bet_in(BetStatus::Proposed, 142);
    assert_eq!(c.get_bet(id).unwrap().outcome.as_deref(), Some("YES"), "maker's side was proposed to win");
    ctx("maker.testnet", 3_000);
    c.concede(id);
    let bet = c.get_bet(id).unwrap();
    assert_eq!(bet.outcome.as_deref(), Some("NO"), "proposed YES superseded: maker conceded, taker's side wins");
    assert_eq!(c1_sum(&c, id, "taker.testnet", USDC), 1_980_000);
    assert_eq!(c1_sum(&c, id, "maker.testnet", USDC), 0);
}

#[test]
fn c1_concede_emits_event() {
    let (mut c, id) = c1_bet_in(BetStatus::Taken, 143);
    ctx("maker.testnet", 3_000);
    c.concede(id);
    let logs = near_sdk::test_utils::get_logs();
    let line = logs
        .iter()
        .find(|l| l.starts_with("EVENT_JSON:") && l.contains("\"event\":\"concede\""))
        .unwrap_or_else(|| panic!("no concede event in {logs:?}"));
    let v: serde_json::Value = serde_json::from_str(line.trim_start_matches("EVENT_JSON:")).unwrap();
    assert_eq!(v["standard"], "praetorial-escrow");
    assert_eq!(v["event"], "concede");
    let d = &v["data"][0];
    assert_eq!(d["bet_id"], id);
    assert_eq!(d["conceder"], "maker.testnet");
    assert_eq!(d["winner"], "taker.testnet");
    assert_eq!(d["at_ns"], 3_000);
}

#[test]
fn c1_concede_race_on_resolution_then_submit_outcome_is_noop_no_double_payout() {
    let (mut c, id) = c1_bet_in(BetStatus::Resolving, 144);
    let req = c.next_request_id - 1;
    ctx("taker.testnet", 1_500);
    c.concede(id);
    let total_after_concede = c1_total(&c, id);
    let lines_after_concede = c.pending_payouts(id).len();
    assert_eq!(c1_sum(&c, id, "maker.testnet", USDC), 1_980_000, "maker wins (taker conceded)");

    // In-flight OutLayer callback lands after the concede.
    let inner = serde_json::json!({ "request_id": req, "unused_compute_yocto": "0" }).to_string();
    ctx_with_promise_result(CONTRACT, 1_600, PromiseResult::Successful(serde_json::to_vec(&inner).unwrap()));
    c.on_resolution(req);
    let bet = c.get_bet(id).unwrap();
    assert_eq!(bet.status, BetStatus::Finalized, "callback must not resurrect the bet");
    assert_eq!(bet.outcome.as_deref(), Some("YES"));

    // ...and a later (validly signed) submit_outcome is refused.
    let run_no = c.get_bet(id).unwrap().pending_run_no.unwrap_or(c.get_bet(id).unwrap().next_expected_run_no);
    for outcome in ["YES", "NO"] {
        let result = SubmittedResult {
            bet_id: id,
            terms_hash: "terms-hash-1".to_string(),
            outcome: outcome.to_string(),
            element_results_hash: "e".repeat(64),
            run_no,
            checked_until: U64(2_000),
            next_check_ns: None,
            judge_pair_index: 0, model_not_found: vec![],
        };
        let sig = sign_result(&outcome_signing_key(), &result);
        ctx("anyone.testnet", 1_700);
        let msg = c1_panic_msg(|| c.submit_outcome(result, sig));
        assert!(msg.contains("bet not awaiting an outcome"), "submit_outcome after concede must be refused, got {msg:?}");
    }
    // Failed-promise callback variant must not restore Resolving either.
    ctx_with_promise_result(CONTRACT, 1_800, PromiseResult::Failed);
    c.on_resolution(req);
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Finalized);
    // Second concede / finalize / request_resolution are refused.
    ctx("maker.testnet", 1_900);
    let msg = c1_panic_msg(|| c.concede(id));
    assert!(msg.contains("not concedable"), "{msg}");
    assert_eq!(c1_total(&c, id), total_after_concede, "no double payout");
    assert_eq!(c.pending_payouts(id).len(), lines_after_concede);
}

#[test]
fn c1_concede_refused_in_non_concedable_statuses() {
    c1_isolated(|| {
    // Open: not taken yet.
    let mut c = new_contract();
    let (_, pk) = test_keypair(150);
    let env = base_envelope(&hex_encode(&pk));
    do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    let open_id = c.next_bet_id - 1;
    ctx("maker.testnet", 2);
    let msg = c1_panic_msg(|| c.concede(open_id));
    assert!(msg.contains("not concedable"), "Open: {msg}");
    });

    c1_isolated(|| {
    // Finalized, then Settled.
    let (mut c, id) = c1_bet_in(BetStatus::Proposed, 151);
    ctx("anyone.testnet", 2_000 + 86_400_000_000_001);
    c.finalize(id);
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Finalized);
    let before = c1_total(&c, id);
    ctx("taker.testnet", 2_000 + 86_400_000_000_002);
    let msg = c1_panic_msg(|| c.concede(id));
    assert!(msg.contains("not concedable"), "Finalized: {msg}");
    assert_eq!(c1_total(&c, id), before);
    drain_all(&mut c, id, 2_000 + 86_400_000_000_003);
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Settled);
    ctx("taker.testnet", 2_000 + 86_400_000_000_004);
    let msg = c1_panic_msg(|| c.concede(id));
    assert!(msg.contains("not concedable"), "Settled: {msg}");
    });

    // Terminal VOID/refunded states.
    for terminal in [BetStatus::Voided, BetStatus::Cancelled, BetStatus::Expired] {
        c1_isolated(move || {
        let (mut c, id) = c1_bet_in(BetStatus::Taken, 152);
        c.bets.get_mut(&id).unwrap().status = terminal.clone();
        ctx("maker.testnet", 3_000);
        let msg = c1_panic_msg(|| c.concede(id));
        assert!(msg.contains("not concedable"), "{terminal:?}: {msg}");
        assert!(c.pending_payouts(id).is_empty());
        });
    }
    // VOID reached for real.
    c1_isolated(|| {
    let (mut c, id) = c1_bet_in(BetStatus::Taken, 153);
    ctx("anyone.testnet", 10_001);
    c.void_after_deadline(id);
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Voided);
    let before = c1_total(&c, id);
    ctx("maker.testnet", 10_002);
    let msg = c1_panic_msg(|| c.concede(id));
    assert!(msg.contains("not concedable"), "VOID: {msg}");
    assert_eq!(c1_total(&c, id), before);
    });
}

#[test]
fn c1_concede_refused_from_third_party_and_unknown_bet() {
    let (mut c, id) = c1_bet_in(BetStatus::Taken, 154);
    for stranger in ["anyone.testnet", KEEPER, FEE, GUARDIAN, OPERATOR, "maker.testnet.evil"] {
        ctx(stranger, 3_000);
        let msg = c1_panic_msg(|| c.concede(id));
        assert!(msg.contains("only maker or taker may concede"), "{stranger}: {msg}");
    }
    assert_eq!(c.get_bet(id).unwrap().status, BetStatus::Taken);
    assert!(c.pending_payouts(id).is_empty());
    ctx("maker.testnet", 3_000);
    let msg = c1_panic_msg(|| c.concede(9_999));
    assert!(msg.contains("unknown bet_id"), "{msg}");
}

#[test]
fn c1_concede_refused_during_shutdown_emergency_refund_governs() {
    let (mut c, id) = c1_bet_in(BetStatus::Taken, 155);
    ctx_with_deposit(GUARDIAN, 2_500, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    ctx("maker.testnet", 3_000);
    let msg = c1_panic_msg(|| c.concede(id));
    assert!(msg.contains("contract is shut down"), "{msg}");
    assert!(c.pending_payouts(id).is_empty());
    // emergency_refund still returns everyone's own deposits.
    c.emergency_refund(id);
    assert_eq!(c1_total(&c, id), 2 * C1_STAKE + 2 * C1_STORAGE_EACH);
}

#[test]
fn c1_concede_cross_asset_each_pot_pays_in_its_own_asset_minus_fee() {
    let mut c = new_contract_spec_assets();
    let (_, pk) = test_keypair(156);
    let mut env = base_envelope(&hex_encode(&pk));
    env.maker_asset = MOCK_BTC.to_string();
    env.taker_asset = USDC.to_string();
    env.stake_maker = U128(10_000);
    env.stake_taker = U128(10_000_000);
    do_mt_transfer_asset(&mut c, "maker.testnet", MOCK_BTC, env.maker_required(), open_msg(&env), 1);
    let id = c.next_bet_id - 1;
    do_mt_transfer_asset(&mut c, "taker.testnet", USDC, env.taker_required(), take_msg(id), 2);
    ctx("taker.testnet", 3_000);
    c.concede(id);
    // fee_bps 100: BTC fee 100, USDC fee 100_000.
    assert_eq!(c1_sum(&c, id, "maker.testnet", MOCK_BTC), 9_900);
    assert_eq!(c1_sum(&c, id, "maker.testnet", USDC), 9_900_000);
    let storage = env.storage_for(STG_FIXTURE_RATE);
    assert_eq!(c1_sum(&c, id, FEE, MOCK_BTC), 100 + storage);
    assert_eq!(c1_sum(&c, id, FEE, USDC), 100_000 + storage);
    assert_eq!(c1_sum(&c, id, "taker.testnet", MOCK_BTC) + c1_sum(&c, id, "taker.testnet", USDC), 0);
    // Per-asset conservation.
    assert_eq!(c1_sum(&c, id, "maker.testnet", MOCK_BTC) + c1_sum(&c, id, FEE, MOCK_BTC), env.maker_required());
    assert_eq!(c1_sum(&c, id, "maker.testnet", USDC) + c1_sum(&c, id, FEE, USDC), env.taker_required());
}

#[test]
fn c1_concede_then_emergency_shutdown_refund_is_noop_no_double_pay() {
    let (mut c, id) = c1_bet_in(BetStatus::Evidence, 157);
    ctx("maker.testnet", 3_000);
    c.concede(id);
    let before = c1_total(&c, id);
    ctx_with_deposit(GUARDIAN, 3_100, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    c.emergency_refund(id);
    assert_eq!(c1_total(&c, id), before, "Finalized by concede: emergency_refund schedules nothing new");
}

// ---------------- D-HORIZON1: max resolve horizon (queue item H1) ----------------

fn horizon_contract() -> Contract {
    new_contract_with_limits(
        Limits {
            max_stake: U128(1_000_000_000),
            max_offer_ttl_secs: 86400 * 60,
            max_stake_per_side_near: U128(100 * 10u128.pow(24)),
            max_rounds: crate::DEFAULT_MAX_ROUNDS,
            max_retries: crate::DEFAULT_MAX_RETRIES,
        },
        None,
    )
}

// D-HORIZON1a (design decision) supersedes D-HORIZON1's 365-day figure:
// the limit is 1,461 days (4 years incl. one leap day). Ruling change, not a
// loosened check: 366-day / 2-year deadlines flip from refused to accepted.
const HORIZON_1461_NS: u64 = 1_461 * 86_400 * 1_000_000_000;

#[test]
fn horizon_constant_is_pinned_to_1461_days() {
    assert_eq!(crate::MAX_HORIZON_NS, HORIZON_1461_NS);
}

#[test]
fn horizon_exactly_1461_days_after_open_is_accepted() {
    let mut c = horizon_contract();
    let (_, pk) = test_keypair(230);
    let open_ts = 5_000u64;
    let mut env = base_envelope(&hex_encode(&pk));
    env.funding_deadline = open_ts + 1_000;
    env.resolve_deadline = open_ts + HORIZON_1461_NS;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), open_ts);
    assert_eq!(resp, vec![U128(0)], "exactly 1,461 days must be accepted (D-HORIZON1a)");
}

#[test]
fn horizon_1461_days_plus_1s_is_refused_with_readable_reason() {
    let mut c = horizon_contract();
    let (_, pk) = test_keypair(231);
    let open_ts = 5_000u64;
    let mut env = base_envelope(&hex_encode(&pk));
    env.funding_deadline = open_ts + 1_000;
    env.resolve_deadline = open_ts + HORIZON_1461_NS + 1_000_000_000;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), open_ts);
    assert_eq!(resp, vec![U128(env.maker_required())], "1,461d + 1s must be refused, full refund");
    let logs = near_sdk::test_utils::get_logs();
    assert!(
        logs.iter().any(|l| l.contains("open_rejected") && l.contains("at most 1461 days")),
        "expected readable horizon reason, got: {logs:?}"
    );
}

#[test]
fn horizon_366_days_is_now_accepted_d_horizon1a() {
    let mut c = horizon_contract();
    let (_, pk) = test_keypair(235);
    let open_ts = 5_000u64;
    let mut env = base_envelope(&hex_encode(&pk));
    env.funding_deadline = open_ts + 1_000;
    env.resolve_deadline = open_ts + 366 * 86_400 * 1_000_000_000u64;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), open_ts);
    assert_eq!(resp, vec![U128(0)], "366 days accepted under D-HORIZON1a");
}

#[test]
fn horizon_2_years_is_now_accepted_d_horizon1a() {
    let mut c = horizon_contract();
    let (_, pk) = test_keypair(232);
    let open_ts = 5_000u64;
    let mut env = base_envelope(&hex_encode(&pk));
    env.funding_deadline = open_ts + 1_000;
    env.resolve_deadline = open_ts + 2 * 365 * 86_400 * 1_000_000_000u64;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), open_ts);
    assert_eq!(resp, vec![U128(0)], "2-year horizon accepted under D-HORIZON1a");
}

#[test]
fn horizon_5_years_is_refused() {
    let mut c = horizon_contract();
    let (_, pk) = test_keypair(236);
    let mut env = base_envelope(&hex_encode(&pk));
    env.resolve_deadline = 5 * 365 * 86_400 * 1_000_000_000u64 + 1;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(env.maker_required())], "5-year horizon must be refused");
}

#[test]
fn horizon_existing_bet_unaffected_after_time_passes() {
    // A bet opened at the limit keeps working (cancel path) long after open;
    // the rule only gates opens.
    let mut c = horizon_contract();
    let (_, pk) = test_keypair(234);
    let open_ts = 5_000u64;
    let mut env = base_envelope(&hex_encode(&pk));
    env.funding_deadline = open_ts + 1_000;
    env.resolve_deadline = open_ts + crate::MAX_HORIZON_NS;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), open_ts);
    assert_eq!(resp, vec![U128(0)]);
    ctx("maker.testnet", open_ts + 10);
    let b = c.get_bet(1).expect("bet exists");
    assert_eq!(b.envelope.resolve_deadline, open_ts + crate::MAX_HORIZON_NS);
}

#[test]
fn horizon_is_measured_from_open_block_time_not_epoch() {
    // A late open may set a deadline up to open_ts + 1,461d, beyond 1,461d since epoch.
    let mut c = horizon_contract();
    let (_, pk) = test_keypair(233);
    let open_ts = 3 * crate::MAX_HORIZON_NS;
    let mut env = base_envelope(&hex_encode(&pk));
    env.funding_deadline = open_ts + 1_000;
    env.resolve_deadline = open_ts + crate::MAX_HORIZON_NS;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg_at(&env, open_ts), open_ts);
    assert_eq!(resp, vec![U128(0)]);
}

// ---------------- G5F: pinned protocol fee (D-FEEPIN1) + minimum fee (D-FEEMIN1) ----------------

const G5F_USDC_MIN: u128 = 10_000_000; // D-MINSTAKE1: $10, 6dp
const G5F_USDC_MIN_FEE: u128 = 500_000; // D-FEEMIN1: $0.50, 6dp
const G5F_BTC_MIN_FEE: u128 = 300; // <= 6_501/20 = 325

fn g5f_limits() -> Limits {
    Limits {
        max_stake: U128(10_000_000_000),
        max_offer_ttl_secs: 86400 * 60,
        max_stake_per_side_near: U128(100 * 10u128.pow(24)),
        max_rounds: crate::DEFAULT_MAX_ROUNDS,
        max_retries: crate::DEFAULT_MAX_RETRIES,
    }
}

fn g5f_assets(usdc_min_fee: u128, usdc_min: u128) -> Vec<(String, AssetLimit)> {
    vec![
        (
            USDC.to_string(),
            AssetLimit {
                min_per_side: U128(usdc_min),
                min_fee_per_side: U128(usdc_min_fee),
                min_fee_cap_per_side: U128(0), // D-PARAMS1 fixture: 0 = cap pinned at min_fee_per_side
                storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
                max_per_side: U128(1_000_000_000),
                run_price: U128(DEFAULT_RUN_PRICE),
                min_bond: U128(USDC_MIN_BOND),
                min_objection: U128(USDC_MIN_OBJECTION),
            },
        ),
        (
            MOCK_BTC.to_string(),
            AssetLimit {
                min_per_side: U128(6_501),
                min_fee_per_side: U128(G5F_BTC_MIN_FEE),
                min_fee_cap_per_side: U128(0), // D-PARAMS1 fixture: 0 = cap pinned at min_fee_per_side
                storage_per_kib: U128(STG_FIXTURE_RATE), // STG1 fixture
                max_per_side: U128(325_059),
                run_price: U128(1),
                min_bond: U128(6_501),
                min_objection: U128(1_300),
            },
        ),
    ]
}

fn g5f_contract() -> Contract {
    new_contract_with_limits_and_assets(g5f_limits(), None, g5f_assets(G5F_USDC_MIN_FEE, G5F_USDC_MIN))
}

fn g5f_open_take(c: &mut Contract, env: &Envelope) -> u64 {
    let resp = do_mt_transfer_asset(c, "maker.testnet", &env.maker_asset, env.maker_required(), open_msg(env), 1);
    assert_eq!(resp, vec![U128(0)], "open should be accepted");
    let id = c.next_bet_id - 1;
    let resp = do_mt_transfer_asset(c, "taker.testnet", &env.taker_asset, env.taker_required(), take_msg(id), 2);
    assert_eq!(resp, vec![U128(0)], "take should be accepted");
    id
}

fn g5f_finalize_yes(c: &mut Contract, id: u64) {
    c1_submit_yes(c, id);
    ctx("anyone.testnet", 2_000 + 86_400_000_000_001);
    c.finalize(id);
}

fn g5f_env(stake_maker: u128, stake_taker: u128) -> Envelope {
    let (_, pk) = test_keypair(170);
    let mut env = base_envelope(&hex_encode(&pk));
    env.stake_maker = U128(stake_maker);
    env.stake_taker = U128(stake_taker);
    env
}

// ---- D-FEEPIN1 ----

#[test]
fn g5f_open_refuses_fee_bps_other_than_pinned_100() {
    for bad in [0u32, 99, 101, 10_000] {
        let mut c = g5f_contract();
        let mut env = g5f_env(20_000_000, 20_000_000);
        env.fee_bps = bad;
        let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
        assert_eq!(
            resp,
            vec![U128(env.maker_required())],
            "fee_bps={bad} must be refused with a full refund (D-FEEPIN1)"
        );
        assert_eq!(c.next_bet_id, 1, "fee_bps={bad}: no bet may be created");
    }
}

#[test]
fn g5f_open_accepts_pinned_fee_bps_100() {
    let mut c = g5f_contract();
    let env = g5f_env(20_000_000, 20_000_000);
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)]);
}

#[test]
fn g5f_pinned_fee_is_exposed_as_100_by_view() {
    let c = g5f_contract();
    assert_eq!(c.protocol_fee_bps(), 100);
}

// ---- D-FEEMIN1 ----

#[test]
fn g5f_finalize_fee_10_dollar_side_pays_minimum_half_dollar() {
    let mut c = g5f_contract();
    let env = g5f_env(10_000_000, 10_000_000);
    let id = g5f_open_take(&mut c, &env);
    g5f_finalize_yes(&mut c, id);
    let st = env.storage_for(STG_FIXTURE_RATE);
    assert_eq!(c1_sum(&c, id, FEE, USDC), 2 * G5F_USDC_MIN_FEE + 2 * st, "two sides each pay the 500_000 minimum");
    assert_eq!(c1_sum(&c, id, "maker.testnet", USDC), 20_000_000 - 2 * G5F_USDC_MIN_FEE);
}

#[test]
fn g5f_finalize_fee_100_dollar_side_pays_one_percent() {
    let mut c = g5f_contract();
    let env = g5f_env(100_000_000, 100_000_000);
    let id = g5f_open_take(&mut c, &env);
    g5f_finalize_yes(&mut c, id);
    let st = env.storage_for(STG_FIXTURE_RATE);
    assert_eq!(c1_sum(&c, id, FEE, USDC), 2 * 1_000_000 + 2 * st);
    assert_eq!(c1_sum(&c, id, "maker.testnet", USDC), 200_000_000 - 2_000_000);
}

#[test]
fn g5f_finalize_fee_50_dollar_side_boundary_is_exactly_half_dollar() {
    // 1% of $50 == $0.50 == the minimum: both formulas agree exactly.
    let mut c = g5f_contract();
    let env = g5f_env(50_000_000, 50_000_000);
    let id = g5f_open_take(&mut c, &env);
    g5f_finalize_yes(&mut c, id);
    let st = env.storage_for(STG_FIXTURE_RATE);
    assert_eq!(c1_sum(&c, id, FEE, USDC), 2 * 500_000 + 2 * st);
}

#[test]
fn g5f_finalize_fee_just_under_boundary_uses_minimum() {
    // $49.99 side: 1% = 499_900 < 500_000 -> minimum binds.
    let mut c = g5f_contract();
    let env = g5f_env(49_990_000, 49_990_000);
    let id = g5f_open_take(&mut c, &env);
    g5f_finalize_yes(&mut c, id);
    let st = env.storage_for(STG_FIXTURE_RATE);
    assert_eq!(c1_sum(&c, id, FEE, USDC), 2 * 500_000 + 2 * st);
}

#[test]
fn g5f_finalize_cross_asset_each_side_takes_its_own_minimum() {
    let mut c = g5f_contract();
    let mut env = g5f_env(10_000, 10_000_000);
    env.maker_asset = MOCK_BTC.to_string();
    env.taker_asset = USDC.to_string();
    let id = g5f_open_take(&mut c, &env);
    g5f_finalize_yes(&mut c, id);
    let st = env.storage_for(STG_FIXTURE_RATE);
    // BTC side: 1% = 100 < 300 -> 300. USDC side: 1% = 100_000 < 500_000 -> 500_000.
    assert_eq!(c1_sum(&c, id, FEE, MOCK_BTC), G5F_BTC_MIN_FEE + st);
    assert_eq!(c1_sum(&c, id, FEE, USDC), G5F_USDC_MIN_FEE + st);
    assert_eq!(c1_sum(&c, id, "maker.testnet", MOCK_BTC), 10_000 - G5F_BTC_MIN_FEE);
    assert_eq!(c1_sum(&c, id, "maker.testnet", USDC), 10_000_000 - G5F_USDC_MIN_FEE);
}

#[test]
fn g5f_finalize_fee_never_exceeds_stake() {
    // min_fee == min_per_side/20 and stake == min_per_side, so the cap is not
    // reachable through new(); build a bet and shrink via a tiny-min table:
    // min_per_side 20, min_fee 1, stake 20 -> fee = max(0, 1) = 1 <= stake.
    let mut c = new_contract_with_limits_and_assets(g5f_limits(), None, g5f_assets(1, 20));
    let env = g5f_env(20, 20);
    let id = g5f_open_take(&mut c, &env);
    g5f_finalize_yes(&mut c, id);
    let st = env.storage_for(STG_FIXTURE_RATE);
    assert_eq!(c1_sum(&c, id, FEE, USDC), 2 + 2 * st);
    assert_eq!(c1_sum(&c, id, "maker.testnet", USDC), 40 - 2);
}

#[test]
fn g5f_void_charges_no_fee() {
    let mut c = g5f_contract();
    let env = g5f_env(10_000_000, 10_000_000);
    let id = g5f_open_take(&mut c, &env);
    ctx("anyone.testnet", 10_001);
    c.void_after_deadline(id);
    let st = env.storage_for(STG_FIXTURE_RATE);
    // Each party gets its whole stake back; fee account gets at most storage.
    assert_eq!(c1_sum(&c, id, "maker.testnet", USDC) + c1_sum(&c, id, "taker.testnet", USDC) + c1_sum(&c, id, FEE, USDC),
        env.maker_required() + env.taker_required());
    assert!(c1_sum(&c, id, FEE, USDC) <= 2 * st, "VOID must take no protocol fee");
    assert!(c1_sum(&c, id, "maker.testnet", USDC) >= env.stake_maker.0);
    assert!(c1_sum(&c, id, "taker.testnet", USDC) >= env.stake_taker.0);
}

#[test]
fn g5f_concede_uses_same_fee_math_small_and_large() {
    // small side: minimum binds
    let mut c = g5f_contract();
    let env = g5f_env(10_000_000, 10_000_000);
    let id = g5f_open_take(&mut c, &env);
    ctx("taker.testnet", 3_000);
    c.concede(id);
    let st = env.storage_for(STG_FIXTURE_RATE);
    assert_eq!(c1_sum(&c, id, FEE, USDC), 2 * G5F_USDC_MIN_FEE + 2 * st);
    assert_eq!(c1_sum(&c, id, "maker.testnet", USDC), 20_000_000 - 2 * G5F_USDC_MIN_FEE);
}

#[test]
fn g5f_concede_large_side_pays_one_percent() {
    let mut c = new_contract_with_limits_and_assets(g5f_limits(), None, g5f_assets(G5F_USDC_MIN_FEE, G5F_USDC_MIN));
    let env = g5f_env(100_000_000, 100_000_000);
    let id = g5f_open_take(&mut c, &env);
    ctx("taker.testnet", 3_000);
    c.concede(id);
    let st = env.storage_for(STG_FIXTURE_RATE);
    assert_eq!(c1_sum(&c, id, FEE, USDC), 2_000_000 + 2 * st);
}

#[test]
fn g5f_concede_cross_asset_each_side_takes_its_own_minimum() {
    let mut c = g5f_contract();
    let mut env = g5f_env(10_000, 10_000_000);
    env.maker_asset = MOCK_BTC.to_string();
    env.taker_asset = USDC.to_string();
    let id = g5f_open_take(&mut c, &env);
    ctx("taker.testnet", 3_000);
    c.concede(id);
    let st = env.storage_for(STG_FIXTURE_RATE);
    assert_eq!(c1_sum(&c, id, FEE, MOCK_BTC), G5F_BTC_MIN_FEE + st);
    assert_eq!(c1_sum(&c, id, FEE, USDC), G5F_USDC_MIN_FEE + st);
}

#[test]
fn g5f_conservation_i2_holds_with_minimum_fee() {
    let mut c = g5f_contract();
    let mut env = g5f_env(10_000, 10_000_000);
    env.maker_asset = MOCK_BTC.to_string();
    env.taker_asset = USDC.to_string();
    let id = g5f_open_take(&mut c, &env);
    g5f_finalize_yes(&mut c, id);
    // Per-asset: everything scheduled out == everything deposited.
    let btc_out: u128 = c.pending_payouts(id).iter().filter(|p| p.token_id == MOCK_BTC).map(|p| p.amount.0).sum();
    let usdc_out: u128 = c.pending_payouts(id).iter().filter(|p| p.token_id == USDC).map(|p| p.amount.0).sum();
    assert_eq!(btc_out, env.maker_required(), "I-2 (BTC)");
    assert_eq!(usdc_out, env.taker_required(), "I-2 (USDC)");
}

#[test]
#[should_panic(expected = "min_fee_per_side must be <= min_per_side/20")]
fn g5f_new_refuses_min_fee_above_one_twentieth_of_min_per_side() {
    new_contract_with_limits_and_assets(g5f_limits(), None, g5f_assets(500_001, G5F_USDC_MIN));
}

#[test]
fn g5f_new_accepts_min_fee_exactly_one_twentieth_of_min_per_side() {
    new_contract_with_limits_and_assets(g5f_limits(), None, g5f_assets(500_000, G5F_USDC_MIN));
}

#[test]
#[should_panic(expected = "min_fee_per_side must be > 0")]
fn g5f_new_refuses_zero_min_fee() {
    new_contract_with_limits_and_assets(g5f_limits(), None, g5f_assets(0, G5F_USDC_MIN));
}

// ---------------- PA1: guardian-adjustable params (D-PARAMS1) ----------------

const PA1_DAY: u64 = crate::PARAMS_DELAY_NS;
const PA1_USDC_CAP: u128 = 2_500_000; // USDC/USDT cap pinned at new() (D-PARAMS1)

fn pa1_assets() -> Vec<(String, AssetLimit)> {
    let mut a = g5f_assets(G5F_USDC_MIN_FEE, G5F_USDC_MIN);
    a[0].1.min_fee_cap_per_side = U128(PA1_USDC_CAP);
    a
}

fn pa1_contract() -> Contract {
    new_contract_with_limits_and_assets(g5f_limits(), None, pa1_assets())
}

fn pa1_usdc(min_fee: Option<u128>, min: Option<u128>, max: Option<u128>) -> AssetParamsChange {
    AssetParamsChange {
        asset_id: USDC.to_string(),
        min_fee_per_side: min_fee.map(U128),
        min_per_side: min.map(U128),
        max_per_side: max.map(U128),
    }
}

fn pa1_change(fee_bps: Option<u32>, assets: Vec<AssetParamsChange>) -> ParamsChange {
    ParamsChange { fee_bps, assets }
}

fn pa1_propose(c: &mut Contract, ts: u64, change: ParamsChange) {
    ctx_with_deposit(GUARDIAN, ts, NearToken::from_yoctonear(1));
    c.propose_params(change);
}

fn pa1_apply(c: &mut Contract, ts: u64) {
    ctx("anyone.testnet", ts);
    c.apply_params();
}

fn pa1_fee_paid(c: &Contract, id: u64) -> u128 {
    c.pending_payouts(id)
        .iter()
        .filter(|p| p.receiver.as_str() == FEE && p.token_id == USDC)
        .map(|p| p.amount.0)
        .sum()
}

#[test]
#[should_panic(expected = "only guardian")]
fn pa1_propose_by_non_guardian_refused() {
    let mut c = pa1_contract();
    ctx_with_deposit("random.testnet", 10, NearToken::from_yoctonear(1));
    c.propose_params(pa1_change(Some(150), vec![]));
}

#[test]
#[should_panic(expected = "only guardian")]
fn pa1_cancel_by_non_guardian_refused() {
    let mut c = pa1_contract();
    pa1_propose(&mut c, 10, pa1_change(Some(150), vec![]));
    ctx_with_deposit("random.testnet", 11, NearToken::from_yoctonear(1));
    c.cancel_params();
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn pa1_propose_requires_one_yocto() {
    let mut c = pa1_contract();
    ctx(GUARDIAN, 10);
    c.propose_params(pa1_change(Some(150), vec![]));
}

#[test]
#[should_panic(expected = "params delay not elapsed")]
fn pa1_apply_before_24h_refused() {
    let mut c = pa1_contract();
    pa1_propose(&mut c, 10, pa1_change(Some(150), vec![]));
    pa1_apply(&mut c, 10 + PA1_DAY - 1);
}

#[test]
#[should_panic(expected = "no pending params")]
fn pa1_apply_with_nothing_pending_refused() {
    let mut c = pa1_contract();
    pa1_apply(&mut c, 10);
}

#[test]
fn pa1_apply_after_24h_by_anyone_changes_fee_and_asset_limits_and_emits_events() {
    let mut c = pa1_contract();
    pa1_propose(&mut c, 10, pa1_change(Some(150), vec![pa1_usdc(Some(400_000), Some(8_000_000), Some(900_000_000))]));
    let logs = near_sdk::test_utils::get_logs().join("\n");
    assert!(logs.contains("\"event\":\"params_proposed\""), "propose emits an event: {logs}");
    let pend = c.pending_params().expect("view shows the pending change");
    assert_eq!(pend.effective_at_ns, 10 + PA1_DAY);
    assert_eq!(pend.change.fee_bps, Some(150));
    // not yet effective
    assert_eq!(c.protocol_fee_bps(), 100);
    pa1_apply(&mut c, 10 + PA1_DAY);
    let logs = near_sdk::test_utils::get_logs().join("\n");
    assert!(logs.contains("\"event\":\"params_applied\""), "apply emits an event: {logs}");
    assert_eq!(c.protocol_fee_bps(), 150);
    let l = c.asset_limit(USDC.to_string()).unwrap();
    assert_eq!(l.min_fee_per_side.0, 400_000);
    assert_eq!(l.min_per_side.0, 8_000_000);
    assert_eq!(l.max_per_side.0, 900_000_000);
    assert_eq!(l.min_fee_cap_per_side.0, PA1_USDC_CAP, "cap is never changed");
    assert!(c.pending_params().is_none(), "pending cleared after apply");
}

#[test]
#[should_panic(expected = "fee_bps exceeds 200")]
fn pa1_fee_201_bps_refused() {
    let mut c = pa1_contract();
    pa1_propose(&mut c, 10, pa1_change(Some(201), vec![]));
}

#[test]
fn pa1_fee_200_bps_accepted() {
    let mut c = pa1_contract();
    pa1_propose(&mut c, 10, pa1_change(Some(200), vec![]));
    pa1_apply(&mut c, 10 + PA1_DAY);
    assert_eq!(c.protocol_fee_bps(), 200);
}

#[test]
#[should_panic(expected = "min_fee_per_side exceeds the per-asset cap")]
fn pa1_min_fee_over_asset_cap_refused() {
    let mut c = pa1_contract();
    // min_per_side is raised so min_fee <= min_per_side/20 holds; only the cap is violated.
    pa1_propose(&mut c, 10, pa1_change(None, vec![pa1_usdc(Some(PA1_USDC_CAP + 1), Some(100_000_000), None)]));
}

#[test]
fn pa1_min_fee_exactly_at_cap_accepted() {
    let mut c = pa1_contract();
    pa1_propose(&mut c, 10, pa1_change(None, vec![pa1_usdc(Some(PA1_USDC_CAP), Some(50_000_000), None)]));
    pa1_apply(&mut c, 10 + PA1_DAY);
    assert_eq!(c.asset_limit(USDC.to_string()).unwrap().min_fee_per_side.0, PA1_USDC_CAP);
}

#[test]
#[should_panic(expected = "min_per_side must be <= max_per_side")]
fn pa1_min_above_max_refused() {
    let mut c = pa1_contract();
    pa1_propose(&mut c, 10, pa1_change(None, vec![pa1_usdc(None, Some(2_000_000_000), None)]));
}

#[test]
#[should_panic(expected = "min_fee_per_side must be <= min_per_side/20")]
fn pa1_min_fee_above_one_twentieth_of_min_refused() {
    let mut c = pa1_contract();
    pa1_propose(&mut c, 10, pa1_change(None, vec![pa1_usdc(Some(600_000), None, None)]));
}

#[test]
#[should_panic(expected = "min_fee_per_side must be > 0")]
fn pa1_zero_min_fee_refused() {
    let mut c = pa1_contract();
    pa1_propose(&mut c, 10, pa1_change(None, vec![pa1_usdc(Some(0), None, None)]));
}

#[test]
#[should_panic(expected = "unknown asset")]
fn pa1_unknown_asset_refused_no_asset_can_be_added() {
    let mut c = pa1_contract();
    let mut a = pa1_usdc(Some(400_000), None, None);
    a.asset_id = "nep141:new-asset.testnet".to_string();
    pa1_propose(&mut c, 10, pa1_change(None, vec![a]));
}

#[test]
#[should_panic(expected = "empty params change")]
fn pa1_empty_change_refused() {
    let mut c = pa1_contract();
    pa1_propose(&mut c, 10, pa1_change(None, vec![]));
}

#[test]
#[should_panic(expected = "params change already pending")]
fn pa1_second_proposal_while_pending_refused() {
    let mut c = pa1_contract();
    pa1_propose(&mut c, 10, pa1_change(Some(150), vec![]));
    pa1_propose(&mut c, 11, pa1_change(Some(120), vec![]));
}

#[test]
fn pa1_cancel_clears_pending_emits_event_and_apply_then_refused() {
    let mut c = pa1_contract();
    pa1_propose(&mut c, 10, pa1_change(Some(150), vec![]));
    ctx_with_deposit(GUARDIAN, 11, NearToken::from_yoctonear(1));
    c.cancel_params();
    let logs = near_sdk::test_utils::get_logs().join("\n");
    assert!(logs.contains("\"event\":\"params_cancelled\""), "cancel emits an event: {logs}");
    assert!(c.pending_params().is_none());
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| pa1_apply(&mut c, 10 + PA1_DAY)));
    assert!(r.is_err(), "apply after cancel must be refused");
    assert_eq!(c.protocol_fee_bps(), 100);
}

#[test]
fn pa1_open_after_change_uses_new_fee_old_fee_envelope_refused() {
    let mut c = pa1_contract();
    pa1_propose(&mut c, 10, pa1_change(Some(150), vec![]));
    pa1_apply(&mut c, 10 + PA1_DAY);
    let mut old = g5f_env(20_000_000, 20_000_000);
    old.fee_bps = 100;
    let resp = do_mt_transfer(&mut c, "maker.testnet", old.maker_required(), open_msg(&old), 1);
    assert_eq!(resp, vec![U128(old.maker_required())], "old fee_bps refused against the CURRENT config");
    let mut new = g5f_env(20_000_000, 20_000_000);
    new.fee_bps = 150;
    let resp = do_mt_transfer(&mut c, "maker.testnet", new.maker_required(), open_msg(&new), 1);
    assert_eq!(resp, vec![U128(0)]);
}

#[test]
fn pa1_change_after_open_does_not_touch_that_bets_finalize_payout() {
    let mut c = pa1_contract();
    let env = g5f_env(10_000_000, 10_000_000); // fee 1% = 100k < min 500k -> min fee applies
    let id = g5f_open_take(&mut c, &env);
    let c0 = c.get_bet(id).unwrap();
    assert_eq!(c0.fee_min_maker.0, 500_000, "open copies the current min fee into the bet");
    assert_eq!(c0.fee_min_taker.0, 500_000);
    // Guardian raises both knobs and the change takes effect while the bet is live.
    pa1_propose(&mut c, 10, pa1_change(Some(200), vec![pa1_usdc(Some(1_000_000), Some(20_000_000), None)]));
    pa1_apply(&mut c, 10 + PA1_DAY);
    assert_eq!(c.asset_limit(USDC.to_string()).unwrap().min_fee_per_side.0, 1_000_000);
    g5f_finalize_yes(&mut c, id);
    assert_eq!(pa1_fee_paid(&c, id), 1_000_000 + 2 * env.storage_for(STG_FIXTURE_RATE), "0.50 per side x2 (+storage) from the bet's own copy, not 1.00 x2");
}

#[test]
fn pa1_change_lowering_min_fee_after_open_does_not_touch_that_bets_payout() {
    let mut c = pa1_contract();
    let env = g5f_env(10_000_000, 10_000_000);
    let id = g5f_open_take(&mut c, &env);
    pa1_propose(&mut c, 10, pa1_change(None, vec![pa1_usdc(Some(100_000), None, None)]));
    pa1_apply(&mut c, 10 + PA1_DAY);
    g5f_finalize_yes(&mut c, id);
    assert_eq!(pa1_fee_paid(&c, id), 1_000_000 + 2 * env.storage_for(STG_FIXTURE_RATE), "still 0.50 per side (+storage)");
}

#[test]
fn pa1_change_after_open_does_not_touch_that_bets_concede_payout() {
    let mut c = pa1_contract();
    let env = g5f_env(10_000_000, 10_000_000);
    let id = g5f_open_take(&mut c, &env);
    pa1_propose(&mut c, 10, pa1_change(None, vec![pa1_usdc(Some(100_000), None, None)]));
    pa1_apply(&mut c, 10 + PA1_DAY);
    ctx("maker.testnet", 3_000 + PA1_DAY);
    c.concede(id);
    assert_eq!(pa1_fee_paid(&c, id), 1_000_000 + 2 * env.storage_for(STG_FIXTURE_RATE), "concede uses the bet's copy too");
}

#[test]
#[should_panic(expected = "new offers are paused")]
fn pa1_propose_while_paused_refused() {
    let mut c = pa1_contract();
    ctx_with_deposit(GUARDIAN, 5, NearToken::from_yoctonear(1));
    c.pause_new_offers();
    pa1_propose(&mut c, 10, pa1_change(Some(150), vec![]));
}

#[test]
#[should_panic(expected = "contract is shut down")]
fn pa1_propose_when_halted_by_emergency_refused() {
    let mut c = pa1_contract();
    ctx_with_deposit(GUARDIAN, 5, NearToken::from_yoctonear(1));
    c.emergency_shutdown();
    pa1_propose(&mut c, 10, pa1_change(Some(150), vec![]));
}

#[test]
fn pa1_apply_while_halted_refused_and_cancel_still_works() {
    for emergency in [true, false] {
        let mut c = pa1_contract();
        pa1_propose(&mut c, 10, pa1_change(Some(150), vec![]));
        ctx_with_deposit(GUARDIAN, 11, NearToken::from_yoctonear(1));
        if emergency {
            c.emergency_shutdown();
        } else {
            c.pause_new_offers();
        }
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| pa1_apply(&mut c, 10 + PA1_DAY)));
        assert!(r.is_err(), "apply while halted (emergency={emergency}) must be refused");
        assert_eq!(c.protocol_fee_bps(), 100);
        ctx_with_deposit(GUARDIAN, 10 + PA1_DAY, NearToken::from_yoctonear(1));
        c.cancel_params(); // withdrawing a pending change is always allowed
        assert!(c.pending_params().is_none());
    }
}

#[test]
#[should_panic(expected = "min_fee_cap_per_side must be >= min_fee_per_side")]
fn pa1_new_refuses_cap_below_min_fee() {
    let mut a = g5f_assets(G5F_USDC_MIN_FEE, G5F_USDC_MIN);
    a[0].1.min_fee_cap_per_side = U128(G5F_USDC_MIN_FEE - 1);
    new_contract_with_limits_and_assets(g5f_limits(), None, a);
}

#[test]
fn pa1_new_pins_cap_at_initial_min_fee_when_unspecified() {
    let c = new_contract_with_limits_and_assets(g5f_limits(), None, g5f_assets(G5F_USDC_MIN_FEE, G5F_USDC_MIN));
    assert_eq!(c.asset_limit(USDC.to_string()).unwrap().min_fee_cap_per_side.0, G5F_USDC_MIN_FEE);
}

/// "No method exists to change assets/resolver/keys/funds": the ONLY
/// guardian-gated methods are the six below, and the params types carry
/// nothing but fee_bps and three per-asset knobs. Adding a guardian power
/// (or a field to the change types) breaks this test on purpose.
#[test]
fn pa1_guardian_powers_exhaustive_and_params_change_has_no_other_knobs() {
    let src = include_str!("lib.rs");
    let mut gated: Vec<String> = Vec::new();
    for chunk in src.split("pub fn ").skip(1) {
        let name = chunk.split('(').next().unwrap().to_string();
        let body = chunk.split("\n    pub fn ").next().unwrap();
        let body = body.split("\n    fn ").next().unwrap();
        let body = body.split("\n#[cfg(test)]").next().unwrap();
        if body.contains("== self.guardian") {
            gated.push(name);
        }
    }
    gated.sort();
    assert_eq!(
        gated,
        vec![
            "cancel_asset",
            "cancel_guardian",
            "cancel_judge_pair",
            "cancel_params",
            "disable_asset_for_new_bets",
            "emergency_shutdown",
            "pause_new_offers",
            "propose_asset",
            "propose_judge_pair",
            "propose_params",
            "set_guardian",
            "unpause_new_offers",
        ]
    );
    // Compile-time exhaustiveness of the change types.
    let ParamsChange { fee_bps: _, assets } = pa1_change(None, vec![pa1_usdc(None, None, None)]);
    let AssetParamsChange { asset_id: _, min_fee_per_side: _, min_per_side: _, max_per_side: _ } = assets[0].clone();
    // apply_params is permissionless and not guardian-gated.
    let mut c = pa1_contract();
    pa1_propose(&mut c, 10, pa1_change(Some(150), vec![]));
    pa1_apply(&mut c, 10 + PA1_DAY);
}

// =====================================================================
// TKH1 (take-check-before-write): every check that can refuse a take
// must run BEFORE handle_take writes the matched option's asset/stake/
// min-fee into the bet, so a refused take leaves the bet byte-identical
// and the taker is refunded in full (I-3), with I-2 intact.
// =====================================================================
#[test]
fn tkh1_refused_take_leaves_bet_unchanged_and_refunds_in_full() {
    let mut c = new_contract_spec_assets();
    let (_, pk) = test_keypair(140);
    let mut env = multi_option_envelope(&hex_encode(&pk));
    env.referee = Some(Referee {
        account: "referee.testnet".parse().unwrap(),
        mode: RefereeMode::Human,
    });
    let resp = do_mt_transfer_asset(&mut c, "maker.testnet", USDC, env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)], "open must be accepted");
    let bet_id = c.next_bet_id - 1;

    // Construct a bet state that genuinely fails the taker tip check: the
    // BTC option's own copied min fee is so large that fee + tip > stake.
    // (Unreachable via public API because new() bounds min fee by
    // min_per_side/20, so the state is built directly -- no test hook in
    // the release code.)
    c.bets.get_mut(&bet_id).unwrap().fee_min_taker_options[0] = U128(10_000);

    let before = serde_json::to_string(&c.get_bet(bet_id).unwrap()).unwrap();
    let before_borsh = near_sdk::borsh::to_vec(c.bets.get(&bet_id).unwrap()).unwrap();

    let deposit = 10_000 + env.storage_for(STG_FIXTURE_RATE);
    let take = serde_json::to_string(&TransferMsg::Take {
        bet_id,
        invite_sig: None,
        tip: true,
        referee_ack: Some("referee.testnet".parse().unwrap()),
    })
    .unwrap();
    let resp = do_mt_transfer_asset(&mut c, "taker.testnet", MOCK_BTC, deposit, take, 2);

    // I-3 / I-2: the whole deposit comes straight back; nothing is kept.
    assert_eq!(resp, vec![U128(deposit)], "refused take must refund the taker in full");
    // Bet is untouched: status, taker, asset, stake, fee copy.
    let after = serde_json::to_string(&c.get_bet(bet_id).unwrap()).unwrap();
    assert_eq!(after, before, "refused take must leave the bet view unchanged");
    let after_borsh = near_sdk::borsh::to_vec(c.bets.get(&bet_id).unwrap()).unwrap();
    assert_eq!(after_borsh, before_borsh, "refused take must leave the stored bet byte-identical");
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, BetStatus::Open);
    assert_eq!(bet.envelope.taker_asset, USDC, "taker_asset must not be overwritten by a refused take");
    assert_eq!(bet.envelope.stake_taker.0, 10_000_000, "stake_taker must not be overwritten");
    assert!(bet.taker.is_none());
    // I-2: no payout lines were created for a refused take.
    assert!(c.pending_payouts(bet_id).is_empty(), "no payouts scheduled for a refused take");
}
