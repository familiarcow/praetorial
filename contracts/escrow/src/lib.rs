//! Praetorial escrow contract v1 (`bets.praetorial.near`).
//!
//! Implements the state machine, envelope, pending-payout ledger, bonds,
//! amendments, prune, pause and views from
//! "Praetorial - Escrow contract spec v1.md", governed by
//! "Praetorial - MASTER MAP.md" (lifecycle §3, rulings C1-C18, invariants
//! I-1..I-6). USDC only. Funds are intents.near multi-token balances;
//! `mt_on_transfer`/`mt_transfer` match
//! "Praetorial - Intents funding and payout spec v0.md" §3.
//!
//! SPEC ISSUES / deviations from the literal spec text are called out in
//! doc comments at the point of divergence, prefixed `SPEC ISSUE:`, and are
//! summarized in the build log and README. None of them touch I-1..I-6.

use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue, PromiseResult,
};

pub const BPS_DENOM: u128 = 10_000;
/// Max length for free-form "hash" strings accepted from callers
/// (terms_hash, models_snapshot_hash, exhibit/rebuttal/note hashes).
/// SECURITY FIX: none of these were length-bounded; a maker/party could
/// previously pay the flat minimum stake/deposit (which they control) and
/// attach an unbounded-length string, griefing the contract's (shared-pool
/// sponsored) storage for ~free. A real sha256/blake3 hex digest is 64
/// chars; 128 leaves headroom for other encodings without allowing
/// multi-KB/MB strings.
pub const MAX_HASH_LEN: usize = 128;
/// Item 7r: NEAR's own account-id length bound (used only to size the
/// `submitted_by` field's contribution to the storage-byte estimate below;
/// account IDs are validated by the `AccountId` type itself, not here).
pub const MAX_ACCOUNT_ID_LEN: usize = 64;
/// Max length of the full term-sheet JSON (`Envelope.terms`) kept onchain
/// when `keep_terms` is true (C9), and of a caller-supplied `terms`
/// argument to `request_resolution` for a hash-only bet. Resolver v1 spec
/// §1 estimates a real term sheet (≤5 elements, capped clause list) at
/// "low KB"; 8 KiB leaves headroom without letting a single bet hold an
/// unbounded blob (same griefing concern as `MAX_HASH_LEN` above, now that
/// `terms` -- not just its hash -- can land in contract storage).
pub const MAX_TERMS_LEN: usize = 8 * 1024;
/// D1: settlement_period documented bound, 1 hour floor / 90 day ceiling.
pub const MIN_SETTLEMENT_PERIOD_NS: u64 = 60 * 60 * 1_000_000_000;
pub const MAX_SETTLEMENT_PERIOD_NS: u64 = 90 * 24 * 60 * 60 * 1_000_000_000;
/// D-DISPUTE1 (dispute design v1 §3.5): after any re-judge, the next
/// `finalize` window is fixed at 24h, never the full `settlement_period`
/// again (closes the up-to-270-day-lock griefing vector on a 90d bet
/// with repeated challenge rounds). Used as `min(settlement_period,
/// ROUND_WINDOW_NS)` so a bet with a settlement_period UNDER 24h keeps
/// using its own (shorter) period, never lengthened by a challenge.
pub const ROUND_WINDOW_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
/// D-STORAGE1 (STG1; supersedes the old D4 flat per-byte rate): storage is
/// billed per asset. Each entry in the asset table carries `storage_per_kib`
/// (raw units of that asset per 1,024 bytes), and the CONTRACT computes each
/// side's charge from the envelope's estimated stored bytes in that side's
/// own asset (`Envelope::storage_for`). The envelope's own
/// `storage_charge_per_side` field must be "0" (`sanity_check` refuses
/// anything else), so a caller can never pick or under-state the charge.
/// The computed amounts are stored on the bet as `storage_maker` /
/// `storage_taker`.
///
/// STG1 test fixture rate (raw units / KiB) used by every test asset table:
/// ceil(3248*6305/2048) = 10_000 for the standard base_envelope (3248
/// est. bytes).
#[cfg(test)]
pub const STG_FIXTURE_RATE: u128 = 6305;
/// Per-bet storage-estimate overhead: a conservative allowance for the
/// near-event log lines written alongside the always-written hash fields
/// (terms_hash, models_snapshot_hash, counted separately in
/// `estimated_storage_bytes`).
pub const STORAGE_EVENT_OVERHEAD_BYTES: u64 = 256;
/// D6 (Tyler, 2026-11-02): beta limits defaults, no admin (contract is
/// immutable). Deploy scripts should pass these unless Tyler specifies
/// otherwise for a given deployment.
/// D-CAP2 (supersedes D-CAP1, which itself superseded D6's 250
/// USDC/side beta cap): each asset's max stake per side in the asset
/// table is set to ~$1,000 equivalent at init, enforced per side for
/// same-asset AND cross-asset bets (`handle_open`/`handle_take`'s
/// `AssetLimit.max_per_side` checks). No longer coupled to
/// `beta_sunset_ns` in any way -- the cap is permanent, the sunset is
/// a separate (and unrelated) new-offers cutoff.
pub const DEFAULT_MAX_STAKE_PER_SIDE_USDC: u128 = 1_000_000_000; // 1,000 USDC @ 6dp
/// D-PRICE2 default: $5-equivalent minimum per side, USDC 6dp. Used by the
/// default USDC entry in the per-asset whitelist (`AssetLimit`) deploy
/// scripts should pass unless Tyler specifies otherwise.
/// D-FEEPIN1 (C12/D-ECON2/D-ECON5/D-FEESPLIT1: "1% of pot"): the protocol
/// fee, in bps, pinned into contract state at `new()`. `handle_open`
/// refuses any envelope with a different `fee_bps`.
pub const PROTOCOL_FEE_BPS_V1: u32 = 100;
pub const DEFAULT_MIN_STAKE_PER_SIDE_USDC: u128 = 5_000_000; // $5 @ 6dp
/// CAP3b: hard ceiling on any asset's `max_per_side`, enforced by `new()`, `propose_params` and `propose_asset`.
/// 10^34 raw = largest power of ten <= u128::MAX / 4096, so the challenge-bond floor (`pot * 1000`, checked u128)
/// cannot overflow at the cap. Mirrors services/release `launchMaxPerSide()` (a test pins the two together).
pub const MAX_PER_SIDE_CEILING: u128 = 10_000_000_000_000_000_000_000_000_000_000_000; // 10^34
/// D-PRICE3: maximum odds (by stake ratio) allowed between the two sides
/// of a bet, checked only when both sides stake the same asset (a
/// cross-asset ratio needs a reference rate -- D-PRICE4/5/6 territory,
/// out of scope for this sub-job; see `handle_open`).
pub const MAX_SAME_ASSET_ODDS: u128 = 10;

/// D-HORIZON1a (supersedes D-HORIZON1's 365 days): a bet's `resolve_deadline`
/// may be at most 1,461 days (4 years incl. one leap day) after the open
/// block time.
pub const MAX_HORIZON_NS: u64 = 1_461 * 86_400 * 1_000_000_000;
/// Sub-job 2 (cross-asset-2, D-PRICE6): griefing-length guard on
/// `Envelope.taker_options`, same spirit as `MAX_HASH_LEN` for free-form
/// strings -- bounds how many extra (asset, amount) options a maker can
/// attach to one offer (the primary `taker_asset`/`stake_taker` pair is
/// not counted against this; it's a separate field).
pub const MAX_TAKER_OPTIONS: usize = 8;
pub const DEFAULT_BETA_SUNSET_DURATION_NS: u64 = 90 * 24 * 60 * 60 * 1_000_000_000;
/// D-DISPUTE1 (Tyler, 2026-11-04, "Praetorial - Dispute design v1"):
/// default cap on the number of challenge/re-judge rounds a bet may go
/// through (RF2: AI challenge rounds only -- the human referee path has
/// no rounds) before the standing outcome settles -- `Limits.max_rounds` below. Supersedes
/// D-AUDIT8's default of 3 (OQ-T10 ruling). Round 0 (the automatic
/// initial ruling) is never counted here -- `bet.bonds.len()` only grows
/// on a challenge bond, so `max_rounds=2` means exactly two challenge
/// rounds are reachable: round 1 ("Review", a 3-model-family panel) and
/// round 2 ("Final appeal", a 5-family panel + debate prompt). 2 is the
/// default a deploy omitting the field gets (see its
/// `#[serde(default = ...)]`); callers may set a different value
/// explicitly.
pub const DEFAULT_MAX_ROUNDS: u32 = 2;
fn default_max_rounds() -> u32 {
    DEFAULT_MAX_ROUNDS
}
/// D-RESOLVE1 (item 7d): recovery-ladder cap mirrored from
/// `judge-proto/evidence.py::resolve_with_recovery` (RECOVERY_CAP_D = 7,
/// 24h-step retries). A VOID-for-unavailability is refused until EITHER
/// `now >= first_unavailable_ns + RECOVERY_WINDOW_NS` OR
/// `retry_count >= Limits.max_retries` (default below) is reached.
/// JC1s (D-JUDGECHAIN1 #8): the resolver's signed "no live judge" result.
/// A RETRY form (carries `next_check_ns`, <=48h horizon) that is NOT an outage
/// signal: it never sets `first_unavailable_ns`, never counts toward
/// `max_retries` and does not consume a paid run, so the 7-day recovery window
/// is untouched and `void_after_deadline` still refunds at `resolve_deadline`.
pub const NO_LIVE_JUDGE_OUTCOME: &str = "RETRY:no_live_judge";
/// JCB1 (D-JCB1): minimum gap between a `RETRY:no_live_judge` and the next `request_resolution`.
pub const NO_LIVE_JUDGE_WAIT_MSG: &str = "waiting for a live judge model";
/// JCD1: `Bet.request_judge_snapshot` value meaning "no pair was live at request time".
const NO_LIVE_SNAPSHOT: u32 = u32::MAX;
/// JCD1 (D-JCD1 #3 / B3): a signed not-found observation must be at most this old (a stateless resolver only ever
/// observes "now"), so 3 retirement checks >= 24h apart really are 3 separate results in real time.
const OBSERVATION_MAX_AGE_NS: u64 = 3_600 * 1_000_000_000;
pub const NO_LIVE_JUDGE_MIN_GAP_NS: u64 = 12 * 60 * 60 * 1_000_000_000;
pub const RECOVERY_WINDOW_NS: u64 = 7 * 24 * 60 * 60 * 1_000_000_000;
/// Default cap on resolver RETRY rounds before VOID-for-unavailability is
/// admissible on the retry-count branch of the gate (init-configurable
/// via `Limits.max_retries`).
pub const DEFAULT_MAX_RETRIES: u32 = 7;
fn default_max_retries() -> u32 {
    DEFAULT_MAX_RETRIES
}
/// RETRY's signed `next_check_ns` must be in the future (never already
/// elapsed -- that would let a stale/replayed RETRY re-arm immediately)
/// and no more than this far out, so a misbehaving/compromised resolver
/// can't park a bet in RETRY indefinitely with one signature. Chosen to
/// comfortably exceed the 24h recovery step with margin for clock skew
/// and keeper scheduling jitter, while still bounding the blast radius.
pub const MAX_RETRY_HORIZON_NS: u64 = 48 * 60 * 60 * 1_000_000_000;
/// mt_on_transfer's forwarded-gas budget per the funding spec (default
/// NotifyOnTransfer.min_gas is 30 TGas; this contract's logic is O(1) state
/// map lookups + one hash compare, measured well under that on testnet --
/// see build log "gas measurements").
pub const MT_ON_TRANSFER_GAS_BUDGET_TGAS: u64 = 30;

// ---------------------------------------------------------------------
// OutLayer constants mirrored from outlayer's own contract
// (execution.rs), read this session at
// ~/.hermes/cache/scratch/praetorial-research/outlayer/contract/src/execution.rs
// and lib.rs. These are OutLayer's hard platform caps / pricing, not ours
// -- duplicated here (escrow can't depend on OutLayer's crate across
// repos) so `request_resolution` can request exactly the hard limit and
// correctly size the attached NEAR deposit instead of guessing.
// ---------------------------------------------------------------------

/// `execution.rs::MAX_INSTRUCTIONS` -- the hard ceiling OutLayer enforces
/// on `resource_limits.max_instructions`; a request above it panics on
/// OutLayer's side before ever running. Per the L1/L2/L3 ruling, escrow
/// requests this ceiling itself rather than a smaller guessed number, so
/// a resolver job is never instruction-starved by an escrow-side under-ask.
pub const OUTLAYER_MAX_INSTRUCTIONS: u64 = 500_000_000_000;
/// `execution.rs::MAX_EXECUTION_SECONDS` -- OutLayer's own hard cap on
/// wall-clock execution time; used below as the "other tiers" value.
pub const OUTLAYER_PLATFORM_MAX_EXECUTION_SECONDS: u64 = 180;
/// Queue item 11: until a 180s OutLayer run has actually completed on
/// testnet, no tier requests more than 150s (the yield/timeout margin
/// at 180s is unproven). Raise back to the platform value only after
/// that run is recorded in the build log.
pub const OUTLAYER_MAX_EXECUTION_SECONDS_CAP: u64 = 150;
/// Ruling: tier 0 ("tier1" in the stake-tier tables, MASTER MAP C13 /
/// Evidence doc §11 -- the contract's `Envelope.tier` field is
/// zero-indexed) gets a shorter budget since it runs the smallest panel
/// (≤2 elements × 1 model × 3 runs, Resolver v1 spec §3.4); every other
/// tier gets the full OutLayer ceiling since larger panels need the room.
pub const TIER1_MAX_EXECUTION_SECONDS: u64 = 120;
/// `lib.rs::INPUT_DATA_FREE_BYTES` -- bytes of `input_data` OutLayer holds
/// in state for free; every byte beyond this is charged for the life of
/// the pending request.
pub const OUTLAYER_INPUT_DATA_FREE_BYTES: usize = 32 * 1024;
/// `lib.rs::STORAGE_PRICE_PER_BYTE` -- yoctoNEAR/byte OutLayer charges for
/// `input_data` held above the free threshold (same rate as NEAR's own
/// storage staking cost).
pub const OUTLAYER_STORAGE_PRICE_PER_BYTE: u128 = 10_000_000_000_000_000_000;
/// Item 16d (D-RESOLVE4): OutLayer's own pricing, derived from
/// out-layer/outlayer @ a2a8510 `contract/src/lib.rs::estimate_cost` (defaults
/// in `new()`), pinned in `tests/fixtures/outlayer_required_payment.json`:
/// `base_fee + (max_instructions/1e6)*per_million_instructions_fee
///  + (max_execution_seconds*1000)*per_ms_fee`. `max_memory_mb` is not priced.
pub const OUTLAYER_BASE_FEE_YOCTO: u128 = 1_000_000_000_000_000_000_000;
pub const OUTLAYER_PER_MILLION_INSTRUCTIONS_FEE_YOCTO: u128 = 100_000_000_000_000;
pub const OUTLAYER_PER_MS_FEE_YOCTO: u128 = 100_000_000_000_000_000;
/// Safety margin on the derived requirement (OutLayer's fees are
/// owner-settable): 5/4 = +25%. Unused compute is refunded by OutLayer
/// (and by `on_resolution` to the payer / keeper pool), so margin is not
/// a cost, only float.
pub const RESOLUTION_COMPUTE_MARGIN_NUM: u128 = 5;
pub const RESOLUTION_COMPUTE_MARGIN_DEN: u128 = 4;

/// OutLayer's exact `estimate_cost` for a request sent by this contract.
pub const fn outlayer_estimated_cost(max_instructions: u64, max_execution_seconds: u64) -> u128 {
    OUTLAYER_BASE_FEE_YOCTO
        + (max_instructions / 1_000_000) as u128 * OUTLAYER_PER_MILLION_INSTRUCTIONS_FEE_YOCTO
        + (max_execution_seconds * 1000) as u128 * OUTLAYER_PER_MS_FEE_YOCTO
}

/// Compute-side deposit floor for a tier timeout: formula + margin.
pub const fn resolution_compute_floor(max_execution_seconds: u64) -> u128 {
    outlayer_estimated_cost(OUTLAYER_MAX_INSTRUCTIONS, max_execution_seconds)
        * RESOLUTION_COMPUTE_MARGIN_NUM
        / RESOLUTION_COMPUTE_MARGIN_DEN
}

/// Compute floor used by `request_resolution`. Cost is monotonic in
/// `max_execution_seconds` and no tier sends more than
/// `OUTLAYER_MAX_EXECUTION_SECONDS_CAP`, so the floor at the cap (150 s:
/// 0.01605 NEAR required -> 0.0200625 NEAR) covers EVERY tier; tier 0
/// (120 s, 0.01305 required) over-attaches by a refunded amount.
pub const MIN_RESOLUTION_COMPUTE_DEPOSIT: NearToken =
    NearToken::from_yoctonear(resolution_compute_floor(OUTLAYER_MAX_EXECUTION_SECONDS_CAP));

const OUTLAYER_GAS: Gas = Gas::from_tgas(80);
const RESOLUTION_CALLBACK_GAS: Gas = Gas::from_tgas(20);
const PAYOUT_GAS: Gas = Gas::from_tgas(15);
const PAYOUT_CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// OQ-T11: max ledger lines `drain_payouts` fires in one call.
/// 10 * (PAYOUT_GAS + PAYOUT_CALLBACK_GAS) = 250 Tgas static, leaving
/// 50 Tgas of headroom under NEAR's 300 Tgas per-call ceiling for the
/// call's own base overhead -- see `oq_t11_drain_payouts_batch_fits_300_tgas`.
const MAX_DRAIN_BATCH: u64 = 10;
/// Red team 2026-11-07: max ids kept in the root-state `open_bet_ids`
/// listing index (80 KB). Bounds per-call state read/write gas.
pub const MAX_OPEN_INDEX_LEN: usize = 10_000;
/// Red team 2026-11-07: max bytes of the OutLayer result kept in
/// `Bet.last_resolution_raw` (informational only), so a huge result cannot
/// push `on_resolution` over its gas budget.
pub const MAX_RESOLUTION_RAW_BYTES: usize = 16 * 1024;
/// Gas for the loop-6 unused-compute refund call (native `Promise::transfer`
/// needs none; the intents-credit rail is one cross-contract call, same
/// budget class as `fire_payout`'s `mt_transfer`).
const REFUND_GAS: Gas = Gas::from_tgas(15);
/// D-MN1: the mainnet intents account. An escrow whose pinned `intents` is
/// this account is a mainnet build; everything else (the testnet
/// `mock-intents`, sandbox accounts) is a test deployment. Derived from the
/// already-pinned `intents` field, so no state layout / `new()` change.
pub const MAINNET_INTENTS_ACCOUNT: &str = "intents.near";
/// Loop 6 (FM-10) / D-MN1: the intents-balance token id an AuthCall-
/// initiated unused-compute refund is credited into on the TESTNET mock
/// only (an arbitrary distinct id so it never collides with
/// `usdc_token_id` in `mock-intents`' shared balance map).
const TESTNET_WNEAR_TOKEN_ID: &str = "nep141:wrap.testnet";
/// wNEAR's real NEP-141 token id on intents.near (mainnet).
const MAINNET_WNEAR_TOKEN_ID: &str = "nep141:wrap.near";

fn require(cond: bool, msg: &str) {
    if !cond {
        env::panic_str(msg);
    }
}

fn hex_decode(s: &str) -> Result<Vec<u8>, ()> {
    if s.len() % 2 != 0 {
        return Err(());
    }
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i < b.len() {
        let hi = (b[i] as char).to_digit(16).ok_or(())?;
        let lo = (b[i + 1] as char).to_digit(16).ok_or(())?;
        out.push(((hi << 4) | lo) as u8);
        i += 2;
    }
    Ok(out)
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// D-FETCH2 (item 7f2b): mirrors `resolver/core::sourcecheck_message`
/// and `services/common/src/sourceCheck.ts::buildSourceCheckMessage`
/// byte-for-byte -- all three (plus `judge-proto/evidence.py`) pin
/// against `contracts/escrow/tests/fixtures/sourcecheck_crosscheck.json`.
/// `spec_hash` is deliberately `Envelope.terms_hash`, no new hash scheme.
pub fn sourcecheck_message(spec_hash: &str, checked_at_ns: u64) -> String {
    format!("praetorial:sourcecheck:v1:{}:{}", spec_hash, checked_at_ns)
}

/// D-FETCH2 (item 7f2b): Open attestation freshness window, inclusive
/// at the boundary -- exactly 1h old passes, 1h+1ns fails. Matches
/// `services/common/src/sourceCheck.ts::isSourceCheckFresh`/
/// `SOURCECHECK_FRESHNESS_WINDOW_NS`.
pub const SOURCECHECK_FRESHNESS_NS: u64 = 3_600 * 1_000_000_000;

/// Ruling: resource limits are derived from the envelope's stake tier, not
/// hardcoded. Tier 0 ("tier1" in the stake-tier docs -- `Envelope.tier` is
/// zero-indexed, see test fixtures / `base_envelope`) gets a shorter
/// wall-clock budget since it runs the smallest model panel; every other
/// tier gets OutLayer's own full `MAX_EXECUTION_SECONDS` ceiling. Pulled
/// out as a pure function so it's unit-testable without a cross-contract
/// call.
fn max_execution_seconds_for_tier(tier: u8) -> u64 {
    if tier == 0 {
        TIER1_MAX_EXECUTION_SECONDS
    } else {
        OUTLAYER_MAX_EXECUTION_SECONDS_CAP
    }
}

/// `max_instructions` is requested at OutLayer's own hard ceiling
/// (`OUTLAYER_MAX_INSTRUCTIONS`) rather than a smaller guess -- the
/// resolver's pipeline (Resolver v1 spec §2) is pinned code with its own
/// internal budgeting, so asking for less than the platform allows only
/// risks an under-provisioned run for no safety benefit (OutLayer bills by
/// *actual* usage, not the requested ceiling, per its
/// `calculate_cost`/`estimate_cost`).
const RESOLUTION_MAX_MEMORY_MB: u32 = 128;

/// The NEAR deposit `request_resolution` must require, given the byte
/// length of the `input_data` string it is about to send to OutLayer.
/// Mirrors `execution.rs::request_execution`'s own check (`required_payment
/// = estimated_cost + input_storage_deposit(len)`): the first
/// `OUTLAYER_INPUT_DATA_FREE_BYTES` are free, every byte above that costs
/// `OUTLAYER_STORAGE_PRICE_PER_BYTE` for the life of the pending request.
/// We have no way to call OutLayer's live compute estimator from here, so
/// `MIN_RESOLUTION_COMPUTE_DEPOSIT` stands in as a generous flat floor for
/// the compute side; the storage side is computed exactly, since it's a
/// pure function of a length this contract already has. Pulled out as a
/// pure function so the size-limit behavior is unit-testable directly.
fn required_resolution_deposit(input_len: usize) -> u128 {
    let storage_component = input_len.saturating_sub(OUTLAYER_INPUT_DATA_FREE_BYTES) as u128
        * OUTLAYER_STORAGE_PRICE_PER_BYTE;
    MIN_RESOLUTION_COMPUTE_DEPOSIT.as_yoctonear() + storage_component
}

/// Builds the exact `input_data` string `request_resolution` sends to
/// OutLayer. SPEC (layer-spec ruling): full stored envelope + terms (when
/// present) + round + run_no + contract id -- see `request_resolution`'s
/// own doc for the full reasoning. Pure function, deliberately: the
/// resolver-facing shape is the thing most worth pinning with a direct
/// unit test (Resolver v1 spec §1 byte-for-byte skew warning), so it does
/// not depend on `env::` or contract state beyond what's passed in.
/// D-JUDGECHAIN1a #3: ASCII `org/model`, <= 128 bytes, exactly one `/`, both halves non-empty, no whitespace/quotes/control.
fn validate_model_id(m: &str) {
    require(!m.is_empty(), "judge pair model ids must be non-empty");
    require(m.len() <= MAX_MODEL_ID_LEN, "model id longer than 128 bytes");
    require(
        m.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b':' | b'+' | b'/')),
        "model id must be ASCII (letters, digits, . _ - : +)",
    );
    let mut parts = m.split('/');
    let (org, model, rest) = (parts.next(), parts.next(), parts.next());
    require(
        matches!((org, model, rest), (Some(o), Some(n), None) if !o.is_empty() && !n.is_empty()),
        "model id must have the form org/model",
    );
}

/// D-JUDGECHAIN1: a pair is two distinct, valid model ids.
fn validate_judge_pair(p: &JudgePair) {
    validate_model_id(&p.model_a);
    validate_model_id(&p.model_b);
    require(p.model_a != p.model_b, "judge pair needs two distinct models");
}

/// Pairs are unordered: (a, b) and (b, a) are the same pair.
fn same_judge_pair(x: &JudgePair, y: &JudgePair) -> bool {
    (x.model_a == y.model_a && x.model_b == y.model_b) || (x.model_a == y.model_b && x.model_b == y.model_a)
}

fn judge_chain_has_pair(chain: &[JudgePair], p: &JudgePair) -> bool {
    chain.iter().any(|q| same_judge_pair(q, p))
}

fn validate_judge_chain(chain: &[JudgePair]) {
    require(
        chain.len() >= MIN_INITIAL_JUDGE_PAIRS && chain.len() <= MAX_INITIAL_JUDGE_PAIRS,
        "judge_chain must have 2..=4 pairs at init",
    );
    for (i, p) in chain.iter().enumerate() {
        validate_judge_pair(p);
        require(!judge_chain_has_pair(&chain[..i], p), "duplicate judge pair in judge_chain");
    }
}

/// D-JUDGECHAIN1a #1 (mirrors resolver/core judge_chain::model_retired): 3 observations, each >= 24h after the previous.
fn model_retired(obs: &[u64]) -> bool {
    let mut v: Vec<u64> = obs.to_vec();
    v.sort_unstable();
    let (mut count, mut last): (usize, Option<u64>) = (0, None);
    for t in v {
        if last.map_or(true, |l| t >= l.saturating_add(RETIRE_MIN_GAP_NS)) {
            count += 1;
            last = Some(t);
            if count >= RETIRE_OBSERVATIONS {
                return true;
            }
        }
    }
    false
}

/// Mirrors resolver/core judge_chain::add_observation: sorted, < 24h after the last kept one is not a new check, cap 3.
fn add_observation(obs: &[u64], ts: u64) -> Vec<u64> {
    let mut v: Vec<u64> = obs.to_vec();
    v.sort_unstable();
    if v.len() >= RETIRE_OBSERVATIONS {
        return v;
    }
    if v.last().map_or(true, |l| ts >= l.saturating_add(RETIRE_MIN_GAP_NS)) {
        v.push(ts);
    }
    v
}

/// Index of the first chain pair whose two models are both live (neither retired).
fn first_live_index(chain: &[JudgePair], missing: &std::collections::BTreeMap<String, Vec<u64>>) -> Option<usize> {
    let retired = |m: &String| missing.get(m).map_or(false, |o| model_retired(o));
    chain.iter().position(|p| !retired(&p.model_a) && !retired(&p.model_b))
}

/// D-JUDGECHAIN1a S3: one NEP-297 event, same key order as the pre-existing hand-formatted events.
/// Validates one asset's limits and pins the min-fee cap (D-FEEMIN1, D-PARAMS1). Shared by `new()` and AS1's
/// `propose_asset` so a guardian-added asset is held to exactly the launch-time rules.
fn validate_asset_limit(limit: AssetLimit) -> AssetLimit {
    require(limit.min_per_side.0 <= limit.max_per_side.0, "asset_limits: min must be <= max");
    require(limit.max_per_side.0 <= MAX_PER_SIDE_CEILING, "asset_limits: max_per_side exceeds the 10^34 raw ceiling");
    // D-FEEMIN1: minimum fee per side, > 0 and <= min_per_side/20.
    require(limit.min_fee_per_side.0 > 0, "asset_limits: min_fee_per_side must be > 0");
    require(
        limit.min_fee_per_side.0 <= limit.min_per_side.0 / 20,
        "asset_limits: min_fee_per_side must be <= min_per_side/20",
    );
    require(limit.run_price.0 > 0, "asset_limits: run_price must be > 0");
    require(limit.storage_per_kib.0 > 0, "asset_limits: storage_per_kib must be > 0");
    require(limit.min_bond.0 > 0, "asset_limits: min_bond must be > 0");
    require(limit.min_objection.0 > 0, "asset_limits: min_objection must be > 0");
    let mut limit = limit;
    // D-PARAMS1: pin the per-asset min-fee cap. Unset (0) = pinned at the initial min fee.
    if limit.min_fee_cap_per_side.0 == 0 {
        limit.min_fee_cap_per_side = limit.min_fee_per_side;
    }
    require(
        limit.min_fee_cap_per_side.0 >= limit.min_fee_per_side.0,
        "asset_limits: min_fee_cap_per_side must be >= min_fee_per_side",
    );
    limit
}

fn emit_event(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"{EVENT_STANDARD}\",\"version\":\"{EVENT_VERSION}\",\"event\":\"{event}\",\"data\":[{data}]}}"
    ));
}

fn resolution_input_data(
    contract_id: &AccountId,
    bet_id: u64,
    envelope: &Envelope,
    terms: &Option<String>,
    round: u32,
    run_no: u64,
    payer_account_id: &AccountId,
    judge_chain: &[JudgePair],
) -> String {
    resolution_input_data_with_missing(
        contract_id,
        bet_id,
        envelope,
        terms,
        round,
        run_no,
        payer_account_id,
        judge_chain,
        &std::collections::BTreeMap::new(),
    )
}

/// JC1x (D-JUDGECHAIN1a #1/#5): same, plus the shared retirement state: `model_missing` (only models that have
/// observations) and `retired_models` (the flags), so the resolver walks to the first live pair.
fn resolution_input_data_with_missing(
    contract_id: &AccountId,
    bet_id: u64,
    envelope: &Envelope,
    terms: &Option<String>,
    round: u32,
    run_no: u64,
    payer_account_id: &AccountId,
    judge_chain: &[JudgePair],
    model_missing: &std::collections::BTreeMap<String, Vec<U64>>,
) -> String {
    let retired: Vec<&String> = model_missing
        .iter()
        .filter(|(_, v)| model_retired(&v.iter().map(|x| x.0).collect::<Vec<_>>()))
        .map(|(m, _)| m)
        .collect();
    json!({
        "contract": contract_id,
        "bet_id": bet_id,
        "envelope": envelope,
        "terms": terms,
        "round": round,
        "run_no": run_no,
        "payer_account_id": payer_account_id,
        // D-JUDGECHAIN1: the CURRENT ordered chain of judge pairs (contract-level,
        // read at request time so open bets see later appends).
        "judge_chain": judge_chain,
        "model_missing": model_missing,
        "retired_models": retired,
    })
    .to_string()
}

fn verify_sig(pubkey_hex: &str, sig_hex: &str, message: &[u8]) -> bool {
    let (Ok(pk), Ok(sig)) = (hex_decode(pubkey_hex), hex_decode(sig_hex)) else {
        return false;
    };
    if pk.len() != 32 || sig.len() != 64 {
        return false;
    }
    let mut pkb = [0u8; 32];
    pkb.copy_from_slice(&pk);
    let mut sigb = [0u8; 64];
    sigb.copy_from_slice(&sig);
    env::ed25519_verify(&sigb, message, &pkb)
}

// ---------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------

/// History (pre-RF2): D-REF1 introduced the one optional referee role,
/// replacing the human arbiter (removed: arbiter_submit/arbiter_pick and the
/// arbiter payout path are gone -- arbiter_fee was removed in 3e74172).
/// RF2 / D-REFUI4 (replaces the removed Witness/Source/FinalSay modes): a bet is
/// decided by exactly ONE method -- the AI (no referee) or a named human
/// (`Human`). The human rules YES/NO/VOID once via `referee_rule`; no AI
/// run, no settlement window, no bonds. An optional per-bettor tip is
/// carved out of that bettor's own stake (`Bet.tip_maker/tip_taker`).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RefereeMode {
    /// A named human decides the bet instead of the AI.
    Human,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Referee {
    pub account: AccountId,
    pub mode: RefereeMode,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TakerAllow {
    Any,
    Account(AccountId),
    /// ed25519 pubkey (hex) that must sign an invite message to take.
    InvitePubkey(String),
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Envelope {
    pub bet_id: u64,
    pub version: u32,
    pub maker: AccountId,
    pub taker_allow: TakerAllow,
    pub terms_hash: String,
    // D-KEY1: resolver_wasm_hash and resolver_pubkey are no longer a
    // maker choice on the envelope -- both are pinned contract-level
    // config set once at `new()` (Contract::resolver_wasm_hash,
    // Contract::outcome_pubkey, Contract::attest_pubkey). See
    // resolver_keys() and every `verify_sig` call site.
    pub models_snapshot_hash: String,
    /// Always ["YES", "NO"] in v1.
    pub outcomes: Vec<String>,
    pub maker_side: String,
    /// Sub-job 1 (D-PRICE6): asset each side stakes, as an intents
    /// multi-token id (e.g. `nep141:usdc.testnet`). Must be a key in the
    /// contract's immutable `asset_limits` whitelist (checked in
    /// `handle_open`). For same-asset bets these are equal; this
    /// sub-job only generalises the data model -- cross-asset taker
    /// options, settlement maths and bonds are later sub-jobs.
    pub maker_asset: String,
    pub taker_asset: String,
    pub stake_maker: U128,
    pub stake_taker: U128,
    /// Sub-job 2 (cross-asset-2, D-PRICE6): additional (asset, amount)
    /// options the maker also accepts from the taker, beyond the
    /// primary `taker_asset`/`stake_taker` pair above. Per D-PRICE6 the
    /// maker fixes the EXACT amount for every foreign asset they'll
    /// accept -- there is no onchain pricing. `handle_open` validates
    /// every entry (whitelisted, within that asset's min/max, and the
    /// 10:1 odds cap IF its asset equals `maker_asset` -- cross-asset
    /// odds are never checked onchain, per D-PRICE6). `handle_take`
    /// accepts a deposit matching this pair OR any one option exactly;
    /// whichever one is used is recorded by overwriting `taker_asset`/
    /// `stake_taker` with it (see `handle_take`), so every downstream
    /// read of those two fields reflects what the taker actually paid.
    /// `#[serde(default)]` so existing JSON callers that predate this
    /// sub-job (single-option offers) still parse with no options.
    #[serde(default)]
    pub taker_options: Vec<TakerOption>,
    pub fee_bps: u32,
    pub storage_charge_per_side: U128,
    pub keep_terms: bool,
    /// Full term-sheet JSON text (ruling C9: kept onchain by default).
    /// `Some(_)` iff `keep_terms` is true (enforced in `sanity_check`);
    /// `None` for a hash-only bet (`keep_terms: false`), in which case
    /// only `terms_hash` is ever stored and `request_resolution` accepts
    /// an optional caller-supplied copy each time it resolves instead
    /// (never persisted -- see that method's doc). Cleared to `None` by
    /// `prune_terms` the same way `terms_hash` is stubbed.
    pub terms: Option<String>,
    pub max_paid_runs: u32,
    pub tier: u8,
    /// D-REF1: the one optional referee role, replacing the arbiter
    /// (history: the removed `arbiter_submit`/`arbiter_pick` are gone;
    /// see `RefereeMode`).
    #[serde(default)]
    pub referee: Option<Referee>,
    /// RF2 / D-REFUI4: the maker opts in (at open) to tipping the referee.
    #[serde(default)]
    pub tip_maker: bool,
    /// Nanosecond timestamps.
    pub funding_deadline: u64,
    pub early_settle_outcome: Option<String>,
    pub finality_delay: u64,
    pub settlement_period: u64,
    pub resolve_deadline: u64,
    pub consent_party_controlled: bool,
}

/// Sub-job 2 (cross-asset-2, D-PRICE6): one additional (asset, amount)
/// a maker will accept from the taker, beyond the primary
/// `Envelope.taker_asset`/`stake_taker` pair. See `Envelope.taker_options`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TakerOption {
    pub asset: String,
    pub amount: U128,
}

impl Envelope {
    fn sanity_check(&self) -> Result<(), &'static str> {
        if self.outcomes != vec!["YES".to_string(), "NO".to_string()] {
            return Err("outcomes must be [YES, NO]");
        }
        if self.maker_side != "YES" && self.maker_side != "NO" {
            return Err("maker_side must be YES or NO");
        }
        if self.stake_maker.0 == 0 || self.stake_taker.0 == 0 {
            return Err("stakes must be > 0");
        }
        // Sub-job 1 (D-PRICE6 data model): asset ids are bounded like the
        // other free-form strings in this struct -- whitelist membership
        // (the real asset validity check) happens in `handle_open`, which
        // has access to contract state; this is just a griefing-length
        // guard so sanity_check (no contract state) still bounds the field.
        if self.maker_asset.is_empty() || self.maker_asset.len() > MAX_HASH_LEN {
            return Err("maker_asset must be non-empty and bounded length");
        }
        if self.taker_asset.is_empty() || self.taker_asset.len() > MAX_HASH_LEN {
            return Err("taker_asset must be non-empty and bounded length");
        }
        // Sub-job 2 (cross-asset-2): same griefing-length guard as every
        // other free-form field here -- whitelist/limit/odds validity
        // (the checks that need contract state) happen in `handle_open`.
        if self.taker_options.len() > MAX_TAKER_OPTIONS {
            return Err("taker_options exceeds MAX_TAKER_OPTIONS");
        }
        for opt in &self.taker_options {
            if opt.asset.is_empty() || opt.asset.len() > MAX_HASH_LEN {
                return Err("taker_options asset must be non-empty and bounded length");
            }
            if opt.amount.0 == 0 {
                return Err("taker_options amount must be > 0");
            }
        }
        if self.fee_bps as u128 > BPS_DENOM {
            return Err("fee_bps out of range");
        }
        if self.max_paid_runs == 0 {
            return Err("max_paid_runs must be > 0");
        }
        // D-KEY1: resolver_pubkey/resolver_wasm_hash length validation
        // moved to Contract::new (they're pinned contract-level config
        // now, not maker-supplied envelope fields).
        // SECURITY FIX: these were previously unbounded, letting a maker
        // pay only the (self-chosen) minimum stake/storage_charge while
        // attaching an arbitrarily large string -- storage griefing against
        // the shared sponsorship pool. terms_hash/models_snapshot_hash get
        // a generous but finite cap.
        if self.terms_hash.len() > MAX_HASH_LEN {
            return Err("terms_hash too long");
        }
        if self.models_snapshot_hash.len() > MAX_HASH_LEN {
            return Err("models_snapshot_hash too long");
        }
        // SPEC (layer-spec ruling): `terms` and `keep_terms` must agree.
        // A keep_terms:true bet with no terms text would hand
        // `request_resolution` nothing to put in input_data; a
        // keep_terms:false bet carrying terms text anyway would defeat
        // the point of the hash-only opt-out (and the storage griefing
        // guard below). NOTE: this does NOT check
        // sha256(terms)==terms_hash -- that check belongs to the
        // resolver (Resolver v1 spec §1's forced decision), which is the
        // only party that needs the plaintext to do anything with it;
        // the contract only bounds length/presence.
        match (&self.terms, self.keep_terms) {
            (Some(t), true) => {
                if t.is_empty() || t.len() > MAX_TERMS_LEN {
                    return Err("terms length out of bounds");
                }
            }
            (None, true) => return Err("keep_terms is true but terms is missing"),
            (Some(_), false) => return Err("terms must be None when keep_terms is false"),
            (None, false) => {}
        }
        // D1 (design decision): settlement_period must sit within the
        // documented 1h-90d bound (MASTER MAP C10 / Decisions log D8);
        // previously only `> 0` was enforced, so chaos found 1ns and
        // 91-day values both accepted. Enforced here (offer creation,
        // via handle_open -> sanity_check) and re-checked at `amend`
        // (amend never mutates settlement_period today, so there is no
        // separate value to re-validate there; the call documents that
        // explicitly below instead of silently relying on this comment).
        if self.settlement_period < MIN_SETTLEMENT_PERIOD_NS
            || self.settlement_period > MAX_SETTLEMENT_PERIOD_NS
        {
            return Err("settlement_period must be between 1h and 90d");
        }
        if self.resolve_deadline <= self.funding_deadline {
            return Err("resolve_deadline must be after funding_deadline");
        }
        // STG1 (D-STORAGE1): the contract computes each side's storage charge
        // from the byte estimate and that side's own asset rate. The envelope
        // field stays (resolver input is stable) but must be "0".
        if self.storage_charge_per_side.0 != 0 {
            return Err("storage_charge_per_side must be \"0\": the contract computes per-side storage charges");
        }
        Ok(())
    }

    /// D4: conservative estimate of total bytes this bet will write
    /// over its lifetime (open + worst-case exhibits from both parties).
    /// Used only to size the proportional storage charge floor above --
    /// not a byte-exact accounting of actual storage usage.
    fn estimated_storage_bytes(&self) -> u64 {
        let terms_bytes = self.terms.as_ref().map(|t| t.len() as u64).unwrap_or(0);
        // D-KEY1: resolver_wasm_hash/resolver_pubkey no longer live on the
        // envelope (pinned contract-level config instead), so they're
        // dropped from this per-bet estimate.
        let always_written_hash_bytes =
            self.terms_hash.len() as u64 + self.models_snapshot_hash.len() as u64;
        // Item 7r: up to THREE filers (maker, taker, and -- D-REF1 -- the
        // referee, each under their own per-submitter cap after the
        // item-7r bugfix), up to 5 exhibits each (submit_exhibits' own
        // cap), each exhibit now storing a hash (<= MAX_HASH_LEN) PLUS
        // the submitter's AccountId (<= MAX_ACCOUNT_ID_LEN) on-chain.
        let max_exhibit_bytes = 3 * 5 * (MAX_HASH_LEN as u64 + MAX_ACCOUNT_ID_LEN as u64);
        terms_bytes
            + always_written_hash_bytes
            + max_exhibit_bytes
            + STORAGE_EVENT_OVERHEAD_BYTES
    }

    /// STG1 (D-STORAGE1): one side's storage charge in an asset whose rate is
    /// `storage_per_kib` raw units per 1,024 bytes:
    /// `max(1, ceil(estimated_storage_bytes * rate / 1024 / 2))`.
    pub fn storage_for(&self, storage_per_kib: u128) -> u128 {
        let num = self.estimated_storage_bytes() as u128 * storage_per_kib;
        std::cmp::max(1, (num + 2047) / 2048)
    }

    /// Test-only: the deposit at the shared fixture storage rate (every test
    /// asset table uses `STG_FIXTURE_RATE`). Production code uses the stored
    /// per-side amounts (`Bet.storage_maker` / `Bet.storage_taker`).
    #[cfg(test)]
    fn maker_required(&self) -> u128 {
        self.stake_maker.0 + self.storage_for(STG_FIXTURE_RATE)
    }
    #[cfg(test)]
    fn taker_required(&self) -> u128 {
        self.stake_taker.0 + self.storage_for(STG_FIXTURE_RATE)
    }
    fn pot(&self) -> u128 {
        self.stake_maker.0 + self.stake_taker.0
    }
    /// D-BOND1: pot used to size a CHALLENGER's bond/objection. For a
    /// same-asset bet this is unchanged -- the whole shared pot
    /// (stake_maker + stake_taker). A cross-asset bet has no single
    /// pot denominated in one asset to take a % of, so D-BOND1 instead
    /// uses 2x the challenger's OWN stake (maker-fixed, no onchain
    /// price per D-PRICE6) as the challenger-side equivalent of "the
    /// pot", in the challenger's own asset.
    fn pot_for_challenger(&self, is_maker: bool) -> u128 {
        if self.maker_asset == self.taker_asset {
            self.stake_maker.0 + self.stake_taker.0
        } else if is_maker {
            self.stake_maker.0 * 2
        } else {
            self.stake_taker.0 * 2
        }
    }
}

// ---------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BetStatus {
    Open,
    Taken,
    Resolving,
    Proposed,
    Challenged,
    Evidence,
    Rejudge,
    /// OQ-T11: outcome decided and the payout ledger persisted, but not
    /// every line has been drained yet. `finalize` leaves
    /// a bet here instead of jumping straight to `Settled` -- the ONLY
    /// place that promotes `Finalized` -> `Settled` is `drain_payouts`
    /// (via `maybe_settle`), once every ledger line for this bet is
    /// `done`. This is what makes "the bet reaches Settled only when
    /// the ledger is empty" true regardless of how many payout lines a
    /// settlement produced.
    Finalized,
    Settled,
    Voided,
    Cancelled,
    Expired,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct BondInfo {
    pub holder: AccountId,
    pub amount: U128,
    pub round: u32,
    /// Outcome in effect at the moment THIS bond's transfer was accepted.
    /// Each bond round carries its own snapshot (see Bet.bonds doc) so
    /// settling one round never depends on another round's state.
    pub pre_challenge_outcome: Option<String>,
    /// D-BOND1: the token this bond was actually deposited in --
    /// always the holder's OWN stake asset (maker_asset if the holder
    /// is the maker, taker_asset if the holder is the taker). On a
    /// cross-asset bet this can differ from the other round's bond
    /// asset, and from the counterparty's stake asset; settlement must
    /// always route the bond back/forward in THIS asset, never
    /// `usdc_token_id`.
    pub asset: String,
}

/// An objection or rebuttal deposit (`mt_on_transfer` `Objection` message),
/// max($1, 0.5% pot) each. Settled at `finalize`:
/// - objection (`is_rebuttal: false`): returned to `sender` if the final
///   outcome differs from `pre_outcome` (the objection changed the result,
///   i.e. was upheld); forfeited to the counterparty if the outcome is
///   unchanged (rejected).
/// - rebuttal (`is_rebuttal: true`): symmetric -- a rebuttal defends the
///   outcome standing at the time it was filed, so it's returned if the
///   final outcome still matches `pre_outcome`, forfeited if the outcome
///   changed out from under it.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct ObjectionDeposit {
    pub sender: AccountId,
    pub amount: U128,
    pub is_rebuttal: bool,
    pub pre_outcome: Option<String>,
    /// D-BOND1: the token this deposit was actually made in -- always
    /// the sender's OWN stake asset (maker_asset if sender is the
    /// maker, taker_asset if sender is the taker). Settlement must
    /// route the deposit back/forward in THIS asset.
    pub asset: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct Proposal {
    pub maker_value: Option<String>,
    pub taker_value: Option<String>,
}

/// v1.1 (FM-13 / I-7): one recorded entry per run that was EVER submitted
/// and signature-verified for a bet, across every resolution round
/// (challenge/re-judge rounds overwrite `Bet.outcome` on each new
/// submission, so without this history earlier rounds' results would be
/// unrecoverable -- spec: "every run's result is recorded (not only the
/// submitted one)"). Distinct from `SubmittedResult` (the wire type) so
/// it can derive borsh/Debug for storage in `Bet` without touching the
/// resolver-facing signed-message shape.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct RunResult {
    pub run_no: u64,
    pub outcome: String,
    pub element_results_hash: String,
    pub checked_until: U64,
}

/// D2 (D-AUDIT2, 2026-11-02): an exhibit hash plus the exact moment this
/// contract recorded it on-chain. `submitted_at` is `env::block_timestamp()`
/// at insertion time -- never anything caller-supplied -- so the
/// off-chain resolver/judge-proto admission check (CAPTURE_GRACE_H) has
/// one authoritative fact to key its anti-backdating check off of,
/// instead of trusting a self-reported `first_capture`/`submitted` field
/// inside the (off-chain) exhibit payload that a party fully controls.
/// Exposed on `get_bet`'s view unchanged (same json/borsh serializers as
/// everything else on `Bet`).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Exhibit {
    pub hash: String,
    pub submitted_at: U64,
    /// Item 7r / D-DISPUTE1 bugfix: the account that filed this exhibit
    /// (maker, taker, or the referee -- `env::predecessor_account_id()`
    /// at submission time, never caller-supplied). `submit_exhibits`'
    /// per-party cap used to be checked against `bet.exhibits.len()`
    /// across ALL filers, so one party (or the referee) could fill all
    /// 5 slots and lock the other side out of evidence even though the
    /// require() message says "max 5 exhibits per party". The cap is
    /// now counted per `submitted_by` instead.
    pub submitted_by: AccountId,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Bet {
    pub envelope: Envelope,
    /// D-PARAMS1: this bet's own copy of the maker-asset / taker-asset
    /// `min_fee_per_side`, taken at open. Every payout path uses only
    /// these (and `envelope.fee_bps`), never the live config.
    pub fee_min_maker: U128,
    pub fee_min_taker: U128,
    /// FM1 (D-FEEMIN2): this bet's own copy of the `min_fee_per_side` of EACH
    /// `envelope.taker_options` asset, taken at open and parallel to
    /// `taker_options` (same order). A `take` that matches an option sets
    /// `fee_min_taker` to the matching copy, so every taker-side fee/tip uses
    /// the min fee of the asset the taker actually staked.
    #[serde(default)]
    pub fee_min_taker_options: Vec<U128>,
    /// RF2: tip amounts carved out of each bettor's own stake (0 = no tip).
    #[serde(default)]
    pub tip_maker: U128,
    #[serde(default)]
    pub tip_taker: U128,
    /// STG1 (D-STORAGE1): this side's own-asset storage charge, computed by
    /// the contract (maker at open, taker at take; 0 until taken).
    #[serde(default)]
    pub storage_maker: U128,
    #[serde(default)]
    pub storage_taker: U128,
    pub status: BetStatus,
    pub taker: Option<AccountId>,
    pub created_at: u64,
    pub taken_at: Option<u64>,
    pub proposed_at: Option<u64>,
    pub outcome: Option<String>,
    pub used_run_nos: Vec<u64>,
    pub runs_used: u32,
    /// All bond rounds placed on this bet (BUG FIX: previously a single
    /// `Option<BondInfo>` that a second Bond transfer (round 2, after an
    /// Evidence-round re-judge) would silently OVERWRITE -- the first
    /// round's USDC was still held by the contract but its BondInfo record
    /// (holder/amount) was gone, so it was never refunded or forfeited at
    /// `finalize`: permanently stranded funds, violating I-2's
    /// contract-wide "sum of tracked balances = intents balance". Now every
    /// round is kept and settled independently at `finalize`.
    pub bonds: Vec<BondInfo>,
    /// Informational only (last bond round's snapshot/challenger); bond
    /// settlement itself uses each `BondInfo.pre_challenge_outcome`, not
    /// this field.
    pub pre_challenge_outcome: Option<String>,
    pub challenged_by: Option<AccountId>,
    pub exhibits: Vec<Exhibit>,
    pub rebuttals: Vec<String>,
    /// Objection/rebuttal deposits awaiting settlement at `finalize` (BUG
    /// FIX: previously folded straight into the old shared reserve pool
    /// (removed, D-ECON5) and always refunded 50/50 regardless of
    /// outcome -- see handle_objection doc).
    pub objection_deposits: Vec<ObjectionDeposit>,
    pub amend_count: u32,
    /// D-REF1: both-sign amend proposal for swapping/adding/removing
    /// the referee (JSON-encoded `Option<Referee>` string), same
    /// two-call commit mechanism as `amend_proposal`. Only usable
    /// before a dispute opens (`bet.bonds.is_empty()`); frozen after.
    pub referee_proposal: Proposal,
    /// SPEC ISSUE: spec's `amend`/`prune_terms` pass
    /// `sig_maker`/`sig_taker` as if verified against a registered pubkey
    /// for each party's NEAR account. This contract has no pubkey registry
    /// for arbitrary bettor accounts (and C6/master-map says bettors hold
    /// no NEAR key at all -- they sign intents, not NEAR transactions), so
    /// literal ed25519-sig verification of "the maker and taker agreed" is
    /// not wireable here without a relayer-submitted meta-tx format that
    /// doesn't exist yet. Safest interpretation implemented instead:
    /// amend/prune_terms use a two-call commit pattern --
    /// each party calls the method themselves (predecessor-authenticated by
    /// NEAR runtime) with the same proposed value; the state change commits
    /// only once both match. This is at least as safe (no forgeable sig)
    /// but requires both parties to have *some* NEAR-callable identity
    /// (e.g. via a relayer acting as their function-call-key holder) --
    /// flagged for Tyler before mainnet.
    pub amend_proposal: Proposal,
    pub prune_proposal: Proposal,
    pub pending_resolution_request: Option<u64>,
    pub last_resolution_raw: Option<String>,
    pub pruned: bool,
    /// v1.1 (FM-13 / I-7): the only `run_no` `submit_outcome` will accept
    /// next. Starts at 1; advances to `run_no + 1` on every successful
    /// submission (any round). A result for any other run_no --
    /// including a LATER one produced off-chain while this one is still
    /// outstanding -- is rejected, so a party holding multiple runs'
    /// results can never choose which one lands; they are forced to
    /// submit them in the exact order generated. See `submit_outcome`.
    pub next_expected_run_no: u64,
    /// v1.1 (FM-13): full audit history of every run ever accepted on
    /// this bet (see `RunResult` doc). `bet.outcome` only ever reflects
    /// the latest round's result.
    pub all_results: Vec<RunResult>,
    /// v1.1 (FM-17/19): true once either party has called
    /// `extend_window` on this bet. One-time only, by design.
    pub window_extended: bool,
    /// v1.1 (FM-17/19): extra nanoseconds added on top of
    /// `envelope.settlement_period` in `finalize`'s elapsed check, set to
    /// 24h by `extend_window`. 0 until extended.
    pub window_extension_ns: u64,
    /// D-RESOLVE1 (item 7d): set once, on the resolver's FIRST signed
    /// RETRY for this bet (never reset by a later RETRY). Anchors the
    /// 7-day recovery window that gates a VOID-for-unavailability.
    #[serde(default)]
    pub first_unavailable_ns: Option<u64>,
    /// D-RESOLVE1 (item 7d): number of signed RETRY outcomes accepted
    /// for this bet so far. Gates VOID-for-unavailability on its own
    /// once it reaches `Limits.max_retries`, independent of elapsed time.
    #[serde(default)]
    pub retry_count: u32,
    /// D-RESOLVE1 (item 7d): the resolver's own `next_check_ns` from the
    /// most recent RETRY -- the keeper re-requests resolution at this
    /// time. `None` until the first RETRY.
    #[serde(default)]
    pub next_check_ns: Option<u64>,
    /// JCB1 (D-JCB1): after a `RETRY:no_live_judge`, `request_resolution` is refused until this time
    /// (max(signed next_check_ns, submit time + NO_LIVE_JUDGE_MIN_GAP_NS)). Cleared by any other result.
    #[serde(default)]
    pub no_live_judge_until_ns: Option<u64>,
    /// JCD1 (D-JCD1 #2 / B2): first-live judge pair index at the moment the in-flight `request_resolution` was made
    /// (`NO_LIVE_SNAPSHOT` = none was live). `submit_outcome` also accepts it for the run that request belongs to,
    /// so a retirement / pair apply between request and submit cannot strand an honest signed result.
    /// Cleared when that run ends (any accepted result, or a failed OutLayer promise).
    #[serde(default)]
    pub request_judge_snapshot: Option<u32>,
    /// JC1s: the judge pair (index into `judge_chain`) that produced the
    /// accepted outcome; `None` until an outcome is accepted.
    #[serde(default)]
    pub judge_pair_index: Option<u32>,
    /// D-RUNNO1 (16t): per-bet monotonic run counter. `request_resolution`
    /// assigns `max(next_run_no, next_expected_run_no)` as the run's
    /// `run_no` (so a bet stored before this field existed, where it
    /// deserializes as 0, still starts correctly) and sets this to
    /// assigned + 1. The GLOBAL `request_id` is only the OutLayer handle.
    #[serde(default)]
    pub next_run_no: u64,
    /// D-RUNNO1 (16t): the run_no assigned to the in-flight resolution
    /// request (None when no request is pending). `submit_outcome`
    /// requires an in-flight run's result to carry exactly this run_no,
    /// so a late result from an earlier (failed/timed-out) run is rejected
    /// after a re-request.
    #[serde(default)]
    pub pending_run_no: Option<u64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct PendingPayout {
    pub id: u64,
    pub bet_id: u64,
    pub token_id: String,
    pub receiver: AccountId,
    pub amount: U128,
    pub reason: String,
    pub attempts: u32,
    pub done: bool,
    /// OQ-T11 (I-4): true while a transfer for this exact line is
    /// between `fire_payout` and its `on_payout_result` callback.
    /// `drain_payouts`/`retry_payout` both skip (never re-fire) an
    /// in-flight line, so two overlapping permissionless calls can
    /// never double-send the same obligation.
    #[serde(default)]
    pub in_flight: bool,
}

// ---------------------------------------------------------------------
// mt_on_transfer message shapes
// ---------------------------------------------------------------------

/// D-FETCH2 (item 7f2b): the resolver-signed, recent sources-reachable
/// attestation that `TransferMsg::Open` must now carry. `checked_at` is
/// ns since epoch; `signature_hex` signs
/// `sourcecheck_message(envelope.terms_hash, checked_at)` with the same
/// `envelope.resolver_pubkey` `submit_outcome` verifies against (see
/// `verify_sig` call sites ~2379). Mirrors
/// `services/common/src/sourceCheck.ts`'s `SourceCheckAttestation` and
/// `resolver/core::sourcecheck_message` byte-for-byte; all three pin
/// against the shared fixture
/// `contracts/escrow/tests/fixtures/sourcecheck_crosscheck.json`.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct SourceCheckAttestation {
    pub checked_at: u64,
    pub signature_hex: String,
}

/// ML1: max chars of serde parse-error text kept in an `open_rejected` log.
const OPEN_REJECTED_PARSE_ERR_MAX: usize = 200;

#[derive(Serialize, Deserialize, Debug)]
#[serde(crate = "near_sdk::serde", tag = "kind")]
pub enum TransferMsg {
    Open {
        envelope: Envelope,
        attestation: SourceCheckAttestation,
    },
    Take {
        bet_id: u64,
        invite_sig: Option<String>,
        /// RF2: the taker opts in to tipping the referee.
        #[serde(default)]
        tip: bool,
        /// RF2: the referee the taker is agreeing to; must match the
        /// bet's current referee (guards a maker swap before the take).
        #[serde(default)]
        referee_ack: Option<AccountId>,
    },
    Bond {
        bet_id: u64,
        round: u32,
    },
    Objection {
        bet_id: u64,
        exhibit_hash: String,
        is_rebuttal: bool,
    },
}

/// Loop 6 (FM-8/FM-10/FM-11): the `msg` body of an intents `AuthCall`
/// targeting this contract's `on_auth`. A passkey-only intents.near user
/// can't sign a native NEAR tx (MASTER MAP §11-12, "Login model
/// corrected") -- these two variants are the AuthCall-shaped equivalents
/// of the direct `request_resolution`/`extend_window` calls, with
/// `signer_id` (not the intents contract, which is just the
/// predecessor) treated as the acting party/payer.
#[derive(Serialize, Deserialize, Debug)]
#[serde(crate = "near_sdk::serde", tag = "kind")]
pub enum AuthMsg {
    RequestResolution { bet_id: u64 },
    ExtendWindow { bet_id: u64 },
}

/// Per-`request_id` record of who actually paid for an OutLayer run and
/// how (FM-11: "refunds attributed to the right payer"). Looked up by
/// `on_resolution` to route any unused-compute refund correctly: a
/// direct `#[payable] request_resolution` caller (keeper/BYO wallet)
/// gets a native NEAR transfer; an `on_auth`/AuthCall-initiated run's
/// payer gets their intents wNEAR balance credited instead (FM-10: never
/// native for that path, since the deposit itself came OUT of their
/// wNEAR balance, not their native NEAR wallet).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct ResolutionPayer {
    pub bet_id: u64,
    pub payer: AccountId,
    pub via_auth_call: bool,
    pub deposit: u128,
    /// D5 (D-AUDIT5 feasibility follow-up, 2026-11-02): true when this
    /// run's compute was drawn from the keeper's prepaid
    /// `keeper_credit` pool (a zero-attached-deposit call from
    /// `self.keeper` itself -- the only call shape a function-call
    /// access key scoped to this contract can make, since NEAR
    /// protocol forbids any attached deposit on a FunctionCall-permission
    /// key regardless of method). `on_resolution`'s unused-compute
    /// refund must credit this back into the pool, never transfer it
    /// natively (the keeper's function-call key can't receive/hold a
    /// native transfer meaningfully differently, but more importantly
    /// the NEAR never left the contract's own balance to begin with).
    pub funded_from_credit: bool,
}

#[ext_contract(ext_intents)]
trait MultiTokenCore {
    fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    );

    /// Loop 6: mock stand-in for the real two-step "wrap.near
    /// `near_deposit()` then `ft_transfer_call` to intents.near with a msg
    /// crediting `account_id`'s wNEAR intents balance" flow (never a
    /// native transfer -- FM-10). `mock-intents` plays both wrap.near's
    /// and intents.near's role in one method since this is a disposable
    /// testnet mock, not a security boundary; the real deployment issues
    /// the two real calls against real `wrap.near`/`intents.near`.
    fn near_deposit_and_credit(&mut self, account_id: AccountId);
}

// Item 16b (D-OL-WIRE1): OutLayer's `request_execution` takes `source`,
// `input_data`, `secrets_ref`, `resource_limits`, `response_format`, ... as
// TOP-LEVEL JSON fields (ABI pinned in
// tests/fixtures/outlayer_request_execution_abi.json). An `#[ext_contract]`
// trait with a single `args_json: String` param serialized as
// `{"args_json":"..."}` and was rejected live ("missing field `source`"),
// so the call is built as a raw function-call promise instead.

/// Safety buffer kept above measured storage cost before `sweep_excess_near`
/// will move anything to `fee_account`. Deliberately generous (storage
/// cost estimation via `env::storage_byte_cost()` is exact for *current*
/// usage but the contract keeps growing every open/bond/etc, so this is a
/// margin against sweeping NEAR a same-block state-growing call still
/// needs) -- not a magic number tied to any specific bet.
const NEAR_SAFETY_BUFFER: NearToken = NearToken::from_near(1);

// ABI fix: `SubmittedResult` is a direct parameter type of the public
// `submit_outcome` method, so `cargo near build`'s ABI generation walks
// it looking for a JSON schema -- unlike `TransferMsg` (only ever parsed
// out of an opaque `msg: String` inside `mt_on_transfer`, never a typed
// method parameter itself). Switched from a bare `Serialize/Deserialize`
// derive to the same `#[near(serializers = [json])]` macro every other
// on-chain type in this file already uses -- it conditionally derives
// `JsonSchema` under cargo-near's `abi` feature (and plain `schemars`
// otherwise doesn't need to exist at all), which is exactly what was
// missing and broke `cargo near build`.
#[near(serializers = [json])]
#[derive(Clone)]
pub struct SubmittedResult {
    pub bet_id: u64,
    pub terms_hash: String,
    pub outcome: String,
    pub element_results_hash: String,
    pub run_no: u64,
    /// Root-cause fix (signature rejections): a bare `u64` here is lossy
    /// in JSON across the JS boundary. `checked_until` is a nanosecond
    /// timestamp (`Date.now() * 1_000_000` in the TS harnesses), which
    /// exceeds `Number.MAX_SAFE_INTEGER` (2^53-1): the JS double's exact
    /// integer value (what gets borsh-serialized into the signed buffer
    /// via BigInt(n)) can differ from the decimal JSON.stringify emits
    /// (what near-api-js actually puts on the wire, and what serde_json
    /// parses here as the literal integer) by tens to hundreds of ns --
    /// same double, two different "true" integers depending on which
    /// side reads it. `U64` forces the wire representation to a JSON
    /// string, so the exact same decimal digits travel end-to-end with
    /// no float round-trip anywhere.
    pub checked_until: U64,
    /// D-RESOLVE1 (item 7d): only meaningful (and required) when
    /// `outcome == "RETRY"` -- the resolver's own next-check nanosecond
    /// timestamp. Included in the signed buffer ONLY for RETRY, so the
    /// signed message for YES/NO/VOID is byte-identical to before this
    /// field existed (old signatures over those outcomes still verify).
    /// `#[serde(default)]` so existing JSON callers omitting the field
    /// (every pre-existing YES/NO/VOID caller) keep working unchanged.
    #[serde(default)]
    pub next_check_ns: Option<U64>,
    /// JC1s (D-JUDGECHAIN1): the position in `judge_chain` of the pair that
    /// produced this result. Part of the SIGNED buffer (right after
    /// `checked_until`, before `next_check_ns`), so a relayer cannot re-label
    /// which pair judged. `submit_outcome` accepts only an APPLIED pair
    /// (index < judge_chain.len(); a pending/cancelled proposal is never in
    /// the chain). For `RETRY:no_live_judge` no pair decided: the resolver signs 0.
    pub judge_pair_index: u32,
    /// JC1x (D-JUDGECHAIN1a #1): the not-found (404/410) answers the resolver saw this run. SIGNED: when non-empty,
    /// `borsh(Vec<(model, observed_ns)>)` is appended at the very end of the signed buffer; when empty the buffer is
    /// byte-identical to the JC1s layout (so older evidence still verifies). `#[serde(default)]` = absent means none.
    #[serde(default)]
    pub model_not_found: Vec<ModelObservation>,
}

// ---------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub intents: AccountId,
    pub usdc_token_id: String,
    /// Sub-job 1 (D-PRICE6): immutable init-time whitelist of assets a
    /// bet side may stake, keyed by intents multi-token id. No admin --
    /// set once at `new()` and never mutated. `handle_open` rejects any
    /// `maker_asset`/`taker_asset` not in this map (and `mt_on_transfer`
    /// rejects any deposit whose `token_ids[0]` isn't a key here at
    /// all, full refund, before any handler runs).
    pub asset_limits: LookupMap<String, AssetLimit>,
    pub outlayer: AccountId,
    /// Queue item 11: see `OutlayerConfig`. Immutable after init.
    pub outlayer_config: OutlayerConfig,
    pub operator: AccountId,
    /// D-SUNSET2/D-SUNSET3: Ledger-controlled account with exactly three
    /// narrow powers -- `pause_new_offers`/`unpause_new_offers` (blocks
    /// only new offers/takes), `set_guardian` (rotation), and
    /// `emergency_shutdown` (permanent, irreversible). Never gated on
    /// any other method; `required_guardian_power_sites_are_exhaustive`
    /// in tests.rs statically enforces this.
    pub guardian: AccountId,
    pub registry: AccountId,
    pub fee_account: AccountId,
    pub keeper: AccountId,
    /// D-SUNSET2: replaces the old operator-gated binary `paused`.
    /// Blocks ONLY new offers (`handle_open`) and new takes
    /// (`handle_take`) -- never cancel/resolve/dispute/finalize/void/
    /// refunds/payouts. Guardian-only, via `pause_new_offers`/
    /// `unpause_new_offers` (1 yoctoNEAR required).
    pub new_offers_paused: bool,
    /// D-SUNSET3: set once, forever, by `emergency_shutdown`. Implies
    /// `new_offers_paused` permanently (unpause is refused once this is
    /// true). Gates resolution/submit_outcome/finalize/challenge
    /// (handle_bond)/amend/amend_referee off; permits
    /// permissionless `emergency_refund` on.
    pub shutdown: bool,
    pub next_bet_id: u64,
    pub bets: LookupMap<u64, Bet>,
    pub open_bet_ids: Vec<u64>,
    pub next_request_id: u64,
    pub pending_requests: LookupMap<u64, u64>, // request_id -> bet_id
    /// Loop 6 (FM-11): request_id -> who paid for that OutLayer run and
    /// how, so an unused-compute refund lands on the right payer via the
    /// right rail (native vs intents wNEAR credit).
    pub resolution_payers: LookupMap<u64, ResolutionPayer>,
    /// Item 16d (D-RESOLVE4): request_id -> the bet status before
    /// `request_resolution` flipped it to Resolving, so a FAILED OutLayer
    /// promise (nothing executed) can restore it and allow a retry.
    pub resolution_prior_status: LookupMap<u64, BetStatus>,
    pub next_payout_id: u64,
    pub pending_payouts: LookupMap<u64, PendingPayout>,
    /// DR-ESC-7: per-bet index of payout ledger line ids (replaces the
    /// old global, never-pruned `payout_ids: Vec<u64>`), so per-bet
    /// operations touch only that bet's lines regardless of history.
    pub payouts_by_bet: LookupMap<u64, Vec<u64>>,
    pub limits: Limits,
    /// D-SUNSET1: `None` (the default) means no sunset at all -- the
    /// contract runs until a new version is deployed and bettors
    /// migrate. `Some(ns)` is the nanosecond timestamp after which
    /// `handle_open` refuses new offers; existing bets are untouched --
    /// they still fund, resolve, settle, refund and pay out normally
    /// past this point. Immutable once set (no admin exists to move
    /// it; superseded the old D6 90-day-default behavior).
    pub beta_sunset_ns: Option<u64>,
    /// D-KEY1 (option A): the resolver's two signing keys, pinned at
    /// `new()` and tied to `resolver_wasm_hash`. Never changeable by the
    /// guardian or anyone else -- only redeploy/upgrade swaps them.
    /// `outcome_pubkey` signs `submit_outcome` results; `attest_pubkey`
    /// signs sourcecheck attestations and archive snapshots (manifest
    /// path "attest", bind:wasm, no caller binding, so the keeper can
    /// launch sourcecheck/archive jobs directly, not only via an escrow
    /// callback).
    pub outcome_pubkey: String,
    pub attest_pubkey: String,
    pub resolver_wasm_hash: String,
    /// D5: prepaid NEAR held by the contract on the keeper's behalf,
    /// topped up via `topup_keeper_credit` by the keeper or fee account
    /// (both already full-access-or-equivalent payers in this design --
    /// never a party to any bet). `request_resolution` draws from this
    /// pool instead of requiring an attached deposit when the caller is
    /// `self.keeper` and attaches zero NEAR, which is the ONLY shape a
    /// function-call access key scoped to this contract can ever submit
    /// (NEAR protocol: a FunctionCall-permission access key's
    /// transaction must carry a zero deposit on every action,
    /// independent of which method is called -- see sandbox proof in
    /// the D5 build log). Denominated in yoctoNEAR, same unit as any
    /// other attached-deposit field in this contract.
    pub keeper_credit: u128,
    /// D-FEEPIN1: protocol fee in bps, pinned at `new()` (v1: 100 = 1%).
    /// `handle_open` refuses any envelope whose `fee_bps` differs.
    pub protocol_fee_bps: u32,
    /// D-PARAMS1: guardian-proposed settings change awaiting its 24h delay.
    pub pending_params: Option<PendingParams>,
    /// D-JUDGECHAIN1: ordered judge-pair chain, set at `new()`, append-only
    /// (the only mutator is `apply_judge_pair`, which pushes at the END).
    pub judge_chain: Vec<JudgePair>,
    /// D-JUDGECHAIN1: at most one proposed append awaiting its 7-day delay.
    pub pending_judge_pair: Option<PendingJudgePair>,
    /// JC1x (D-JUDGECHAIN1a #1): shared, contract-level not-found observations per model (<= 3, unix ns, ascending).
    pub model_missing: LookupMap<String, Vec<u64>>,
    /// JC1x (D-JUDGECHAIN1a S1): a proposed guardian rotation; the old guardian stays until this account accepts.
    pub pending_guardian: Option<AccountId>,
    /// AS1 (D-ASSET1): the single proposed asset addition / re-enable awaiting its 24h delay.
    pub pending_asset: Option<PendingAsset>,
    /// AS1: assets the guardian closed to NEW bets (still in `asset_limits`; existing bets unaffected).
    pub disabled_assets: LookupMap<String, bool>,
}

/// AS1 (D-ASSET1): delay between `propose_asset` and `apply_asset` (24h).
pub const ASSET_DELAY_NS: u64 = 24 * 3_600 * 1_000_000_000;

/// AS1: the single pending asset proposal and when `apply_asset` first works.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct PendingAsset {
    pub token_id: String,
    pub limit: AssetLimit,
    /// true = re-enable of a disabled asset (limits must equal the stored ones); false = append a new asset.
    pub reenable: bool,
    pub proposed_at_ns: u64,
    pub effective_at_ns: u64,
}

/// D-PARAMS1: one asset's proposed settings. Omitted field = unchanged.
/// Only these three knobs are guardian-adjustable; the asset set, bond
/// and run-price settings are not.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct AssetParamsChange {
    pub asset_id: String,
    pub min_fee_per_side: Option<U128>,
    pub min_per_side: Option<U128>,
    pub max_per_side: Option<U128>,
}

/// D-PARAMS1: a guardian-proposed settings change. NEW bets only.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct ParamsChange {
    pub fee_bps: Option<u32>,
    pub assets: Vec<AssetParamsChange>,
}

/// D-PARAMS1: the pending change and when `apply_params` first works.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingParams {
    pub change: ParamsChange,
    pub proposed_at_ns: u64,
    pub effective_at_ns: u64,
}

/// D-JUDGECHAIN1: one judge PAIR -- two distinct model ids that must both be
/// live for the resolver to use the pair.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JudgePair {
    pub model_a: String,
    pub model_b: String,
}

/// D-JUDGECHAIN1a #1: one signed "the provider answered 404/410 for this model" observation (unix ns).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelObservation {
    pub model: String,
    pub observed_ns: U64,
}

/// D-JUDGECHAIN1: the single pending append and when `apply_judge_pair` first works.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingJudgePair {
    pub pair: JudgePair,
    pub proposed_at_ns: u64,
    pub effective_at_ns: u64,
}

/// D-JUDGECHAIN1: delay between `propose_judge_pair` and `apply_judge_pair` (7d).
pub const JUDGE_PAIR_DELAY_NS: u64 = 7 * 24 * 60 * 60 * 1_000_000_000;
/// D-JUDGECHAIN1: hard cap on the number of pairs in the chain.
pub const MAX_JUDGE_PAIRS: usize = 12;
/// D-JUDGECHAIN1a #3: the chain given to `new()` has 2..=4 pairs (the rest arrive by guardian append).
pub const MIN_INITIAL_JUDGE_PAIRS: usize = 2;
pub const MAX_INITIAL_JUDGE_PAIRS: usize = 4;
/// D-JUDGECHAIN1a #3: a model id is ASCII `org/model`, at most this many bytes.
pub const MAX_MODEL_ID_LEN: usize = 128;
/// D-JUDGECHAIN1a #1: a model is retired after this many not-found observations, each >= 24h after the previous one.
pub const RETIRE_OBSERVATIONS: usize = 3;
pub const RETIRE_MIN_GAP_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
/// One result may carry at most this many observations (<= 12 pairs x 2 models).
pub const MAX_OBSERVATIONS_PER_RESULT: usize = 2 * MAX_JUDGE_PAIRS;
/// D-JUDGECHAIN1a S3: NEP-297 event envelope.
pub const EVENT_STANDARD: &str = "praetorial-escrow";
pub const EVENT_VERSION: &str = "1.0.0";

/// D-PARAMS1: delay between `propose_params` and `apply_params` (24h).
pub const PARAMS_DELAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
/// D-PARAMS1: hard cap on the protocol fee rate (2%).
pub const MAX_FEE_BPS: u32 = 200;

/// D-FEEMIN1: one side's protocol fee =
/// `min(stake, max(stake*fee_bps/10000, min_fee_per_side))`, where
/// `min_fee_per_side` is the limit of THAT side's own asset. Shared by
/// finalize and concede.
pub fn side_fee(stake: u128, fee_bps: u128, min_fee_per_side: u128) -> u128 {
    std::cmp::min(stake, std::cmp::max(stake * fee_bps / BPS_DENOM, min_fee_per_side))
}

/// Sub-job 1 (D-PRICE6): per-asset per-side stake bounds, native units of
/// that asset. Set once per whitelisted asset at `new()` (immutable, no
/// admin); replaces the old flat `Limits.max_stake_per_side_usdc`
/// (USDC-only, no min) with a per-asset min AND max, keyed in
/// `Contract.asset_limits`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct AssetLimit {
    pub min_per_side: U128,
    pub max_per_side: U128,
    /// D-FEEMIN1: minimum protocol fee per side, in this asset's own
    /// native units. Each side's fee at finalize/concede is
    /// `min(stake, max(stake*fee_bps/10000, min_fee_per_side))` using
    /// THAT side's asset. Pinned at `new()`; validated >0 and
    /// <= `min_per_side/20` (so the minimum never exceeds 5% of the
    /// smallest legal stake).
    pub min_fee_per_side: U128,
    /// D-PARAMS1: hard per-asset cap on `min_fee_per_side`, pinned at
    /// `new()` and never changeable (USDC/USDT v1: 2,500,000 = $2.50 per
    /// side = $5 per bet). `0` (absent in JSON) means "pin the cap at the
    /// initial `min_fee_per_side`", i.e. the guardian can lower but never
    /// raise it. Validated `>= min_fee_per_side` at `new()`.
    #[serde(default)]
    pub min_fee_cap_per_side: U128,
    /// D-ECON5: round-0 judge run cost for bets staking this asset, in
    /// the asset's own native units. Validated >0 at `new()`. Used by
    /// `handle_bond`/`required_challenge_bond` for this asset's own
    /// challenge-bond run-cost component (D-BOND1: every asset, not
    /// just USDC); round-0 itself is funded entirely by
    /// `keeper_credit`, never drawn from bet money (D-ECON5).
    pub run_price: U128,
    /// D-BOND1: challenge-bond floor for this asset, in its own native
    /// units -- the per-asset analog of the old hardcoded $5 USDC
    /// floor (`handle_bond`'s `max(min_bond, 5% of pot_for_challenger)
    /// + run_price`). Validated >0 at `new()`.
    pub min_bond: U128,
    /// D-BOND1: objection/rebuttal deposit floor for this asset, in its
    /// own native units -- the per-asset analog of the old hardcoded $1
    /// USDC floor (`handle_objection`'s `max(min_objection, 0.5% of
    /// pot_for_challenger)`). Validated >0 at `new()`.
    pub min_objection: U128,
    /// STG1 (D-STORAGE1): storage rate in THIS asset's raw units per 1,024
    /// bytes of estimated bet storage. Required in `new()` (no serde
    /// default), validated > 0, immutable (not part of propose_params).
    /// Each side's charge = max(1, ceil(estimated_bytes * rate / 1024 / 2)).
    pub storage_per_kib: U128,
}

/// D-BOND1: the view-side counterpart to a `Bond` transfer's required
/// (amount, asset) -- the asset is always the querying challenger's own
/// stake asset, so unlike the pre-D-BOND1 USDC-only amount this must
/// travel with it. See `Contract::required_challenge_bond`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChallengeBondQuote {
    pub amount: U128,
    pub asset: String,
}

/// Queue item 11 (D-RESOLVE2 wiring): OutLayer deployment config, set once
/// at `new()`. The wasm is fetched from `{wasm_base_url}/{resolver_wasm_hash}.wasm`
/// (FastFS layout: `https://<gateway>/<uploader>/<receiver>`), and the run
/// reads the secret stored under `secrets_ref {profile, account_id}`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct OutlayerConfig {
    pub wasm_base_url: String,
    pub secrets_profile: String,
    pub secrets_account_id: AccountId,
}

impl OutlayerConfig {
    fn validate(&self) {
        require(
            self.wasm_base_url.starts_with("https://"),
            "outlayer_config: wasm_base_url must start with https://",
        );
        require(
            !self.wasm_base_url.ends_with('/'),
            "outlayer_config: wasm_base_url must not end with /",
        );
        let n = self.secrets_profile.len();
        require(
            (1..=64).contains(&n),
            "outlayer_config: secrets_profile must be 1-64 bytes",
        );
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Limits {
    /// MS1: DEPRECATED/unused. No contract path reads it; per-asset
    /// `AssetLimit.max_per_side` is the stake cap. Kept so the `new()`
    /// args and the borsh layout do not change.
    pub max_stake: U128,
    pub max_offer_ttl_secs: u64,
    /// D6: NEAR-denominated equivalent of the same cap, reserved for a
    /// NEAR-native stake path. This contract's bets are always
    /// denominated in `usdc_token_id` (no NEAR-stake path exists in
    /// this version) -- stored and validated for shape at init, but
    /// not enforced against any live stake today; see the v1.2 spec
    /// note before relying on it.
    pub max_stake_per_side_near: U128,
    /// D-AUDIT8 (Tyler, 2026-11-03, OQ-T10 ruling): max number of
    /// challenge/re-judge rounds (`Bet.bonds.len()`) a bet may reach.
    /// `handle_bond` refuses a new round once this cap is hit; the bet
    /// then settles on the standing outcome via ordinary `finalize`.
    /// RF2: this caps AI challenge rounds only; a named human referee
    /// rules once via `referee_rule` with no rounds, so it is unaffected.
    /// `#[serde(default)]` so existing JSON callers (chaos
    /// scripts, deploy tooling) that omit the field at init get the
    /// documented default of `DEFAULT_MAX_ROUNDS` (2) without needing
    /// an update; borsh (state round-trips) never needs a default since
    /// it only ever reads back what this same contract version wrote.
    #[serde(default = "default_max_rounds")]
    pub max_rounds: u32,
    /// D-RESOLVE1 (item 7d): retry-count branch of the VOID-for-
    /// unavailability gate (see `RECOVERY_WINDOW_NS`/`submit_outcome`).
    /// `#[serde(default)]` so existing JSON callers that omit this field
    /// at init get `DEFAULT_MAX_RETRIES` (7) without needing an update.
    #[serde(default = "default_max_retries")]
    pub max_retries: u32,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        intents: AccountId,
        usdc_token_id: String,
        outlayer: AccountId,
        operator: AccountId,
        // D-SUNSET2/D-SUNSET3: Ledger-controlled guardian account, fixed
        // at init, rotatable only by itself via `set_guardian`.
        guardian: AccountId,
        registry: AccountId,
        fee_account: AccountId,
        keeper: AccountId,
        limits: Limits,
        // D-SUNSET1: `None` means no sunset (the new default); `Some(ns)`
        // pins an explicit absolute nanosecond timestamp after which
        // `handle_open` refuses new offers.
        beta_sunset_ns: Option<u64>,
        // Sub-job 1 (D-PRICE6): the immutable asset whitelist, (token_id,
        // AssetLimit) pairs. Must include `usdc_token_id` itself, since
        // bonds/objections (unchanged this sub-job) still deposit in it
        // unconditionally.
        asset_limits: Vec<(String, AssetLimit)>,
        // D-KEY1 (option A): the resolver's two signing keys, pinned here
        // for the life of the contract and tied to `resolver_wasm_hash`
        // (verified against this SAME pinned hash by handle_open/
        // submit_outcome/request_resolution -- never a maker-supplied
        // envelope value). Not changeable by guardian or anyone; only a
        // redeploy/upgrade can rotate them.
        outcome_pubkey: String,
        attest_pubkey: String,
        resolver_wasm_hash: String,
        // Queue item 11: where the pinned resolver wasm is hosted and
        // which OutLayer secrets entry the run reads. Fixed at init
        // (no setter), so a mainnet deploy never inherits a testnet URL.
        outlayer_config: OutlayerConfig,
        // D-JUDGECHAIN1: the built-in ordered judge-pair chain (1..=12 pairs).
        judge_chain: Vec<JudgePair>,
    ) -> Self {
        outlayer_config.validate();
        validate_judge_chain(&judge_chain);
        require(
            asset_limits.iter().any(|(id, _)| id == &usdc_token_id),
            "asset_limits must include usdc_token_id",
        );
        require(outcome_pubkey.len() == 64, "outcome_pubkey must be 32 bytes hex");
        require(attest_pubkey.len() == 64, "attest_pubkey must be 32 bytes hex");
        require(resolver_wasm_hash.len() == 64, "resolver_wasm_hash must be 32 bytes hex");
        let mut asset_limits_map: LookupMap<String, AssetLimit> = LookupMap::new(b"A");
        for (token_id, limit) in asset_limits {
            let limit = validate_asset_limit(limit);
            asset_limits_map.insert(token_id, limit);
        }
        Self {
            intents,
            usdc_token_id,
            asset_limits: asset_limits_map,
            outlayer,
            operator,
            guardian,
            registry,
            fee_account,
            keeper,
            new_offers_paused: false,
            shutdown: false,
            next_bet_id: 1,
            bets: LookupMap::new(b"B"),
            open_bet_ids: Vec::new(),
            next_request_id: 1,
            pending_requests: LookupMap::new(b"R"),
            resolution_payers: LookupMap::new(b"Y"),
            resolution_prior_status: LookupMap::new(b"Z"),
            next_payout_id: 1,
            pending_payouts: LookupMap::new(b"P"),
            payouts_by_bet: LookupMap::new(b"Q"),
            // SECURITY FIX: `limits` was accepted by `new()` but discarded
            // (`#[allow(unused_variables)]`) and never enforced anywhere --
            // `max_stake` and `max_offer_ttl_secs` were dead config. Now
            // stored and checked in `handle_open`.
            limits,
            beta_sunset_ns,
            outcome_pubkey,
            attest_pubkey,
            resolver_wasm_hash,
            outlayer_config,
            keeper_credit: 0,
            protocol_fee_bps: PROTOCOL_FEE_BPS_V1,
            pending_params: None,
            judge_chain,
            pending_judge_pair: None,
            model_missing: LookupMap::new(b"M"),
            pending_guardian: None,
            pending_asset: None,
            disabled_assets: LookupMap::new(b"D"),
        }
    }

    /// D-FEEPIN1: the protocol fee (bps) pinned at `new()` for the life
    /// of the contract. `handle_open` refuses any envelope whose
    /// `fee_bps` differs, so every bet's per-bet value equals this.
    pub fn protocol_fee_bps(&self) -> u32 {
        self.protocol_fee_bps
    }

    /// Queue item 11: view the init-time OutLayer wiring (FastFS base
    /// URL + secrets_ref). Immutable after `new()`.
    pub fn outlayer_config(&self) -> OutlayerConfig {
        self.outlayer_config.clone()
    }

    /// D-KEY1: view the pinned resolver keys/hash. No method ever
    /// changes these -- not the guardian, not anyone -- only a
    /// redeploy/upgrade of the whole contract can.
    pub fn resolver_keys(&self) -> (String, String, String) {
        (
            self.outcome_pubkey.clone(),
            self.attest_pubkey.clone(),
            self.resolver_wasm_hash.clone(),
        )
    }

    /// D5: fund the keeper compute credit pool. Restricted to the
    /// keeper account itself or the fee account -- never a bet party --
    /// since this pool pays for `request_resolution` calls made with a
    /// function-call access key that cannot attach its own deposit.
    #[payable]
    pub fn topup_keeper_credit(&mut self) {
        let predecessor = env::predecessor_account_id();
        require(
            predecessor == self.keeper || predecessor == self.fee_account,
            "topup_keeper_credit: only the keeper or fee account may fund keeper compute credit",
        );
        let amount = env::attached_deposit().as_yoctonear();
        require(amount > 0, "topup_keeper_credit: attach a deposit");
        self.keeper_credit += amount;
    }

    /// D5 view: current prepaid keeper compute credit balance, yoctoNEAR.
    pub fn keeper_credit_balance(&self) -> U128 {
        U128(self.keeper_credit)
    }

    // -------------------------------------------------------------
    // mt_on_transfer (I-3: never panic, full accept or full reject)
    // -------------------------------------------------------------
    pub fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> PromiseOrValue<Vec<U128>> {
        // Trust boundary per funding spec §3a: predecessor must be
        // intents.near. We don't hold the user's balance ourselves, so a
        // non-intents caller claiming `sender_id` would just be lying about
        // money it doesn't have the authority to move; reject defensively
        // anyway rather than trust predecessor alone silently.
        if env::predecessor_account_id() != self.intents {
            return PromiseOrValue::Value(amounts);
        }
        if token_ids.len() != 1 || amounts.len() != 1 {
            return PromiseOrValue::Value(amounts);
        }
        if previous_owner_ids != vec![sender_id.clone()] {
            return PromiseOrValue::Value(amounts);
        }
        // Sub-job 1 (D-PRICE6): the hardcoded single-asset check
        // (`token_ids[0] != self.usdc_token_id`) is replaced by whitelist
        // membership -- any token not in `asset_limits` is refunded here,
        // before any handler runs. This does NOT by itself prove
        // `token_ids[0]` is the RIGHT asset for this particular call
        // (e.g. that it matches `envelope.maker_asset`); that match is
        // checked in `handle_open`/`handle_take` below, which have the
        // envelope/bet to check it against.
        if self.asset_limits.get(&token_ids[0]).is_none() {
            return PromiseOrValue::Value(amounts);
        }
        let token_id = token_ids[0].clone();
        let amount = amounts[0].0;

        let parsed: Result<TransferMsg, _> = serde_json::from_str(&msg);
        let parsed = match parsed {
            Ok(p) => p,
            Err(e) => {
                // ML1: full refund (I-3) is unchanged; this only leaves a
                // trace of WHY. serde error text can echo attacker bytes
                // (e.g. unknown variant names), so cap it hard, on a char
                // boundary.
                let full = e.to_string();
                let mut text: String = full.chars().take(OPEN_REJECTED_PARSE_ERR_MAX).collect();
                if full.chars().count() > OPEN_REJECTED_PARSE_ERR_MAX {
                    text.push_str("...");
                }
                env::log_str(&format!(
                    "open_rejected bet=unassigned reason=msg parse failure: {text}"
                ));
                return PromiseOrValue::Value(amounts);
            }
        };

        let accepted = match parsed {
            TransferMsg::Open { envelope, attestation } => {
                self.handle_open(sender_id, envelope, attestation, token_id, amount)
            }
            TransferMsg::Take {
                bet_id,
                invite_sig,
                tip,
                referee_ack,
            } => self.handle_take(sender_id, bet_id, invite_sig, tip, referee_ack, token_id, amount),
            // D-BOND1 (cross-asset-4): a challenge bond or objection
            // deposit is posted in the DEPOSITOR's own stake asset,
            // never hardcoded to `usdc_token_id` -- `handle_bond`/
            // `handle_objection` below check the deposit's actual
            // token against the depositor's own side (maker_asset if
            // they're the maker, taker_asset if they're the taker)
            // and reject (full refund, I-3) anything else, including a
            // same-asset bet's lone USDC-or-nothing case from before.
            TransferMsg::Bond { bet_id, round } => {
                self.handle_bond(sender_id, bet_id, round, token_id, amount)
            }
            TransferMsg::Objection {
                bet_id,
                exhibit_hash,
                is_rebuttal,
            } => {
                self.handle_objection(sender_id, bet_id, exhibit_hash, is_rebuttal, token_id, amount)
            }
        };

        if accepted {
            PromiseOrValue::Value(vec![U128(0)])
        } else {
            PromiseOrValue::Value(amounts)
        }
    }

    fn handle_open(
        &mut self,
        sender_id: AccountId,
        mut envelope: Envelope,
        attestation: SourceCheckAttestation,
        token_id: String,
        amount: u128,
    ) -> bool {
        if self.new_offers_paused {
            return false; // D-SUNSET2/D-SUNSET3: pause/shutdown blocks open
        }
        // PRT-L2 open-validation gap, named honestly: every sanity_check
        // failure (including a keep_terms:true bet with no terms --
        // `(None, true) => "keep_terms is true but terms is missing"`)
        // previously refunded *silently* -- correct per I-3 (never panic,
        // reject = full refund) but with zero onchain trace of *why*, so
        // a maker/indexer watching only the refund has no way to tell a
        // bad envelope apart from e.g. a paused contract. Refund behavior
        // is unchanged; this only adds a log line carrying the exact
        // `sanity_check` reason.
        if let Err(reason) = envelope.sanity_check() {
            env::log_str(&format!("open_rejected bet=unassigned reason={reason}"));
            return false;
        }
        if envelope.maker != sender_id {
            return false;
        }
        // D-FETCH2 (item 7f2b): Open requires a resolver-signed, fresh
        // sources-reachable attestation for this exact term sheet
        // before any deposit is accepted into escrow. Message/key
        // mirror submit_outcome's own verify_sig pattern (~2379) --
        // D-KEY1: now the pinned contract-level attest_pubkey (not
        // envelope.resolver_pubkey, which no longer exists), same
        // byte-for-byte message construction as resolver/core::sourcecheck_message and
        // services/common/src/sourceCheck.ts::buildSourceCheckMessage
        // (shared fixture: sourcecheck_crosscheck.json). A mismatched
        // spec_hash is caught here too, structurally: the message is
        // always built from THIS envelope's terms_hash, so an
        // attestation signed over any other spec_hash just fails the
        // signature check below. Refusing hits the same I-3
        // full-refund path as every other handle_open rejection -- no
        // panic, no stranded funds.
        // D-KEY1: verified against the pinned contract-level attest_pubkey
        // (sourcecheck/archive key), never a maker-supplied envelope key.
        let sc_message = sourcecheck_message(&envelope.terms_hash, attestation.checked_at);
        if !verify_sig(&self.attest_pubkey, &attestation.signature_hex, sc_message.as_bytes()) {
            env::log_str("open_rejected bet=unassigned reason=sourcecheck attestation signature invalid");
            return false;
        }
        let sc_now = env::block_timestamp();
        if attestation.checked_at > sc_now {
            env::log_str("open_rejected bet=unassigned reason=sourcecheck attestation checked_at is in the future");
            return false;
        }
        if sc_now - attestation.checked_at > SOURCECHECK_FRESHNESS_NS {
            env::log_str("open_rejected bet=unassigned reason=sourcecheck attestation stale (older than 1h)");
            return false;
        }
        // Sub-job 1 (D-PRICE6): the deposit's actual token must be the
        // asset the maker declared they're staking.
        if token_id != envelope.maker_asset {
            env::log_str("open_rejected bet=unassigned reason=deposit token does not match maker_asset");
            return false;
        }
        // MS1: the old flat raw `limits.max_stake` comparison is gone (it
        // compared USDC 6dp and wNEAR 24dp raw units against one number).
        // The only stake upper bound is each asset's own
        // `AssetLimit.max_per_side`, checked below for the maker, taker and
        // every taker_options asset. `limits.max_stake` stays in the struct
        // for init/borsh compatibility but is unused by the contract.
        // D-FEEPIN1: the protocol fee is pinned at init; an envelope may
        // not carry any other value (0 would drain keeper credit, absurd
        // values would confiscate stake). Full refund via `return false`.
        if envelope.fee_bps != self.protocol_fee_bps {
            env::log_str(&format!(
                "open_rejected bet=unassigned reason=fee_bps must equal the pinned protocol fee ({} bps), got {}",
                self.protocol_fee_bps, envelope.fee_bps
            ));
            return false;
        }
        // Sub-job 1 (D-PRICE6): both the maker's and taker's declared
        // assets must be whitelisted, and each side's stake must sit
        // within that asset's own [min_per_side, max_per_side] (replaces
        // the old flat, USDC-only, no-min `max_stake_per_side_usdc`).
        // AS1: a guardian-disabled asset takes no NEW bets on either side (existing bets are untouched).
        if self.asset_disabled(envelope.maker_asset.clone())
            || self.asset_disabled(envelope.taker_asset.clone())
            || envelope.taker_options.iter().any(|o| self.asset_disabled(o.asset.clone()))
        {
            env::log_str("open_rejected bet=unassigned reason=asset disabled for new bets");
            return false;
        }
        let Some(maker_limit) = self.asset_limits.get(&envelope.maker_asset).cloned() else {
            env::log_str("open_rejected bet=unassigned reason=maker_asset not whitelisted");
            return false;
        };
        // STG1 (D-STORAGE1): the maker's charge is computed by the contract in
        // the maker's own asset; a wrong deposit is refunded in full.
        let storage_maker = envelope.storage_for(maker_limit.storage_per_kib.0);
        if amount != envelope.stake_maker.0 + storage_maker {
            env::log_str("open_rejected bet=unassigned reason=deposit does not equal stake_maker + the maker-asset storage charge");
            return false;
        }
        let Some(taker_limit) = self.asset_limits.get(&envelope.taker_asset).cloned() else {
            env::log_str("open_rejected bet=unassigned reason=taker_asset not whitelisted");
            return false;
        };
        if envelope.stake_maker.0 < maker_limit.min_per_side.0
            || envelope.stake_maker.0 > maker_limit.max_per_side.0
        {
            env::log_str("open_rejected bet=unassigned reason=stake_maker outside asset_limits for maker_asset");
            return false;
        }
        if envelope.stake_taker.0 < taker_limit.min_per_side.0
            || envelope.stake_taker.0 > taker_limit.max_per_side.0
        {
            env::log_str("open_rejected bet=unassigned reason=stake_taker outside asset_limits for taker_asset");
            return false;
        }
        // D-PRICE3: 10:1 max odds, same-asset bets only -- a cross-asset
        // ratio needs a reference rate (D-PRICE4/5/6), out of scope here.
        if envelope.maker_asset == envelope.taker_asset {
            let (lo, hi) = if envelope.stake_maker.0 <= envelope.stake_taker.0 {
                (envelope.stake_maker.0, envelope.stake_taker.0)
            } else {
                (envelope.stake_taker.0, envelope.stake_maker.0)
            };
            if hi > lo * MAX_SAME_ASSET_ODDS {
                env::log_str("open_rejected bet=unassigned reason=stake ratio exceeds 10:1 max odds");
                return false;
            }
        }
        // Sub-job 2 (cross-asset-2, D-PRICE6): every extra taker_options
        // entry gets exactly the same two checks as the primary
        // taker_asset/stake_taker pair above -- whitelisted + within
        // that asset's min/max, and (only when its asset equals
        // maker_asset) the same-asset 10:1 odds cap. A cross-asset
        // option is never odds-checked onchain, per D-PRICE6.
        for opt in &envelope.taker_options {
            let Some(opt_limit) = self.asset_limits.get(&opt.asset).cloned() else {
                env::log_str("open_rejected bet=unassigned reason=taker_options asset not whitelisted");
                return false;
            };
            if opt.amount.0 < opt_limit.min_per_side.0 || opt.amount.0 > opt_limit.max_per_side.0 {
                env::log_str("open_rejected bet=unassigned reason=taker_options amount outside asset_limits");
                return false;
            }
            if opt.asset == envelope.maker_asset {
                let (lo, hi) = if envelope.stake_maker.0 <= opt.amount.0 {
                    (envelope.stake_maker.0, opt.amount.0)
                } else {
                    (opt.amount.0, envelope.stake_maker.0)
                };
                if hi > lo * MAX_SAME_ASSET_ODDS {
                    env::log_str("open_rejected bet=unassigned reason=taker_options stake ratio exceeds 10:1 max odds");
                    return false;
                }
            }
        }
        // D-REF1: referee != maker, taker or fee_account (RF2: the
        // single human-decides mode; the Source/FinalSay modes are removed).
        if let Some(referee) = &envelope.referee {
            if referee.account == envelope.maker || referee.account == self.fee_account {
                env::log_str("open_rejected bet=unassigned reason=referee cannot be maker or fee_account");
                return false;
            }
            let named_taker = match &envelope.taker_allow {
                TakerAllow::Account(a) => Some(a.clone()),
                _ => None,
            };
            // RF2 / D-REFUI4: taking = agreeing, so no named taker is
            // required any more; only the referee != named taker rule stays.
            if named_taker.as_ref() == Some(&referee.account) {
                env::log_str("open_rejected bet=unassigned reason=referee cannot be the named taker");
                return false;
            }
        }
        // RF2 / D-REFUI4: the maker's tip opt-in needs a referee to tip, and
        // protocol fee + tip must fit inside the stake. PA1: uses the bet's
        // own fee copies (the live limit read at open), never later params.
        let tip_maker_amt = if envelope.tip_maker {
            if envelope.referee.is_none() {
                env::log_str("open_rejected bet=unassigned reason=tip requires a referee");
                return false;
            }
            let t = side_fee(envelope.stake_maker.0, envelope.fee_bps as u128, maker_limit.min_fee_per_side.0);
            let f = side_fee(envelope.stake_maker.0, envelope.fee_bps as u128, maker_limit.min_fee_per_side.0);
            if f + t > envelope.stake_maker.0 {
                env::log_str("open_rejected bet=unassigned reason=fee + tip exceeds stake");
                return false;
            }
            t
        } else {
            0
        };
        // D-SUNSET1: beta sunset, optional. No admin exists to move this
        // once set at init; existing bets are unaffected (only new
        // offers blocked). `None` means no sunset at all.
        if let Some(sunset) = self.beta_sunset_ns {
            if env::block_timestamp() >= sunset {
                env::log_str("open_rejected bet=unassigned reason=beta sunset reached, no new offers");
                return false;
            }
        }
        let max_ttl_ns = self.limits.max_offer_ttl_secs as u128 * 1_000_000_000u128;
        if (envelope.funding_deadline as u128)
            > env::block_timestamp() as u128 + max_ttl_ns
        {
            return false;
        }
        // D-HORIZON1a: resolve_deadline at most 1,461 days after open (exactly
        // 1,461 days accepted). Open-time only; existing bets are unaffected.
        if (envelope.resolve_deadline as u128)
            > env::block_timestamp() as u128 + MAX_HORIZON_NS as u128
        {
            env::log_str("open_rejected bet=unassigned reason=resolve_deadline must be at most 1461 days after open (D-HORIZON1a)");
            return false;
        }
        let bet_id = self.next_bet_id;
        self.next_bet_id += 1;
        envelope.bet_id = bet_id;
        let now = env::block_timestamp();
        let bet = Bet {
            // D-PARAMS1: the bet keeps its own copy of the min fees for life.
            fee_min_maker: maker_limit.min_fee_per_side,
            fee_min_taker: taker_limit.min_fee_per_side,
            // FM1: each option asset was just proven whitelisted above.
            fee_min_taker_options: envelope
                .taker_options
                .iter()
                .map(|o| self.asset_limits.get(&o.asset).map(|l| l.min_fee_per_side).unwrap_or(U128(0)))
                .collect(),
            tip_maker: U128(tip_maker_amt),
            tip_taker: U128(0),
            storage_maker: U128(storage_maker),
            storage_taker: U128(0),
            envelope: envelope.clone(),
            status: BetStatus::Open,
            taker: None,
            created_at: now,
            taken_at: None,
            proposed_at: None,
            outcome: None,
            used_run_nos: Vec::new(),
            runs_used: 0,
            bonds: Vec::new(),
            pre_challenge_outcome: None,
            challenged_by: None,
            exhibits: Vec::new(),
            rebuttals: Vec::new(),
            objection_deposits: Vec::new(),
            amend_count: 0,
            referee_proposal: Proposal::default(),
            amend_proposal: Proposal::default(),
            prune_proposal: Proposal::default(),
            pending_resolution_request: None,
            last_resolution_raw: None,
            pruned: false,
            next_expected_run_no: 1,
            next_run_no: 1,
            pending_run_no: None,
            all_results: Vec::new(),
            window_extended: false,
            window_extension_ns: 0,
            first_unavailable_ns: None,
            retry_count: 0,
            next_check_ns: None,
            no_live_judge_until_ns: None,
            request_judge_snapshot: None,
            judge_pair_index: None,
        };
        self.bets.insert(bet_id, bet);
        // Red team 2026-11-07: capped listing index. Past the cap the offer
        // is fully functional by id (and discoverable via the `open
        // bet_id=` log line) but not listed by `open_offers`.
        if self.open_bet_ids.len() < MAX_OPEN_INDEX_LEN {
            self.open_bet_ids.push(bet_id);
        }
        env::log_str(&format!("open bet_id={bet_id} maker={sender_id}"));
        emit_event("bet_opened", json!({"bet_id": bet_id, "maker": sender_id}));
        true
    }

    fn handle_take(
        &mut self,
        sender_id: AccountId,
        bet_id: u64,
        invite_sig: Option<String>,
        tip: bool,
        referee_ack: Option<AccountId>,
        token_id: String,
        amount: u128,
    ) -> bool {
        if self.new_offers_paused {
            return false; // D-SUNSET2/D-SUNSET3: pause/shutdown blocks take
        }
        let Some(bet) = self.bets.get_mut(&bet_id) else {
            return false;
        };
        if bet.status != BetStatus::Open {
            return false;
        }
        if env::block_timestamp() > bet.envelope.funding_deadline {
            return false;
        }
        match &bet.envelope.taker_allow {
            TakerAllow::Any => {}
            TakerAllow::Account(a) => {
                if *a != sender_id {
                    return false;
                }
            }
            TakerAllow::InvitePubkey(pk) => {
                let Some(sig) = invite_sig else { return false };
                let message = format!("praetorial:invite:v1:{bet_id}:{sender_id}");
                if !verify_sig(pk, &sig, message.as_bytes()) {
                    return false;
                }
            }
        }
        // D-REF1: referee != taker (covers the TakerAllow::Any case,
        // where the taker isn't known until take time -- the
        // maker/fee_account/named-taker cases are already rejected at
        // `handle_open`).
        if let Some(referee) = &bet.envelope.referee {
            if referee.account == sender_id {
                return false;
            }
        }
        // RF2 / D-REFUI4: taking = agreeing to the referee. The taker must
        // name the referee they are agreeing to (so a maker swap racing the
        // take cannot land them under a different referee), and may only
        // opt in to a tip when there is a referee to tip.
        if referee_ack != bet.envelope.referee.as_ref().map(|r| r.account.clone()) {
            env::log_str("take_rejected reason=referee_ack does not match the bet's referee");
            return false;
        }
        if tip && bet.envelope.referee.is_none() {
            env::log_str("take_rejected reason=tip requires a referee");
            return false;
        }
        if sender_id == bet.envelope.maker {
            return false; // can't take your own bet
        }
        // Sub-job 2 (cross-asset-2, D-PRICE6): the deposit's actual
        // token/amount must match EXACTLY ONE of the offer's taker
        // options -- either the primary (taker_asset, stake_taker)
        // pair, or one entry in taker_options (both already proven
        // whitelisted + within asset_limits at open time). Wrong
        // asset, wrong amount, over- or under-deposit against every
        // option is rejected (I-3: full refund via mt_on_transfer).
        // Whichever option matches is recorded by overwriting
        // taker_asset/stake_taker with it -- settlement/payout code
        // downstream of `take` reads only those two fields and is
        // otherwise unchanged by this sub-job.
        // TKH1: every check that can refuse the take runs BEFORE any write
        // to the bet (a `false` return does not revert state), so a refused
        // take leaves the bet byte-identical. The matched option is held in
        // locals and only written once all checks have passed.
        // STG1 (D-STORAGE1): the taker's storage charge is computed in the
        // asset actually taken (primary or option) from that asset's rate.
        let primary_rate = self
            .asset_limits
            .get(&bet.envelope.taker_asset)
            .map(|l| l.storage_per_kib.0)
            .unwrap_or_else(|| env::panic_str("taker_asset has no asset limit"));
        let storage_primary = bet.envelope.storage_for(primary_rate);
        let required_for_primary = bet.envelope.stake_taker.0 + storage_primary;
        // (asset, stake, fee_min, is_option, storage) the taker's deposit
        // resolves to; is_option = alternate option (needs writing).
        let matched: Option<(String, U128, U128, bool, u128)> = if token_id == bet.envelope.taker_asset {
            if amount == required_for_primary {
                Some((
                    bet.envelope.taker_asset.clone(),
                    bet.envelope.stake_taker,
                    bet.fee_min_taker,
                    false,
                    storage_primary,
                ))
            } else {
                None
            }
        } else if let Some((opt_idx, opt)) = bet
            .envelope
            .taker_options
            .iter()
            .enumerate()
            .find(|(_, o)| o.asset == token_id)
            .map(|(i, o)| (i, o.clone()))
        {
            let opt_rate = self
                .asset_limits
                .get(&opt.asset)
                .map(|l| l.storage_per_kib.0)
                .unwrap_or_else(|| env::panic_str("taker option asset has no asset limit"));
            let storage_opt = bet.envelope.storage_for(opt_rate);
            let required = opt.amount.0 + storage_opt;
            if amount == required {
                // FM1 (D-FEEMIN2): the option asset's own min fee, copied at open.
                let fee_min = bet
                    .fee_min_taker_options
                    .get(opt_idx)
                    .copied()
                    .unwrap_or_else(|| env::panic_str("missing fee_min_taker_options copy"));
                Some((opt.asset, opt.amount, fee_min, true, storage_opt))
            } else {
                None
            }
        } else {
            None
        };
        let Some((m_asset, m_stake, m_fee_min, is_option, m_storage)) = matched else {
            env::log_str(&format!(
                "take_rejected bet_id={bet_id} reason=deposit does not exactly match taker_asset or any taker_options entry"
            ));
            return false;
        };
        let mut tip_taker_amt = 0u128;
        if tip {
            // The taker's tip is on THEIR stake, in THEIR (matched) asset,
            // using the bet's own taker fee copy (PA1).
            let t = side_fee(m_stake.0, bet.envelope.fee_bps as u128, m_fee_min.0);
            if t + t > m_stake.0 {
                env::log_str("take_rejected reason=fee + tip exceeds stake");
                return false;
            }
            tip_taker_amt = t;
        }
        // ---- all checks passed: first write ----
        if is_option {
            bet.envelope.taker_asset = m_asset;
            bet.envelope.stake_taker = m_stake;
            bet.fee_min_taker = m_fee_min;
        }
        if tip {
            bet.tip_taker = U128(tip_taker_amt);
        }
        bet.storage_taker = U128(m_storage);
        bet.taker = Some(sender_id.clone());
        bet.status = BetStatus::Taken;
        bet.taken_at = Some(env::block_timestamp());
        self.unindex_open_offer(bet_id);
        env::log_str(&format!("take bet_id={bet_id} taker={sender_id}"));
        emit_event("bet_taken", json!({"bet_id": bet_id, "taker": sender_id}));
        true
    }

    fn handle_bond(&mut self, sender_id: AccountId, bet_id: u64, round: u32, token_id: String, amount: u128) -> bool {
        if self.shutdown {
            return false; // D-SUNSET3: no new challenge round can race emergency_refund
        }
        let max_rounds = self.limits.max_rounds;
        let Some(bet) = self.bets.get_mut(&bet_id) else {
            return false;
        };
        // RF2 / D-REFUI4: no bonds or challenges on a human-referee bet.
        if bet.envelope.referee.is_some() {
            return false;
        }
        let is_maker = sender_id == bet.envelope.maker;
        let is_party = is_maker || bet.taker.as_ref() == Some(&sender_id);
        if !is_party {
            return false;
        }
        let challengeable = matches!(bet.status, BetStatus::Proposed | BetStatus::Evidence);
        if !challengeable {
            return false;
        }
        // D-AUDIT8 (design decision, OQ-T10 ruling #4): a bet may go
        // through at most `max_rounds` challenge/re-judge rounds
        // (`bet.bonds.len()` is exactly the count of rounds opened so
        // far). Past the cap, no further challenge is accepted -- the
        // bet settles on the standing outcome via `finalize`
        // (RF2: no arbiter escalation exists any more).
        if bet.bonds.len() as u32 >= max_rounds {
            env::log_str(&format!(
                "challenge_rejected bet_id={bet_id} reason=max_rounds reached ({max_rounds})"
            ));
            return false;
        }
        // D-BOND1: the bond must be posted in the CHALLENGER's own
        // stake asset -- maker_asset if they're the maker, taker_asset
        // if they're the taker. Anything else (including the other
        // party's own asset, or USDC on a bet that doesn't stake it)
        // is rejected here and refunded in full by the caller
        // (`mt_on_transfer`'s I-3 path).
        let depositor_asset = if is_maker {
            bet.envelope.maker_asset.clone()
        } else {
            bet.envelope.taker_asset.clone()
        };
        if token_id != depositor_asset {
            env::log_str(&format!(
                "challenge_rejected bet_id={bet_id} reason=bond token does not match depositor's own stake asset"
            ));
            return false;
        }
        let Some(limit) = self.asset_limits.get(&depositor_asset).cloned() else {
            return false;
        };
        // D-AUDIT8 (ruling #2), generalized per asset by D-BOND1: the
        // bond must cover this asset's own challenge-bond minimum
        // (max(min_bond, 5% of pot_for_challenger)) PLUS this round's
        // full `run_price` (also this asset's own) -- compute for
        // every round is now paid from the CHALLENGER's own bond,
        // never from the shared reserve or the other party's share,
        // so the reserve can never be overdrawn by a challenge round
        // (see `finalize`'s doc).
        // D-DISPUTE1: max($10, 10% of pot) DOUBLES per challenge round
        // (round r's multiplier is 2^(r-1); round 1 = x1, round 2 =
        // x2) -- the whole max(...) is doubled, not just the 10%-of-pot
        // term, so a floor-dominated round 1 still doubles in round 2.
        // `run_price` is NOT doubled -- each round pays exactly its own
        // (undoubled) compute cost. The round about to open is
        // `bet.bonds.len() + 1` (1-indexed; this bond hasn't been
        // pushed yet).
        let pot = bet.envelope.pot_for_challenger(is_maker);
        let challenge_floor = std::cmp::max(limit.min_bond.0, pot * 1_000 / BPS_DENOM);
        let this_round = bet.bonds.len() as u32 + 1;
        let challenge_min = challenge_floor * 2u128.pow(this_round - 1);
        let required = challenge_min + limit.run_price.0;
        if amount != required {
            return false;
        }
        // BUG FIX: append (don't overwrite) -- a round-2 bond during
        // Evidence used to clobber `bet.bond`, stranding round 1's USDC
        // with no settlement path. Each round keeps its own pre-challenge
        // outcome snapshot so it settles independently at `finalize`.
        let pre_outcome = bet.outcome.clone();
        bet.bonds.push(BondInfo {
            holder: sender_id.clone(),
            amount: U128(amount),
            // RED-TEAM (referee collusion): the round label is POSITIONAL,
            // never the caller-supplied `round` -- `referee_rule` finds the
            // prepaid-panel bond by `b.round == max_rounds`, so a spoofed
            // label on an earlier bond captured the final-round refund.
            round: this_round,
            pre_challenge_outcome: pre_outcome.clone(),
            asset: depositor_asset,
        });
        bet.pre_challenge_outcome = pre_outcome;
        bet.challenged_by = Some(sender_id.clone());
        bet.status = BetStatus::Challenged;
        env::log_str(&format!("challenge bet_id={bet_id} by={sender_id} round={round}"));
        true
    }

    fn handle_objection(
        &mut self,
        sender_id: AccountId,
        bet_id: u64,
        exhibit_hash: String,
        is_rebuttal: bool,
        token_id: String,
        amount: u128,
    ) -> bool {
        if self.shutdown {
            return false; // D-SUNSET3: no new objection/rebuttal can race emergency_refund
        }
        if exhibit_hash.len() > MAX_HASH_LEN {
            return false;
        }
        let Some(bet) = self.bets.get_mut(&bet_id) else {
            return false;
        };
        let is_maker = sender_id == bet.envelope.maker;
        let is_party = is_maker || bet.taker.as_ref() == Some(&sender_id);
        if !is_party {
            return false;
        }
        if !matches!(bet.status, BetStatus::Challenged | BetStatus::Evidence) {
            return false;
        }
        // D-BOND1: the objection/rebuttal deposit must be posted in
        // the OBJECTOR's own stake asset, same rule as `handle_bond`.
        let depositor_asset = if is_maker {
            bet.envelope.maker_asset.clone()
        } else {
            bet.envelope.taker_asset.clone()
        };
        if token_id != depositor_asset {
            return false;
        }
        let Some(limit) = self.asset_limits.get(&depositor_asset).cloned() else {
            return false;
        };
        let pot = bet.envelope.pot_for_challenger(is_maker);
        let required = std::cmp::max(limit.min_objection.0, pot * 50 / BPS_DENOM); // max(min_objection, 0.5% pot)
        if amount != required {
            return false;
        }
        // D2: `bet.exhibits` and `bet.rebuttals` differ in element type
        // now (exhibits carry the on-chain `submitted_at` moment,
        // rebuttals don't -- D2 scopes the timestamp requirement to
        // exhibits specifically), so the two branches can no longer
        // share one `&mut Vec<_>` binding as before.
        if is_rebuttal {
            if bet.rebuttals.len() >= 5 {
                return false;
            }
            bet.rebuttals.push(exhibit_hash);
        } else {
            // Item 7r bugfix: per-SUBMITTER cap (same fix as submit_exhibits),
            // not a global cap across every filer sharing bet.exhibits.
            if bet.exhibits.iter().filter(|e| e.submitted_by == sender_id).count() >= 5 {
                return false;
            }
            let now = env::block_timestamp();
            env::log_str(&format!(
                "exhibit_submitted bet_id={bet_id} by={sender_id} hash={exhibit_hash} submitted_at={now}"
            ));
            bet.exhibits.push(Exhibit {
                hash: exhibit_hash,
                submitted_at: U64(now),
                submitted_by: sender_id.clone(),
            });
        }
        let pre_outcome = bet.outcome.clone();
        bet.status = BetStatus::Evidence;
        // BUG FIX (the ask for this pass): objection/rebuttal deposits used
        // to be folded straight into the old shared reserve pool (removed,
        // D-ECON5) and always split 50/50 at finalize, regardless of
        // whether the objection was
        // upheld or rejected. Now tracked separately and settled at
        // `finalize` per `ObjectionDeposit`'s doc: forfeited to the
        // counterparty when rejected, returned to the depositor when
        // upheld.
        bet.objection_deposits.push(ObjectionDeposit {
            sender: sender_id,
            amount: U128(amount),
            is_rebuttal,
            pre_outcome,
            asset: depositor_asset,
        });
        true
    }

    // -------------------------------------------------------------
    // Maker/anyone refund paths
    // -------------------------------------------------------------

    pub fn cancel(&mut self, bet_id: u64) {
        let predecessor = env::predecessor_account_id();
        let bet = self.bet_mut(bet_id);
        require(bet.status == BetStatus::Open, "bet is not Open");
        require(predecessor == bet.envelope.maker, "only maker may cancel");
        self.refund_open(bet_id, BetStatus::Cancelled);
    }

    pub fn expire(&mut self, bet_id: u64) {
        let bet = self.bet_mut(bet_id);
        require(bet.status == BetStatus::Open, "bet is not Open");
        require(
            env::block_timestamp() > bet.envelope.funding_deadline,
            "funding_deadline not reached",
        );
        self.refund_open(bet_id, BetStatus::Expired);
    }

    /// PRT-L2-031 / PRT-L6-009 (Decisions log D7, b0nd decision #8):
    /// storage sponsor can close an untaken sponsored offer and recover
    /// storage NEAR. `cancel` (maker-only, anytime) and `expire`
    /// (permissionless, only after `funding_deadline`) already cover an
    /// untaken offer's refund path -- the one gap they leave is an
    /// operator-initiated early close *before* `funding_deadline` for an
    /// offer whose storage this platform is sponsoring (this contract
    /// has no literal per-bet NEAR sponsor escrow -- storage is a shared
    /// pool, same structural model as `prune_terms`, PRT-L2-019 -- so the
    /// sponsor recovering "storage NEAR" means the pool stops being
    /// charged for this bet, exactly like `prune_terms`/`expire`). Gated
    /// to `operator` (the de facto storage sponsor in this build) rather
    /// than made fully permissionless, so a stranger can't force-close
    /// someone else's live offer. Refund mechanics are identical to
    /// `cancel`/`expire` (full refund, no fee, terminal status
    /// `Cancelled` -- same bucket as a maker-initiated cancel, since both
    /// are "bet closed before it was ever taken").
    pub fn reclaim(&mut self, bet_id: u64) {
        require(
            env::predecessor_account_id() == self.operator,
            "only operator may reclaim",
        );
        let bet = self.bet_mut(bet_id);
        require(bet.status == BetStatus::Open, "bet is not Open");
        env::log_str(&format!("reclaim bet_id={bet_id} by=operator"));
        self.refund_open(bet_id, BetStatus::Cancelled);
    }

    fn refund_open(&mut self, bet_id: u64, terminal: BetStatus) {
        let bet = self.bet_mut(bet_id);
        let maker = bet.envelope.maker.clone();
        let amount = bet.envelope.stake_maker.0 + bet.storage_maker.0;
        let maker_asset = bet.envelope.maker_asset.clone();
        bet.status = terminal.clone();
        emit_event(
            if terminal == BetStatus::Expired { "bet_expired" } else { "bet_cancelled" },
            json!({"bet_id": bet_id, "maker": maker}),
        );
        self.unindex_open_offer(bet_id);
        self.schedule_payout(bet_id, maker, maker_asset, amount, "cancel_expire_refund".to_string());
    }

    /// Red team 2026-11-07: `open_bet_ids` lives in ROOT state (borsh
    /// read+written on every call), so it must stay small. An id leaves the
    /// index the moment its offer stops being Open (taken/cancelled/expired).
    fn unindex_open_offer(&mut self, bet_id: u64) {
        self.open_bet_ids.retain(|id| *id != bet_id);
    }

    // -------------------------------------------------------------
    // Resolution
    // -------------------------------------------------------------

    /// `terms`: only meaningful for a hash-only bet (`keep_terms: false`).
    /// The escrow contract never stored the plaintext for such a bet, so
    /// if the resolver needs it (anything beyond a bare terms_hash
    /// mismatch check), the caller of `request_resolution` may pass it
    /// here each time; it is forwarded into `input_data` and never
    /// persisted onchain. For a `keep_terms: true` bet, this argument is
    /// ignored -- the contract's own stored `envelope.terms` is used
    /// instead, so a caller cannot smuggle in a different copy than what
    /// both parties funded against.
    ///
    /// SECURITY: this contract does **not** verify
    /// `sha256(terms) == terms_hash` for the caller-supplied path -- by
    /// design (Resolver v1 spec §1's forced decision #1): the resolver is
    /// the only party that reads the plaintext, so it is the one that
    /// must reject a mismatch (treat it as `INVALID_INPUT` -> VOID, same
    /// as any other malformed input, per that spec's §11 error taxonomy).
    /// A caller passing garbage here costs them nothing new -- it's the
    /// same trust level as passing nothing at all.

    /// v1.1 (FM-9): read-only dry run of `request_resolution`'s own
    /// pre-spend guards, so an app can check *before* letting a user
    /// sign and attach NEAR to a call that would otherwise panic after
    /// the deposit has already left their account (NEAR only refunds a
    /// failed call's attached deposit for a *native* caller -- the whole
    /// reason this view exists is to avoid a failing call in the first
    /// place, not to rely on that refund). Mirrors every `require` in
    /// `request_resolution` up to (not including) the attached-deposit
    /// check, which depends on a deposit the caller hasn't chosen yet.
    /// `near_sdk`'s `#[near]` macro deprecates a bare `Result<T, E>`
    /// return from a public contract method (it would otherwise
    /// serialize failure as a JSON error object instead of an RPC
    /// panic, which `#[handle_result]` exists to opt into -- not what a
    /// plain dry-run view wants). `Option<String>` avoids that
    /// footgun entirely: `None` = "go ahead", `Some(reason)` = the exact
    /// `require` message `request_resolution` would panic with.
    pub fn can_request_resolution(&self, bet_id: u64) -> Option<String> {
        let Some(bet) = self.bets.get(&bet_id) else {
            return Some("unknown bet_id".to_string());
        };
        if !matches!(
            bet.status,
            BetStatus::Taken | BetStatus::Challenged | BetStatus::Evidence
        ) {
            return Some("bet not awaiting resolution".to_string());
        }
        let now = env::block_timestamp();
        let early_ok = bet.envelope.early_settle_outcome.is_some();
        if !(now >= bet.envelope.funding_deadline || early_ok) {
            return Some("too early to request resolution".to_string());
        }
        if bet.runs_used >= bet.envelope.max_paid_runs {
            return Some("max_paid_runs reached".to_string());
        }
        if now >= bet.envelope.resolve_deadline {
            return Some("resolve_deadline passed".to_string());
        }
        // RF2 / D-REFUI4: a human-referee bet is never AI-resolved.
        if bet.envelope.referee.is_some() {
            return Some("a person decides this bet (no AI run)".to_string());
        }
        // JCB1 (D-JCB1): bounded RETRY:no_live_judge loop.
        if bet.no_live_judge_until_ns.is_some_and(|t| now < t) {
            return Some(NO_LIVE_JUDGE_WAIT_MSG.to_string());
        }
        None
    }

    #[payable]
    pub fn request_resolution(&mut self, bet_id: u64, terms: Option<String>) -> Promise {
        require(!self.shutdown, "contract is shut down");
        let payer = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        self.internal_request_resolution(bet_id, terms, payer, deposit, false)
    }

    /// Loop 6 (FM-8): the intents `AuthCall` entrypoint. Only the intents
    /// contract itself may call this (an `AuthCall` is routed through
    /// intents.near, which attaches native NEAR debited from the
    /// signer's own wNEAR intents balance -- see `AuthCall.attached_deposit`
    /// doc in defuse-core -- so `env::attached_deposit()` here is real,
    /// spendable NEAR, just funded differently than a direct caller's).
    /// `signer_id` (not `env::predecessor_account_id()`, which is always
    /// the intents contract for this call) is the acting party/payer.
    /// Every check below runs BEFORE any cross-contract spend, so a
    /// doomed call fails cheaply (FM-8: cheap failure).
    #[payable]
    pub fn on_auth(&mut self, signer_id: AccountId, msg: String) -> PromiseOrValue<()> {
        require(
            env::predecessor_account_id() == self.intents,
            "on_auth: only callable by the intents contract",
        );
        let parsed: AuthMsg = serde_json::from_str(&msg)
            .unwrap_or_else(|_| env::panic_str("on_auth: bad msg"));
        match parsed {
            AuthMsg::RequestResolution { bet_id } => {
                let deposit = env::attached_deposit().as_yoctonear();
                let promise = self.internal_request_resolution(
                    bet_id, None, signer_id, deposit, true,
                );
                PromiseOrValue::Promise(promise)
            }
            AuthMsg::ExtendWindow { bet_id } => {
                // No native spend for this variant; any attached deposit
                // (there shouldn't be one) is simply left with the
                // contract -- matches `extend_window`'s own non-payable
                // direct entrypoint.
                self.internal_extend_window(bet_id, &signer_id);
                PromiseOrValue::Value(())
            }
        }
    }

    fn internal_request_resolution(
        &mut self,
        bet_id: u64,
        terms: Option<String>,
        payer: AccountId,
        deposit: u128,
        via_auth_call: bool,
    ) -> Promise {
        // FIX (D-BOND3 unit-test finding): every mutation below used to
        // happen BEFORE the attached-deposit sufficiency check further
        // down (`required_deposit`/`required(deposit >= ...)`). On real
        // NEAR that ordering is harmless -- a `require()` panic aborts
        // the whole receipt and reverts every state change in it, so a
        // doomed call is a no-op onchain regardless of mutation order.
        // But near-sdk's in-process unit-test harness calls methods
        // directly on the same long-lived `Contract` struct with no such
        // rollback: a caller using `catch_unwind` to probe "does this
        // call succeed" (exactly what `request_resolution`'s zero-deposit
        // non-keeper path invites, D5) was left with `bet.status` already
        // flipped to `Resolving` and `next_request_id`/`pending_requests`
        // already advanced from the FAILED attempt, so the next, properly
        // funded call then failed its own `bet not awaiting resolution`
        // check. Deferring every mutation (request_id allocation,
        // `pending_requests` insert, `bet.status`/`pending_resolution_request`)
        // until after ALL `require()` validation -- including the deposit
        // check -- makes a failed call a true no-op under both chain
        // semantics (where it already was) and direct in-process calls
        // (where it wasn't), with no behavior change for any call that
        // actually succeeds.
        let request_id = self.next_request_id;
        let wasm_hash;
        let round;
        {
            let bet = self.bet(bet_id);
            require(
                matches!(
                    bet.status,
                    BetStatus::Taken | BetStatus::Challenged | BetStatus::Evidence
                ),
                "bet not awaiting resolution",
            );
            let now = env::block_timestamp();
            let early_ok = bet.envelope.early_settle_outcome.is_some();
            require(
                now >= bet.envelope.funding_deadline || early_ok,
                "too early to request resolution",
            );
            require(bet.runs_used < bet.envelope.max_paid_runs, "max_paid_runs reached");
            require(now < bet.envelope.resolve_deadline, "resolve_deadline passed");
            // RF2 / D-REFUI4: a human-referee bet is never AI-resolved.
            require(
                bet.envelope.referee.is_none(),
                "a person decides this bet (no AI run)",
            );
            // JCB1 (D-JCB1): after a RETRY:no_live_judge, wait max(signed next_check_ns, submit + 12h).
            require(
                !bet.no_live_judge_until_ns.is_some_and(|t| now < t),
                NO_LIVE_JUDGE_WAIT_MSG,
            );

            // SPEC (layer-spec ruling): the resolver needs to know which
            // dispute round this resolution attempt belongs to (the
            // initial resolve is round 0; each bond round recorded by
            // `handle_bond` -- challenge, then a re-judge after an
            // Evidence round, etc -- bumps it). `bet.bonds` already
            // tracks one entry per round (see its own doc re: the
            // round-2-overwrite bug fix), so its length is exactly that
            // count at the moment resolution is requested.
            round = bet.bonds.len() as u32;
            // D-KEY1: resolver_wasm_hash is pinned contract-level config
            // now, not a per-bet maker choice.
            wasm_hash = self.resolver_wasm_hash.clone();
        }
        let bet = self.bets.get(&bet_id).unwrap();

        // SPEC (layer-spec ruling): terms for input_data --
        // `envelope.terms` when the bet kept them onchain (ignoring any
        // caller-supplied `terms`, which would otherwise let a caller
        // substitute a different copy than what both parties funded
        // against); the caller-supplied argument only for a hash-only
        // bet, where the contract never had a copy to begin with.
        let effective_terms: Option<String> = if bet.envelope.keep_terms {
            bet.envelope.terms.clone()
        } else {
            terms
        };

        let max_execution_seconds = max_execution_seconds_for_tier(bet.envelope.tier);

        // Ruling (b0nd, 2026-11-01, overrides the stale "Canonical design
        // v1 (reconciled)" doc per MASTER MAP's own precedence rule): the
        // CONTRACT calls OutLayer, never the keeper directly (C1/C2) --
        // the signing key OutLayer hands back is bound to
        // (wasm_hash, caller=predecessor), and the predecessor of
        // `request_execution` must be this escrow contract for a result to
        // ever verify in `submit_outcome`. `request_resolution` itself stays
        // permissionless + payable: anyone (typically the keeper) may call
        // it and front the attached NEAR; `payer_account_id` below records
        // the real caller, not this contract, for reimbursement purposes.
        //
        // `source` is a bare pinned-hash `WasmUrl` -- never OutLayer's
        // `Project` reference (would let the project owner swap code post
        // facto) and never an `attached_usd`-style self-pay mode (C4/C5:
        // every run is paid from the bet's own USDC reserve at a flat
        // run_price, reimbursed to the keeper at finalize/void, not billed
        // through OutLayer's own stablecoin project in v1).
        //
        // `input_data` (layer-spec ruling, widened this pass): the FULL
        // stored envelope (not just terms_hash -- the resolver needs
        // judge config/tier/outcomes/etc, not just a hash to re-derive
        // them from, per Resolver v1 spec §1's own gap writeup), plus
        // `terms` (see `effective_terms` above), the dispute `round`, the
        // `run_no` (D-RUNNO1: the BET's own monotonic run counter, NOT the
        // global `request_id` -- `submit_outcome` enforces per-bet order),
        // and the
        // contract id. The caller supplies only `bet_id` (to pick the
        // bet) and, for a hash-only bet, an optional `terms` string --
        // never free-form bytes that land in the resolver's input
        // unexamined. Built by a pure function so its exact shape is
        // unit-testable without a cross-contract call.
        let run_no = bet.next_run_no.max(bet.next_expected_run_no);
        let input_data_string = resolution_input_data_with_missing(
            &env::current_account_id(),
            bet_id,
            &bet.envelope,
            &effective_terms,
            round,
            run_no,
            &payer,
            &self.judge_chain,
            &self.model_missing_map(),
        );

        // Watch input_data size vs OutLayer's own charge formula
        // (execution.rs::request_execution: `estimated_cost +
        // input_storage_deposit(len)`, where the first
        // OUTLAYER_INPUT_DATA_FREE_BYTES are free and every byte above
        // that is charged OUTLAYER_STORAGE_PRICE_PER_BYTE for the life of
        // the pending request) and make the attached-deposit requirement
        // correct: embedding the full envelope (+ terms, for a
        // keep_terms bet) can push input_data past the free threshold,
        // which the old hardcoded ~0.01 NEAR attachment never accounted
        // for. We can't call OutLayer's live compute estimator from here,
        // so MIN_RESOLUTION_COMPUTE_DEPOSIT stands in as a generous flat
        // floor for the compute side (same figure the keeper already
        // floats, MASTER MAP §3 step 4); the storage side is computed
        // exactly, since it's a pure function of a length this contract
        // already has.
        let input_len = input_data_string.len();
        let required_deposit = required_resolution_deposit(input_len);
        // D5: a zero-deposit call from the keeper itself is the one call
        // shape a function-call access key scoped to this contract can
        // ever make (NEAR protocol forbids any attached deposit on a
        // FunctionCall-permission key, full stop -- confirmed in the
        // sandbox proof, D5 build log). Draw the compute cost from the
        // prepaid pool instead of requiring an attachment; every other
        // caller (including the keeper attaching NEAR directly, e.g.
        // from a full-access key or a BYO-wallet keeper variant) keeps
        // the original attached-deposit requirement unchanged.
        let use_keeper_credit = deposit == 0 && !via_auth_call && payer == self.keeper;
        let (effective_deposit, funded_from_credit) = if use_keeper_credit {
            require(
                self.keeper_credit >= required_deposit,
                "insufficient keeper credit",
            );
            self.keeper_credit -= required_deposit;
            (required_deposit, true)
        } else {
            require(
                deposit >= required_deposit,
                "attached deposit too low for OutLayer compute + input_data storage",
            );
            (deposit, false)
        };
        // Every `require()` above has now passed -- commit the mutations
        // that used to happen up front (see the long comment at the top
        // of this function for why they're deferred to here).
        let snapshot = first_live_index(&self.judge_chain, &self.model_missing_btree())
            .map_or(NO_LIVE_SNAPSHOT, |i| i as u32);
        self.next_request_id += 1;
        self.pending_requests.insert(request_id, bet_id);
        {
            let bet = self.bet_mut(bet_id);
            let prior = bet.status.clone();
            bet.pending_resolution_request = Some(request_id);
            bet.request_judge_snapshot = Some(snapshot);
            // D-RUNNO1: commit the assigned per-bet run_no.
            bet.pending_run_no = Some(run_no);
            bet.next_expected_run_no = run_no;
            bet.next_run_no = run_no + 1;
            bet.status = BetStatus::Resolving;
            self.resolution_prior_status.insert(request_id, prior);
        }
        // FM-11: record who paid and how BEFORE spending it on OutLayer,
        // so `on_resolution`'s unused-compute refund (below) always has
        // somewhere correct to send money back to.
        self.resolution_payers.insert(
            request_id,
            ResolutionPayer {
                bet_id,
                payer: payer.clone(),
                via_auth_call,
                deposit: effective_deposit,
                funded_from_credit,
            },
        );

        let args = json!({
            "source": {
                "WasmUrl": {
                    "url": format!(
                        "{}/{}.wasm",
                        self.outlayer_config.wasm_base_url, wasm_hash
                    ),
                    "hash": wasm_hash,
                    "build_target": "wasm32-wasip2",
                }
            },
            "input_data": input_data_string,
            // Queue item 11: the OutLayer secret the run reads, from init config.
            "secrets_ref": {
                "profile": self.outlayer_config.secrets_profile,
                "account_id": self.outlayer_config.secrets_account_id,
            },
            "resource_limits": {
                "max_instructions": OUTLAYER_MAX_INSTRUCTIONS,
                "max_memory_mb": RESOLUTION_MAX_MEMORY_MB,
                "max_execution_seconds": max_execution_seconds,
            },
            "response_format": "Json",
        });
        env::log_str(&format!(
            "request_resolution bet_id={bet_id} request_id={request_id} payer={payer} round={round} input_len={input_len}"
        ));

        // Raw bytes: the `args` object IS the request_execution parameter
        // object (no wrapper).
        Promise::new(self.outlayer.clone())
            .function_call(
                "request_execution".to_string(),
                args.to_string().into_bytes(),
                NearToken::from_yoctonear(effective_deposit),
                OUTLAYER_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(RESOLUTION_CALLBACK_GAS)
                    .on_resolution(request_id),
            )
    }

    #[private]
    pub fn on_resolution(&mut self, request_id: u64) {
        let Some(&bet_id) = self.pending_requests.get(&request_id) else {
            return;
        };
        // Loop 6 (FM-10/FM-11): unused OutLayer compute, if any, is
        // refunded now -- natively for a direct `#[payable]
        // request_resolution` payer, or credited into the signer's
        // intents wNEAR balance for an `on_auth`/AuthCall payer (never
        // native for that path, since that deposit was never the
        // signer's native NEAR to begin with).
        let mut unused_compute: u128 = 0;
        // D-RESOLVE4: true only when the OutLayer promise itself failed
        // (nothing executed). An executed-but-unusable result is NOT this.
        let mut promise_failed = false;
        let raw = match env::promise_result(0) {
            PromiseResult::Successful(bytes) => {
                // BUG FIX (found live on testnet, loop 6 resume): mock-outlayer's
                // `request_execution` is a `#[near]` method returning `-> String`,
                // so the SDK auto-serializes the return value as JSON *of that
                // string* -- i.e. these bytes are a quoted, escaped JSON string
                // (`"{\"request_id\":...}"`), not the raw object. Parsing `bytes`
                // directly as a `Value` used to "succeed" by deserializing a
                // `Value::String(..)`, so `.get("unused_compute_yocto")` always
                // silently returned `None` (that call is a no-op on a String
                // value) and the refund below never fired on real testnet --
                // never caught by the unit test because it mocked the promise
                // result with raw object bytes instead of double-JSON-encoded
                // ones, which isn't what a real `String`-returning cross-contract
                // call actually produces on chain. Decode the outer JSON-string
                // layer first, then parse ITS contents as the Value.
                let outer = String::from_utf8(bytes).unwrap_or_default();
                let text = serde_json::from_str::<String>(&outer).unwrap_or(outer);
                match serde_json::from_str::<serde_json::Value>(&text) {
                    Ok(v) if v.is_object() => {
                        if let Some(s) = v.get("unused_compute_yocto").and_then(|x| x.as_str()) {
                            unused_compute = s.parse().unwrap_or(0);
                        }
                    }
                    _ => {
                        // D-RESOLVE4a: Successful but NO resolver output
                        // (`null`, empty, whitespace, or any non-object).
                        // Real OutLayer reports a failed execution this
                        // way ("Execution promise failed ... Refunded").
                        // Treated exactly like PromiseResult::Failed for
                        // status/retry. Refund rule: unused_compute stays
                        // 0 -- OutLayer already refunded the unused
                        // deposit itself as plain NEAR to this contract
                        // (recoverable via sweep_excess_near, D-OL-REFUND1),
                        // so refunding again here could double-pay. The
                        // raw text is kept in last_resolution_raw.
                        promise_failed = true;
                    }
                }
                text
            }
            PromiseResult::Failed => {
                // OutLayer never ran anything for this request -- the
                // whole deposit is "unused".
                promise_failed = true;
                if let Some(meta) = self.resolution_payers.get(&request_id) {
                    unused_compute = meta.deposit;
                }
                "{\"error\":\"outlayer_call_failed\"}".to_string()
            }
        };
        if let Some(bet) = self.bets.get_mut(&bet_id) {
            let mut raw = raw;
            if raw.len() > MAX_RESOLUTION_RAW_BYTES {
                let mut cut = MAX_RESOLUTION_RAW_BYTES;
                while !raw.is_char_boundary(cut) {
                    cut -= 1;
                }
                raw.truncate(cut);
            }
            bet.last_resolution_raw = Some(raw);
        }
        if unused_compute > 0 {
            if let Some(meta) = self.resolution_payers.get(&request_id) {
                let payer = meta.payer.clone();
                let via_auth_call = meta.via_auth_call;
                let funded_from_credit = meta.funded_from_credit;
                let amount = unused_compute.min(meta.deposit);
                if funded_from_credit {
                    // D5: this run was paid out of the keeper's prepaid
                    // compute pool (zero-attached-deposit call, drawn
                    // from `self.keeper_credit`) -- the NEAR never left
                    // the contract's own balance, so the refund is
                    // simply crediting the pool back, never a transfer
                    // to any account.
                    self.keeper_credit += amount;
                } else if via_auth_call && self.is_mainnet() {
                    // D-MN1 / D-OL-REFUND1: real intents.near has no
                    // `near_deposit_and_credit` (a testnet-mock-only
                    // method). Real OutLayer refunds unused compute as
                    // plain NEAR straight to this contract, so nothing
                    // is sent: it stays here and is recovered by the
                    // permissionless `sweep_excess_near`.
                } else if via_auth_call {
                    let _ = ext_intents::ext(self.intents.clone())
                        .with_attached_deposit(NearToken::from_yoctonear(amount))
                        .with_static_gas(REFUND_GAS)
                        .near_deposit_and_credit(payer);
                } else {
                    let _ = Promise::new(payer).transfer(NearToken::from_yoctonear(amount));
                }
            }
        }
        // D-RESOLVE4 (refines D-RESOLVE3): a FAILED OutLayer promise means
        // nothing ran. Restore the pre-request status and clear the
        // in-flight markers so `request_resolution` can be retried. Only if
        // the bet is still waiting on THIS request (not voided / shut
        // down / superseded). Dropping the request bookkeeping also makes a
        // replayed callback a no-op (no double refund). An executed-but-
        // unusable result keeps D-RESOLVE3 (stays Resolving; VOID backstop).
        if promise_failed {
            let prior = self.resolution_prior_status.get(&request_id).cloned();
            if let Some(bet) = self.bets.get_mut(&bet_id) {
                if bet.status == BetStatus::Resolving
                    && bet.pending_resolution_request == Some(request_id)
                {
                    if let Some(prior) = prior {
                        bet.status = prior;
                        bet.pending_resolution_request = None;
                        bet.pending_run_no = None;
                        bet.request_judge_snapshot = None;
                    }
                }
            }
            self.pending_requests.remove(&request_id);
            self.resolution_payers.remove(&request_id);
            self.resolution_prior_status.remove(&request_id);
        }
    }

    /// Anyone submits the resolver's signed outcome (ed25519 over borsh of
    /// `SubmittedResult`). Validated fully on-chain; `on_resolution`'s
    /// stored raw payload is informational only and never itself settles a
    /// bet (matches the v0 contract's safety property, carried forward).
    pub fn submit_outcome(&mut self, result: SubmittedResult, signature_hex: String) {
        require(!self.shutdown, "contract is shut down");
        // D-RESOLVE1 (item 7d): outcome is one of "YES", "NO", "RETRY",
        // "VOID" (legacy/unreasoned -- never gated), or "VOID:<reason>"
        // (e.g. "VOID:unavailable", "VOID:source_conflict",
        // "VOID:referee_silence"). Only the "unavailable" reason is
        // gated by the recovery ladder below; every other VOID reason
        // (and the bare legacy "VOID") settles exactly as before.
        let is_no_live_judge = result.outcome == NO_LIVE_JUDGE_OUTCOME;
        let is_retry = result.outcome == "RETRY" || is_no_live_judge;
        let void_reason: Option<&str> = result.outcome.strip_prefix("VOID:");
        require(
            result.outcome == "YES"
                || result.outcome == "NO"
                || result.outcome == "VOID"
                || is_retry
                || matches!(void_reason, Some(r) if !r.is_empty()),
            "bad outcome",
        );
        let max_retries = self.limits.max_retries;
        // JC1x (D-JUDGECHAIN1a #1): apply this result's signed not-found observations to a LOCAL copy of the shared
        // state, then require the claimed pair is the first LIVE applied pair (or none is live for no_live_judge).
        require(
            result.model_not_found.len() <= MAX_OBSERVATIONS_PER_RESULT,
            "too many model_not_found observations",
        );
        let now_ts = env::block_timestamp();
        let mut eff = self.model_missing_btree();
        let mut observed: Vec<String> = Vec::new();
        for o in &result.model_not_found {
            require(
                self.judge_chain.iter().any(|p| p.model_a == o.model || p.model_b == o.model),
                "observation names a model outside the judge chain",
            );
            require(o.observed_ns.0 <= now_ts, "observation is in the future");
            // JCD1 (D-JCD1 #3 / B3): fresh, and at most one per model per result.
            require(
                o.observed_ns.0 >= now_ts.saturating_sub(OBSERVATION_MAX_AGE_NS),
                "observation is older than 1h",
            );
            require(!observed.contains(&o.model), "at most one observation per model per result");
            let cur = eff.entry(o.model.clone()).or_default();
            *cur = add_observation(cur, o.observed_ns.0);
            if !observed.contains(&o.model) {
                observed.push(o.model.clone());
            }
        }
                let first_live_pre = first_live_index(&self.judge_chain, &self.model_missing_btree());
        let first_live_post = first_live_index(&self.judge_chain, &eff);
        // JC1s: only an APPLIED pair can have judged (pending/cancelled
        // proposals are never in `judge_chain`). Cheap, so before the sig.
        require(
            (result.judge_pair_index as usize) < self.judge_chain.len(),
            "judge_pair_index is not an applied judge pair",
        );
        // The resolver may retire a pair IN-RUN (its own signed observations are the 3rd check) and walk to the next one,
        // so the claimed pair must be the first live pair either before or after applying this result's observations.
        let live_ok_state = if is_no_live_judge {
            first_live_post.is_none()
        } else {
            first_live_pre == Some(result.judge_pair_index as usize) || first_live_post == Some(result.judge_pair_index as usize)
        };
        let clears_pair = result.outcome == "YES" || result.outcome == "NO";
        let judged_pair = self.judge_chain.get(result.judge_pair_index as usize).cloned().unwrap();
        // D-KEY1: snapshot the pinned outcome key before taking a
        // mutable borrow of `bet` below (self.bet_mut borrows all of
        // `self`, so `self.outcome_pubkey` can't be read through it).
        let outcome_pubkey = self.outcome_pubkey.clone();
        let bet = self.bet_mut(result.bet_id);
        require(
            matches!(
                bet.status,
                BetStatus::Taken
                    | BetStatus::Resolving
                    | BetStatus::Challenged
                    | BetStatus::Evidence
            ),
            "bet not awaiting an outcome",
        );
        // RF2 / D-REFUI4: a person decides a referee bet; no AI-signed
        // outcome can land on it.
        require(
            bet.envelope.referee.is_none(),
            "a person decides this bet (no AI outcome)",
        );
        require(
            result.terms_hash == bet.envelope.terms_hash,
            "terms_hash mismatch",
        );
        require(
            !bet.used_run_nos.contains(&result.run_no),
            "run_no already used",
        );
        // v1.1 (FM-13 / I-7, "result shopping"): strict run order. A
        // party holding several off-chain run results (e.g. a
        // non-deterministic judge re-run multiple times) cannot choose
        // which one to submit -- only `bet.next_expected_run_no` is
        // accepted, so results must land in the exact order they were
        // produced; a later run is rejected outright while an earlier
        // one is still outstanding. Checked before the signature verify
        // so a bad run_no fails cheaply and with a clear reason.
        require(
            result.run_no == bet.next_expected_run_no,
            "run_no out of order (I-7: strict run order, no result shopping)",
        );
        // JCD1 (D-JCD1 #2 / B2): the run an in-flight request belongs to may also be judged by the pair that was
        // first-live when it was requested (the resolver signs against its request-time input_data).
        let live_ok = live_ok_state
            || (bet.pending_run_no.is_some()
                && bet.request_judge_snapshot.is_some_and(|s| {
                    if is_no_live_judge {
                        s == NO_LIVE_SNAPSHOT
                    } else {
                        s != NO_LIVE_SNAPSHOT && s == result.judge_pair_index
                    }
                }));
        // D-RUNNO1: while a resolution request is in flight, only the
        // run_no assigned to THAT request is acceptable (a stale result
        // from an earlier failed/timed-out run is rejected).
        if let Some(pending) = bet.pending_run_no {
            require(
                result.run_no == pending,
                "run_no does not match the pending resolution request",
            );
        }
        // D-RESOLVE1 (item 7d): VOID-for-unavailability gate. Only the
        // resolver's OWN signed RETRY history (first_unavailable_ns /
        // retry_count, both maintained exclusively by this method, never
        // by any party call) counts; no brief/claim field is read here.
        // D-RESOLVE1 audit (item 7d2): the gate above must not be
        // bypassable by a resolver-signed bare "VOID" once the recovery
        // ladder has already engaged for this bet (first_unavailable_ns
        // is set by an earlier RETRY). Only an explicit reason OTHER than
        // "unavailable" (VOID:source_conflict, VOID:referee_silence, ...)
        // -- or a bare VOID with NO recovery history at all -- settles
        // unconditionally; those are genuinely unrelated to availability.
        // "VOID only after retries + archive + fallbacks fail."
        let gated_by_recovery_ladder =
            void_reason == Some("unavailable") || (result.outcome == "VOID" && bet.first_unavailable_ns.is_some());
        if gated_by_recovery_ladder {
            let now = env::block_timestamp();
            let window_ok = bet
                .first_unavailable_ns
                .is_some_and(|t| now >= t + RECOVERY_WINDOW_NS);
            let retries_ok = bet.retry_count >= max_retries;
            require(
                window_ok || retries_ok,
                "VOID-for-unavailability refused: recovery window not exhausted \
                 (needs 7d from first_unavailable_ns or max_retries RETRYs)",
            );
        }
        let mut buf = Vec::new();
        BorshSerialize::serialize(&env::current_account_id(), &mut buf).unwrap();
        BorshSerialize::serialize(&result.bet_id, &mut buf).unwrap();
        BorshSerialize::serialize(&result.terms_hash, &mut buf).unwrap();
        BorshSerialize::serialize(&result.outcome, &mut buf).unwrap();
        BorshSerialize::serialize(&result.element_results_hash, &mut buf).unwrap();
        BorshSerialize::serialize(&result.run_no, &mut buf).unwrap();
        BorshSerialize::serialize(&result.checked_until.0, &mut buf).unwrap();
        BorshSerialize::serialize(&result.judge_pair_index, &mut buf).unwrap();
        if is_retry {
            let Some(next_check_ns) = result.next_check_ns else {
                env::panic_str("RETRY requires next_check_ns");
            };
            BorshSerialize::serialize(&next_check_ns.0, &mut buf).unwrap();
            Self::append_observations(&mut buf, &result.model_not_found);
            // D-KEY1: verified against the pinned contract-level
            // outcome_pubkey, never a maker-supplied envelope key.
            require(
                verify_sig(&outcome_pubkey, &signature_hex, &buf),
                "bad signature",
            );
            require(live_ok, "judge_pair_index is not the first live applied pair (or a pair is live for no_live_judge)");
            let now = env::block_timestamp();
            require(next_check_ns.0 > now, "next_check_ns must be in the future");
            require(
                next_check_ns.0 <= now + MAX_RETRY_HORIZON_NS,
                "next_check_ns too far ahead (max 48h)",
            );
            // RETRY never settles: no money moves, no status/outcome
            // change, I-1 untouched. Only run-order bookkeeping and the
            // recovery-ladder state below are updated.
            // JCB1: a no_live_judge run_no is NOT pushed to used_run_nos (per-bet storage stays bounded):
            // `next_expected_run_no` below already refuses any replay or out-of-order run_no.
            if !is_no_live_judge {
                bet.used_run_nos.push(result.run_no);
            }
            bet.next_expected_run_no = result.run_no + 1;
            bet.pending_run_no = None;
            bet.request_judge_snapshot = None;
            // JCD1 (D-JCD1 #1 / B1): an accepted RETRY ends the in-flight request like a failed OutLayer promise does:
            // restore the saved prior status and clear the pending request, so the bet can be re-requested.
            let restore = if bet.status == BetStatus::Resolving { bet.pending_resolution_request.take() } else { None };
            if let Some(rid) = restore {
                if let Some(prior) = self.resolution_prior_status.remove(&rid) {
                    self.bet_mut(result.bet_id).status = prior;
                }
            }
            let bet = self.bet_mut(result.bet_id);
            if is_no_live_judge {
                // JC1s: no judge is live -- not an outage. The recovery
                // window, retry count and paid-run budget are untouched.
                bet.next_check_ns = Some(next_check_ns.0);
                bet.no_live_judge_until_ns = Some(next_check_ns.0.max(now.saturating_add(NO_LIVE_JUDGE_MIN_GAP_NS)));
                self.commit_observations(&eff, &observed, None);
                env::log_str(&format!(
                    "submit_outcome RETRY:no_live_judge bet_id={} next_check_ns={}",
                    result.bet_id, next_check_ns.0
                ));
                emit_event(
                    "outcome_retry",
                    json!({"bet_id": result.bet_id, "run_no": result.run_no, "judge_pair_index": result.judge_pair_index,
                           "no_live_judge": true, "next_check_ns": next_check_ns.0.to_string(), "model_not_found": result.model_not_found}),
                );
                return;
            }
            bet.no_live_judge_until_ns = None;
            bet.runs_used += 1;
            if bet.first_unavailable_ns.is_none() {
                bet.first_unavailable_ns = Some(now);
            }
            bet.retry_count += 1;
            bet.next_check_ns = Some(next_check_ns.0);
            let retry_count = bet.retry_count;
            self.commit_observations(&eff, &observed, None);
            env::log_str(&format!(
                "submit_outcome RETRY bet_id={} retry_count={} next_check_ns={}",
                result.bet_id, retry_count, next_check_ns.0
            ));
            emit_event(
                "outcome_retry",
                json!({"bet_id": result.bet_id, "run_no": result.run_no, "judge_pair_index": result.judge_pair_index,
                       "no_live_judge": false, "retry_count": retry_count, "next_check_ns": next_check_ns.0.to_string(),
                       "model_not_found": result.model_not_found}),
            );
            return;
        }
        Self::append_observations(&mut buf, &result.model_not_found);
        // D-KEY1: verified against the pinned contract-level
        // outcome_pubkey, never a maker-supplied envelope key.
        require(
            verify_sig(&outcome_pubkey, &signature_hex, &buf),
            "bad signature",
        );
        require(live_ok, "judge_pair_index is not the first live applied pair");

        bet.used_run_nos.push(result.run_no);
        bet.no_live_judge_until_ns = None;
        bet.request_judge_snapshot = None;
        bet.runs_used += 1;
        // v1.1 (FM-13): record this run's result permanently before
        // `bet.outcome` is overwritten (a later challenge/re-judge round
        // would otherwise erase this round's result with no trace).
        bet.all_results.push(RunResult {
            run_no: result.run_no,
            outcome: result.outcome.clone(),
            element_results_hash: result.element_results_hash.clone(),
            checked_until: result.checked_until,
        });
        bet.next_expected_run_no = result.run_no + 1;
        bet.pending_run_no = None;
        // Normalize "VOID:<reason>" down to plain "VOID" for settlement
        // (finalize only ever matches the bare string); the reason only
        // ever mattered for the gate check above.
        let stored_outcome = if void_reason.is_some() {
            "VOID".to_string()
        } else {
            result.outcome
        };
        bet.outcome = Some(stored_outcome);
        bet.judge_pair_index = Some(result.judge_pair_index);
        bet.status = BetStatus::Proposed;
        bet.proposed_at = Some(env::block_timestamp());
        // D-JUDGECHAIN1a #1: a successful signed YES/NO from a pair clears its models' observations.
        self.commit_observations(&eff, &observed, if clears_pair { Some(&judged_pair) } else { None });
        env::log_str(&format!("submit_outcome bet_id={}", result.bet_id));
        emit_event(
            "outcome_submitted",
            json!({"bet_id": result.bet_id, "run_no": result.run_no, "judge_pair_index": result.judge_pair_index,
                   "model_not_found": result.model_not_found}),
        );
    }

    // -------------------------------------------------------------
    // Evidence / arbiter
    // -------------------------------------------------------------

    /// RF2 / D-REFUI4: the named human referee rules YES / NO / VOID, once,
    /// from `funding_deadline` until `resolve_deadline` (inclusive). The
    /// ruling sets the outcome and pays out IMMEDIATELY through the normal
    /// payout path -- no settlement window, no bonds, no challenges. A
    /// silent referee is handled by the unchanged `void_after_deadline`.
    /// The tip (if opted in) is paid on every ruling, VOID included, so the
    /// referee has no incentive to prefer a decisive result.
    pub fn referee_rule(&mut self, bet_id: u64, outcome: String) {
        require(!self.shutdown, "contract is shut down");
        require(
            outcome == "YES" || outcome == "NO" || outcome == "VOID",
            "outcome must be YES, NO or VOID",
        );
        let predecessor = env::predecessor_account_id();
        let now = env::block_timestamp();
        let bet = self.bet_mut(bet_id);
        let Some(referee) = bet.envelope.referee.clone() else {
            env::panic_str("no referee named");
        };
        require(referee.account == predecessor, "only the named referee may rule");
        require(bet.status == BetStatus::Taken, "bet is not awaiting a ruling");
        require(bet.outcome.is_none(), "already ruled");
        require(now >= bet.envelope.funding_deadline, "too early: funding_deadline not reached");
        require(now <= bet.envelope.resolve_deadline, "resolve_deadline passed");
        bet.outcome = Some(outcome.clone());
        bet.status = BetStatus::Finalized;
        bet.proposed_at = Some(now);
        let maker = bet.envelope.maker.clone();
        let taker = bet.taker.clone().unwrap_or_else(|| env::panic_str("bet has no taker"));
        let maker_side = bet.envelope.maker_side.clone();
        let (maker_asset, taker_asset) = (bet.envelope.maker_asset.clone(), bet.envelope.taker_asset.clone());
        let (stake_maker, stake_taker) = (bet.envelope.stake_maker.0, bet.envelope.stake_taker.0);
        let (storage_maker, storage_taker) = (bet.storage_maker.0, bet.storage_taker.0);
        let keep_terms = bet.envelope.keep_terms;
        let fee_bps = bet.envelope.fee_bps as u128;
        // PA1: the bet's own fee copies, never the live config.
        let (fee_maker, fee_taker) = (
            side_fee(stake_maker, fee_bps, bet.fee_min_maker.0),
            side_fee(stake_taker, fee_bps, bet.fee_min_taker.0),
        );
        let (tip_maker, tip_taker) = self.pay_tips(bet_id);
        let fee_account = self.fee_account.clone();
        env::log_str(&format!("referee_rule bet_id={bet_id} referee={predecessor} outcome={outcome}"));
        emit_event("referee_ruled", json!({"bet_id": bet_id, "referee": predecessor, "outcome": outcome}));
        if outcome == "VOID" {
            self.schedule_payout(bet_id, maker.clone(), maker_asset.clone(), stake_maker - tip_maker, "void_refund_maker".to_string());
            self.schedule_payout(bet_id, taker.clone(), taker_asset.clone(), stake_taker - tip_taker, "void_refund_taker".to_string());
            self.schedule_void_storage(bet_id, &maker, &taker, &maker_asset, &taker_asset, storage_maker, storage_taker, keep_terms);
        } else {
            let winner = if outcome == maker_side { maker } else { taker };
            self.schedule_payout(bet_id, winner.clone(), maker_asset.clone(), stake_maker - fee_maker - tip_maker, "payout_winner".to_string());
            self.schedule_payout(bet_id, winner, taker_asset.clone(), stake_taker - fee_taker - tip_taker, "payout_winner".to_string());
            self.schedule_payout(bet_id, fee_account.clone(), maker_asset, fee_maker + storage_maker, "fee_and_storage".to_string());
            self.schedule_payout(bet_id, fee_account, taker_asset, fee_taker + storage_taker, "fee_and_storage".to_string());
        }
        self.drain_payouts(bet_id, MAX_DRAIN_BATCH);
    }

    /// RF2: schedules the referee's tip lines (one per bettor, in that
    /// bettor's own asset) and returns `(tip_maker, tip_taker)` so the
    /// caller deducts them from that bettor's own payout. `(0, 0)` and no
    /// lines in AI mode. Fee + tip <= stake was checked when the tip was
    /// reserved (open / take), against the bet's own fee copies (PA1).
    fn pay_tips(&mut self, bet_id: u64) -> (u128, u128) {
        let (referee, tm, tt, ma, ta) = {
            let b = self.bet(bet_id);
            (
                b.envelope.referee.as_ref().map(|r| r.account.clone()),
                b.tip_maker.0,
                b.tip_taker.0,
                b.envelope.maker_asset.clone(),
                b.envelope.taker_asset.clone(),
            )
        };
        let Some(referee) = referee else { return (0, 0) };
        if tm > 0 {
            self.schedule_payout(bet_id, referee.clone(), ma, tm, "referee_tip".to_string());
        }
        if tt > 0 {
            self.schedule_payout(bet_id, referee, ta, tt, "referee_tip".to_string());
        }
        (tm, tt)
    }

    /// Storage-charge disposition on a VOID (D-ECON3): fee account when
    /// keep_terms, else refunded to each side in its own asset.
    #[allow(clippy::too_many_arguments)]
    fn schedule_void_storage(
        &mut self,
        bet_id: u64,
        maker: &AccountId,
        taker: &AccountId,
        maker_asset: &str,
        taker_asset: &str,
        storage_maker: u128,
        storage_taker: u128,
        keep_terms: bool,
    ) {
        // STG1 (D-STORAGE1): each side's own stored amount in its own asset.
        let fee_account = self.fee_account.clone();
        if keep_terms {
            if maker_asset == taker_asset {
                let combined = storage_maker + storage_taker;
                if combined > 0 {
                    self.schedule_payout(bet_id, fee_account, maker_asset.to_string(), combined, "void_storage_keep_terms".to_string());
                }
            } else {
                if storage_maker > 0 {
                    self.schedule_payout(bet_id, fee_account.clone(), maker_asset.to_string(), storage_maker, "void_storage_keep_terms".to_string());
                }
                if storage_taker > 0 {
                    self.schedule_payout(bet_id, fee_account, taker_asset.to_string(), storage_taker, "void_storage_keep_terms".to_string());
                }
            }
        } else {
            self.schedule_payout(bet_id, maker.clone(), maker_asset.to_string(), storage_maker, "void_storage_refund_maker".to_string());
            self.schedule_payout(bet_id, taker.clone(), taker_asset.to_string(), storage_taker, "void_storage_refund_taker".to_string());
        }
    }

    /// RF2 / D-REFUI4 (D-REFUI3a/3b): the referee can be changed in two ways.
    /// (a) While the offer is untaken (`Open`) the maker alone may set or
    /// remove it, immediately. (b) After the take only the both-sign path
    /// (two matching calls, maker and taker) changes it; `"null"` switches
    /// the bet to AI mode (allowed until the referee has ruled -- a ruling
    /// makes the bet terminal -- and frozen once an AI dispute opens).
    /// Switching to AI clears the tip reservations (no tip in AI mode).
    /// `new_referee_json` is `serde_json::to_string` of `Option<Referee>`.
    pub fn amend_referee(&mut self, bet_id: u64, new_referee_json: String) {
        require(!self.shutdown, "contract is shut down");
        let predecessor = env::predecessor_account_id();
        let fee_account = self.fee_account.clone();
        let parsed: Option<Referee> = serde_json::from_str(&new_referee_json)
            .unwrap_or_else(|_| env::panic_str("new_referee_json must be a valid Option<Referee> JSON"));
        let untaken;
        {
            let bet = self.bet_mut(bet_id);
            require(
                !matches!(
                    bet.status,
                    BetStatus::Finalized
                        | BetStatus::Settled
                        | BetStatus::Voided
                        | BetStatus::Cancelled
                        | BetStatus::Expired
                ),
                "bet already terminal",
            );
            // RA1 (D-REFUI3a/D-REFUI4a): after the take the referee may only
            // change while the bet is Taken; Resolving/Proposed/Challenged/
            // Evidence/Rejudge (a decision or dispute underway) are frozen.
            require(
                bet.status == BetStatus::Open || (bet.status == BetStatus::Taken && bet.bonds.is_empty()),
                // The legacy phrase is kept as a suffix so the pre-RA1
                // tests.rs should_panic(expected = ...) still matches.
                "referee frozen once a decision or dispute starts (referee frozen once a dispute opens)",
            );
            if let Some(referee) = &parsed {
                require(
                    referee.account != bet.envelope.maker && referee.account != fee_account,
                    "referee cannot be maker or fee_account",
                );
                let named_taker = match &bet.envelope.taker_allow {
                    TakerAllow::Account(a) => Some(a.clone()),
                    _ => None,
                };
                require(
                    named_taker.as_ref() != Some(&referee.account),
                    "referee cannot be the named taker",
                );
                if let Some(t) = &bet.taker {
                    require(referee.account != *t, "referee cannot be the taker");
                }
            }
            untaken = bet.status == BetStatus::Open;
            if untaken {
                require(predecessor == bet.envelope.maker, "only the maker may edit an untaken offer");
                // The maker's tip opt-in survives a swap to another
                // referee; removing the referee drops it.
                if parsed.is_none() {
                    bet.tip_maker = U128(0);
                    bet.envelope.tip_maker = false;
                }
                bet.envelope.referee = parsed.clone();
                // JCD1 (D-JCD1 #5): emitted only now, after every check passed; a maker edit of an untaken offer applies at once.
                emit_event("referee_amended", json!({"bet_id": bet_id, "by": predecessor, "referee": new_referee_json}));
                return;
            }
        }
        let event_by = predecessor.clone();
        let event_referee = new_referee_json.clone();
        let committed = self.commit_two_party(
            bet_id,
            predecessor,
            new_referee_json,
            |bet| &mut bet.referee_proposal,
            |bet, value| {
                let parsed: Option<Referee> = serde_json::from_str(&value).unwrap();
                if parsed.is_none() {
                    // AI mode: no referee, no tip (refunded by construction --
                    // the tips were carved from stakes and are simply not
                    // deducted at payout).
                    bet.tip_maker = U128(0);
                    bet.tip_taker = U128(0);
                }
                bet.envelope.referee = parsed;
            },
        );
        // JCD1 (D-JCD1 #5): the proposing half says `*_proposed`, the applying half `*_amended`.
        emit_event(
            if committed { "referee_amended" } else { "referee_amend_proposed" },
            json!({"bet_id": bet_id, "by": event_by, "referee": event_referee}),
        );
    }

    pub fn submit_exhibits(&mut self, bet_id: u64, hashes: Vec<String>) {
        let predecessor = env::predecessor_account_id();
        let bet = self.bet_mut(bet_id);
        // D-REF1: a referee (any mode) may file exhibits in the same
        // windows and under the same limits as the parties.
        let is_referee = bet
            .envelope
            .referee
            .as_ref()
            .map(|r| r.account == predecessor)
            .unwrap_or(false);
        let is_party = predecessor == bet.envelope.maker
            || bet.taker.as_ref() == Some(&predecessor)
            || is_referee;
        require(is_party, "only a party or the referee may submit exhibits");
        require(
            matches!(bet.status, BetStatus::Challenged | BetStatus::Evidence),
            "not in evidence window",
        );
        // Item 7r / D-DISPUTE1 bugfix: record frozen after round 1 (dispute
        // design v1 S3.3) -- `bet.bonds.len()` is the number of challenge
        // rounds opened so far (1 = round 1's bond already placed). Once a
        // second bond lands (round 2), no brand-new exhibits are accepted
        // through this call; round 2 is objections-only (the separate
        // OBJECTION_DEPOSIT mt_on_transfer path / handle_objection).
        require(
            bet.bonds.len() <= 1,
            "record frozen after round 1: no new exhibits accepted via submit_exhibits once round 2 opens",
        );
        // Item 7r bugfix: this used to check `bet.exhibits.len() + hashes.len()
        // <= 5` across ALL filers sharing one bet, even though the message
        // says "max 5 exhibits per party" -- so one party (or the referee)
        // could fill all 5 slots and lock the other side out of evidence.
        // Cap is now per submitter (maker/taker/referee each get their own
        // 5-exhibit bucket, D-REF1 "same limits as parties" for the referee).
        let already_filed = bet.exhibits.iter().filter(|e| e.submitted_by == predecessor).count();
        require(
            already_filed + hashes.len() <= 5,
            "max 5 exhibits per party",
        );
        require(
            hashes.iter().all(|h| h.len() <= MAX_HASH_LEN),
            "exhibit hash too long",
        );
        // D2 (D-AUDIT2): record the on-chain moment of submission per
        // exhibit (state) -- never anything the caller could supply --
        // and log a matching event so an off-chain indexer can recover
        // it without replaying full state. `get_bet`'s view exposes the
        // same `submitted_at` field automatically (Bet/Exhibit share the
        // ordinary json/borsh serializers).
        let now = env::block_timestamp();
        for hash in &hashes {
            env::log_str(&format!(
                "exhibit_submitted bet_id={bet_id} by={predecessor} hash={hash} submitted_at={now}"
            ));
        }
        bet.exhibits
            .extend(hashes.into_iter().map(|hash| Exhibit {
                hash,
                submitted_at: U64(now),
                submitted_by: predecessor.clone(),
            }));
        bet.status = BetStatus::Evidence;
    }

    // -------------------------------------------------------------
    // Amend / prune (two-call commit; see Bet.amend_proposal docs)
    // -------------------------------------------------------------

    pub fn amend(&mut self, bet_id: u64, new_terms_hash: String) {
        require(!self.shutdown, "contract is shut down");
        let predecessor = env::predecessor_account_id();
        let bet = self.bet_mut(bet_id);
        // SECURITY FIX (security review F8 / PRT-L2-015): `amend` had no
        // terminal-status guard. It never touches money, but it corrupts
        // the audit trail of a record meant to be immutable once the bet
        // reaches a terminal state (Settled/Voided/Cancelled/Expired) --
        // e.g. a cancelled bet's `terms_hash` could still be rewritten
        // after the fact. Same terminal set / same message as
        // the other terminal-state guards, for consistency.
        require(
            !matches!(
                bet.status,
                BetStatus::Finalized
                    | BetStatus::Settled
                    | BetStatus::Voided
                    | BetStatus::Cancelled
                    | BetStatus::Expired
            ),
            "bet already terminal",
        );
        require(
            env::block_timestamp() < bet.envelope.funding_deadline,
            "amend only pre-funding_deadline",
        );
        require(bet.amend_count < 5, "max 5 amendments");
        // D1: amend doesn't mutate settlement_period itself, but
        // re-validate the envelope's existing value against the
        // documented 1h-90d bound so no bet with a legacy out-of-bound
        // value (from before this check existed) can be amended further
        // without first being caught.
        require(
            bet.envelope.settlement_period >= MIN_SETTLEMENT_PERIOD_NS
                && bet.envelope.settlement_period <= MAX_SETTLEMENT_PERIOD_NS,
            "settlement_period must be between 1h and 90d",
        );
        let event_by = predecessor.clone();
        let event_hash = new_terms_hash.clone();
        let committed = self.commit_two_party(
            bet_id,
            predecessor,
            new_terms_hash,
            |bet| &mut bet.amend_proposal,
            |bet, value| {
                bet.envelope.terms_hash = value;
                bet.amend_count += 1;
            },
        );
        // JCD1 (D-JCD1 #5): only after every check passed; proposing half `terms_amend_proposed`, applying half `terms_amended`.
        emit_event(
            if committed { "terms_amended" } else { "terms_amend_proposed" },
            json!({"bet_id": bet_id, "by": event_by, "new_terms_hash": event_hash}),
        );
    }

    pub fn prune_terms(&mut self, bet_id: u64) {
        let predecessor = env::predecessor_account_id();
        let bet = self.bet_mut(bet_id);
        require(
            matches!(bet.status, BetStatus::Settled | BetStatus::Voided),
            "prune only after settled/voided",
        );
        self.commit_two_party(
            bet_id,
            predecessor,
            "prune".to_string(),
            |bet| &mut bet.prune_proposal,
            |bet, _| {
                // SPEC ISSUE: spec says prune refunds storage NEAR 50/50 to
                // bettors. This contract sponsors offer storage out of a
                // shared pool, not a per-bet NEAR escrow, so there is no
                // per-bet NEAR balance to split -- the "refund" is
                // structural (we stop paying for this bet's storage, which
                // is the real resource being freed) rather than a literal
                // outgoing transfer. Terms/exhibit/rebuttal/arbiter-
                // submission data is cleared; a small stub (bet_id, outcome,
                // status, terms_hash) is kept permanently, per spec.
                bet.envelope.terms_hash = format!("pruned:{}", bet.envelope.terms_hash);
                // The full term-sheet text (new in this pass, keep_terms
                // path) is exactly what prune_terms exists to delete --
                // clear it the same way terms_hash is stubbed above.
                bet.envelope.terms = None;
                bet.exhibits.clear();
                bet.rebuttals.clear();
                bet.referee_proposal = Proposal::default();
                bet.pruned = true;
            },
        );
    }

    fn commit_two_party(
        &mut self,
        bet_id: u64,
        predecessor: AccountId,
        value: String,
        proposal_of: impl Fn(&mut Bet) -> &mut Proposal,
        on_commit: impl Fn(&mut Bet, String),
    ) -> bool {
        let bet = self.bet_mut(bet_id);
        let is_maker = predecessor == bet.envelope.maker;
        let is_taker = bet.taker.as_ref() == Some(&predecessor);
        require(is_maker || is_taker, "only maker or taker may propose");
        {
            let p = proposal_of(bet);
            if is_maker {
                p.maker_value = Some(value.clone());
            } else {
                p.taker_value = Some(value.clone());
            }
        }
        let p = proposal_of(bet);
        if let (Some(m), Some(t)) = (p.maker_value.clone(), p.taker_value.clone()) {
            if m == t {
                on_commit(bet, m);
                // D-BD2a: clear both sides on commit so one party cannot
                // repeat the value and re-commit alone.
                let p = proposal_of(bet);
                p.maker_value = None;
                p.taker_value = None;
                return true;
            }
        }
        false
    }

    /// v1.1 (FM-17/19): either party may extend the current dispute/
    /// settlement window by +24h, once per bet. Covers a missed/degraded
    /// notification (FM-17) or an auth-provider outage during the window
    /// (FM-19) without giving either side repeated unilateral stalling
    /// power. Only meaningful once there's a proposed outcome running a
    /// clock (`proposed_at` is set); applies to `finalize`'s
    /// `settlement_period` elapsed-check via `window_extension_ns`.
    pub fn extend_window(&mut self, bet_id: u64) {
        let predecessor = env::predecessor_account_id();
        self.internal_extend_window(bet_id, &predecessor);
    }

    /// Shared by the direct `extend_window` entrypoint and `on_auth`'s
    /// `ExtendWindow` AuthCall variant (loop 6, FM-8). `acting_party` is
    /// `env::predecessor_account_id()` for the direct call, or
    /// `signer_id` for an AuthCall (never the intents contract itself).
    fn internal_extend_window(&mut self, bet_id: u64, acting_party: &AccountId) {
        let bet = self.bet_mut(bet_id);
        let is_party =
            *acting_party == bet.envelope.maker || bet.taker.as_ref() == Some(acting_party);
        require(is_party, "only maker or taker may extend the window");
        require(
            matches!(
                bet.status,
                BetStatus::Proposed | BetStatus::Challenged | BetStatus::Evidence
            ),
            "no active dispute/settlement window to extend",
        );
        require(bet.proposed_at.is_some(), "no proposed outcome yet");
        require(!bet.window_extended, "window already extended once");
        bet.window_extended = true;
        bet.window_extension_ns = 24 * 60 * 60 * 1_000_000_000u64;
        env::log_str(&format!("extend_window bet_id={bet_id} by={acting_party}"));
    }

    // -------------------------------------------------------------
    // Finalize / void
    // -------------------------------------------------------------

    /// cross-asset-3 (D-PRICE6): `Plan::YesNo` now carries the winner's
    /// payout PER ASSET (their own stake back minus that asset's own
    /// fee, for EACH of maker_asset/taker_asset) instead of one
    /// combined `pot`/`fee`/`winner_payout` number -- the winner
    /// receives both pots, each in its own asset, never converted
    /// (D-PRICE1). `Plan::Void` is already asset-pure (each side's own
    /// stake, in its own asset) and is unchanged. D-ECON5: the old
    /// combined reserve-leftover/run-cost bookkeeping is gone -- only
    /// each side's stored `storage_maker` / `storage_taker` (D-STORAGE1)
    /// is paid out in that side's own asset, never split or converted.
    pub fn finalize(&mut self, bet_id: u64) {
        require(!self.shutdown, "contract is shut down");
        enum Plan {
            YesNo {
                winner: AccountId,
                winner_payout_maker_asset: u128,
                winner_payout_taker_asset: u128,
                fee_maker_asset: u128,
                fee_taker_asset: u128,
                storage_maker: u128,
                storage_taker: u128,
            },
            Void {
                maker_amt: u128,
                taker_amt: u128,
                keep_terms_storage: bool,
                storage_maker: u128,
                storage_taker: u128,
            },
        }
        let (
            maker,
            taker,
            maker_asset,
            taker_asset,
            plan,
            bond_settlements,
            objection_settlements,
            won_round_claims,
        ) = {
            // D-BOND1: each bond now carries its OWN asset (cross-asset
            // bets can mix a maker-asset bond round with a taker-asset
            // one), so there is no single `run_price` to read -- peek
            // at every bond's asset (immutable borrow) and precompute
            // a per-asset run_price map before taking `bet`'s mutable
            // borrow of `self` below, mirroring the old single-asset
            // read's borrow-ordering.
            // D-FEEMIN1: per-asset minimum fees, read before the &mut bet borrow.
            // D-PARAMS1: from the bet's own copy taken at open, never the live config.
            let (min_fee_maker, min_fee_taker) = self
                .bets
                .get(&bet_id)
                .map(|b| (b.fee_min_maker.0, b.fee_min_taker.0))
                .unwrap_or((0, 0));
            let run_price_by_asset: std::collections::BTreeMap<String, u128> = self
                .bets
                .get(&bet_id)
                .map(|b| {
                    b.bonds
                        .iter()
                        .map(|bond| bond.asset.clone())
                        .collect::<std::collections::BTreeSet<_>>()
                })
                .unwrap_or_default()
                .into_iter()
                .map(|asset| {
                    let rp = self.asset_limits.get(&asset).map(|l| l.run_price.0).unwrap_or(0);
                    (asset, rp)
                })
                .collect();
            let bet = self.bet_mut(bet_id);
            require(
                matches!(bet.status, BetStatus::Proposed | BetStatus::Challenged | BetStatus::Evidence),
                "bet not Proposed/Challenged/Evidence",
            );
            // D-DISPUTE1 (dispute design v1 §3.5, implementation list
            // item 3): round 0's challenge window is the full signed
            // `settlement_period` (1h-90d). Every window AFTER a
            // re-judge (i.e. at least one challenge bond has been
            // posted on this bet -- `bet.bonds` is non-empty right up
            // until this fn's later `mem::take`) is capped at a FIXED
            // 24h instead, regardless of `settlement_period` -- a 90d
            // bet must not lock the re-judged result for another 90
            // days. `window_extension_ns` (the one-time 24h
            // `extend_window`) still applies on top either way.
            // RED-TEAM (referee collusion / bond-grinding): a bond still
            // awaiting its ruling (status Challenged/Evidence: the re-judge
            // has not landed) must not be
            // finalizable while a ruling is still possible -- otherwise the
            // winner finalizes right after a last-minute challenge and forfeits the challenger's bond
            // unreviewed. Once no ruling can ever happen (resolve_deadline
            // passed or paid runs exhausted) finalize stays open: no stuck funds.
            if !bet.bonds.is_empty()
                && matches!(bet.status, BetStatus::Challenged | BetStatus::Evidence)
            {
                require(
                    env::block_timestamp() >= bet.envelope.resolve_deadline
                        || bet.runs_used >= bet.envelope.max_paid_runs,
                    "challenge round pending a ruling",
                );
            }
            let base_window = if bet.bonds.is_empty() {
                bet.envelope.settlement_period
            } else {
                std::cmp::min(bet.envelope.settlement_period, ROUND_WINDOW_NS)
            };
            require(
                env::block_timestamp()
                    >= bet.proposed_at.unwrap() + base_window + bet.window_extension_ns,
                "settlement_period not elapsed",
            );
            let outcome = bet.outcome.clone().unwrap();
            let maker = bet.envelope.maker.clone();
            let taker = bet.taker.clone().unwrap_or_else(|| maker.clone());
            let maker_asset = bet.envelope.maker_asset.clone();
            let taker_asset = bet.envelope.taker_asset.clone();

            // D-AUDIT8 (design decision, OQ-T10 ruling -- SUPERSEDES
            // D-AUDIT3's split for WON rounds, keeps it for LOST rounds):
            // the bet's reserve funds ONLY the initial (round-0)
            // resolution run, nothing else. Every challenge round's
            // `run_price` is now paid out of THAT round's own bond --
            // which `handle_bond` requires to be big enough to cover it
            // (challenge-bond minimum + run_price) -- regardless of who
            // wins the round, so the reserve and the counterparty's
            // share are never drawn on for compute. This is what closes
            // OQ-T10 / the D3 overflow: a counterparty's reserve share
            // is never charged a round cost at all anymore, so there is
            // nothing left to overflow.
            //
            // - Challenger LOSES the round: bond forfeits. `round_cost`
            //   comes out of the bond to the keeper; the remainder goes
            //   to the counterparty (unchanged from D-AUDIT3).
            // - Challenger WINS the round: `round_cost` STILL comes out
            //   of the bond to the keeper (this is new -- previously the
            //   full bond returned and the counterparty's reserve share
            //   was charged instead); the remainder returns to the
            //   challenger. The challenger is then reimbursed up to
            //   `round_cost` from the ROUND'S LOSING PARTY's own
            //   finalize-time payout (`won_round_claims`, resolved
            //   below against each party's actual winnings/stake --
            //   never the shared reserve), capped at what that party
            //   actually has; any shortfall is borne by the challenger
            //   (documented, not an error -- ruling #3).
            // Round-0 (no bond) stays in the ordinary `run_reimbursement`
            // path, funded from the reserve, unchanged.
            let bonds = std::mem::take(&mut bet.bonds);
            let mut bond_funded_from_bond: u128 = 0;
            // (challenger, counterparty) for every WON round, in the
            // order the rounds happened. D-BOND2: no amount is baked in
            // here any more -- the reimbursement loop below looks up
            // the PAYING (counterparty) side's own asset's run_price at
            // use time, never this round's challenger-asset round_cost.
            let mut won_round_claims: Vec<(AccountId, AccountId)> = Vec::new();
            let bond_settlements: Vec<(AccountId, AccountId, u128, u128, bool, String)> = bonds
                .into_iter()
                .map(|bond| {
                    let challenger_won =
                        bond.pre_challenge_outcome.as_deref() != Some(outcome.as_str());
                    // D-BOND1: this round's own run_price, in this
                    // bond's own asset -- never a single contract-wide
                    // USDC rate.
                    let run_price = run_price_by_asset.get(&bond.asset).copied().unwrap_or(0);
                    let round_cost = run_price.min(bond.amount.0);
                    let counterparty = if bond.holder == maker {
                        taker.clone()
                    } else {
                        maker.clone()
                    };
                    // D-AUDIT8: the round's compute always comes out of
                    // the bond now, win or lose -- never the reserve.
                    bond_funded_from_bond += round_cost;
                    if challenger_won {
                        won_round_claims.push((bond.holder.clone(), counterparty.clone()));
                    }
                    (bond.holder, counterparty, bond.amount.0, round_cost, challenger_won, bond.asset)
                })
                .collect();

            // Objection/rebuttal deposit settlement -- see ObjectionDeposit
            // doc: forfeited to the counterparty when rejected (outcome
            // unchanged from the snapshot taken when the deposit was
            // filed), returned to the depositor when upheld (outcome
            // changed). THE FIX this pass was asked for.
            let objections = std::mem::take(&mut bet.objection_deposits);
            let objection_settlements: Vec<(AccountId, AccountId, u128, bool, String)> = objections
                .into_iter()
                .map(|dep| {
                    let maintained = dep.pre_outcome.as_deref() == Some(outcome.as_str());
                    let depositor_wins = if dep.is_rebuttal { maintained } else { !maintained };
                    let counterparty = if dep.sender == maker {
                        taker.clone()
                    } else {
                        maker.clone()
                    };
                    (dep.sender, counterparty, dep.amount.0, depositor_wins, dep.asset)
                })
                .collect();

            // D-ECON3: storage is always a per-side, own-asset charge --
            // never shared/converted between maker and taker.
            let storage_maker = bet.storage_maker.0;
            let storage_taker = bet.storage_taker.0;
            // D-ECON5: round-0's judge run is funded entirely by
            // `keeper_credit`, repaid by the 1% protocol fee via
            // treasury -- never drawn from bet money. `bond_funded_from_bond`
            // (every challenge round's own cost, win or lose) is the
            // only run-cost bookkeeping left in this function.
            let _ = bond_funded_from_bond;

            let plan = match outcome.as_str() {
                "YES" | "NO" => {
                    let winner_is_maker = outcome == bet.envelope.maker_side;
                    let fee_bps = bet.envelope.fee_bps as u128;
                    // D-FEEMIN1: per-side fee with that side's own asset minimum.
                    let fee_maker_asset = side_fee(bet.envelope.stake_maker.0, fee_bps, min_fee_maker);
                    let winner_payout_maker_asset = bet.envelope.stake_maker.0 - fee_maker_asset;
                    let fee_taker_asset = side_fee(bet.envelope.stake_taker.0, fee_bps, min_fee_taker);
                    let winner_payout_taker_asset = bet.envelope.stake_taker.0 - fee_taker_asset;
                    // I-1 per asset: winner_payout + fee == stake, for
                    // each asset independently -- the winner receives
                    // BOTH pots, each in its own asset (D-PRICE1), no
                    // conversion, never mixed with the other asset's
                    // reserve/storage handling below.
                    require(
                        winner_payout_maker_asset + fee_maker_asset == bet.envelope.stake_maker.0,
                        "I-1 sanity (yes/no, maker asset)",
                    );
                    require(
                        winner_payout_taker_asset + fee_taker_asset == bet.envelope.stake_taker.0,
                        "I-1 sanity (yes/no, taker asset)",
                    );
                    Plan::YesNo {
                        winner: if winner_is_maker { maker.clone() } else { taker.clone() },
                        winner_payout_maker_asset,
                        winner_payout_taker_asset,
                        fee_maker_asset,
                        fee_taker_asset,
                        storage_maker,
                        storage_taker,
                    }
                }
                "VOID" => Plan::Void {
                    maker_amt: bet.envelope.stake_maker.0,
                    taker_amt: bet.envelope.stake_taker.0,
                    keep_terms_storage: bet.envelope.keep_terms,
                    storage_maker,
                    storage_taker,
                },
                other => env::panic_str(&format!("unexpected outcome at finalize: {other}")),
            };

            // OQ-T11: not Settled yet -- see finalize's identical
            // comment above; `finalize`'s whole worst-case fan-out (up
            // to 48 lines, ~620 Tgas were it fired in one call) is
            // exactly why this can no longer jump straight to Settled.
            bet.status = BetStatus::Finalized;
            bet.pre_challenge_outcome = None;
            emit_event("bet_finalized", json!({"bet_id": bet_id}));
            (
                maker,
                taker,
                maker_asset,
                taker_asset,
                plan,
                bond_settlements,
                objection_settlements,
                won_round_claims,
            )
        };

        let fee_account = self.fee_account.clone();
        let keeper = self.keeper.clone();
        // D-BOND1: every bond/objection now settles in the asset it was
        // actually posted in, never a hardcoded `usdc_token_id`.
        for (holder, counterparty, bond_amount, round_cost, challenger_won, bond_asset) in bond_settlements {
            // D-AUDIT8: `round_cost` always goes to the keeper now, win
            // or lose -- the bond is what funds every round's compute,
            // never the reserve or the counterparty's share.
            if challenger_won {
                let remainder = bond_amount - round_cost;
                self.schedule_payout(bet_id, holder, bond_asset.clone(), remainder, "bond_returned_won_minus_run_cost".to_string());
            } else {
                let to_counterparty = bond_amount - round_cost;
                self.schedule_payout(bet_id, counterparty, bond_asset.clone(), to_counterparty, "bond_lost_to_counterparty".to_string());
            }
            if round_cost > 0 {
                self.schedule_payout(bet_id, keeper.clone(), bond_asset, round_cost, "bond_round_cost_to_keeper".to_string());
            }
        }
        for (sender, counterparty, amount, depositor_wins, dep_asset) in objection_settlements {
            if depositor_wins {
                self.schedule_payout(bet_id, sender, dep_asset, amount, "objection_deposit_returned".to_string());
            } else {
                self.schedule_payout(bet_id, counterparty, dep_asset, amount, "objection_deposit_forfeited".to_string());
            }
        }

        // D-AUDIT8 (ruling #3): the stake/winnings component each party
        // would otherwise receive from `plan`, BEFORE any won-round
        // reimbursement claim against them is applied. Loser-pays
        // `mut` locals so the claim-resolution loop below can deduct
        // from them directly.
        // cross-asset-3: `stake_maker_out`/`stake_taker_out` now mean
        // "the maker_asset-denominated component" / "the
        // taker_asset-denominated component" of this plan's payout --
        // for `Void` that's literally each side's own stake refund
        // (unchanged); for `YesNo` it's the winner's two per-asset
        // pot shares (BOTH go to the same winner at payment time
        // below, never to maker/taker by slot). The DR-09 claim loop
        // below only ever draws `from_stake` when `is_void`, so this
        // relabeling changes nothing about its behavior for a YES/NO
        // final (from_stake stays 0 regardless of what these two
        // numbers represent).
        let (mut stake_maker_out, mut stake_taker_out, fee_maker_asset, fee_taker_asset, storage_maker_amt, storage_taker_amt, keep_terms_storage, is_void, winner_opt) =
            match &plan {
                Plan::YesNo { winner, winner_payout_maker_asset, winner_payout_taker_asset, fee_maker_asset, fee_taker_asset, storage_maker, storage_taker } => (
                    *winner_payout_maker_asset,
                    *winner_payout_taker_asset,
                    *fee_maker_asset,
                    *fee_taker_asset,
                    *storage_maker,
                    *storage_taker,
                    false,
                    false,
                    Some(winner.clone()),
                ),
                Plan::Void { maker_amt, taker_amt, keep_terms_storage, storage_maker, storage_taker } => {
                    (*maker_amt, *taker_amt, 0u128, 0u128, *storage_maker, *storage_taker, *keep_terms_storage, true, None)
                }
            };

        // D-ECON5: no per-bet reserve exists any more, so a WON round's
        // reimbursement claim can only ever draw against the round's
        // losing party's own stake refund -- and only on a VOID, where
        // a losing party still gets their own stake back (a YES/NO
        // final's non-winner has no stake refund to draw from; the
        // winner's stake_share is their own winnings, never touched by
        // a round they didn't lose). Capped at what's actually left via
        // plain `min()`, never a `require`; any shortfall is simply not
        // reimbursed (borne by the challenger -- not an error).
        // D-BOND2 (design decision, DR-BOND1-1 fix): the reimbursement below is
        // drawn from the round-LOSING party's own stake, IN THEIR OWN
        // ASSET, using THAT asset's own `AssetLimit.run_price` -- never
        // the challenger's bond-asset run_price value reinterpreted as
        // raw units of the paying asset. On a cross-asset bet (e.g. a
        // USDC-staking challenger reimbursed in BTC, because that's the
        // asset the losing counterparty's own stake sits in) the two
        // assets' run_prices can be wildly different numbers (BTC
        // run_price=1 sat vs USDC run_price=5_000 micro-USDC) -- using
        // the wrong one previously paid out, say, 5_000 BTC sats (~$4)
        // for what should have been exactly 1 BTC sat. No conversion,
        // no onchain price: each asset's own fixed run_price, never
        // mixed. Same-asset bets are unaffected (the paying asset's
        // run_price lookup is simply that one shared asset's own
        // value, byte-for-byte what the pre-D-BOND2 code already paid).
        for (challenger, counterparty) in won_round_claims {
            let (stake_share, stake_asset) = if counterparty == maker {
                (&mut stake_maker_out, maker_asset.clone())
            } else {
                (&mut stake_taker_out, taker_asset.clone())
            };
            let paying_asset_run_price =
                self.asset_limits.get(&stake_asset).map(|l| l.run_price.0).unwrap_or(0);
            // Clamped at the paying side's remaining stake via plain
            // `min()` (never a `require`) -- same documented shortfall
            // rule as before: if the paying side's stake can't cover
            // even their own asset's run_price, the challenger simply
            // nets less, never an error, never drawn from anywhere else.
            let from_stake = if is_void { paying_asset_run_price.min(*stake_share) } else { 0 };
            *stake_share -= from_stake;
            self.schedule_payout(bet_id, challenger, stake_asset, from_stake, "won_round_reimbursement".to_string());
        }

        if is_void {
            // D-ECON5: on a VOID nobody won or lost, and no shared
            // compute benefit occurred to split -- each side gets back
            // exactly their own stake and (if !keep_terms) storage
            // charge, in their OWN asset. No per-bet reserve exists any
            // more to refund.
            self.schedule_payout(bet_id, maker.clone(), maker_asset.clone(), stake_maker_out, "void_refund_maker".to_string());
            self.schedule_payout(bet_id, taker.clone(), taker_asset.clone(), stake_taker_out, "void_refund_taker".to_string());
            // D-ECON3: same-asset bet -> one combined storage line
            // (legacy, byte-for-byte); mixed-asset -> each side's own
            // asset line, never merged/converted.
            if maker_asset == taker_asset {
                let combined = storage_maker_amt + storage_taker_amt;
                if keep_terms_storage && combined > 0 {
                    self.schedule_payout(bet_id, fee_account, maker_asset.clone(), combined, "void_storage_keep_terms".to_string());
                } else if !keep_terms_storage {
                    self.schedule_payout(bet_id, maker, maker_asset.clone(), storage_maker_amt, "void_storage_refund_maker".to_string());
                    self.schedule_payout(bet_id, taker, taker_asset.clone(), storage_taker_amt, "void_storage_refund_taker".to_string());
                }
            } else if keep_terms_storage {
                if storage_maker_amt > 0 {
                    self.schedule_payout(bet_id, fee_account.clone(), maker_asset.clone(), storage_maker_amt, "void_storage_keep_terms".to_string());
                }
                if storage_taker_amt > 0 {
                    self.schedule_payout(bet_id, fee_account, taker_asset.clone(), storage_taker_amt, "void_storage_keep_terms".to_string());
                }
            } else {
                self.schedule_payout(bet_id, maker, maker_asset.clone(), storage_maker_amt, "void_storage_refund_maker".to_string());
                self.schedule_payout(bet_id, taker, taker_asset.clone(), storage_taker_amt, "void_storage_refund_taker".to_string());
            }
        } else {
            // D-PRICE1: the winner receives BOTH pots, each in its own
            // asset -- never maker.clone()/taker.clone() by slot.
            let winner = winner_opt.expect("YesNo plan always sets a winner");
            if stake_maker_out > 0 {
                self.schedule_payout(bet_id, winner.clone(), maker_asset.clone(), stake_maker_out, "payout_winner".to_string());
            }
            if stake_taker_out > 0 {
                self.schedule_payout(bet_id, winner, taker_asset.clone(), stake_taker_out, "payout_winner".to_string());
            }
            // D-ECON3: storage is a per-side, own-asset charge -- never
            // split across assets.
            let fee_and_storage_maker_asset = fee_maker_asset + storage_maker_amt;
            let fee_and_storage_taker_asset = fee_taker_asset + storage_taker_amt;
            if fee_and_storage_maker_asset > 0 {
                self.schedule_payout(bet_id, fee_account.clone(), maker_asset.clone(), fee_and_storage_maker_asset, "fee_and_storage".to_string());
            }
            if fee_and_storage_taker_asset > 0 {
                self.schedule_payout(bet_id, fee_account, taker_asset.clone(), fee_and_storage_taker_asset, "fee_and_storage".to_string());
            }
            // D-ECON5: no per-bet reserve exists any more to split.
        }
        // D-ECON5: round-0's judge run is funded entirely by
        // `keeper_credit`, repaid by the 1% protocol fee via treasury --
        // never drawn from or reimbursed out of bet money, so no
        // `run_reimbursement` payout to the keeper happens here.
        let _ = keeper;
        // D-AUDIT11: fire every grouped transfer (<=4 groups today:
        // maker/taker/fee_account/keeper x 1 asset) in THIS transaction
        // instead of leaving the bet at Finalized waiting on a separate
        // permissionless drain. Also covers the (rare) all-zero-amount
        // edge case where no line was ever scheduled, since
        // `drain_payouts` calls `maybe_settle` unconditionally even when
        // it fires nothing -- without this, a bet whose entire
        // settlement nets to zero would sit at Finalized forever.
        self.drain_payouts(bet_id, MAX_DRAIN_BATCH);
    }

    /// D-ECON3 (supersedes the cross-asset-3 doc below): on a VOID
    /// nobody won/lost and no shared compute benefit occurred to split
    /// -- each side's reserve and storage charge (collected in THEIR
    /// OWN stake asset at open/take) is refunded/charged entirely in
    /// that side's own asset, with NO sharing between maker and taker
    /// (DR-P6-6). Only the round-0 run reimbursement, if any runs
    /// happened before the deadline, is split in half between the two
    /// sides' buckets -- each half paid to the keeper in that bucket's
    /// own asset. For a same-asset bet both buckets are the same asset
    /// and each side's own contribution equals what the old combined
    /// 50/50 split gave them, so every existing same-asset test's
    /// totals are unchanged.
    pub fn void_after_deadline(&mut self, bet_id: u64) {
        // Red-team (kill-switch mid-dispute): once shut down,
        // `emergency_refund` is the ONLY exit. This permissionless path
        // routes keep_terms storage to the fee account, so a third party
        // could front-run emergency_refund and strip the parties'
        // storage deposits.
        require(!self.shutdown, "contract is shut down");
        let (
            maker,
            taker,
            maker_asset,
            taker_asset,
            stake_maker,
            stake_taker,
            storage_maker_amt,
            storage_taker_amt,
            keep_terms_storage,
        ) = {
            let bet = self.bet_mut(bet_id);
            require(
                !matches!(
                    bet.status,
                    BetStatus::Finalized
                        | BetStatus::Settled
                        | BetStatus::Voided
                        | BetStatus::Cancelled
                        | BetStatus::Expired
                        | BetStatus::Open
                ),
                "bet not in a voidable state",
            );
            require(
                env::block_timestamp() > bet.envelope.resolve_deadline,
                "resolve_deadline not reached",
            );
            require(bet.outcome.is_none(), "already has an outcome; use finalize");
            let maker = bet.envelope.maker.clone();
            let taker = bet.taker.clone().unwrap_or_else(|| maker.clone());
            let maker_asset = bet.envelope.maker_asset.clone();
            let taker_asset = bet.envelope.taker_asset.clone();
            let stake_maker = bet.envelope.stake_maker.0;
            let stake_taker = bet.envelope.stake_taker.0;
            // Bug 1 fix (I-2): the stored per-side amounts (bet.storage_maker /
            // bet.storage_taker) were collected at open/take but never
            // disposed of here, stranding them.
            // D-ECON3: always a per-side, own-asset charge -- goes to
            // fee_account when keep_terms, else refunded to that same
            // side, never shared/converted with the other side.
            let storage_maker_amt = bet.storage_maker.0;
            let storage_taker_amt = bet.storage_taker.0;
            let keep_terms_storage = bet.envelope.keep_terms;
            bet.status = BetStatus::Voided;
            bet.outcome = Some("VOID".to_string());
            emit_event("bet_voided", json!({"bet_id": bet_id, "reason": "resolve_deadline_passed"}));
            (
                maker,
                taker,
                maker_asset,
                taker_asset,
                stake_maker,
                stake_taker,
                storage_maker_amt,
                storage_taker_amt,
                keep_terms_storage,
            )
        };
        let fee_account = self.fee_account.clone();
        // RF2 / D-REFUI4: a silent referee still earns the opted-in tip
        // (deadline VOID is an ending after the take); AI mode: (0, 0).
        let (tip_maker, tip_taker) = self.pay_tips(bet_id);
        self.schedule_payout(bet_id, maker.clone(), maker_asset.clone(), stake_maker - tip_maker, "void_deadline_maker".to_string());
        self.schedule_payout(bet_id, taker.clone(), taker_asset.clone(), stake_taker - tip_taker, "void_deadline_taker".to_string());
        // D-ECON5: no per-bet reserve exists any more to refund, and
        // round-0's judge run is funded entirely by `keeper_credit`
        // (repaid by the 1% protocol fee via treasury) -- never drawn
        // from or reimbursed out of bet money here.
        // D-ECON3: for a same-asset bet both sides' storage charges are
        // the SAME asset -- combine them into one payout line (legacy
        // behavior, byte-for-byte); for a mixed-asset bet each side's
        // own charge routes in its own asset as two separate lines.
        if maker_asset == taker_asset {
            let combined = storage_maker_amt + storage_taker_amt;
            if keep_terms_storage && combined > 0 {
                self.schedule_payout(bet_id, fee_account, maker_asset, combined, "void_storage_keep_terms".to_string());
            } else if !keep_terms_storage {
                self.schedule_payout(bet_id, maker, maker_asset.clone(), storage_maker_amt, "void_storage_refund_maker".to_string());
                self.schedule_payout(bet_id, taker, taker_asset, storage_taker_amt, "void_storage_refund_taker".to_string());
            }
        } else if keep_terms_storage {
            if storage_maker_amt > 0 {
                self.schedule_payout(bet_id, fee_account.clone(), maker_asset.clone(), storage_maker_amt, "void_storage_keep_terms".to_string());
            }
            if storage_taker_amt > 0 {
                self.schedule_payout(bet_id, fee_account, taker_asset.clone(), storage_taker_amt, "void_storage_keep_terms".to_string());
            }
        } else {
            self.schedule_payout(bet_id, maker, maker_asset, storage_maker_amt, "void_storage_refund_maker".to_string());
            self.schedule_payout(bet_id, taker, taker_asset, storage_taker_amt, "void_storage_refund_taker".to_string());
        }
        // D-AUDIT11: same inline-drain as finalize.
        self.drain_payouts(bet_id, MAX_DRAIN_BATCH);
    }

    // -------------------------------------------------------------
    // Pending-payout ledger (I-4: retryable, never loses/double-pays)
    // -------------------------------------------------------------

    /// OQ-T11: persists the ledger line ONLY -- never fires a transfer.
    /// `finalize`/`void_after_deadline`/etc all just
    /// record obligations here; `drain_payouts` (below) is the ONLY
    /// place a transfer is ever sent, in bounded batches, which is what
    /// keeps the worst-case 48-line fan-out that used to blow past 300
    /// Tgas in one `finalize` call from ever happening again.
    /// cross-asset-3 (D-PRICE6): `token_id` is now explicit at every call
    /// site -- no more hardcoded `usdc_token_id`. Each side's stake,
    /// reserve and storage charge was deposited in that side's own
    /// asset (`handle_open`/`handle_take`), so every refund/payout must
    /// route back in the SAME asset it arrived in to hold I-1 per
    /// asset. D-BOND1 (cross-asset-4): `handle_bond`/`handle_objection`
    /// deposits now follow the same rule -- each bond/objection is
    /// posted in, and settled back in, the depositor's own stake
    /// asset (`BondInfo.asset`/`ObjectionDeposit.asset`), never a
    /// hardcoded `self.usdc_token_id`.
    fn index_payout(&mut self, bet_id: u64, id: u64) {
        if let Some(v) = self.payouts_by_bet.get_mut(&bet_id) {
            v.push(id);
        } else {
            self.payouts_by_bet.insert(bet_id, vec![id]);
        }
    }

    fn bet_payout_ids(&self, bet_id: u64) -> Vec<u64> {
        self.payouts_by_bet.get(&bet_id).cloned().unwrap_or_default()
    }

    fn schedule_payout(&mut self, bet_id: u64, receiver: AccountId, token_id: String, amount: u128, reason: String) {
        if amount == 0 {
            return;
        }
        let id = self.next_payout_id;
        self.next_payout_id += 1;
        self.pending_payouts.insert(
            id,
            PendingPayout {
                id,
                bet_id,
                token_id,
                receiver,
                amount: U128(amount),
                reason,
                attempts: 0,
                done: false,
                in_flight: false,
            },
        );
        self.index_payout(bet_id, id);
    }

    /// D-AUDIT11 test-only hook: inject a ledger line with an arbitrary
    /// `token_id` directly, bypassing the hardcoded `usdc_token_id` every
    /// real `schedule_payout` call uses today. Lets unit tests prove the
    /// `(receiver, token_id)` grouping is genuinely asset-agnostic (and
    /// exercise a > MAX_DRAIN_BATCH-groups worst case) without needing a
    /// second real asset wired through `open`/`handle_bond` (see the
    /// settlement design debate doc, (o): that restriction is separate,
    /// pre-existing, intentional product scope, not lifted by this test
    /// hook).
    #[cfg(test)]
    pub(crate) fn test_inject_pending_payout(
        &mut self,
        bet_id: u64,
        receiver: AccountId,
        token_id: String,
        amount: u128,
        reason: String,
    ) {
        let id = self.next_payout_id;
        self.next_payout_id += 1;
        self.pending_payouts.insert(
            id,
            PendingPayout {
                id,
                bet_id,
                token_id,
                receiver,
                amount: U128(amount),
                reason,
                attempts: 0,
                done: false,
                in_flight: false,
            },
        );
        self.index_payout(bet_id, id);
    }

    /// DR-ESC-7 test-only hook: injects an already-`done` ledger line
    /// (history for some OTHER bet) so tests can build a long-lived
    /// contract with thousands of settled lines.
    #[cfg(test)]
    pub(crate) fn test_inject_done_payout(&mut self, bet_id: u64, receiver: AccountId, token_id: String, amount: u128) {
        let id = self.next_payout_id;
        self.next_payout_id += 1;
        self.pending_payouts.insert(
            id,
            PendingPayout {
                id,
                bet_id,
                token_id,
                receiver,
                amount: U128(amount),
                reason: "history".to_string(),
                attempts: 1,
                done: true,
                in_flight: false,
            },
        );
        self.index_payout(bet_id, id);
    }

    /// Minimal fixed gas is reserved only for the two legs that must not
    /// starve (the outgoing `mt_transfer` call itself, and its callback's
    /// own fixed bookkeeping); the callback is also given a weighted share
    /// of whatever gas is left over after scheduling, so a payout fired
    /// from deep in a call chain (e.g. `drain_payouts`'s several payouts
    /// in one transaction) doesn't get starved by a hardcoded constant
    /// sized for the worst case of "many payouts in one call".
    /// D-AUDIT11: fires ONE `mt_transfer` for the SUM of every id's
    /// amount in `ids` (all already verified same `receiver`/`token_id`
    /// by the caller -- see `group_pending_ids`) and attaches a single
    /// callback that resolves every id in the group together. This is
    /// the mechanism that turns "one cross-contract transfer per
    /// obligation" (the 48-line worst case) into "one transfer per
    /// (receiver, token_id) pair" (D-AUDIT11 supersedes D-AUDIT9's
    /// batching-only fix) -- the audit ledger itself (`PendingPayout`
    /// rows, one per reason) is untouched; only how many promises are
    /// fired to settle it shrinks.
    fn fire_payout(&self, ids: Vec<u64>, receiver: AccountId, token_id: String, amount: u128) {
        let _ = ext_intents::ext(self.intents.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(PAYOUT_GAS)
            .mt_transfer(receiver, token_id, U128(amount), None, None)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(PAYOUT_CALLBACK_GAS)
                    .with_unused_gas_weight(1)
                    .on_payout_result(ids),
            );
    }

    /// D-AUDIT11: callback for a GROUPED transfer -- `ids` is every
    /// ledger line that was summed into the one promise this resolves.
    /// Each id is closed over by this exact callback invocation (a
    /// function argument, not shared mutable state reached some other
    /// way), so one group's result can never leak into another group's
    /// bookkeeping (attack (c)). Success marks every id `done`; failure
    /// clears `in_flight` on every id and leaves `done=false` on all of
    /// them, so the WHOLE group (not a subset) becomes pickable again
    /// by the next `drain_payouts` call -- it was one real transfer, so
    /// it either moved all of that money or none of it.
    #[private]
    pub fn on_payout_result(&mut self, ids: Vec<u64>) {
        let succeeded = matches!(env::promise_result(0), PromiseResult::Successful(_));
        let mut bet_id = None;
        for id in &ids {
            if let Some(p) = self.pending_payouts.get_mut(id) {
                // OQ-T11 (I-4): always clear in_flight first, success or
                // failure -- a failed group must become pickable again by
                // the NEXT `drain_payouts`/`retry_payout` call.
                p.in_flight = false;
                if succeeded {
                    p.done = true;
                }
                bet_id = Some(p.bet_id);
            }
        }
        // Failed: leave done=false, in_flight=false on every id in this
        // group; the next drain/retry re-sends the WHOLE group as one
        // transfer again. Money is never marked spent until the
        // cross-contract transfer actually succeeds (I-4), and
        // `schedule_payout` only ever runs once per logical obligation,
        // so a retry cannot double-pay.
        emit_event(
            if succeeded { "payout_done" } else { "payout_failed" },
            json!({"bet_id": bet_id, "payout_ids": ids}),
        );
        if let Some(bet_id) = bet_id {
            self.maybe_settle(bet_id);
        }
    }

    /// Kept for explicit single-line retries and backward compatibility;
    /// merged onto the exact same `in_flight`-guarded path `drain_payouts`
    /// uses (OQ-T11 ruling: "the old retry_payout path should be merged
    /// into it or kept consistent with it") so the two can never race and
    /// double-fire the same line. Fires that one line alone (a
    /// single-element group) -- for aggregated retries of several lines
    /// at once, call `drain_payouts` instead.
    pub fn retry_payout(&mut self, id: u64) {
        let p = self
            .pending_payouts
            .get_mut(&id)
            .unwrap_or_else(|| env::panic_str("unknown payout id"));
        require(!p.done, "payout already completed");
        require(!p.in_flight, "payout already in flight");
        p.attempts += 1;
        p.in_flight = true;
        let receiver = p.receiver.clone();
        let token_id = p.token_id.clone();
        let amount = p.amount.0;
        self.fire_payout(vec![id], receiver, token_id, amount);
    }

    /// D-AUDIT11: groups every not-done, not-in-flight ledger line for
    /// `bet_id` by `(receiver, token_id)` -- generic, no hardcoded
    /// asset list, so this works unchanged if a future bet's ledger
    /// ever carries more than one `token_id` (it doesn't today: every
    /// line this contract schedules currently shares `usdc_token_id` --
    /// see the settlement debate doc, Phase 0). Stable first-seen group
    /// order so which groups land in a size-limited batch is
    /// deterministic.
    fn group_pending_ids(&self, bet_id: u64) -> Vec<(AccountId, String, Vec<u64>, u128)> {
        let mut groups: Vec<(AccountId, String, Vec<u64>, u128)> = Vec::new();
        for id in self.bet_payout_ids(bet_id) {
            let Some(p) = self.pending_payouts.get(&id) else { continue };
            if p.bet_id != bet_id || p.done || p.in_flight {
                continue;
            }
            if let Some(g) = groups
                .iter_mut()
                .find(|(r, t, _, _)| *r == p.receiver && *t == p.token_id)
            {
                g.2.push(id);
                g.3 += p.amount.0;
            } else {
                groups.push((p.receiver.clone(), p.token_id.clone(), vec![id], p.amount.0));
            }
        }
        groups
    }

    /// OQ-T11 / D-AUDIT11: the permissionless batch drain. Groups every
    /// not-done, not-already-in-flight ledger line for `bet_id` by
    /// `(receiver, token_id)` (see `group_pending_ids`) and fires up to
    /// `limit` (clamped to `MAX_DRAIN_BATCH`) of those GROUPS as one
    /// `mt_transfer` each, at the same static gas budget (`PAYOUT_GAS` +
    /// `PAYOUT_CALLBACK_GAS`) `fire_payout` has always used per promise
    /// -- `MAX_DRAIN_BATCH` is sized so even the worst-case batch fits
    /// well under NEAR's 300 Tgas per-call ceiling (see
    /// `oq_t11_drain_payouts_batch_fits_300_tgas`). Since a bet has only
    /// a handful of distinct (receiver, token_id) pairs (D-AUDIT11:
    /// typically <=4 today, maker/taker/fee_account/keeper x 1 asset),
    /// the worst-case fan-out now fits in a SINGLE call instead of
    /// needing several -- this is called automatically at the end of
    /// `finalize`/`void_after_deadline` so the common
    /// case settles in the same transaction that finalized it. A group
    /// whose transfer fails is left retryable (I-4: never sent twice,
    /// never lost) -- the next `drain_payouts` call, by anyone, picks it
    /// back up, re-summing from the ledger (never from a stale cached
    /// amount). Returns the number of individual LEDGER LINES fired
    /// this call (not the number of groups), so existing callers
    /// checking "did this call do anything" still see a positive count.
    /// Once every line for this bet is done, a bet left at `Finalized`
    /// is promoted to `Settled` here (via `maybe_settle`) -- the ONLY
    /// place that transition happens, so a bet reaches `Settled` exactly
    /// when its ledger is empty, never before.
    pub fn drain_payouts(&mut self, bet_id: u64, limit: u64) -> u64 {
        let batch_limit = limit.clamp(1, MAX_DRAIN_BATCH) as usize;
        let groups = self.group_pending_ids(bet_id);
        let mut fired = 0u64;
        for (receiver, token_id, ids, amount) in groups.into_iter().take(batch_limit) {
            for id in &ids {
                let p = self.pending_payouts.get_mut(id).unwrap();
                p.in_flight = true;
                p.attempts += 1;
            }
            fired += ids.len() as u64;
            self.fire_payout(ids, receiver, token_id, amount);
        }
        self.maybe_settle(bet_id);
        fired
    }

    /// True iff `bet_id` has no ledger line still owed (every scheduled
    /// line is `done`; a bet with zero scheduled lines is vacuously
    /// fully paid).
    fn bet_fully_paid(&self, bet_id: u64) -> bool {
        !self.bet_payout_ids(bet_id).iter().any(|id| {
            self.pending_payouts
                .get(id)
                .map(|p| p.bet_id == bet_id && !p.done)
                .unwrap_or(false)
        })
    }

    /// OQ-T11: the ONLY place a bet is promoted from `Finalized` to
    /// `Settled` -- called after every `drain_payouts`/`on_payout_result`
    /// so the promotion happens as soon as (and only as soon as) the
    /// ledger actually empties out, with no separate "are we done yet"
    /// call a keeper has to remember to make.
    fn maybe_settle(&mut self, bet_id: u64) {
        if !self.bet_fully_paid(bet_id) {
            return;
        }
        if let Some(bet) = self.bets.get_mut(&bet_id) {
            if bet.status == BetStatus::Finalized {
                bet.status = BetStatus::Settled;
            }
        }
    }

    /// C1 (D-CONCEDE1, Tyler 2026-11-07; scope per D-PM3): either bettor
    /// may concede their OWN side of a bet that is Taken, Resolving,
    /// Proposed, Challenged, Evidence or Rejudge (i.e. after Taken and
    /// before Finalized/Settled). The counterparty is awarded the bet
    /// immediately: it receives the pot minus the normal fee through the
    /// normal ledger (`schedule_payout` + `drain_payouts`), fee and
    /// storage charges go to `fee_account` exactly as in a YES/NO
    /// `finalize`. It can only cost the caller, so no consent or verdict
    /// is needed. Any in-flight resolution request or proposed outcome
    /// is superseded (the bet leaves every status that
    /// `submit_outcome`/`request_resolution`/`finalize` accept, so a late
    /// OutLayer callback or signed outcome is a no-op). Challenge bonds
    /// and objection/rebuttal deposits are returned in full to their
    /// holders -- no verdict decided them, so nothing is forfeited and no
    /// round cost is charged. Refused in Open, Finalized, Settled,
    /// Voided/Cancelled/Expired, after shutdown, and from anyone but the
    /// maker/taker. There is deliberately no mutual settle (D-SETTLE3).
    pub fn concede(&mut self, bet_id: u64) {
        require(!self.shutdown, "contract is shut down");
        let caller = env::predecessor_account_id();
        let fee_account = self.fee_account.clone();
        let (maker, taker, maker_asset, taker_asset, stake_maker, stake_taker, fee_bps, storage_maker, storage_taker, winner, bonds, objections) = {
            let bet = self.bet_mut(bet_id);
            require(
                matches!(
                    bet.status,
                    BetStatus::Taken
                        | BetStatus::Resolving
                        | BetStatus::Proposed
                        | BetStatus::Challenged
                        | BetStatus::Evidence
                        | BetStatus::Rejudge
                ),
                "bet not concedable in its current status",
            );
            let maker = bet.envelope.maker.clone();
            let taker = bet.taker.clone().unwrap_or_else(|| env::panic_str("bet has no taker"));
            require(
                caller == maker || caller == taker,
                "only maker or taker may concede",
            );
            // The conceder's side loses; the other side's outcome wins.
            let maker_side = bet.envelope.maker_side.clone();
            let winning_outcome = if caller == maker {
                bet.envelope
                    .outcomes
                    .iter()
                    .find(|o| **o != maker_side)
                    .cloned()
                    .unwrap_or_else(|| env::panic_str("no counterparty outcome"))
            } else {
                maker_side
            };
            let winner = if caller == maker { taker.clone() } else { maker.clone() };
            bet.outcome = Some(winning_outcome);
            bet.status = BetStatus::Finalized;
            emit_event("bet_conceded", json!({"bet_id": bet_id, "conceded_by": caller}));
            bet.pre_challenge_outcome = None;
            bet.pending_resolution_request = None;
            bet.pending_run_no = None;
            let bonds = std::mem::take(&mut bet.bonds);
            let objections = std::mem::take(&mut bet.objection_deposits);
            (
                maker,
                taker,
                bet.envelope.maker_asset.clone(),
                bet.envelope.taker_asset.clone(),
                bet.envelope.stake_maker.0,
                bet.envelope.stake_taker.0,
                bet.envelope.fee_bps as u128,
                bet.storage_maker.0,
                bet.storage_taker.0,
                winner,
                bonds,
                objections,
            )
        };
        let _ = (&maker, &taker);
        // Held deposits go back to their holders, in their own asset.
        for b in bonds {
            self.schedule_payout(bet_id, b.holder, b.asset, b.amount.0, "concede_bond_refund".to_string());
        }
        for o in objections {
            self.schedule_payout(bet_id, o.sender, o.asset, o.amount.0, "concede_objection_refund".to_string());
        }
        // Same arithmetic as a YES/NO finalize (I-1 per asset).
        // D-FEEMIN1: same per-side minimum-fee math as finalize.
        // D-PARAMS1: the bet's own copy from open, never the live config.
        let (min_fee_maker, min_fee_taker) = {
            let b = self.bet(bet_id);
            (b.fee_min_maker.0, b.fee_min_taker.0)
        };
        let fee_maker = side_fee(stake_maker, fee_bps, min_fee_maker);
        let fee_taker = side_fee(stake_taker, fee_bps, min_fee_taker);
        // RF2 / D-REFUI4: the referee's tip (if opted in) is paid on a
        // concede too, carved from each bettor's own stake.
        let (tip_maker, tip_taker) = self.pay_tips(bet_id);
        self.schedule_payout(bet_id, winner.clone(), maker_asset.clone(), stake_maker - fee_maker - tip_maker, "payout_winner".to_string());
        self.schedule_payout(bet_id, winner.clone(), taker_asset.clone(), stake_taker - fee_taker - tip_taker, "payout_winner".to_string());
        self.schedule_payout(bet_id, fee_account.clone(), maker_asset, fee_maker + storage_maker, "fee_and_storage".to_string());
        self.schedule_payout(bet_id, fee_account, taker_asset, fee_taker + storage_taker, "fee_and_storage".to_string());
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"praetorial-escrow\",\"version\":\"1.0.0\",\"event\":\"concede\",\"data\":[{{\"bet_id\":{},\"conceder\":\"{}\",\"winner\":\"{}\",\"at_ns\":{}}}]}}",
            bet_id,
            caller,
            winner,
            env::block_timestamp()
        ));
        self.drain_payouts(bet_id, MAX_DRAIN_BATCH);
    }

    // -------------------------------------------------------------
    // Pause (I-5: blocks only open/take, enforced inside mt_on_transfer)
    // -------------------------------------------------------------

    // ---------------- D-PARAMS1: guardian-adjustable params ----------------

    /// D-PARAMS1: guardian proposes a settings change for NEW bets. It
    /// is validated against the hard caps now (and again at apply),
    /// emits `params_proposed`, and can be applied by anyone after
    /// `PARAMS_DELAY_NS` (24h). Refused while new offers are paused or
    /// after shutdown (a halted contract opens no bets). One pending
    /// change at a time; cancel first to replace it.
    #[payable]
    pub fn propose_params(&mut self, change: ParamsChange) {
        assert_one_yocto();
        require(env::predecessor_account_id() == self.guardian, "only guardian");
        self.require_not_halted_for_params();
        require(self.pending_params.is_none(), "params change already pending; cancel it first");
        self.validate_params_change(&change);
        let now = env::block_timestamp();
        let pending = PendingParams {
            change,
            proposed_at_ns: now,
            effective_at_ns: now + PARAMS_DELAY_NS,
        };
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"praetorial-escrow\",\"version\":\"1.0.0\",\"event\":\"params_proposed\",\"data\":[{}]}}",
            Self::params_event_json(&pending)
        ));
        self.pending_params = Some(pending);
    }

    /// D-PARAMS1: permissionless; works only once the 24h delay has
    /// elapsed and the contract is not halted. Never touches an existing
    /// bet (each bet holds its own copy of the fee terms).
    pub fn apply_params(&mut self) {
        self.require_not_halted_for_params();
        let pending = self.pending_params.clone().unwrap_or_else(|| env::panic_str("no pending params"));
        require(env::block_timestamp() >= pending.effective_at_ns, "params delay not elapsed");
        self.validate_params_change(&pending.change);
        if let Some(bps) = pending.change.fee_bps {
            self.protocol_fee_bps = bps;
        }
        for a in &pending.change.assets {
            let mut l = self.asset_limits.get(&a.asset_id).cloned().unwrap_or_else(|| env::panic_str("unknown asset"));
            if let Some(v) = a.min_fee_per_side {
                l.min_fee_per_side = v;
            }
            if let Some(v) = a.min_per_side {
                l.min_per_side = v;
            }
            if let Some(v) = a.max_per_side {
                l.max_per_side = v;
            }
            self.asset_limits.insert(a.asset_id.clone(), l);
        }
        self.pending_params = None;
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"praetorial-escrow\",\"version\":\"1.0.0\",\"event\":\"params_applied\",\"data\":[{}]}}",
            Self::params_event_json(&pending)
        ));
    }

    /// D-PARAMS1: guardian withdraws the pending change. Always allowed
    /// (also when halted -- removing a pending change is never harmful).
    #[payable]
    pub fn cancel_params(&mut self) {
        assert_one_yocto();
        require(env::predecessor_account_id() == self.guardian, "only guardian");
        let pending = self.pending_params.take().unwrap_or_else(|| env::panic_str("no pending params"));
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"praetorial-escrow\",\"version\":\"1.0.0\",\"event\":\"params_cancelled\",\"data\":[{}]}}",
            Self::params_event_json(&pending)
        ));
    }

    // ---------------- D-JUDGECHAIN1: append-only judge-pair chain ----------------

    /// D-JUDGECHAIN1: guardian proposes ONE pair to append at the END of the
    /// chain. Public event; `apply_judge_pair` works after 7 days.
    #[payable]
    pub fn propose_judge_pair(&mut self, pair: JudgePair) {
        assert_one_yocto();
        require(env::predecessor_account_id() == self.guardian, "only guardian");
        require(!self.shutdown, "contract is shut down");
        // JC1x (D-JUDGECHAIN1a #4): propose is refused while paused (apply/cancel stay allowed).
        require(!self.new_offers_paused, "new offers are paused; judge pair proposals are refused");
        require(self.pending_judge_pair.is_none(), "judge pair already pending; cancel it first");
        require(self.judge_chain.len() < MAX_JUDGE_PAIRS, "judge chain is full (max 12 pairs)");
        validate_judge_pair(&pair);
        require(!judge_chain_has_pair(&self.judge_chain, &pair), "judge pair already in the chain");
        let now = env::block_timestamp();
        let pending = PendingJudgePair {
            pair,
            proposed_at_ns: now,
            effective_at_ns: now + JUDGE_PAIR_DELAY_NS,
        };
        Self::log_judge_event("judge_pair_proposed", &pending);
        self.pending_judge_pair = Some(pending);
    }

    /// D-JUDGECHAIN1: permissionless; only after the 7-day delay. Appends at the end.
    pub fn apply_judge_pair(&mut self) {
        require(!self.shutdown, "contract is shut down");
        let pending = self
            .pending_judge_pair
            .clone()
            .unwrap_or_else(|| env::panic_str("no pending judge pair"));
        require(env::block_timestamp() >= pending.effective_at_ns, "judge pair delay not elapsed");
        require(self.judge_chain.len() < MAX_JUDGE_PAIRS, "judge chain is full (max 12 pairs)");
        require(!judge_chain_has_pair(&self.judge_chain, &pending.pair), "judge pair already in the chain");
        self.judge_chain.push(pending.pair.clone());
        self.pending_judge_pair = None;
        Self::log_judge_event("judge_pair_applied", &pending);
    }

    /// D-JUDGECHAIN1: guardian withdraws the pending proposal (before it is applied).
    #[payable]
    pub fn cancel_judge_pair(&mut self) {
        assert_one_yocto();
        require(env::predecessor_account_id() == self.guardian, "only guardian");
        let pending = self
            .pending_judge_pair
            .take()
            .unwrap_or_else(|| env::panic_str("no pending judge pair"));
        Self::log_judge_event("judge_pair_cancelled", &pending);
    }

    fn log_judge_event(event: &str, p: &PendingJudgePair) {
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"praetorial-escrow\",\"version\":\"1.0.0\",\"event\":\"{}\",\"data\":[{}]}}",
            event,
            json!({
                "model_a": p.pair.model_a,
                "model_b": p.pair.model_b,
                "proposed_at_ns": p.proposed_at_ns,
                "effective_at_ns": p.effective_at_ns,
            })
        ));
    }

    // ---------------- AS1 (D-ASSET1): guardian-added assets, 24h delay ----------------

    /// AS1: guardian proposes ONE asset to append (or a disabled asset to re-enable with its stored limits).
    /// Refused while paused or shut down; `apply_asset` works after 24h.
    #[payable]
    pub fn propose_asset(&mut self, token_id: String, limit: AssetLimit) {
        assert_one_yocto();
        require(env::predecessor_account_id() == self.guardian, "only guardian");
        require(!self.shutdown, "contract is shut down");
        require(!self.new_offers_paused, "new offers are paused; asset proposals are refused");
        require(self.pending_asset.is_none(), "asset already pending; cancel it first");
        require(!token_id.is_empty(), "token_id must not be empty");
        let limit = validate_asset_limit(limit);
        let reenable = match self.asset_limits.get(&token_id) {
            None => false,
            Some(stored) => {
                require(self.asset_disabled(token_id.clone()), "asset already in the table");
                require(
                    near_sdk::borsh::to_vec(stored).unwrap() == near_sdk::borsh::to_vec(&limit).unwrap(),
                    "re-enable limits must equal the stored limits",
                );
                true
            }
        };
        let now = env::block_timestamp();
        let pending = PendingAsset { token_id, limit, reenable, proposed_at_ns: now, effective_at_ns: now + ASSET_DELAY_NS };
        Self::log_asset_event("asset_proposed", &pending);
        self.pending_asset = Some(pending);
    }

    /// AS1: permissionless; only after the 24h delay.
    pub fn apply_asset(&mut self) {
        require(!self.shutdown, "contract is shut down");
        let pending = self.pending_asset.clone().unwrap_or_else(|| env::panic_str("no pending asset"));
        require(env::block_timestamp() >= pending.effective_at_ns, "asset delay not elapsed");
        if pending.reenable {
            require(self.disabled_assets.remove(&pending.token_id).is_some(), "asset is not disabled");
        } else {
            require(self.asset_limits.get(&pending.token_id).is_none(), "asset already in the table");
            self.asset_limits.insert(pending.token_id.clone(), pending.limit.clone());
        }
        self.pending_asset = None;
        Self::log_asset_event("asset_applied", &pending);
    }

    /// AS1: guardian withdraws the pending proposal.
    #[payable]
    pub fn cancel_asset(&mut self) {
        assert_one_yocto();
        require(env::predecessor_account_id() == self.guardian, "only guardian");
        let pending = self.pending_asset.take().unwrap_or_else(|| env::panic_str("no pending asset"));
        Self::log_asset_event("asset_cancelled", &pending);
    }

    /// AS1: guardian closes an asset to NEW bets, immediately. Existing bets are untouched; the asset stays in the
    /// table (append-only); re-enabling goes through `propose_asset` + `apply_asset` (24h).
    #[payable]
    pub fn disable_asset_for_new_bets(&mut self, token_id: String) {
        assert_one_yocto();
        require(env::predecessor_account_id() == self.guardian, "only guardian");
        require(self.asset_limits.get(&token_id).is_some(), "unknown asset");
        require(!self.asset_disabled(token_id.clone()), "asset already disabled");
        self.disabled_assets.insert(token_id.clone(), true);
        emit_event("asset_disabled", json!({"token_id": token_id, "guardian": self.guardian, "at_ns": env::block_timestamp()}));
    }

    fn log_asset_event(event: &str, p: &PendingAsset) {
        emit_event(
            event,
            json!({
                "token_id": p.token_id,
                "limit": p.limit,
                "reenable": p.reenable,
                "proposed_at_ns": p.proposed_at_ns,
                "effective_at_ns": p.effective_at_ns,
            }),
        );
    }

    pub fn pending_asset(&self) -> Option<PendingAsset> {
        self.pending_asset.clone()
    }

    pub fn asset_disabled(&self, token_id: String) -> bool {
        self.disabled_assets.get(&token_id).copied().unwrap_or(false)
    }

    /// D-JUDGECHAIN1 view: the live chain, in order.
    pub fn judge_chain(&self) -> Vec<JudgePair> {
        self.judge_chain.clone()
    }

    /// D-JUDGECHAIN1 view: the pending proposal, if any.
    pub fn pending_judge_pair(&self) -> Option<PendingJudgePair> {
        self.pending_judge_pair.clone()
    }

    /// JC1x: stored observations of one model (unix ns, ascending, <= 3).
    pub fn model_missing(&self, model: String) -> Vec<U64> {
        self.model_missing.get(&model).cloned().unwrap_or_default().into_iter().map(U64).collect()
    }

    /// JC1x: chain models that are currently retired (3 not-found observations >= 24h apart).
    pub fn retired_models(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for p in &self.judge_chain {
            for m in [&p.model_a, &p.model_b] {
                let retired = self.model_missing.get(m).map_or(false, |o| model_retired(o));
                if retired && !out.contains(m) {
                    out.push(m.clone());
                }
            }
        }
        out
    }

    /// D-JUDGECHAIN1a S4: number of bets ever opened (the next bet id).
    pub fn bet_count(&self) -> u64 {
        self.next_bet_id - 1
    }

    /// D-JUDGECHAIN1a S1: the proposed (not yet accepted) guardian, if any.
    pub fn pending_guardian(&self) -> Option<AccountId> {
        self.pending_guardian.clone()
    }

    fn model_missing_btree(&self) -> std::collections::BTreeMap<String, Vec<u64>> {
        let mut m = std::collections::BTreeMap::new();
        for p in &self.judge_chain {
            for id in [&p.model_a, &p.model_b] {
                if let Some(v) = self.model_missing.get(id) {
                    m.insert(id.clone(), v.clone());
                }
            }
        }
        m
    }

    fn model_missing_map(&self) -> std::collections::BTreeMap<String, Vec<U64>> {
        self.model_missing_btree()
            .into_iter()
            .filter(|(_, v)| !v.is_empty())
            .map(|(k, v)| (k, v.into_iter().map(U64).collect()))
            .collect()
    }

    fn append_observations(buf: &mut Vec<u8>, obs: &[ModelObservation]) {
        if !obs.is_empty() {
            let v: Vec<(String, u64)> = obs.iter().map(|o| (o.model.clone(), o.observed_ns.0)).collect();
            BorshSerialize::serialize(&v, buf).unwrap();
        }
    }

    /// Writes the post-observation state for the models this result named; a success clears both models of its pair.
    fn commit_observations(
        &mut self,
        eff: &std::collections::BTreeMap<String, Vec<u64>>,
        observed: &[String],
        clear: Option<&JudgePair>,
    ) {
        for m in observed {
            if let Some(v) = eff.get(m) {
                self.model_missing.insert(m.clone(), v.clone());
            }
        }
        if let Some(p) = clear {
            // JCD2 (D-JCD1a): retirement is final. A success never clears a model that is retired at submit time
            // (checked on the post-observation state), even when it came from a B2 snapshot pair retired in flight.
            for m in [&p.model_a, &p.model_b] {
                let is_retired = self.model_missing.get(m).map_or(false, |o| model_retired(o));
                if !is_retired {
                    self.model_missing.remove(m);
                }
            }
        }
    }

    /// D-PARAMS1 view: the pending change (with its effective time), if any.
    pub fn pending_params(&self) -> Option<PendingParams> {
        self.pending_params.clone()
    }

    /// D-PARAMS1 view: the CURRENT limits of one asset (what a bet opened now copies).
    pub fn asset_limit(&self, asset_id: String) -> Option<AssetLimit> {
        self.asset_limits.get(&asset_id).cloned()
    }

    /// D-SUNSET2: guardian-only, blocks only new offers/takes. Requires
    /// exactly 1 yoctoNEAR attached (standard NEAR access-key-safety
    /// convention for a state-changing admin call).
    #[payable]
    pub fn pause_new_offers(&mut self) {
        assert_one_yocto();
        require(env::predecessor_account_id() == self.guardian, "only guardian");
        self.new_offers_paused = true;
        emit_event("offers_paused", json!({"guardian": self.guardian, "at_ns": env::block_timestamp().to_string()}));
    }

    /// D-SUNSET2: guardian-only. Refused once `emergency_shutdown` has
    /// run -- shutdown is permanent and implies this pause forever.
    #[payable]
    pub fn unpause_new_offers(&mut self) {
        assert_one_yocto();
        require(env::predecessor_account_id() == self.guardian, "only guardian");
        require(!self.shutdown, "contract is shut down; unpause is impossible after shutdown");
        self.new_offers_paused = false;
        emit_event("offers_unpaused", json!({"guardian": self.guardian, "at_ns": env::block_timestamp().to_string()}));
    }

    /// D-SUNSET2 (queue item 8c): guardian rotation. Guardian-only,
    /// never callable by anyone else, and grants the new guardian only
    /// the same three narrow powers -- no other power is ever added.
    #[payable]
    pub fn set_guardian(&mut self, new_guardian: AccountId) {
        assert_one_yocto();
        require(env::predecessor_account_id() == self.guardian, "only guardian");
        // JC1x (D-JUDGECHAIN1a S1): proposes only. The old guardian stays until `new_guardian` itself calls
        // `accept_guardian` -- which is what proves the account exists and its key is held.
        emit_event(
            "guardian_proposed",
            json!({"guardian": self.guardian, "proposed": new_guardian, "at_ns": env::block_timestamp().to_string()}),
        );
        self.pending_guardian = Some(new_guardian);
    }

    /// JC1x (D-JUDGECHAIN1a S1): the proposed account takes over. Only the proposed account may call.
    #[payable]
    pub fn accept_guardian(&mut self) {
        assert_one_yocto();
        let pending = self.pending_guardian.clone().unwrap_or_else(|| env::panic_str("no pending guardian"));
        require(env::predecessor_account_id() == pending, "only the proposed guardian may accept");
        let old = std::mem::replace(&mut self.guardian, pending.clone());
        self.pending_guardian = None;
        emit_event(
            "guardian_rotated",
            json!({"old_guardian": old, "guardian": pending, "at_ns": env::block_timestamp().to_string()}),
        );
    }

    /// JC1x (D-JUDGECHAIN1a S1): the current guardian withdraws a pending rotation.
    #[payable]
    pub fn cancel_guardian(&mut self) {
        assert_one_yocto();
        require(env::predecessor_account_id() == self.guardian, "only guardian");
        let pending = self.pending_guardian.take().unwrap_or_else(|| env::panic_str("no pending guardian"));
        emit_event(
            "guardian_cancelled",
            json!({"guardian": self.guardian, "cancelled": pending, "at_ns": env::block_timestamp().to_string()}),
        );
    }

    /// D-SUNSET3: guardian-only, immediate, irreversible, whole-contract
    /// shutdown. Implies `new_offers_paused` permanently (unpause is
    /// refused forever after this). Emits a NEP-297-style event log so
    /// indexers/keepers can react. After this, `emergency_refund`
    /// becomes permissionless and resolution/submit_outcome/finalize/
    /// challenge (handle_bond)/amend/amend_referee are all
    /// refused, so a refund can never race a payout decision.
    #[payable]
    pub fn emergency_shutdown(&mut self) {
        assert_one_yocto();
        require(env::predecessor_account_id() == self.guardian, "only guardian");
        require(!self.shutdown, "already shut down");
        self.shutdown = true;
        self.new_offers_paused = true;
        env::log_str(
            &format!(
                "EVENT_JSON:{{\"standard\":\"praetorial-escrow\",\"version\":\"1.0.0\",\"event\":\"emergency_shutdown\",\"data\":[{{\"guardian\":\"{}\",\"at_ns\":{}}}]}}",
                self.guardian,
                env::block_timestamp()
            )
        );
    }

    /// D-SUNSET3: permissionless, one bet per call, only callable after
    /// `emergency_shutdown`. Returns each party exactly their own
    /// deposits (stake + storage charge for maker/taker if deposited,
    /// every still-unsettled bond and objection/rebuttal deposit by its
    /// own holder/sender) in their own asset, with no fee, via the
    /// existing `schedule_payout` pull path (retried normally by
    /// `drain_payouts`/`retry_payout`).
    ///
    /// Double-pay safety (8c2 fix -- replaces the earlier, broken
    /// "any existing line in this asset means the whole asset is
    /// already fully scheduled" HashSet check): that assumption was
    /// false. History (pre-RF2): the removed FinalSay panel refund
    /// scheduled only the panel-cost PORTION of the final-round bond on
    /// a bet left non-terminal, with real money still owed in that very
    /// asset. The old per-asset-existence check saw that one line and
    /// skipped the ENTIRE asset, stranding everything else in it forever
    /// (both sides on a same-asset bet, or just the challenger's side on
    /// a cross-asset bet). The status-based rule below is the guard.
    ///
    /// The actual invariant: every money-moving mutator in this
    /// contract (`finalize`/`void_after_deadline`/
    /// `refund_open`) sets the bet's status to a TERMINAL value
    /// (`Finalized`, which `drain_payouts`/`maybe_settle` later
    /// promotes to `Settled`, or straight to `Voided`/`Cancelled`/
    /// `Expired`) in the SAME atomic call that schedules 100% of the
    /// bet's money for every asset it ever held. `referee_rule` (RF2) also
    /// moves the bet to `Finalized` in the same call that schedules all
    /// of its money. (Pre-RF2 the removed FinalSay panel refund was the
    /// one exception.) So the correct rule
    /// is on `bet.status`, not on "does this asset already have a
    /// line": a `Finalized` bet already had 100% of every asset
    /// scheduled by whichever call finalized it, so this schedules
    /// nothing further (those lines are left to drain exactly as
    /// before, and the bet is left at `Finalized` too -- NOT marked
    /// `Voided` -- so `drain_payouts`/`maybe_settle` can still promote
    /// it to `Settled` once its ledger empties, the only surviving
    /// transition for `Finalized`; a second `emergency_refund` call on
    /// it is still a no-op, since it hits this same branch again).
    /// Any OTHER non-terminal status (anything but `Finalized`, which
    /// covers `finalize` and `referee_rule`'s ruling as well as every
    /// earlier, never-disputed or mid-dispute state) schedules every
    /// candidate below regardless of what's already pending in that
    /// asset. (Pre-RF2 the removed FinalSay panel refund was the one
    /// call site that scheduled money yet left a bet non-terminal.)
    /// Terminal (`Settled`/`Voided`/`Cancelled`/`Expired`) bets are
    /// refused outright (nothing left owed, or already closed). A
    /// successful non-`Finalized` call marks the bet `Voided` so a
    /// second call (or any other mutator) on the same bet is refused.
    pub fn emergency_refund(&mut self, bet_id: u64) {
        require(self.shutdown, "emergency_refund is only callable after emergency_shutdown");
        let bet = self.bets.get(&bet_id).cloned().unwrap_or_else(|| env::panic_str("bet not found"));
        require(
            !matches!(
                bet.status,
                BetStatus::Settled | BetStatus::Voided | BetStatus::Cancelled | BetStatus::Expired
            ),
            "bet is already terminal; emergency_refund refused",
        );
        if bet.status == BetStatus::Finalized {
            // Already 100% scheduled atomically by whichever call
            // finalized it; leave it exactly as-is so the pre-existing
            // lines keep draining and `maybe_settle` can still promote
            // it to `Settled`.
            env::log_str(&format!("emergency_refund bet_id={bet_id} already Finalized; nothing scheduled"));
            return;
        }
        // Candidate (receiver, asset, amount, reason) lines -- exactly
        // what each party deposited, nothing more. Scheduled
        // unconditionally: the only non-terminal status that can carry
        // a pre-existing PARTIAL line (referee_rule's panel refund)
        // still owes every one of these in full.
        let mut candidates: Vec<(AccountId, String, u128, String)> = Vec::new();
        candidates.push((
            bet.envelope.maker.clone(),
            bet.envelope.maker_asset.clone(),
            bet.envelope.stake_maker.0 + bet.storage_maker.0,
            "emergency_refund_maker".to_string(),
        ));
        if let Some(taker) = bet.taker.clone() {
            candidates.push((
                taker,
                bet.envelope.taker_asset.clone(),
                bet.envelope.stake_taker.0 + bet.storage_taker.0,
                "emergency_refund_taker".to_string(),
            ));
        }
        for b in &bet.bonds {
            candidates.push((
                b.holder.clone(),
                b.asset.clone(),
                b.amount.0,
                "emergency_refund_bond".to_string(),
            ));
        }
        for o in &bet.objection_deposits {
            candidates.push((
                o.sender.clone(),
                o.asset.clone(),
                o.amount.0,
                "emergency_refund_objection".to_string(),
            ));
        }
        for (receiver, asset, amount, reason) in candidates {
            self.schedule_payout(bet_id, receiver, asset, amount, reason);
        }
        self.bet_mut(bet_id).status = BetStatus::Voided;
        env::log_str(&format!("emergency_refund bet_id={bet_id}"));
        emit_event("bet_voided", json!({"bet_id": bet_id, "reason": "emergency_refund"}));
    }

    // -------------------------------------------------------------
    // Views
    // -------------------------------------------------------------

    pub fn get_bet(&self, bet_id: u64) -> Option<Bet> {
        self.bets.get(&bet_id).cloned()
    }

    /// D-AUDIT8 view, generalized per-asset by D-BOND1: the exact
    /// amount and asset a `Bond` transfer from `challenger` must carry
    /// to open the NEXT challenge round on this bet right now, or
    /// `None` if the bet is unknown, `challenger` is neither the maker
    /// nor the taker, or the bet is already at `limits.max_rounds` (no
    /// further challenge possible -- see `handle_bond`). The asset is
    /// always `challenger`'s own stake asset (maker_asset if they're
    /// the maker, taker_asset if they're the taker) -- a cross-asset
    /// bet's maker and taker can be quoted two different (amount,
    /// asset) pairs for the same bet. Lets a keeper/UI quote the
    /// correct amount (this asset's own challenge-bond minimum + this
    /// round's own `run_price`) instead of hardcoding the pre-D-BOND1
    /// USDC-only formula, which is now rejected by `handle_bond`.
    pub fn required_challenge_bond(&self, bet_id: u64, challenger: AccountId) -> Option<ChallengeBondQuote> {
        let bet = self.bets.get(&bet_id)?;
        if bet.bonds.len() as u32 >= self.limits.max_rounds {
            return None;
        }
        let is_maker = challenger == bet.envelope.maker;
        let is_taker = bet.taker.as_ref() == Some(&challenger);
        if !is_maker && !is_taker {
            return None;
        }
        let asset = if is_maker {
            bet.envelope.maker_asset.clone()
        } else {
            bet.envelope.taker_asset.clone()
        };
        let limit = self.asset_limits.get(&asset)?;
        // D-DISPUTE1: mirror handle_bond's doubling exactly -- see its
        // doc comment for the formula.
        let pot = bet.envelope.pot_for_challenger(is_maker);
        let challenge_floor = std::cmp::max(limit.min_bond.0, pot * 1_000 / BPS_DENOM);
        let this_round = bet.bonds.len() as u32 + 1;
        let challenge_min = challenge_floor * 2u128.pow(this_round - 1);
        Some(ChallengeBondQuote {
            amount: U128(challenge_min + limit.run_price.0),
            asset,
        })
    }

    pub fn open_offers(&self, from: u64, limit: u64) -> Vec<Bet> {
        self.open_bet_ids
            .iter()
            .filter(|id| **id >= from)
            .take(limit as usize)
            .filter_map(|id| self.bets.get(id).cloned())
            .filter(|b| b.status == BetStatus::Open)
            .collect()
    }

    pub fn get_stub(&self, bet_id: u64) -> Option<(u64, Option<String>, String, String)> {
        self.bets.get(&bet_id).map(|b| {
            (
                b.envelope.bet_id,
                b.outcome.clone(),
                format!("{:?}", b.status),
                b.envelope.terms_hash.clone(),
            )
        })
    }

    pub fn pending_payouts_view(&self, from: u64, limit: u64) -> Vec<PendingPayout> {
        // Ids are dense and never pruned: 1..next_payout_id.
        (from.max(1)..self.next_payout_id)
            .take(limit as usize)
            .filter_map(|id| self.pending_payouts.get(&id).cloned())
            .collect()
    }

    /// OQ-T11 view: every not-yet-done ledger line for `bet_id`, in the
    /// order they were scheduled -- what a keeper/UI polls to decide
    /// whether (and with how many lines) to call `drain_payouts` next.
    pub fn pending_payouts(&self, bet_id: u64) -> Vec<PendingPayout> {
        self.bet_payout_ids(bet_id)
            .iter()
            .filter_map(|id| self.pending_payouts.get(id).cloned())
            .filter(|p| p.bet_id == bet_id && !p.done)
            .collect()
    }

    /// OQ-T11 view: true iff every ledger line ever scheduled for
    /// `bet_id` is `done` (vacuously true if none were). A bet can only
    /// be `Settled` once this is true -- see `maybe_settle`.
    pub fn is_fully_paid(&self, bet_id: u64) -> bool {
        self.bet_fully_paid(bet_id)
    }

    /// D-SUNSET2: true iff new offers/takes are currently blocked --
    /// either via `pause_new_offers` or (permanently) via
    /// `emergency_shutdown`. Kept under its old name for existing
    /// callers; `is_new_offers_paused` is the same value under its new
    /// name.
    pub fn is_paused(&self) -> bool {
        self.new_offers_paused
    }

    /// D-SUNSET2: same value as `is_paused`, named for the narrower
    /// semantics this flag now actually has.
    pub fn is_new_offers_paused(&self) -> bool {
        self.new_offers_paused
    }

    /// D-SUNSET3: true iff `emergency_shutdown` has run. Permanent.
    pub fn is_shutdown(&self) -> bool {
        self.shutdown
    }

    /// D-UPGRADE1 (contract half): this build's version, for a keeper/
    /// indexer watching multiple deployed contract versions to tell
    /// them apart. Sourced from the crate's own Cargo.toml version at
    /// compile time.
    pub fn contract_version(&self) -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }

    /// Permissionless. Sends any NEAR held above (current storage cost +
    /// a fixed safety buffer) to `fee_account`. Exists because this
    /// contract is immutable/lock-after-deploy (I-6: no admin withdraw) --
    /// without a permissionless sweep, NEAR sent here by mistake (or excess
    /// keeper float) would be stranded forever with no owner key able to
    /// pull it out. Never touches USDC/intents balances (those are tracked
    /// separately on intents.near, not NEAR-native); never blocked by
    /// pause (I-5 only gates open/take).
    pub fn sweep_excess_near(&mut self) -> NearToken {
        let required = NearToken::from_yoctonear(
            env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear(),
        )
        .saturating_add(NEAR_SAFETY_BUFFER);
        let balance = env::account_balance();
        if balance <= required {
            return NearToken::from_yoctonear(0);
        }
        let excess = balance.saturating_sub(required);
        if excess.as_yoctonear() > 0 {
            let _ = Promise::new(self.fee_account.clone()).transfer(excess);
        }
        excess
    }

    /// D-MN1: true iff this escrow is pinned to the real `intents.near`.
    fn is_mainnet(&self) -> bool {
        self.intents.as_str() == MAINNET_INTENTS_ACCOUNT
    }

    /// D-MN1: the wNEAR token id on the pinned intents contract, derived
    /// from the network (never a testnet literal on a mainnet escrow).
    #[allow(dead_code)] // pinned by tests; no escrow-side wNEAR call exists yet
    fn wnear_token_id(&self) -> String {
        if self.is_mainnet() {
            MAINNET_WNEAR_TOKEN_ID.to_string()
        } else {
            TESTNET_WNEAR_TOKEN_ID.to_string()
        }
    }

    fn require_not_halted_for_params(&self) {
        require(!self.shutdown, "contract is shut down");
        require(!self.new_offers_paused, "new offers are paused; params changes are refused while halted");
    }

    /// D-PARAMS1: all hard caps, checked against the CURRENT config
    /// merged with the change. Panics with the violated rule.
    fn validate_params_change(&self, change: &ParamsChange) {
        require(change.fee_bps.is_some() || !change.assets.is_empty(), "empty params change");
        if let Some(bps) = change.fee_bps {
            require(bps <= MAX_FEE_BPS, "fee_bps exceeds 200 (2%)");
        }
        let mut seen: Vec<&str> = Vec::new();
        for a in &change.assets {
            require(!seen.contains(&a.asset_id.as_str()), "duplicate asset in params change");
            seen.push(a.asset_id.as_str());
            let l = self.asset_limits.get(&a.asset_id).unwrap_or_else(|| env::panic_str("unknown asset"));
            let min_fee = a.min_fee_per_side.unwrap_or(l.min_fee_per_side).0;
            let min = a.min_per_side.unwrap_or(l.min_per_side).0;
            let max = a.max_per_side.unwrap_or(l.max_per_side).0;
            require(min_fee > 0, "min_fee_per_side must be > 0");
            require(min_fee <= l.min_fee_cap_per_side.0, "min_fee_per_side exceeds the per-asset cap");
            require(min <= max, "min_per_side must be <= max_per_side");
            require(max <= MAX_PER_SIDE_CEILING, "max_per_side exceeds the 10^34 raw ceiling");
            require(min_fee <= min / 20, "min_fee_per_side must be <= min_per_side/20");
        }
    }

    fn params_event_json(p: &PendingParams) -> String {
        let assets: Vec<String> = p
            .change
            .assets
            .iter()
            .map(|a| {
                let f = |o: &Option<U128>| o.map(|v| format!("\"{}\"", v.0)).unwrap_or_else(|| "null".to_string());
                format!(
                    "{{\"asset_id\":\"{}\",\"min_fee_per_side\":{},\"min_per_side\":{},\"max_per_side\":{}}}",
                    a.asset_id,
                    f(&a.min_fee_per_side),
                    f(&a.min_per_side),
                    f(&a.max_per_side)
                )
            })
            .collect();
        format!(
            "{{\"fee_bps\":{},\"assets\":[{}],\"proposed_at_ns\":{},\"effective_at_ns\":{}}}",
            p.change.fee_bps.map(|b| b.to_string()).unwrap_or_else(|| "null".to_string()),
            assets.join(","),
            p.proposed_at_ns,
            p.effective_at_ns
        )
    }

    fn bet_mut(&mut self, bet_id: u64) -> &mut Bet {
        self.bets
            .get_mut(&bet_id)
            .unwrap_or_else(|| env::panic_str("unknown bet_id"))
    }

    fn bet(&self, bet_id: u64) -> &Bet {
        self.bets
            .get(&bet_id)
            .unwrap_or_else(|| env::panic_str("unknown bet_id"))
    }
}

#[cfg(test)]
mod tests;

// Plain (non-#[near]) impl: not exported as a contract method.
impl Contract {
    /// DR-ESC-8: payout ledger line ids in scheduling order. Ids are dense
    /// (`1..next_payout_id`) and never pruned, so no stored global log is
    /// needed (it made the root state grow linearly with all-time history).
    /// Intended for tests/seams; O(n), never call from a contract method.
    #[doc(hidden)]
    pub fn payout_ids_in_order(&self) -> Vec<u64> {
        (1..self.next_payout_id).collect()
    }
}

#[cfg(test)]
impl Contract {
    /// JC1x test hook: the exact `input_data` `request_resolution` would build for this bet right now.
    pub(crate) fn resolution_input_data_for_test(&self, bet_id: u64) -> String {
        let bet = self.bet(bet_id);
        resolution_input_data_with_missing(
            &env::current_account_id(),
            bet_id,
            &bet.envelope,
            &bet.envelope.terms,
            0,
            1,
            &self.keeper,
            &self.judge_chain,
            &self.model_missing_map(),
        )
    }

    pub(crate) fn resolution_input_data_with_missing_for_test(
        &self,
        envelope: &Envelope,
        missing: &std::collections::BTreeMap<String, Vec<U64>>,
    ) -> String {
        resolution_input_data_with_missing(
            &env::current_account_id(),
            u64::MAX,
            envelope,
            &envelope.terms,
            u32::MAX,
            u64::MAX,
            &self.keeper,
            &self.judge_chain,
            missing,
        )
    }
}
