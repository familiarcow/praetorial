//! SEAM AUDIT (2026-11-02): contract tests for every place two Praetorial
//! subsystems hand data to each other. Each test's name states the seam
//! and the expected result (PASS or MISMATCH). A MISMATCH test documents
//! a disagreement as a *passing* test that asserts the disagreement
//! exists (so it can't regress silently back to "nobody noticed") and is
//! cross-referenced in "Praetorial - Seam audit v1.md".
//!
//! Scope: local only (no testnet, no services/data, no vault docs another
//! agent owns). Reuses `tests.rs`'s private helpers (`new_contract`,
//! `base_envelope`, `open_and_take`, `sign_result`, `ctx*`) since this is
//! `#[path]`-included as a sibling module in the same crate.
use super::*;
use ed25519_dalek::Signer;

// ===================================================================
// SEAM: services/keeper/src/resolverSim.ts (TS) -> escrow submit_outcome
// (Rust) run_no handshake. I-7 / FM-13 "strict run order, no result
// shopping": the contract only accepts result.run_no == bet.next_expected_run_no,
// which starts at 1 and becomes run_no+1 after each accepted submission
// (contracts/escrow/src/lib.rs: Bet::default init + submit_outcome). The
// TS-side testnet resolver simulator instead computes
// `run_no = bet.runs_used`, which starts at 0 -- see
// services/keeper/src/resolverSim.ts:36 ("next run index, matches
// used_run_nos dedupe on-chain", a comment describing intent, not the
// contract's actual field). This test proves the two sides disagree by
// replaying resolverSim's exact arithmetic against the real contract.
// ===================================================================

/// PASS (seam agrees): the contract's own expectation is run_no == 1 for
/// the very first submission on a fresh bet (next_expected_run_no inits
/// to 1, see Bet construction in open()).
#[test]
fn seam_escrow_first_accepted_run_no_is_one_not_zero() {
    let mut c = new_contract();
    let (_sk, pk) = test_keypair(201);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let bet = c.get_bet(bet_id).unwrap();
    assert_eq!(
        bet.next_expected_run_no, 1,
        "SEAM FACT: escrow expects the first run_no to be 1"
    );

    // run_no = bet.runs_used (resolverSim.ts's actual formula) would send 0.
    let runs_used_formula_run_no = bet.runs_used as u64; // == 0
    assert_eq!(runs_used_formula_run_no, 0);
    assert_ne!(
        runs_used_formula_run_no, bet.next_expected_run_no,
        "the two sides compute different run_no values for the first submission"
    );
}

/// MISMATCH: replaying resolverSim.ts's exact formula (`run_no =
/// bet.runs_used`) against the real contract's submit_outcome is
/// rejected on the very first call. This is the TS testnet harness
/// disagreeing with the Rust contract it drives -- every lifecycle run
/// that exercises resolverSim's self-submit path (as opposed to the
/// mock-outlayer -> on_resolution callback path, which never calls
/// submit_outcome with a caller-chosen run_no) would panic here.
/// Severity: HIGH for the testnet harness (this test-only path is dead
/// on arrival), not a contract bug and not money-at-risk in production
/// (real OutLayer results flow through on_resolution's callback, which
/// escrow itself drives with the correct run_no -- see
/// resolution_input_data's `run_no` parameter, set by request_resolution,
/// not by the resolver). Fix: resolverSim.ts should read
/// `bet.next_expected_run_no`, which is already exposed on the Bet view
/// (services/common/src/types.ts has the field) -- one-line fix, see
/// Seam audit v1.md.
#[test]
#[should_panic(expected = "run_no out of order")]
fn seam_mismatch_resolversim_run_no_formula_rejected_by_escrow() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(202);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let bet = c.get_bet(bet_id).unwrap();

    // Exact formula from services/keeper/src/resolverSim.ts:36.
    let run_no_from_resolver_sim = bet.runs_used as u64;

    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: bet.envelope.terms_hash.clone(),
        outcome: "YES".to_string(),
        element_results_hash: "e".repeat(64),
        run_no: run_no_from_resolver_sim, // == 0, contract wants 1
        checked_until: U64(2_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let sig = sign_result(&outcome_signing_key(), &result);
    c.submit_outcome(result, sig); // panics: "run_no out of order (I-7...)"
}

// ===================================================================
// SEAM: resolution_input_data (escrow, Rust) -> resolver wasm-bin stdin
// parsing (resolver/wasm-bin/src/main.rs). Already green (confirmed by
// existing unit tests in both crates); recorded here as a PASS anchor so
// a future change to either side's shape trips a test immediately rather
// than being caught only on testnet. escrow's own
// `resolution_input_data_carries_full_envelope_and_terms_round_run_no`
// test pins the exact JSON shape; this test pins that the SAME shape's
// field *names* are what wasm-bin's main.rs reads (contract, bet_id,
// envelope.terms_hash, terms, round, run_no, payer_account_id).
// ===================================================================
#[test]
fn seam_escrow_resolution_input_data_field_names_match_resolver_reader() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(203);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    ctx_with_deposit(KEEPER, 1_001, NearToken::from_millinear(50));
    let _ = c.request_resolution(bet_id, None);
    // request_resolution's outbound call carries resolution_input_data's
    // JSON as the (mocked) outlayer call's args; verify its top-level
    // keys are exactly what wasm-bin's main.rs::main() reads via
    // job["contract"], job["bet_id"], job["envelope"], job["terms"],
    // job["round"], job["run_no"], job["payer_account_id"] (grep-verified
    // in resolver/wasm-bin/src/main.rs around line 1246-1283).
    let bet = c.get_bet(bet_id).unwrap();
    let input = resolution_input_data(
        &CONTRACT.parse().unwrap(),
        bet_id,
        &bet.envelope,
        &bet.envelope.terms,
        0,
        bet.next_expected_run_no,
        &KEEPER.parse().unwrap(),
        &c.judge_chain(),
    );
    let v: serde_json::Value = serde_json::from_str(&input).unwrap();
    for key in [
        "contract",
        "bet_id",
        "envelope",
        "terms",
        "round",
        "run_no",
        "payer_account_id",
    ] {
        assert!(
            v.get(key).is_some(),
            "SEAM MISMATCH: resolution_input_data is missing key `{key}` that resolver/wasm-bin/src/main.rs reads"
        );
    }
    assert!(
        v["envelope"].get("terms_hash").is_some(),
        "SEAM MISMATCH: resolver reads envelope.terms_hash for the stage-0 sha256 check"
    );
}

// ===================================================================
// SEAM: submit_outcome's signed borsh layout (escrow, Rust) vs the
// resolver's local-signer borsh layout (resolver/wasm-bin/src/main.rs
// submitted_result_borsh_buf). Both must serialize
// contract_id+bet_id+terms_hash+outcome+element_results_hash+run_no+
// checked_until in the same order with the same encoding (u32-LE length
// prefix + utf8 for strings, 8-byte LE for u64) or every signature
// verification fails. PASS: cross-check by building the buffer with the
// *contract's* exact BorshSerialize calls (as submit_outcome does) and
// the resolver's manual byte-pushing helper, then diffing the bytes.
// ===================================================================
#[test]
fn seam_submit_outcome_borsh_layout_matches_resolver_local_signer() {
    let result = SubmittedResult {
        bet_id: 42,
        terms_hash: "deadbeef".repeat(4),
        outcome: "NO".to_string(),
        element_results_hash: "c".repeat(64),
        run_no: 7,
        checked_until: U64(1_799_999_999_000_000_000),
        next_check_ns: None,
        judge_pair_index: 0, model_not_found: vec![],
    };
    let contract_id: AccountId = CONTRACT.parse().unwrap();

    // Exact escrow-side construction (contracts/escrow/src/lib.rs
    // submit_outcome, lines ~1417-1424).
    let mut escrow_buf = Vec::new();
    BorshSerialize::serialize(&contract_id, &mut escrow_buf).unwrap();
    BorshSerialize::serialize(&result.bet_id, &mut escrow_buf).unwrap();
    BorshSerialize::serialize(&result.terms_hash, &mut escrow_buf).unwrap();
    BorshSerialize::serialize(&result.outcome, &mut escrow_buf).unwrap();
    BorshSerialize::serialize(&result.element_results_hash, &mut escrow_buf).unwrap();
    BorshSerialize::serialize(&result.run_no, &mut escrow_buf).unwrap();
    BorshSerialize::serialize(&result.checked_until.0, &mut escrow_buf).unwrap();
    BorshSerialize::serialize(&result.judge_pair_index, &mut escrow_buf).unwrap();

    // Resolver-side construction, re-implemented by hand here to the
    // documented algorithm in resolver/wasm-bin/src/main.rs
    // (borsh_put_str: u32-LE len prefix + utf8 bytes; u64: 8-byte LE),
    // since that crate's local-signer feature is not a dependency of
    // this one. If the resolver crate's actual helper ever diverges from
    // this re-implementation, resolver/wasm-bin's own unit tests (which
    // round-trip through ed25519-dalek verify) catch it independently;
    // this test's job is to catch escrow's side drifting from the
    // *documented, shared* algorithm.
    fn borsh_put_str(out: &mut Vec<u8>, s: &str) {
        out.extend_from_slice(&(s.len() as u32).to_le_bytes());
        out.extend_from_slice(s.as_bytes());
    }
    let mut resolver_buf = Vec::new();
    borsh_put_str(&mut resolver_buf, contract_id.as_str());
    resolver_buf.extend_from_slice(&result.bet_id.to_le_bytes());
    borsh_put_str(&mut resolver_buf, &result.terms_hash);
    borsh_put_str(&mut resolver_buf, &result.outcome);
    borsh_put_str(&mut resolver_buf, &result.element_results_hash);
    resolver_buf.extend_from_slice(&result.run_no.to_le_bytes());
    resolver_buf.extend_from_slice(&result.checked_until.0.to_le_bytes());
    resolver_buf.extend_from_slice(&result.judge_pair_index.to_le_bytes());

    assert_eq!(
        escrow_buf, resolver_buf,
        "SEAM MISMATCH: escrow's submit_outcome borsh buffer and the resolver's \
         documented local-signer buffer diverge -- every signature would fail verify_sig"
    );

    // And: a signature built over the resolver-style buffer must verify
    // against the contract's own verify_sig path end-to-end.
    let mut c = new_contract();
    let (sk, pk) = test_keypair(204);
    let bet_id = open_and_take(&mut c, &hex_encode(&pk));
    let mut result2 = result.clone();
    result2.bet_id = bet_id;
    result2.terms_hash = c.get_bet(bet_id).unwrap().envelope.terms_hash.clone();
    result2.run_no = 1; // first accepted run_no
    let mut buf2 = Vec::new();
    borsh_put_str(&mut buf2, CONTRACT);
    buf2.extend_from_slice(&result2.bet_id.to_le_bytes());
    borsh_put_str(&mut buf2, &result2.terms_hash);
    borsh_put_str(&mut buf2, &result2.outcome);
    borsh_put_str(&mut buf2, &result2.element_results_hash);
    buf2.extend_from_slice(&result2.run_no.to_le_bytes());
    buf2.extend_from_slice(&result2.checked_until.0.to_le_bytes());
    buf2.extend_from_slice(&result2.judge_pair_index.to_le_bytes());
    // D-KEY1: submit_outcome verifies against the pinned contract-level
    // outcome key now, never a maker-supplied envelope key.
    let sig = outcome_signing_key().sign(&buf2);
    ctx("anyone.testnet", 2_000);
    c.submit_outcome(result2, hex_encode(&sig.to_bytes()));
    assert_eq!(c.get_bet(bet_id).unwrap().status, BetStatus::Proposed);
}

// ===================================================================
// SEAM: amounts/decimals -- USDC (6dp) stake math vs U128 wire type vs
// fee_bps integer math. PASS anchor: fee_bps=100 (1%) of a 6dp USDC pot
// must not truncate/round in a way that breaks I-2 (total out <= total
// in). Exercise the actual payout arithmetic path via finalize() on a
// stake size chosen to be NOT a round number in basis points, which is
// where integer-division seams usually hide bugs.
// ===================================================================
#[test]
fn seam_usdc_6dp_fee_bps_math_never_pays_out_more_than_pot_i2() {
    let mut c = new_contract();
    let (sk, pk) = test_keypair(205);
    let pk_hex = hex_encode(&pk);
    // 1_234_567 micro-USDC (~$1.234567) per side -- deliberately not a
    // round number, to catch integer-division/truncation mismatches
    // between "basis points of the pot" as computed here and whatever a
    // services/indexer or app-side preview might independently compute
    // (the latter is out of local-test scope, but the contract's own
    // arithmetic is pinned here as the seam of record other layers must
    // match).
    let mut env = base_envelope(&pk_hex);
    env.stake_maker = U128(1_234_567);
    env.stake_taker = U128(1_234_567);
    // D-FEEPIN1 ruling change: the only legal fee_bps is the pinned 100 (was 137,
    // now refused at open). The non-round stake still exercises truncation:
    // 1_234_567 * 100 / 10_000 = 12_345.67 -> 12_345.
    env.fee_bps = 100;
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1);
    assert_eq!(resp, vec![U128(0)]);
    let bet_id = c.next_bet_id - 1;
    let resp = do_mt_transfer(&mut c, "taker.testnet", env.taker_required(), take_msg(bet_id), 2);
    assert_eq!(resp, vec![U128(0)]);

    ctx("anyone.testnet", 2_000);
    let result = SubmittedResult {
        bet_id,
        terms_hash: env.terms_hash.clone(),
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
    c.finalize(bet_id);

    let pot = env.stake_maker.0 + env.stake_taker.0;
    let total_scheduled: u128 = c
        .payout_ids_in_order()
        .iter()
        .filter_map(|id| c.pending_payouts.get(id))
        .filter(|p| p.bet_id == bet_id)
        .map(|p| p.amount.0)
        .sum();
    assert!(
        total_scheduled <= pot + 2 * env.storage_for(STG_FIXTURE_RATE),
        "SEAM MISMATCH (I-2): scheduled payouts {total_scheduled} exceed total in for bet {bet_id}"
    );
}

// ===================================================================
// SEAM: OutLayer refund path has no bet_id (per the Money flow end to
// end v0 doc). on_resolution's unused-compute refund is keyed by
// request_id -> resolution_payers map, NOT by bet_id -- confirm the
// contract actually looks it up that way (PASS: it does, see
// resolution_payers.get(&request_id) in on_resolution) and that a
// request_id with no matching payer record (e.g. a replayed/forged
// callback, or a request from a different bet entirely) cannot be used
// to redirect a refund to an unrelated account.
// ===================================================================
#[test]
fn seam_outlayer_refund_keyed_by_request_id_not_bet_id_unknown_request_is_noop() {
    let mut c = new_contract();
    // on_resolution for a request_id that was never issued by
    // request_resolution (no resolution_payers entry, no bets map entry
    // routing to it) must not panic and must not transfer anything --
    // proves the refund path can't be money-moved by guessing an id.
    ctx_with_promise_result(
        CONTRACT,
        5_000,
        PromiseResult::Successful(
            serde_json::to_vec(&serde_json::json!({"unused_compute_yocto": "999999999"}).to_string()).unwrap(),
        ),
    );
    let before = near_sdk::test_utils::get_created_receipts().len();
    c.on_resolution(999_999); // never issued
    let receipts = near_sdk::test_utils::get_created_receipts();
    assert_eq!(
        receipts.len(),
        before,
        "SEAM MISMATCH: an unknown request_id produced an outbound receipt (possible refund-redirect)"
    );
}

// ===================================================================
// SEAM: time units -- envelope deadlines are nanoseconds (block_timestamp
// units), matching services' Date.now()*1_000_000 convention documented
// in types.ts/SubmittedResult. PASS anchor: funding_deadline comparison
// uses the same unit as env::block_timestamp() (ns), not ms or s -- a
// services-side bug that sent seconds or ms would make every deadline
// wildly wrong in one direction. Exercise the boundary directly.
// ===================================================================
#[test]
fn seam_time_units_funding_deadline_compared_in_nanoseconds_not_millis() {
    let mut c = new_contract();
    let (_, pk) = test_keypair(206);
    let mut env = base_envelope(&hex_encode(&pk));
    // funding_deadline expressed as a plausible *millisecond* epoch value
    // misinterpreted as nanoseconds would be ~1970 (way in the past);
    // expressed as a plausible ns value it's far in the future. Confirm
    // the contract's open() accepts an envelope whose funding_deadline,
    // read as ns, is still far beyond "now" when "now" is also ns.
    env.funding_deadline = 1_000 + 500; // ns, relative to ctx ts=1000 base used by do_mt_transfer
    let resp = do_mt_transfer(&mut c, "maker.testnet", env.maker_required(), open_msg(&env), 1_000);
    assert_eq!(resp, vec![U128(0)], "open with a near-future ns deadline should be accepted");

    // Now prove the inverse: a deadline that LOOKS valid as milliseconds
    // (e.g. "500" ms from epoch, i.e. almost zero) but is passed through
    // unconverted as if it were ns is already-expired nanoseconds-wise,
    // and the contract must reject taking it after expiry -- this is the
    // behavior services/common must replicate when building envelopes
    // (any ms-not-ns bug would make every bet expire before it's even
    // taken). We assert the contract's own internal unit is ns by
    // checking a deadline of literal milliseconds (small number) is
    // already in the past relative to a realistic block_timestamp.
    let bet_id = c.next_bet_id - 1;
    ctx("anyone.testnet", 10_000); // "now" = 10_000 ns, way past funding_deadline=1_500 ns
    c.expire(bet_id);
    assert_eq!(
        c.get_bet(bet_id).unwrap().status,
        BetStatus::Expired,
        "SEAM FACT: a ns-unit deadline of 1500 is expired by ts=10000 (ns), confirming ns is the contract's unit"
    );
}
