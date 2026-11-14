import { test } from "node:test";
import assert from "node:assert/strict";
import { computeNotices } from "../src/notifier.js";
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

test("proposed bet emits a proposed notice once, not twice", () => {
  const bets = new Map<number, Bet>([[1, bet({})]]);
  const seen = new Set<string>();
  const first = computeNotices(bets, 1 * NS, seen);
  const second = computeNotices(bets, 2 * NS, seen);
  assert.equal(first.filter((n) => n.kind === "proposed").length, 1);
  assert.equal(second.filter((n) => n.kind === "proposed").length, 0);
});

test("closing-soon notice fires only inside the 6h window before settlement end", () => {
  const settlementPeriod = 48 * 3600 * NS; // 48h, matches contract default
  const bets = new Map<number, Bet>([
    [1, bet({ proposed_at: 0, envelope: { ...bet({}).envelope, settlement_period: settlementPeriod } })],
  ]);
  // Far before the window end (now=0, 48h left): no closing notice yet.
  const early = computeNotices(bets, 0, new Set());
  assert.equal(early.filter((n) => n.kind === "challenge_window_closing").length, 0);

  // Inside the last 6h before settlement_period elapses: fires.
  const late = computeNotices(bets, settlementPeriod - 1 * 3600 * NS, new Set());
  assert.equal(late.filter((n) => n.kind === "challenge_window_closing").length, 1);
});

test("settled bet always gets a settled notice, independent of proposed history", () => {
  const bets = new Map<number, Bet>([[1, bet({ status: "Settled" })]]);
  const seen = new Set<string>();
  const notices = computeNotices(bets, 100 * NS, seen);
  assert.ok(notices.some((n) => n.kind === "settled" && n.bet_id === 1));
});

test("notices include both maker and taker as recipients", () => {
  const bets = new Map<number, Bet>([[1, bet({})]]);
  const notices = computeNotices(bets, 1 * NS, new Set());
  const proposed = notices.find((n) => n.kind === "proposed")!;
  assert.deepEqual(proposed.to_accounts.sort(), ["maker1.testnet", "taker1.testnet"]);
});
