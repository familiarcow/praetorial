import { test } from "node:test";
import assert from "node:assert/strict";
import { nextActionForBet, planActions, aiPathSkipReason } from "../src/policy.js";
import type { Bet, Envelope } from "@praetorial/common/types.js";

const NS = 1_000_000_000;

function baseEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    bet_id: 1,
    version: 1,
    maker: "maker1.testnet",
    taker_allow: { Any: {} },
    terms_hash: "a".repeat(64),
    maker_asset: "usdc.fakes.testnet", taker_asset: "usdc.fakes.testnet",
    models_snapshot_hash: "d".repeat(10),
    outcomes: ["YES", "NO"],
    maker_side: "YES",
    stake_maker: "1000000",
    stake_taker: "1000000",
    fee_bps: 100,
    storage_charge_per_side: "10000",
    keep_terms: true,
    max_paid_runs: 3,
    tier: 1,
    arbiter: null,
    funding_deadline: 100 * NS,
    early_settle_outcome: null,
    finality_delay: 0,
    settlement_period: 48 * 3600 * NS,
    resolve_deadline: 10_000 * NS,
    consent_party_controlled: false,
    ...overrides,
  };
}

function baseBet(overrides: Partial<Bet> = {}): Bet {
  return {
    envelope: baseEnvelope(overrides.envelope as any),
    status: "Open",
    taker: null,
    created_at: 0,
    taken_at: null,
    proposed_at: null,
    outcome: null,
    used_run_nos: [],
    runs_used: 0,
    bonds: [],
    pre_challenge_outcome: null,
    challenged_by: null,
    exhibits: [],
    rebuttals: [],
    objection_deposits: [],
    arbiter_submissions: [],
    amend_count: 0,
    pending_resolution_request: null,
    last_resolution_raw: null,
    pruned: false,
    next_expected_run_no: 1, all_results: [], window_extended: false, window_extension_ns: "0",
    ...overrides,
  };
}

test("Open bet past funding_deadline -> expire", () => {
  const bet = baseBet({ status: "Open" });
  const action = nextActionForBet(bet, 1, 101 * NS);
  assert.deepEqual(action, { kind: "expire", bet_id: 1 });
});

test("Open bet before funding_deadline -> no action", () => {
  const bet = baseBet({ status: "Open" });
  assert.equal(nextActionForBet(bet, 1, 50 * NS), null);
});

test("Taken bet past funding_deadline, no pending request -> request_resolution", () => {
  const bet = baseBet({ status: "Taken", taker: "taker1.testnet" });
  const action = nextActionForBet(bet, 2, 150 * NS);
  assert.deepEqual(action, { kind: "request_resolution", bet_id: 2 });
});

// RF2c / D-REFUI4: a bet with a referee is decided by a person (referee_rule); the escrow refuses
// request_resolution on it, so the keeper/AI path must never fire it, with a named skip reason.
test("RF2c: Taken referee bet past funding_deadline -> never request_resolution (referee_bet_human_only)", () => {
  const bet = baseBet({
    status: "Taken", taker: "taker1.testnet",
    envelope: baseEnvelope({ referee: { account: "ref.testnet", mode: "Human" } }),
  });
  assert.equal(nextActionForBet(bet, 2, 150 * NS), null);
  assert.equal(aiPathSkipReason(bet), "referee_bet_human_only");
  assert.equal(aiPathSkipReason(baseBet({ status: "Taken", taker: "taker1.testnet" })), null);
});

test("RF2c: referee bet still gets the permissionless void_after_deadline (silent referee) and expire", () => {
  const taken = baseBet({
    status: "Taken", taker: "taker1.testnet",
    envelope: baseEnvelope({ referee: { account: "ref.testnet", mode: "Human" } }),
  });
  assert.deepEqual(nextActionForBet(taken, 2, 20_000 * NS), { kind: "void_after_deadline", bet_id: 2 });
  const open = baseBet({ status: "Open", envelope: baseEnvelope({ referee: { account: "ref.testnet", mode: "Human" } }) });
  assert.deepEqual(nextActionForBet(open, 1, 101 * NS), { kind: "expire", bet_id: 1 });
});

test("Taken bet with a pending resolution request -> no duplicate call", () => {
  const bet = baseBet({ status: "Taken", taker: "taker1.testnet", pending_resolution_request: 7 });
  assert.equal(nextActionForBet(bet, 2, 150 * NS), null);
});

test("Taken bet past resolve_deadline with no outcome -> void_after_deadline, not request_resolution", () => {
  const bet = baseBet({ status: "Taken", taker: "taker1.testnet" });
  const action = nextActionForBet(bet, 2, 20_000 * NS);
  assert.deepEqual(action, { kind: "void_after_deadline", bet_id: 2 });
});

test("Proposed bet, settlement_period elapsed -> finalize", () => {
  const bet = baseBet({
    status: "Proposed",
    taker: "taker1.testnet",
    outcome: "YES",
    proposed_at: 200 * NS,
    envelope: baseEnvelope({ settlement_period: 100 * NS }),
  });
  const action = nextActionForBet(bet, 3, 301 * NS);
  assert.deepEqual(action, { kind: "finalize", bet_id: 3 });
});

test("Proposed bet, settlement_period not yet elapsed -> no action", () => {
  const bet = baseBet({
    status: "Proposed",
    taker: "taker1.testnet",
    outcome: "YES",
    proposed_at: 200 * NS,
    envelope: baseEnvelope({ settlement_period: 100 * NS }),
  });
  assert.equal(nextActionForBet(bet, 3, 250 * NS), null);
});

test("Settled bet never gets an action (terminal)", () => {
  const bet = baseBet({ status: "Settled", outcome: "YES" });
  assert.equal(nextActionForBet(bet, 4, 1_000_000 * NS), null);
});

// item 7d3: resolver signed RETRY (next_check_ns set, pending_resolution_request
// stays non-null -- submit_outcome's RETRY branch never clears it). The keeper
// must re-request resolution once now >= next_check_ns, bypassing the normal
// "no duplicate call" gate, and must NOT re-request before it.
test("Taken bet with next_check_ns due -> re-request resolution despite pending_resolution_request", () => {
  const bet = baseBet({
    status: "Taken",
    taker: "taker1.testnet",
    pending_resolution_request: 7,
    runs_used: 1,
    next_check_ns: String(500 * NS),
  });
  const action = nextActionForBet(bet, 2, 500 * NS);
  assert.deepEqual(action, { kind: "request_resolution", bet_id: 2 });
});

test("Taken bet with next_check_ns not yet due -> no action", () => {
  const bet = baseBet({
    status: "Taken",
    taker: "taker1.testnet",
    pending_resolution_request: 7,
    runs_used: 1,
    next_check_ns: String(500 * NS),
  });
  assert.equal(nextActionForBet(bet, 2, 499 * NS), null);
});

test("Taken bet with next_check_ns due but runs exhausted -> no action", () => {
  const bet = baseBet({
    status: "Taken",
    taker: "taker1.testnet",
    pending_resolution_request: 7,
    runs_used: 3, // == max_paid_runs
    next_check_ns: String(500 * NS),
  });
  assert.equal(nextActionForBet(bet, 2, 500 * NS), null);
});

// JCB1 (D-JCB1): after RETRY:no_live_judge the contract refuses request_resolution until
// no_live_judge_until_ns (the same gate can_request_resolution reports); the keeper must not fire early.
test("JCB1: no_live_judge gate not yet open -> no request_resolution even if next_check_ns is due", () => {
  const bet = baseBet({
    status: "Taken",
    taker: "taker1.testnet",
    pending_resolution_request: null,
    next_check_ns: String(500 * NS),
    no_live_judge_until_ns: String(900 * NS),
  });
  assert.equal(nextActionForBet(bet, 2, 600 * NS), null);
  assert.equal(nextActionForBet(bet, 2, 899 * NS), null);
});

test("JCB1: no_live_judge gate open -> request_resolution again", () => {
  const bet = baseBet({
    status: "Taken",
    taker: "taker1.testnet",
    pending_resolution_request: null,
    next_check_ns: String(500 * NS),
    no_live_judge_until_ns: String(900 * NS),
  });
  assert.deepEqual(nextActionForBet(bet, 2, 900 * NS), { kind: "request_resolution", bet_id: 2 });
});

test("JCB1: a cleared gate (null) does not block", () => {
  const bet = baseBet({
    status: "Taken",
    taker: "taker1.testnet",
    pending_resolution_request: 7,
    runs_used: 1,
    next_check_ns: String(500 * NS),
    no_live_judge_until_ns: null,
  });
  assert.deepEqual(nextActionForBet(bet, 2, 500 * NS), { kind: "request_resolution", bet_id: 2 });
});

test("planActions aggregates across bets + pending payouts", () => {
  const bets = new Map<number, Bet>([
    [1, baseBet({ status: "Open" })],
    [2, baseBet({ status: "Taken", taker: "t.testnet" })],
  ]);
  const actions = planActions(bets, 150 * NS, [42]);
  assert.equal(actions.length, 3);
  assert.ok(actions.some((a) => a.kind === "expire" && a.bet_id === 1));
  assert.ok(actions.some((a) => a.kind === "request_resolution" && a.bet_id === 2));
  assert.ok(actions.some((a) => a.kind === "drain_payouts" && a.bet_id === 42));
});

// C1 / D-CONCEDE1: concede is a party-only action -- the keeper never
// concedes, and tolerates a conceded bet (Finalized, outcome = the
// counterparty's side, bonds already refunded) without voiding,
// re-finalizing or re-requesting resolution.
test("C1: keeper never proposes a concede, in any status", () => {
  const statuses = ["Open", "Taken", "Resolving", "Proposed", "Challenged", "Evidence", "Rejudge", "Finalized", "Settled", "Voided", "Cancelled", "Expired"];
  for (const status of statuses) {
    for (const nowNs of [0, 150 * NS, 20_000 * NS, 500_000 * NS]) {
      const a = nextActionForBet(baseBet({ status: status as any, taker: "taker1.testnet" }), 1, nowNs);
      assert.notEqual((a as any)?.kind, "concede", `${status}@${nowNs}`);
    }
  }
});

test("C1: a conceded bet (Finalized with an outcome, past every deadline) gets no keeper action", () => {
  const bet = baseBet({ status: "Finalized" as any, taker: "taker1.testnet", outcome: "NO" as any });
  assert.equal(nextActionForBet(bet, 1, 500_000 * NS), null);
});

// KEEPLIVE1 (live, frz3 bet 14, 2026-11-10): the chain's get_bet returns `next_check_ns: null` (not absent) for a bet that
// never got a RETRY. The keeper treated null as "RETRY set, due at 0" and fired request_resolution right after the take,
// 6.5 min before funding_deadline (tx 4L29vn7D7wriwao8DKDBJ1gZpyNxBgApw2X7g5PuUoyp, "too early to request resolution"),
// bypassing the funding_deadline / LH5 not-before / pending-request gates (and feeding the MON4 OutLayer-unhealthy alarm).
test("KEEPLIVE1: Taken bet with next_check_ns null (chain shape) before funding_deadline -> no request_resolution", () => {
  const bet = baseBet({ status: "Taken", taker: "taker1.testnet", next_check_ns: null as any, no_live_judge_until_ns: null as any });
  assert.equal(nextActionForBet(bet, 14, 50 * NS), null);
});

test("KEEPLIVE1: Taken bet with next_check_ns null after funding_deadline -> request_resolution (normal path)", () => {
  const bet = baseBet({ status: "Taken", taker: "taker1.testnet", next_check_ns: null as any, no_live_judge_until_ns: null as any });
  assert.deepEqual(nextActionForBet(bet, 14, 100 * NS), { kind: "request_resolution", bet_id: 14 });
});

test("KEEPLIVE1: next_check_ns null with a request already pending -> no duplicate request_resolution", () => {
  const bet = baseBet({ status: "Taken", taker: "taker1.testnet", pending_resolution_request: 3, next_check_ns: null as any, no_live_judge_until_ns: null as any });
  assert.equal(nextActionForBet(bet, 14, 200 * NS), null);
});
