import { test } from "node:test";
import assert from "node:assert/strict";
import { buildOpenOffersBoard, buildHistory } from "../src/board.js";
import type { Bet } from "@praetorial/common/types.js";

function bet(overrides: Partial<Bet>): Bet {
  return {
    envelope: {
      bet_id: 1, version: 1, maker: "maker1.testnet", taker_allow: { Any: {} },
      terms_hash: "x",
      maker_asset: "usdc.fakes.testnet", taker_asset: "usdc.fakes.testnet",
      models_snapshot_hash: "m", outcomes: ["YES", "NO"], maker_side: "YES",
      stake_maker: "100", stake_taker: "100", fee_bps: 100, storage_charge_per_side: "1", keep_terms: true, max_paid_runs: 1,
      tier: 1, arbiter: null, funding_deadline: 100, early_settle_outcome: null,
      finality_delay: 0, settlement_period: 100, resolve_deadline: 1000, consent_party_controlled: false,
    },
    status: "Open", taker: null, created_at: 0, taken_at: null, proposed_at: null,
    outcome: null, used_run_nos: [], runs_used: 0, bonds: [],
    pre_challenge_outcome: null, challenged_by: null, exhibits: [], rebuttals: [],
    objection_deposits: [], arbiter_submissions: [], amend_count: 0,
    pending_resolution_request: null, last_resolution_raw: null, pruned: false,
    next_expected_run_no: 1, all_results: [], window_extended: false, window_extension_ns: "0",
    ...overrides,
  };
}

test("board only includes Open bets", () => {
  const bets = new Map<number, Bet>([
    [1, bet({ status: "Open" })],
    [2, bet({ status: "Taken", taker: "t.testnet" })],
    [3, bet({ status: "Settled" })],
  ]);
  const board = buildOpenOffersBoard(bets);
  assert.deepEqual(board.map((o) => o.bet_id), [1]);
});

test("history filters by account when given", () => {
  const bets = new Map<number, Bet>([
    [1, bet({ status: "Open", envelope: { ...bet({}).envelope, maker: "alice.testnet" } })],
    [2, bet({ status: "Taken", taker: "bob.testnet", envelope: { ...bet({}).envelope, maker: "carol.testnet" } })],
  ]);
  const h = buildHistory(bets, "bob.testnet");
  assert.deepEqual(h.map((e) => e.bet_id), [2]);
  assert.equal(buildHistory(bets).length, 2);
});
