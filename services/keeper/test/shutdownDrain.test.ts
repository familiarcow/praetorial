// RED-team (shutdown mid-dispute): contract `emergency_refund` only SCHEDULES
// payout ledger lines (it never fires the transfers), and a Finalized bet's
// pre-existing lines (possibly with a failed transfer awaiting retry) are
// likewise only moved by `drain_payouts`. The keeper used to SKIP
// drain_payouts on every shut-down contract ("emergency_refund supersedes
// it"), so refunds scheduled by emergency_refund -- and failed Finalized
// payouts -- were never sent by the keeper (stuck until a user drains by
// hand), while Finalized bets got a pointless emergency_refund no-op tx
// every tick.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planActionsForContracts } from "../src/policy.js";
import type { TaggedBet } from "@praetorial/common/discovery.js";
import type { Bet, Envelope } from "@praetorial/common/types.js";

const NS = 1_000_000_000;
const DEAD = "escrow-dead.testnet";

function envelope(): Envelope {
  return {
    bet_id: 1, version: 1, maker: "maker.testnet", taker_allow: { Any: {} },
    terms_hash: "a".repeat(64),
    models_snapshot_hash: "d", outcomes: ["YES", "NO"], maker_side: "YES",
    stake_maker: "100", stake_taker: "100", fee_bps: 100, storage_charge_per_side: "1", keep_terms: true, max_paid_runs: 3,
    tier: 1, arbiter: null, funding_deadline: 100 * NS, early_settle_outcome: null,
    finality_delay: 0, settlement_period: 48 * 3600 * NS, resolve_deadline: 10_000 * NS, consent_party_controlled: false,
  } as any;
}

function bet(status: string): Bet {
  return {
    envelope: envelope(), status, taker: "taker.testnet", created_at: 0,
    taken_at: 0, proposed_at: null, outcome: null, used_run_nos: [], runs_used: 0, bonds: [],
    pre_challenge_outcome: null, challenged_by: null, exhibits: [], rebuttals: [],
    objection_deposits: [], arbiter_submissions: [], amend_count: 0, pending_resolution_request: null,
    last_resolution_raw: null, pruned: false, next_expected_run_no: 1, all_results: [],
    window_extended: false, window_extension_ns: "0",
  } as any;
}

const tagged = (id: number, status: string): TaggedBet => ({ betId: id, bet: bet(status), contractId: DEAD, version: "v2" });

test("shut-down contract: a Voided bet with pending refund lines gets drain_payouts", () => {
  const bets = new Map([["v2:1", tagged(1, "Voided")]]);
  const actions = planActionsForContracts(bets, 1 * NS, new Set([DEAD]), [{ contractId: DEAD, betId: 1 }]);
  assert.deepEqual(actions, [{ contractId: DEAD, action: { kind: "drain_payouts", bet_id: 1 } }]);
});

test("shut-down contract: a Finalized bet is only drained (emergency_refund is a no-op on it), exactly once per tick", () => {
  const bets = new Map([["v2:1", tagged(1, "Finalized")]]);
  const actions = planActionsForContracts(bets, 1 * NS, new Set([DEAD]), [{ contractId: DEAD, betId: 1 }]);
  assert.deepEqual(actions, [{ contractId: DEAD, action: { kind: "drain_payouts", bet_id: 1 } }]);
});

test("shut-down contract: a non-terminal bet is refunded, never also drained in the same tick (no double call)", () => {
  const bets = new Map([["v2:1", tagged(1, "Resolving")]]);
  const actions = planActionsForContracts(bets, 1 * NS, new Set([DEAD]), [{ contractId: DEAD, betId: 1 }]);
  assert.deepEqual(actions, [{ contractId: DEAD, action: { kind: "emergency_refund", bet_id: 1 } }]);
});

test("shut-down contract: a Finalized bet with nothing pending plans nothing", () => {
  const bets = new Map([["v2:1", tagged(1, "Finalized")]]);
  assert.deepEqual(planActionsForContracts(bets, 1 * NS, new Set([DEAD]), []), []);
});
