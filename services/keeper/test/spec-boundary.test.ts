// SPEC: offchain services and surfaces spec v0 §7 Keeper,
// "Cannot" — "sign an outcome, choose what the resolver decides, bypass
// the settlement period, or touch a bet's stake/bond... **Never calls**
// `challenge`, `mutual_settle`, or any money-destination-changing method
// — those require a party's own signature by design, and the keeper is
// not a party." Master map §0: "none of them hold a key that can move
// user funds or sign an outcome" (the one narrow, explicitly-labeled
// testnet exception is resolverSim.ts, gated behind
// PRAETORIAL_RESOLVER_SECRET_SEED_HEX and documented as never-production
// in its own module doc).
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextActionForBet } from "../src/policy.js";
import type { Bet, BetStatus, Envelope } from "@praetorial/common/types.js";

const NS = 1_000_000_000;
const FORBIDDEN_KINDS = ["challenge", "mutual_settle", "submit_outcome", "amend", "arbiter_pick", "cancel"];
const ALLOWED_KINDS = ["request_resolution", "finalize", "void_after_deadline", "expire", "drain_payouts"];

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    bet_id: 1, version: 1, maker: "maker1.testnet", taker_allow: { Any: {} },
    terms_hash: "a".repeat(64),
    maker_asset: "usdc.fakes.testnet", taker_asset: "usdc.fakes.testnet",
    models_snapshot_hash: "d", outcomes: ["YES", "NO"], maker_side: "YES",
    stake_maker: "1000000", stake_taker: "1000000", fee_bps: 100, storage_charge_per_side: "10000", keep_terms: true, max_paid_runs: 3,
    tier: 1, arbiter: null, funding_deadline: 100 * NS, early_settle_outcome: null,
    finality_delay: 0, settlement_period: 100 * NS, resolve_deadline: 10_000 * NS, consent_party_controlled: false,
    ...overrides,
  };
}

function bet(status: BetStatus, overrides: Partial<Bet> = {}): Bet {
  return {
    envelope: envelope(), status, taker: "taker1.testnet", created_at: 0, taken_at: 0,
    proposed_at: null, outcome: null, used_run_nos: [], runs_used: 0, bonds: [], pre_challenge_outcome: null, challenged_by: null, exhibits: [], rebuttals: [],
    objection_deposits: [], arbiter_submissions: [], amend_count: 0, pending_resolution_request: null,
    last_resolution_raw: null, pruned: false,
    next_expected_run_no: 1, all_results: [], window_extended: false, window_extension_ns: "0",
    ...overrides,
  };
}

const ALL_STATUSES: BetStatus[] = [
  "Open", "Taken", "Resolving", "Proposed", "Challenged", "Evidence",
  "Rejudge", "Finalized", "Settled", "Voided", "Cancelled", "Expired",
];
const TIME_SAMPLES = [0, 50 * NS, 150 * NS, 5_000 * NS, 20_000 * NS];

test("nextActionForBet never produces a signature/money-destination action, across every status x time combination", () => {
  for (const status of ALL_STATUSES) {
    for (const proposedAt of [null, 0, 50 * NS]) {
      for (const outcome of [null, "YES" as const]) {
        for (const nowNs of TIME_SAMPLES) {
          const b = bet(status, { proposed_at: proposedAt, outcome });
          const action = nextActionForBet(b, 1, nowNs);
          if (action === null) continue;
          assert.ok(
            ALLOWED_KINDS.includes(action.kind),
            `status=${status} proposed_at=${proposedAt} outcome=${outcome} now=${nowNs} produced disallowed action ${action.kind}`,
          );
          assert.ok(!FORBIDDEN_KINDS.includes(action.kind));
        }
      }
    }
  }
});
