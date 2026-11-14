//! NOKEY1 (D-NOKEY1): the escrow's handling of the output a real-http resolver emits when NEAR_AI_API_KEY is not bound
//! (fixtures/nokey1_no_key_output.json: an UNSIGNED error object -- no `result`, no signature). Frozen escrow (no src change):
//! on_resolution stores it in last_resolution_raw and nothing else moves. runs_used unchanged, the bet stays Resolving, and
//! NO recovery/VOID-refund clock starts (first_unavailable_ns None, retry_count 0). A signed `VOID:unavailable` is still refused.
//! (A signed `RETRY:no_live_judge` is NOT the form: the escrow accepts it only when no judge pair is live.)
use ed25519_dalek::Signer;
use escrow::*;
use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::{U128, U64};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, NearToken, PromiseOrValue, PromiseResult};

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
const TAKER: &str = "taker.testnet";
const STG_FIXTURE_RATE: u128 = 6274;
const NO_KEY_FIXTURE: &str = include_str!("fixtures/nokey1_no_key_output.json");

fn ctx(predecessor: &str, ts: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .signer_account_id(predecessor.parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .block_timestamp(ts);
    testing_env!(b.build());
}

fn ctx_deposit(predecessor: &str, ts: u64, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(CONTRACT.parse().unwrap())
        .signer_account_id(predecessor.parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .attached_deposit(deposit)
        .block_timestamp(ts);
    testing_env!(b.build());
}

fn ctx_promise(predecessor: &str, ts: u64, result: PromiseResult) {
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

fn signing_key() -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[0xd1; 32])
}
fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}
fn pubkey_hex() -> String {
    hex_encode(&signing_key().verifying_key().to_bytes())
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
            max_offer_ttl_secs: 31_536_000,
            max_stake_per_side_near: U128(100 * 10u128.pow(24)),
            max_rounds: escrow::DEFAULT_MAX_ROUNDS,
            max_retries: escrow::DEFAULT_MAX_RETRIES,
        },
        None,
        vec![(
            USDC.to_string(),
            AssetLimit {
                min_per_side: U128(20),
                min_fee_per_side: U128(1),
                min_fee_cap_per_side: U128(0),
                storage_per_kib: U128(STG_FIXTURE_RATE),
                max_per_side: U128(escrow::DEFAULT_MAX_STAKE_PER_SIDE_USDC),
                run_price: U128(50_000),
                min_bond: U128(5_000_000),
                min_objection: U128(1_000_000),
            },
        )],
        pubkey_hex(),
        pubkey_hex(),
        "f".repeat(64),
        OutlayerConfig {
            wasm_base_url: "https://test.fastfs.io/praetorial-dev-1101.testnet/outlayer.testnet".to_string(),
            secrets_profile: "praetorial-resolver".to_string(),
            secrets_account_id: "escrow.praetorial-dev-1101.testnet".parse().unwrap(),
        },
        vec![
            escrow::JudgePair { model_a: "deepseek-ai/DeepSeek-V4.1-Flash-1017".to_string(), model_b: "zai-org/GLM-5.3-flash".to_string() },
            escrow::JudgePair { model_a: "t/jc-backup-a1".to_string(), model_b: "t/jc-backup-a2".to_string() },
        ],
    )
}

fn base_envelope() -> Envelope {
    Envelope {
        bet_id: 0,
        version: 1,
        maker: MAKER.parse().unwrap(),
        taker_allow: TakerAllow::Any,
        terms_hash: "a".repeat(64),
        models_snapshot_hash: "c".repeat(64),
        outcomes: vec!["YES".to_string(), "NO".to_string()],
        maker_side: "YES".to_string(),
        maker_asset: USDC.to_string(),
        taker_asset: USDC.to_string(),
        stake_maker: U128(1_000_000),
        stake_taker: U128(1_000_000),
        taker_options: Vec::new(),
        fee_bps: 100,
        storage_charge_per_side: U128(0),
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

#[derive(near_sdk::serde::Serialize)]
#[serde(crate = "near_sdk::serde", tag = "kind")]
enum Msg {
    Open { envelope: Envelope, attestation: SourceCheckAttestation },
}

fn mt(c: &mut Contract, sender: &str, amount: u128, msg: String, ts: u64) -> Vec<U128> {
    ctx(INTENTS, ts);
    match c.mt_on_transfer(sender.parse().unwrap(), vec![sender.parse().unwrap()], vec![USDC.to_string()], vec![U128(amount)], msg) {
        PromiseOrValue::Value(v) => v,
        PromiseOrValue::Promise(_) => panic!("unexpected promise"),
    }
}

fn open_and_take(c: &mut Contract) -> u64 {
    let env = base_envelope();
    let message = sourcecheck_message(&env.terms_hash, 0);
    let attestation = SourceCheckAttestation { checked_at: 0, signature_hex: hex_encode(&signing_key().sign(message.as_bytes()).to_bytes()) };
    let msg = near_sdk::serde_json::to_string(&Msg::Open { envelope: env.clone(), attestation }).unwrap();
    let amount = env.stake_maker.0 + env.storage_for(STG_FIXTURE_RATE);
    assert_eq!(mt(c, MAKER, amount, msg, 1), vec![U128(0)], "open");
    let bet_id = c.next_bet_id - 1;
    let take = near_sdk::serde_json::to_string(&TransferMsg::Take { bet_id, invite_sig: None, tip: false, referee_ack: None }).unwrap();
    let amount = env.stake_taker.0 + env.storage_for(STG_FIXTURE_RATE);
    assert_eq!(mt(c, TAKER, amount, take, 2), vec![U128(0)], "take");
    bet_id
}

fn sign_result(r: &SubmittedResult) -> String {
    let mut buf = Vec::new();
    BorshSerialize::serialize(&CONTRACT.parse::<near_sdk::AccountId>().unwrap(), &mut buf).unwrap();
    BorshSerialize::serialize(&r.bet_id, &mut buf).unwrap();
    BorshSerialize::serialize(&r.terms_hash, &mut buf).unwrap();
    BorshSerialize::serialize(&r.outcome, &mut buf).unwrap();
    BorshSerialize::serialize(&r.element_results_hash, &mut buf).unwrap();
    BorshSerialize::serialize(&r.run_no, &mut buf).unwrap();
    BorshSerialize::serialize(&r.checked_until.0, &mut buf).unwrap();
    BorshSerialize::serialize(&r.judge_pair_index, &mut buf).unwrap();
    hex_encode(&signing_key().sign(&buf).to_bytes())
}

/// What OutLayer hands the callback for a Successful run: the resolver's stdout as a JSON-encoded string.
fn outlayer_success_bytes(output_json: &str) -> Vec<u8> {
    near_sdk::serde_json::to_string(output_json).unwrap().into_bytes()
}

#[test]
fn nokey1_no_key_output_leaves_runs_used_unchanged_bet_resolving_and_no_refund_clock() {
    let mut c = new_contract();
    let bet_id = open_and_take(&mut c);
    let before = c.get_bet(bet_id).unwrap();
    assert_eq!(before.runs_used, 0);

    // keeper requests a resolution (funded from its prepaid pool, as in production)
    ctx_deposit(KEEPER, 3, NearToken::from_millinear(50));
    c.topup_keeper_credit();
    let ts_req = 3600 * 1_000_000_000 + 10;
    ctx_deposit(KEEPER, ts_req, NearToken::from_yoctonear(0));
    let _ = c.request_resolution(bet_id, Some("x".to_string()));
    let request_id = c.next_request_id - 1;
    let run_no = c.get_bet(bet_id).unwrap().pending_run_no.expect("pending run_no");
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Resolving);

    // the run finishes Successful with the no-key error object (the fixture the resolver test pins)
    ctx_promise(CONTRACT, ts_req + 1_000, PromiseResult::Successful(outlayer_success_bytes(NO_KEY_FIXTURE)));
    c.on_resolution(request_id);

    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.runs_used, 0, "a no-key run is not a paid/counted run");
    assert_eq!(bet.status, BetStatus::Resolving, "no outcome is applied; the bet is not settled by it");
    assert_eq!(bet.outcome, None);
    assert_eq!(bet.first_unavailable_ns, None, "the D-RESOLVE1 recovery/VOID-refund clock must not start");
    assert_eq!(bet.retry_count, 0);
    assert_eq!(bet.no_live_judge_until_ns, None);
    assert!(bet.last_resolution_raw.as_deref().unwrap_or("").contains("NEAR_AI_API_KEY"), "the missing key is recorded on the bet for the operator");

    // no refund clock: a signed VOID:unavailable is refused (window not started), and void_after_deadline is not available early
    ctx("anyone.testnet", ts_req + 2_000);
    let r = SubmittedResult {
        bet_id,
        terms_hash: "a".repeat(64),
        outcome: "VOID:unavailable".to_string(),
        element_results_hash: "e".repeat(64),
        run_no,
        checked_until: U64(ts_req),
        next_check_ns: None,
        judge_pair_index: 0,
        model_not_found: vec![],
    };
    let sig = sign_result(&r);
    let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.submit_outcome(r, sig))).is_err();
    assert!(refused, "VOID:unavailable must stay refused: the no-key run did not start the recovery window");
    let early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.void_after_deadline(bet_id))).is_err();
    assert!(early, "void_after_deadline only after resolve_deadline");
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(bet.status, BetStatus::Resolving);
    assert_eq!(bet.runs_used, 0);
}
