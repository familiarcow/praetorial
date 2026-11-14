// RED-first (D-UPGRADE1): computeNoticesMulti must process bets from
// every configured contract and tag each resulting notice with its
// contract id; identical bet_ids on two different contracts must not
// be deduped against each other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeNoticesMulti } from "../src/notifier.js";
import type { Bet } from "@praetorial/common/types.js";

const NS = 1_000_000_000;

function bet(overrides: Partial<Bet>): Bet {
  return {
    envelope: {
      bet_id: 1, version: 1, maker: "maker1.testnet", taker_allow: { Any: {} },
      terms_hash: "x",
      maker_asset: "usdc.fakes.testnet", taker_asset: "usdc.fakes.testnet",
      models_snapshot_hash: "m", outcomes: ["YES", "NO"], maker_side: "YES",
      stake_maker: "100", stake_taker: "100", fee_bps: 100, storage_charge_per_side: "1", keep_terms: true, max_paid_runs: 1,
      tier: 1, arbiter: null, funding_deadline: 100, early_settle_outcome: null,
      finality_delay: 0, settlement_period: 10 * NS, resolve_deadline: 1000 * NS, consent_party_controlled: false,
    },
    status: "Proposed", taker: "taker1.testnet", created_at: 0, taken_at: null, proposed_at: 0,
    outcome: "YES", used_run_nos: [], runs_used: 1, bonds: [],
    pre_challenge_outcome: null, challenged_by: null, exhibits: [], rebuttals: [],
    objection_deposits: [], arbiter_submissions: [], amend_count: 0,
    pending_resolution_request: null, last_resolution_raw: null, pruned: false,
    next_expected_run_no: 1, all_results: [], window_extended: false, window_extension_ns: "0",
    ...overrides,
  };
}

test("computeNoticesMulti tags notices with their contract id across two contracts", () => {
  const betsByContract = new Map<string, Map<number, Bet>>([
    ["escrow-v1.testnet", new Map([[1, bet({})]])],
    ["escrow-v2.testnet", new Map([[1, bet({})]])], // same bet_id, different contract
  ]);
  const notices = computeNoticesMulti(betsByContract, 1 * NS, new Set());
  // This fixture's settlement_period (10ns) is inside the 6h
  // "closing soon" window, so each contract emits both a "proposed"
  // and a "challenge_window_closing" notice for its bet -- 2 per
  // contract x 2 contracts.
  assert.equal(notices.length, 4);
  assert.deepEqual(
    notices.map((n) => n.contract_id).sort(),
    ["escrow-v1.testnet", "escrow-v1.testnet", "escrow-v2.testnet", "escrow-v2.testnet"],
  );
});

test("computeNoticesMulti dedupes within a contract but not across contracts with the same bet_id", () => {
  const seen = new Set<string>();
  const betsByContract = new Map<string, Map<number, Bet>>([
    ["escrow-v1.testnet", new Map([[1, bet({})]])],
    ["escrow-v2.testnet", new Map([[1, bet({})]])],
  ]);
  const first = computeNoticesMulti(betsByContract, 1 * NS, seen);
  const second = computeNoticesMulti(betsByContract, 2 * NS, seen);
  assert.equal(first.length, 4); // proposed + closing-soon, once per contract
  assert.equal(second.length, 0); // both already seen, each within its own contract
});
