// Unit tests for the invariant monitor (I-1, I-2, I-4, I-5) against
// fabricated chain-state fixtures. Written against escrow contract spec
// v1 "Invariants (tested on every path)" (I-1/I-2/I-4/I-5 lines).
// RED was recorded by running this file before invariants.ts existed:
// `node --import tsx --test monitor/test/invariants.test.ts` failed with
// "Cannot find module '../src/invariants.js'". GREEN below.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkI1,
  checkI2PerBet,
  checkI2ContractWide,
  checkI4,
  checkI5,
  checkI7,
  runMonitor,
  type Actors,
} from "../src/invariants.js";
import type { Bet, PendingPayout } from "@praetorial/common/types.js";

function bet(p: Partial<Bet>): Bet {
  return {
    envelope: { bet_id: 1 } as Bet["envelope"],
    status: "Proposed",
    taker: "taker1.testnet",
    created_at: 0,
    taken_at: 0,
    proposed_at: 0,
    outcome: "YES",
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
    next_expected_run_no: 1,
    all_results: [],
    window_extended: false,
    window_extension_ns: "0",
    ...p,
  };
}

const actors: Actors = {
  maker: "maker1.testnet",
  taker: "taker1.testnet",
  feeAccount: "fees.praetorial-dev-1101.testnet",
  keeper: "keeper.praetorial-dev-1101.testnet",
};

function payout(p: Partial<PendingPayout>): PendingPayout {
  return {
    id: 1,
    bet_id: 1,
    token_id: "usdc.testnet",
    receiver: actors.maker,
    amount: "100",
    reason: "winner",
    attempts: 0,
    done: true,
    in_flight: false,
    ...p,
  };
}

// ---------------------------- I-1 ----------------------------
test("I-1: all payouts to maker/taker/fee/keeper pass clean", () => {
  const payouts = [
    payout({ id: 1, receiver: actors.maker }),
    payout({ id: 2, receiver: actors.taker ?? "" }),
    payout({ id: 3, receiver: actors.feeAccount }),
    payout({ id: 4, receiver: actors.keeper }),
  ];
  assert.deepEqual(checkI1(payouts, actors), []);
});

test("I-1: payout to an outside account is flagged", () => {
  const payouts = [payout({ id: 5, receiver: "attacker.testnet" })];
  const violations = checkI1(payouts, actors);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].invariant, "I-1");
  assert.match(violations[0].detail, /attacker\.testnet/);
});

// Root-cause (false positive found live, 2026-11-02 arbiter_pick path,
// pre-D-REF1): contracts/escrow/src/lib.rs's arbiter_pick used to pay
// bet.envelope.arbiter_fee straight to the bet's named arbiter. D-REF1
// removed that fee payout entirely, but the monitor's allowed-set must
// still include a bet's own arbiter (when one is configured) -- the
// arbiter's ruling power is unchanged, and nothing stops a future
// payout reason from legitimately naming them. Passed in per-bet (not
// a fixed service account like fee/keeper).
test("I-1: a bet's own named arbiter is an allowed payout receiver", () => {
  const actorsWithArbiter: Actors = { ...actors, arbiter: "arbiter1.testnet" };
  const payouts = [payout({ id: 6, receiver: "arbiter1.testnet", reason: "arbiter_fee" })];
  assert.deepEqual(checkI1(payouts, actorsWithArbiter), []);
});

test("I-1: an arbiter payout is still flagged when the bet has no arbiter configured", () => {
  const payouts = [payout({ id: 7, receiver: "arbiter1.testnet", reason: "arbiter_fee" })];
  const violations = checkI1(payouts, actors); // actors.arbiter is undefined here
  assert.equal(violations.length, 1);
  assert.equal(violations[0].invariant, "I-1");
});

// ---------------------------- I-2 ----------------------------
test("I-2 per-bet: out <= in passes", () => {
  const payouts = [payout({ bet_id: 7, amount: "900", done: true })];
  const fundsIn = new Map([[7, 1000n]]);
  assert.deepEqual(checkI2PerBet(payouts, fundsIn), []);
});

test("I-2 per-bet: out > in is flagged", () => {
  const payouts = [
    payout({ id: 1, bet_id: 7, amount: "600", done: true }),
    payout({ id: 2, bet_id: 7, amount: "600", done: true }),
  ];
  const fundsIn = new Map([[7, 1000n]]);
  const violations = checkI2PerBet(payouts, fundsIn);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].invariant, "I-2");
});

test("I-2 per-bet: pending (not done) payouts don't count as out yet", () => {
  const payouts = [payout({ bet_id: 7, amount: "1500", done: false })];
  const fundsIn = new Map([[7, 1000n]]);
  assert.deepEqual(checkI2PerBet(payouts, fundsIn), []);
});

test("I-2 contract-wide: tracked == actual passes", () => {
  assert.deepEqual(checkI2ContractWide(5000n, 5000n), []);
});

test("I-2 contract-wide: mismatch is flagged (money leaked)", () => {
  const violations = checkI2ContractWide(5000n, 4000n);
  assert.equal(violations.length, 1);
  assert.match(violations[0].detail, /tracked=5000.*4000/);
});

// ---------------------------- I-4 ----------------------------
test("I-4: clean payout set (each logical payout done once) passes", () => {
  const payouts = [
    payout({ id: 1, bet_id: 1, receiver: actors.maker, reason: "winner", done: true }),
    payout({ id: 2, bet_id: 1, receiver: actors.feeAccount, reason: "fee", done: true }),
  ];
  assert.deepEqual(checkI4(payouts), []);
});

// MON2: two DISTINCT payout ids with the same bet/receiver/reason are the
// normal same-asset finalize shape (one row per side's stake), so row
// equality is no longer a violation. The real double-pay signal here is
// done+pending winner rows whose sum exceeds the pot (cap).
test("I-4: done+pending winner rows summing over the pot are flagged (MON2)", () => {
  const payouts = [
    payout({ id: 1, bet_id: 1, receiver: actors.maker, reason: "payout_winner", amount: "600", done: true }),
    payout({ id: 2, bet_id: 1, receiver: actors.maker, reason: "payout_winner", amount: "600", done: false }),
  ];
  const violations = checkI4(payouts, { potByBet: new Map([[1, new Map([["usdc.testnet", 1000n]])]]) });
  assert.equal(violations.length, 1);
  assert.match(violations[0].detail, /exceeds/);
});

// MON2: real same-asset finalize ledger: two rows (maker stake + taker
// stake) summing to pot minus fee must NOT flag, including while one row
// is still pending.
test("I-4: same-asset finalize (two identical winner rows) is clean (MON2)", () => {
  const pot = { potByBet: new Map([[1, new Map([["usdc.testnet", 1000n]])]]) };
  const rows = (d2: boolean) => [
    payout({ id: 1, bet_id: 1, receiver: actors.maker, reason: "payout_winner", amount: "495", done: true }),
    payout({ id: 2, bet_id: 1, receiver: actors.maker, reason: "payout_winner", amount: "495", done: d2 }),
    payout({ id: 3, bet_id: 1, receiver: actors.feeAccount, reason: "fee_and_storage", amount: "10", done: true }),
  ];
  assert.deepEqual(checkI4(rows(true), pot), []);
  assert.deepEqual(checkI4(rows(false), pot), []);
  assert.deepEqual(checkI4(rows(true)), []); // no pot data: still clean
});

test("I-4: same payout id marked done twice is flagged (MON2)", () => {
  const payouts = [
    payout({ id: 5, bet_id: 1, receiver: actors.maker, reason: "payout_winner", done: true }),
    payout({ id: 5, bet_id: 1, receiver: actors.maker, reason: "payout_winner", done: true }),
  ];
  assert.ok(checkI4(payouts).some((v) => /id=5.*more than once/.test(v.detail)));
});

test("I-4: more than 2 payout_winner rows for a bet is flagged (MON2)", () => {
  const payouts = [1, 2, 3].map((id) =>
    payout({ id, bet_id: 1, receiver: actors.maker, reason: "payout_winner", amount: "10", done: id === 1 }),
  );
  assert.ok(checkI4(payouts).some((v) => /3 payout_winner rows/.test(v.detail)));
});

test("I-4: concede refund rows (multiple per receiver) are clean (MON2)", () => {
  const payouts = [
    payout({ id: 1, bet_id: 1, receiver: actors.maker, reason: "concede_bond_refund", amount: "50", done: true }),
    payout({ id: 2, bet_id: 1, receiver: actors.maker, reason: "concede_bond_refund", amount: "50", done: false }),
    payout({ id: 3, bet_id: 1, receiver: actors.maker, reason: "concede_objection_refund", amount: "5", done: true }),
  ];
  assert.deepEqual(checkI4(payouts), []);
});

test("I-4: payout flipping from done back to pending is flagged", () => {
  const payouts = [
    payout({ id: 9, bet_id: 1, receiver: actors.maker, reason: "winner", done: true }),
    payout({ id: 9, bet_id: 1, receiver: actors.maker, reason: "winner", done: false }),
  ];
  const violations = checkI4(payouts);
  assert.ok(violations.some((v) => /impossible transition/.test(v.detail)));
});

// ---------------------------- I-5 ----------------------------
test("I-5: not paused -> nothing to check", () => {
  assert.deepEqual(checkI5("open", false, false), []);
});

test("I-5: paused correctly blocks open", () => {
  assert.deepEqual(checkI5("open", true, true), []);
});

test("I-5: paused correctly blocks take", () => {
  assert.deepEqual(checkI5("take", true, true), []);
});

test("I-5: paused but open NOT blocked is a violation", () => {
  const violations = checkI5("open", true, false);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].invariant, "I-5");
});

test("I-5: paused must not block finalize", () => {
  assert.deepEqual(checkI5("finalize", true, false), []);
});

test("I-5: paused must not block challenge/resolve/refund-ish actions", () => {
  for (const action of ["request_resolution", "challenge", "object", "rebut", "arbiter_pick", "cancel", "expire", "reclaim", "void_after_deadline", "retry_payout", "prune_terms", "amend", "submit_outcome"] as const) {
    assert.deepEqual(checkI5(action, true, false), [], `${action} must not be pause-blocked`);
  }
});

test("I-5: paused incorrectly blocking finalize is flagged", () => {
  const violations = checkI5("finalize", true, true);
  assert.equal(violations.length, 1);
  assert.match(violations[0].detail, /incorrectly blocked finalize/);
});

// ---------------------------- runMonitor (integration of all 4) ----------------------------
test("runMonitor: a fully clean post-finalize snapshot reports ok", () => {
  const result = runMonitor({
    betId: 42,
    paused: false,
    actors,
    payouts: [
      payout({ id: 1, bet_id: 42, receiver: actors.maker, reason: "winner", amount: "1900000", done: true }),
      payout({ id: 2, bet_id: 42, receiver: actors.feeAccount, reason: "fee", amount: "20000", done: true }),
    ],
    fundsIn: 2000000n,
    trackedTotalYocto: 80000n,
    actualIntentsBalanceYocto: 80000n,
    action: "finalize",
    actionWasBlocked: false,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test("runMonitor: catches an out-of-set payout plus a per-bet overpay simultaneously", () => {
  const result = runMonitor({
    betId: 42,
    paused: false,
    actors,
    payouts: [
      payout({ id: 1, bet_id: 42, receiver: "attacker.testnet", reason: "winner", amount: "1900000", done: true }),
      payout({ id: 2, bet_id: 42, receiver: actors.feeAccount, reason: "fee", amount: "200000", done: true }),
    ],
    fundsIn: 2000000n,
    trackedTotalYocto: 80000n,
    actualIntentsBalanceYocto: 80000n,
    action: "finalize",
    actionWasBlocked: false,
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.invariant === "I-1"));
  assert.ok(result.violations.some((v) => v.invariant === "I-2"));
});

test("runMonitor: catches a pause violation on top of clean money", () => {
  const result = runMonitor({
    betId: 42,
    paused: true,
    actors,
    payouts: [],
    fundsIn: 2000000n,
    trackedTotalYocto: 2000000n,
    actualIntentsBalanceYocto: 2000000n,
    action: "finalize",
    actionWasBlocked: true, // wrongly blocked
  });
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].invariant, "I-5");
});

// ---------------- I-7 (v1.1, FM-13: no result shopping) ----------------

test("I-7: clean single-round bet (run 1 only) passes", () => {
  assert.deepEqual(
    checkI7(
      bet({
        used_run_nos: [1],
        next_expected_run_no: 2,
        all_results: [{ run_no: 1, outcome: "YES", element_results_hash: "e".repeat(64), checked_until: "1" }],
      }),
    ),
    [],
  );
});

test("I-7: clean two-round bet (challenge re-judge) passes", () => {
  assert.deepEqual(
    checkI7(
      bet({
        used_run_nos: [1, 2],
        next_expected_run_no: 3,
        all_results: [
          { run_no: 1, outcome: "NO", element_results_hash: "e".repeat(64), checked_until: "1" },
          { run_no: 2, outcome: "YES", element_results_hash: "f".repeat(64), checked_until: "2" },
        ],
      }),
    ),
    [],
  );
});

test("I-7: a gap/skip-ahead in used_run_nos is flagged", () => {
  // Should never happen if the contract's own guard holds, but if it
  // ever did (regression), this must be caught, not silently accepted.
  const violations = checkI7(
    bet({
      used_run_nos: [1, 3], // skipped run 2
      next_expected_run_no: 4,
      all_results: [
        { run_no: 1, outcome: "NO", element_results_hash: "e".repeat(64), checked_until: "1" },
        { run_no: 3, outcome: "YES", element_results_hash: "f".repeat(64), checked_until: "2" },
      ],
    }),
  );
  assert.ok(violations.some((v) => v.invariant === "I-7" && v.detail.includes("gap or skip-ahead")));
});

test("I-7: next_expected_run_no trailing behind used_run_nos is flagged", () => {
  const violations = checkI7(
    bet({
      used_run_nos: [1],
      next_expected_run_no: 1, // should be 2
      all_results: [{ run_no: 1, outcome: "YES", element_results_hash: "e".repeat(64), checked_until: "1" }],
    }),
  );
  assert.ok(violations.some((v) => v.invariant === "I-7" && v.detail.includes("next_expected_run_no=1")));
});

test("I-7: missing a recorded result for a used run_no is flagged (every run must be recorded)", () => {
  const violations = checkI7(
    bet({
      used_run_nos: [1, 2],
      next_expected_run_no: 3,
      all_results: [{ run_no: 1, outcome: "NO", element_results_hash: "e".repeat(64), checked_until: "1" }], // run 2's result missing
    }),
  );
  assert.ok(violations.some((v) => v.invariant === "I-7" && v.detail.includes("all_results run_nos")));
});

test("runMonitor includes I-7 checks when a bet is supplied", () => {
  const result = runMonitor({
    betId: 1,
    paused: false,
    actors,
    payouts: [],
    fundsIn: 0n,
    trackedTotalYocto: 0n,
    actualIntentsBalanceYocto: 0n,
    bet: bet({ used_run_nos: [2], next_expected_run_no: 3, all_results: [{ run_no: 2, outcome: "YES", element_results_hash: "e".repeat(64), checked_until: "1" }] }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.invariant === "I-7"));
});

// 17e: D-SETTLE3 removed mutual_settle
test("no mutual_settle lifecycle action or MUTUAL outcome remains in the monitor/common sources (D-SETTLE3)", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["../src/invariants.ts", "../src/snapshot.ts", "../../common/src/nearClient.ts", "../../common/src/types.ts", "../../relayer/src/policy.ts"]) {
    const txt = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.ok(!/mutual_settle|MUTUAL/.test(txt), `${f} still references mutual_settle/MUTUAL`);
  }
});

// ---------------------------- C1 concede (D-CONCEDE1) ----------------------------
test("C1: a conceded bet (bond+objection refunded, pot-minus-fee to counterparty) satisfies I-1/I-2/I-4", () => {
  const result = runMonitor({
    betId: 9,
    paused: false,
    actors,
    payouts: [
      payout({ id: 1, bet_id: 9, receiver: actors.taker!, reason: "concede_bond_refund", amount: "5005000", done: true }),
      payout({ id: 2, bet_id: 9, receiver: actors.taker!, reason: "concede_objection_refund", amount: "1000000", done: true }),
      payout({ id: 3, bet_id: 9, receiver: actors.taker!, reason: "payout_winner", amount: "1980000", done: true }),
      payout({ id: 5, bet_id: 9, receiver: actors.feeAccount, reason: "fee_and_storage", amount: "40000", done: true }),
    ],
    fundsIn: 2_000_000n + 20_000n + 5_005_000n + 1_000_000n,
    trackedTotalYocto: 0n,
    actualIntentsBalanceYocto: 0n,
    action: "concede",
    actionWasBlocked: false,
  });
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
});

test("C1: I-5 -- pause must not block concede (it only blocks open/take)", () => {
  assert.deepEqual(checkI5("concede", true, false), []);
  const v = checkI5("concede", true, true);
  assert.equal(v.length, 1);
  assert.match(v[0].detail, /incorrectly blocked concede/);
});

test("C1: a conceded bet whose payouts exceed funds-in is still an I-2 violation", () => {
  const result = runMonitor({
    betId: 9,
    paused: false,
    actors,
    payouts: [payout({ id: 1, bet_id: 9, receiver: actors.taker!, reason: "payout_winner", amount: "3000000", done: true })],
    fundsIn: 2_020_000n,
    trackedTotalYocto: 0n,
    actualIntentsBalanceYocto: 0n,
    action: "concede",
  });
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].invariant, "I-2");
});
