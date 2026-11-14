// RED-first (D-UPGRADE1): keeper must process bets across two mock
// contract versions and, for whichever one reports shut down, fire
// emergency_refund for every still-open bet on it instead of its
// normal next action.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planActionsForContracts } from "../src/policy.js";
import type { TaggedBet } from "@praetorial/common/discovery.js";
import type { Bet, Envelope } from "@praetorial/common/types.js";

const NS = 1_000_000_000;

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    bet_id: 1, version: 1, maker: "maker.testnet", taker_allow: { Any: {} },
    terms_hash: "a".repeat(64),
    maker_asset: "usdc.fakes.testnet", taker_asset: "usdc.fakes.testnet",
    models_snapshot_hash: "d", outcomes: ["YES", "NO"], maker_side: "YES",
    stake_maker: "100", stake_taker: "100", fee_bps: 100, storage_charge_per_side: "1", keep_terms: true, max_paid_runs: 3,
    tier: 1, arbiter: null, funding_deadline: 100 * NS, early_settle_outcome: null,
    finality_delay: 0, settlement_period: 48 * 3600 * NS, resolve_deadline: 10_000 * NS, consent_party_controlled: false,
    ...overrides,
  };
}

function bet(overrides: Partial<Bet> = {}): Bet {
  return {
    envelope: envelope(overrides.envelope as any), status: "Taken", taker: "taker.testnet", created_at: 0,
    taken_at: 0, proposed_at: null, outcome: null, used_run_nos: [], runs_used: 0, bonds: [],
    pre_challenge_outcome: null, challenged_by: null, exhibits: [], rebuttals: [],
    objection_deposits: [], arbiter_submissions: [], amend_count: 0, pending_resolution_request: null,
    last_resolution_raw: null, pruned: false, next_expected_run_no: 1, all_results: [],
    window_extended: false, window_extension_ns: "0",
    ...overrides,
  };
}

function tagged(contractId: string, version: string, betId: number, b: Bet): TaggedBet {
  return { betId, bet: b, contractId, version };
}

test("live contract: bets get their normal planned action, tagged with contractId", () => {
  const bets = new Map<string, TaggedBet>([
    ["v1:1", tagged("escrow-v1.testnet", "v1", 1, bet({ status: "Open", envelope: envelope({ funding_deadline: 0 }) }))],
  ]);
  const actions = planActionsForContracts(bets, 1 * NS, new Set());
  assert.deepEqual(actions, [{ contractId: "escrow-v1.testnet", action: { kind: "expire", bet_id: 1 } }]);
});

test("shut-down contract: every non-terminal bet gets emergency_refund instead of its normal action", () => {
  const bets = new Map<string, TaggedBet>([
    // Still-live contract: normal policy applies (nothing due yet).
    ["v1:1", tagged("escrow-v1.testnet", "v1", 1, bet({ status: "Taken" }))],
    // Shut-down contract: two open bets must both get emergency_refund...
    ["v2:1", tagged("escrow-v2.testnet", "v2", 1, bet({ status: "Taken" }))],
    ["v2:2", tagged("escrow-v2.testnet", "v2", 2, bet({ status: "Open" }))],
    // ...but an already-terminal bet on the shut-down contract does not.
    ["v2:3", tagged("escrow-v2.testnet", "v2", 3, bet({ status: "Settled" }))],
  ]);
  const actions = planActionsForContracts(bets, 1 * NS, new Set(["escrow-v2.testnet"]));

  const v1Actions = actions.filter((a) => a.contractId === "escrow-v1.testnet");
  const v2Actions = actions.filter((a) => a.contractId === "escrow-v2.testnet");

  assert.deepEqual(v1Actions, []); // Taken bet, nothing due yet on the live contract
  assert.equal(v2Actions.length, 2);
  assert.ok(v2Actions.every((a) => a.action.kind === "emergency_refund"));
  assert.deepEqual(v2Actions.map((a) => (a.action as any).bet_id).sort(), [1, 2]);
});

// Corrected by the red-team shutdown run: emergency_refund only schedules
// ledger lines, so drain_payouts is NOT superseded -- a Finalized bet's
// pending lines are drained and emergency_refund (a no-op there) is not called.
// See shutdownDrain.test.ts for the full matrix.
test("pending payouts on a shut-down contract are drained (emergency_refund does not send transfers)", () => {
  const bets = new Map<string, TaggedBet>([
    ["v2:1", tagged("escrow-v2.testnet", "v2", 1, bet({ status: "Finalized" }))],
  ]);
  const actions = planActionsForContracts(
    bets,
    1 * NS,
    new Set(["escrow-v2.testnet"]),
    [{ contractId: "escrow-v2.testnet", betId: 1 }],
  );
  assert.equal(actions.filter((a) => a.action.kind === "drain_payouts").length, 1);
  assert.equal(actions.filter((a) => a.action.kind === "emergency_refund").length, 0);
});
