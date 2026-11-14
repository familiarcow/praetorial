//! Minimal mock of OutLayer, for testnet E2E only.
//!
//! Real OutLayer runs pinned resolver wasm inside a TEE and signs results
//! with a key bound to (wasm_hash, caller=predecessor). This mock skips the
//! TEE/wasm execution entirely: `request_execution` reads a forced outcome
//! straight out of the caller-supplied `input_data` JSON (`{"bet_id":...,
//! "force_outcome":"YES"|"NO"}`) and signs it with a fixed test ed25519 key
//! baked into the contract at deploy time (`new(pubkey_hex)` is init-only;
//! the private key lives only in the test/E2E harness, never on any chain).
//! It calls the caller's `on_resolution(request_id)` callback the same way
//! the real OutLayer->escrow flow is specified, so the escrow contract's
//! callback-handling code path is exercised for real on testnet.
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOutlayer {
    pub next_request_id: u64,
    /// Loop 6 test-only knob (FM-10/FM-11): how much of the attached
    /// compute deposit this mock reports as "unused" on the NEXT
    /// `request_execution` call, so the E2E harness can exercise
    /// escrow's unused-compute refund path deterministically. `None`
    /// (the default) reports zero unused -- every existing lifecycle
    /// path that never calls `set_test_unused_compute` sees no change
    /// in behavior.
    pub test_unused_compute_yocto: Option<u128>,
    /// Item 16d: when true, `request_execution` panics "Insufficient
    /// payment" if the attached deposit is below OutLayer's required
    /// payment (mirrors execution.rs::request_execution, see
    /// `required_payment`). Default false: existing paths unchanged.
    pub test_reject_insufficient_payment: bool,
}

/// BUG FIX (found live on testnet, 2026-11-02 lifecycle matrix run):
/// this struct required a top-level `terms_hash: String` and claimed to
/// read `payer_account_id` at the top level, but escrow's actual
/// `resolution_input_data` (contracts/escrow/src/lib.rs) never emits
/// either at the top level -- both live nested under `envelope`/
/// `payer_account_id` is in fact a top-level field (verified against
/// source), but `terms_hash` genuinely is not: escrow sends
/// `{contract, bet_id, envelope, terms, round, run_no,
/// payer_account_id}`. The mismatch made `serde_json::from_str`
/// unconditionally fail and `request_execution` panic
/// ("bad input_data") on every single real call this contract has ever
/// received -- the mock's own request-dispatch path was completely
/// non-functional, always falling back to escrow's `on_resolution`
/// Failed-result branch. Fixed by matching the real shape; `bet_id` and
/// `force_outcome` (the only fields this mock actually uses) are read
/// correctly now.
#[derive(Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct InputData {
    bet_id: u64,
    #[allow(dead_code)]
    #[serde(default)]
    payer_account_id: Option<String>,
    /// Test-only control field, not part of the real resolver input: the
    /// E2E harness sets this so the mock can echo a specific outcome
    /// without running any real judging logic.
    #[serde(default)]
    force_outcome: Option<String>,
}

#[near]
impl MockOutlayer {
    #[init]
    pub fn new() -> Self {
        Self {
            next_request_id: 1,
            test_unused_compute_yocto: None,
            test_reject_insufficient_payment: false,
        }
    }

    /// Loop 6 test-only (FM-10/FM-11). See `test_unused_compute_yocto`
    /// doc. Permissionless -- this is a disposable testnet mock, not a
    /// security boundary (same convention as mock-intents'
    /// `set_fail_mt_transfer`).
    pub fn set_test_unused_compute(&mut self, amount_yocto: Option<U128>) {
        self.test_unused_compute_yocto = amount_yocto.map(|a| a.0);
    }

    /// Item 16d test-only: enable/disable the real-contract payment check.
    pub fn set_test_reject_insufficient_payment(&mut self, enabled: bool) {
        self.test_reject_insufficient_payment = enabled;
    }

    /// Signing key is NOT stored here (a real TEE key never touches
    /// contract state either); the harness passes the matching secret key
    /// out of band. This method exists purely so callers/tests can see the
    /// request was received and get a request_id correlated in logs.
    /// BUG FIX (found live, loop 6 -- `pause_during_open_bet` run logs):
    /// this used to end with a cross-contract call,
    /// `ext_caller::ext(predecessor).on_resolution(request_id, input_data,
    /// signature_hex)`, calling escrow's `on_resolution` DIRECTLY.
    /// Escrow's real `on_resolution(request_id)` takes one argument and
    /// is `#[private]` (only escrow calling itself may invoke it); a
    /// direct call from this contract always failed with "Method
    /// on_resolution is private" -- a dead-end, harmless-but-noisy inner
    /// receipt every single resolution request generated, visible in
    /// every testnet tx log since this mock existed but never actually
    /// blocking anything (escrow's OWN `.then()`-chained call to its own
    /// `on_resolution`, from `request_resolution`, is what really runs
    /// the callback; it never depended on this one). Fixed by simply
    /// returning the data synchronously -- escrow's `.then()` callback
    /// reads it from `env::promise_result(0)` either way, and it never
    /// needed a second hop through a method this contract was never
    /// authorized to call. Also carries the loop-6 FM-10/FM-11
    /// unused-compute report escrow's refund logic reads.
    #[payable]
    pub fn request_execution(
        &mut self,
        source: serde_json::Value,
        resource_limits: Option<serde_json::Value>,
        input_data: Option<String>,
        secrets_ref: Option<serde_json::Value>,
        response_format: Option<serde_json::Value>,
        payer_account_id: Option<String>,
        params: Option<serde_json::Value>,
    ) {
        // Item 16b (D-OL-WIRE1): the REAL OutLayer ABI -- these are
        // top-level JSON fields (pinned in
        // contracts/escrow/tests/fixtures/outlayer_request_execution_abi.json).
        // `source` is required: a call without it fails exactly like the
        // real contract ("missing field `source`").
        let _ = (&source, &secrets_ref, &response_format, &payer_account_id, &params);
        if self.test_reject_insufficient_payment {
            // Mirrors OutLayer a2a8510 execution.rs::request_execution +
            // lib.rs::estimate_cost (defaults), input storage ignored here.
            let rl = resource_limits.as_ref();
            let instr = rl.and_then(|r| r.get("max_instructions")).and_then(|v| v.as_u64()).unwrap_or(1_000_000_000);
            let secs = rl.and_then(|r| r.get("max_execution_seconds")).and_then(|v| v.as_u64()).unwrap_or(60);
            let required: u128 = 1_000_000_000_000_000_000_000u128
                + (instr / 1_000_000) as u128 * 100_000_000_000_000u128
                + (secs * 1000) as u128 * 100_000_000_000_000_000u128;
            let got = env::attached_deposit().as_yoctonear();
            if got < required {
                env::panic_str(&format!(
                    "Insufficient payment: required {required} yoctoNEAR, got {got} yoctoNEAR"
                ));
            }
        }
        let request_id = self.next_request_id;
        self.next_request_id += 1;
        let input_data = input_data
            .unwrap_or_else(|| env::panic_str("mock-outlayer: input_data required"));
        let input: InputData = serde_json::from_str(&input_data)
            .unwrap_or_else(|_| env::panic_str("mock-outlayer: bad input_data"));
        env::log_str(&format!(
            "mock-outlayer: request_id={request_id} bet_id={} outcome={:?}",
            input.bet_id, input.force_outcome
        ));
        let attached = env::attached_deposit().as_yoctonear();
        let unused = self.test_unused_compute_yocto.unwrap_or(0).min(attached);
        // Real shape: the callback gets the guest output as a raw JSON
        // value (value_return, not a JSON-encoded string). The
        // `unused_compute_yocto` key is a mock-only test knob (real
        // OutLayer refunds natively to payer_account_id).
        let out = serde_json::to_vec(&json!({
            "request_id": request_id,
            "input_data": input_data,
            "unused_compute_yocto": unused.to_string(),
        }))
        .unwrap();
        env::value_return(&out);
    }

    pub fn get_next_request_id(&self) -> u64 {
        self.next_request_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::{testing_env, NearToken};

    fn call(c: &mut MockOutlayer, deposit: u128, secs: u64) {
        testing_env!(VMContextBuilder::new()
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .build());
        c.request_execution(
            json!({"WasmUrl": {}}),
            Some(json!({"max_instructions": 500_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": secs})),
            Some(json!({"bet_id": 1}).to_string()),
            None, None, None, None,
        );
    }

    // Item 16d: pinned in escrow's tests/fixtures/outlayer_required_payment.json
    // (OutLayer a2a8510 execution.rs request_execution + lib.rs estimate_cost).
    #[test]
    #[should_panic(expected = "Insufficient payment")]
    fn rejects_when_deposit_below_required_payment() {
        let mut c = MockOutlayer::new();
        c.set_test_reject_insufficient_payment(true);
        call(&mut c, 10_000_000_000_000_000_000_000, 150); // 0.01 < 0.01605
    }

    #[test]
    fn accepts_exact_required_payment_and_default_mode_never_rejects() {
        let mut c = MockOutlayer::new();
        call(&mut c, 0, 150); // default: no enforcement
        c.set_test_reject_insufficient_payment(true);
        call(&mut c, 16_050_000_000_000_000_000_000, 150);
    }
}
