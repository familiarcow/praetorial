// MON3: per-reason row caps for I-4. A duplicate NON-winner payout row
// (same bet + receiver + token + reason, more rows than the contract can
// schedule) must flag I-4, while legit multi-row ledgers stay clean.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkI4, runMonitor, REASON_ROW_CAPS, type Actors } from "../src/invariants.js";
import type { Bet, PendingPayout } from "@praetorial/common/types.js";

const actors: Actors = {
  maker: "maker1.testnet",
  taker: "taker1.testnet",
  feeAccount: "fee.testnet",
  keeper: "keeper.testnet",
};

let nextId = 1;
function row(p: Partial<PendingPayout>): PendingPayout {
  return {
    id: nextId++,
    bet_id: 1,
    token_id: "usdc.testnet",
    receiver: actors.maker,
    amount: "10",
    reason: "void_refund_maker",
    attempts: 0,
    done: true,
    in_flight: false,
    ...p,
  };
}
const rows = (n: number, p: Partial<PendingPayout>) => Array.from({ length: n }, (_, i) => row({ ...p, done: i % 2 === 0 }));
const flagged = (v: { detail: string }[], re: RegExp) => v.some((x) => re.test(x.detail));

test("MON3: duplicate void_refund_maker row (cap 1) is flagged", () => {
  const v = checkI4(rows(2, { reason: "void_refund_maker" }));
  assert.ok(flagged(v, /void_refund_maker.*2 rows.*at most 1/), JSON.stringify(v));
  assert.ok(v.every((x) => x.invariant === "I-4"));
});

test("MON3: one row per refund reason is clean, incl. maker refund + taker refund to the same account", () => {
  const same = actors.maker;
  const ledger = [
    row({ reason: "void_refund_maker", receiver: same }),
    row({ reason: "void_refund_taker", receiver: same }),
    row({ reason: "void_storage_refund_maker", receiver: same }),
    row({ reason: "void_storage_refund_taker", receiver: same }),
    row({ reason: "void_deadline_maker", receiver: same }),
    row({ reason: "void_deadline_taker", receiver: same }),
    row({ reason: "cancel_expire_refund", receiver: same }),
    row({ reason: "emergency_refund_maker", receiver: same }),
    row({ reason: "emergency_refund_taker", receiver: same }),
  ];
  assert.deepEqual(checkI4(ledger), []);
});

test("MON3: each single-row refund reason flags on a duplicate", () => {
  for (const reason of [
    "void_refund_taker", "void_storage_refund_maker", "void_storage_refund_taker",
    "void_deadline_maker", "void_deadline_taker", "cancel_expire_refund",
    "emergency_refund_maker", "emergency_refund_taker",
  ]) {
    const v = checkI4(rows(2, { reason }));
    assert.ok(flagged(v, new RegExp(`${reason}.*2 rows`)), reason);
  }
});

test("MON3: fee_and_storage: 2 rows same token (maker+taker fee) clean, 3 flagged, 2 tokens x1 clean", () => {
  const f = (n: number, token = "usdc.testnet") => rows(n, { reason: "fee_and_storage", receiver: actors.feeAccount, token_id: token });
  assert.deepEqual(checkI4(f(2)), []);
  assert.ok(flagged(checkI4(f(3)), /fee_and_storage.*3 rows.*at most 2/));
  assert.deepEqual(checkI4([...f(1), ...f(1, "btc.testnet")]), []);
});

test("MON3: void_storage_keep_terms: 1 per token; duplicate in one token flagged, one per token clean", () => {
  const k = (n: number, token = "usdc.testnet") => rows(n, { reason: "void_storage_keep_terms", receiver: actors.feeAccount, token_id: token });
  assert.deepEqual(checkI4([...k(1), ...k(1, "btc.testnet")]), []);
  assert.ok(flagged(checkI4(k(2)), /void_storage_keep_terms.*2 rows.*at most 1/));
});

test("MON3: caps are per bet, per receiver and per token (no cross-grouping)", () => {
  const ledger = [
    row({ bet_id: 1, reason: "void_refund_maker" }),
    row({ bet_id: 2, reason: "void_refund_maker" }),
    row({ bet_id: 1, reason: "void_refund_maker", receiver: actors.taker! }),
    row({ bet_id: 1, reason: "void_refund_maker", token_id: "btc.testnet" }),
  ];
  assert.deepEqual(checkI4(ledger), []);
});

test("MON3: repeated snapshots of the same payout id count once", () => {
  const a = row({ id: 900, reason: "void_refund_maker", done: false });
  const b = { ...a, done: true };
  assert.deepEqual(checkI4([a, b]).filter((v) => /rows/.test(v.detail)), []);
});

test("MON3: round-keyed bond rows are bounded by the bet's bond count (roundsByBet)", () => {
  for (const reason of [
    "bond_returned_won_minus_run_cost", "bond_lost_to_counterparty", "bond_round_cost_to_keeper",
    "won_round_reimbursement", "concede_bond_refund", "emergency_refund_bond",
  ]) {
    assert.deepEqual(checkI4(rows(2, { reason }), { roundsByBet: new Map([[1, 2]]) }), [], `${reason} 2 rows / 2 rounds`);
    assert.ok(flagged(checkI4(rows(3, { reason }), { roundsByBet: new Map([[1, 2]]) }), new RegExp(`${reason}.*3 rows.*at most 2`)), reason);
    // no round data -> unknown bound -> never flag
    assert.deepEqual(checkI4(rows(5, { reason })), [], `${reason} without data`);
  }
});

test("MON3: objection rows are bounded by the bet's objection count (objectionsByBet)", () => {
  for (const reason of [
    "objection_deposit_returned", "objection_deposit_forfeited",
    "concede_objection_refund", "emergency_refund_objection",
  ]) {
    assert.deepEqual(checkI4(rows(3, { reason }), { objectionsByBet: new Map([[1, 3]]) }), [], reason);
    assert.ok(flagged(checkI4(rows(4, { reason }), { objectionsByBet: new Map([[1, 3]]) }), new RegExp(`${reason}.*4 rows.*at most 3`)), reason);
    assert.deepEqual(checkI4(rows(9, { reason })), [], `${reason} without data`);
  }
});

test("MON3: unknown / new reasons are never flagged", () => {
  assert.deepEqual(checkI4(rows(6, { reason: "some_future_reason" })), []);
  assert.deepEqual(checkI4(rows(6, { reason: "refund_extra" })), []);
});

test("MON3: MON2 payout_winner behavior unchanged (2 same-asset rows clean, 3 flagged once by the winner rule)", () => {
  const w = (n: number) => rows(n, { reason: "payout_winner" });
  assert.deepEqual(checkI4(w(2)), []);
  const v = checkI4(w(3));
  assert.equal(v.length, 1);
  assert.match(v[0].detail, /3 payout_winner rows/);
});

test("MON3: legit same-asset finalize and concede ledgers stay clean", () => {
  const finalize = [
    row({ reason: "payout_winner", receiver: actors.maker, amount: "495" }),
    row({ reason: "payout_winner", receiver: actors.maker, amount: "495", done: false }),
    row({ reason: "fee_and_storage", receiver: actors.feeAccount }),
    row({ reason: "fee_and_storage", receiver: actors.feeAccount }),
  ];
  assert.deepEqual(checkI4(finalize), []);
  const concede = [
    ...finalize,
    row({ reason: "concede_bond_refund", receiver: actors.taker! }),
    row({ reason: "concede_bond_refund", receiver: actors.taker! }),
    row({ reason: "concede_objection_refund", receiver: actors.taker! }),
  ];
  assert.deepEqual(checkI4(concede, { roundsByBet: new Map([[1, 2]]), objectionsByBet: new Map([[1, 1]]) }), []);
});

test("MON3: runMonitor derives round/objection bounds from the bet record", () => {
  const b = {
    envelope: { bet_id: 1 }, bonds: [{}, {}], objection_deposits: [{}], pruned: false,
    used_run_nos: [], next_expected_run_no: 1, all_results: [],
  } as unknown as Bet;
  const snap = (payouts: PendingPayout[]) => ({
    betId: 1, paused: false, actors, payouts, fundsIn: 10_000n,
    trackedTotalYocto: 0n, actualIntentsBalanceYocto: 0n, bet: b,
  });
  const ok = runMonitor(snap(rows(2, { reason: "concede_bond_refund", amount: "1" })));
  assert.deepEqual(ok.violations.filter((v) => v.invariant === "I-4"), []);
  const bad = runMonitor(snap(rows(3, { reason: "concede_bond_refund", amount: "1" })));
  assert.ok(bad.violations.some((v) => v.invariant === "I-4" && /concede_bond_refund/.test(v.detail)));
  const dup = runMonitor(snap(rows(2, { reason: "void_refund_maker", amount: "1" })));
  assert.ok(dup.violations.some((v) => v.invariant === "I-4"));
  // a pruned bet record carries no trustworthy counts -> bounded reasons not checked
  const pruned = runMonitor({ ...snap(rows(5, { reason: "concede_bond_refund", amount: "1" })), bet: { ...b, pruned: true, bonds: [] } as unknown as Bet });
  assert.deepEqual(pruned.violations.filter((v) => v.invariant === "I-4"), []);
});

// ---- drift guard: every reason lib.rs can schedule must be in the table ----
const LIB_RS = fileURLToPath(new URL("../../../contracts/escrow/src/lib.rs", import.meta.url));

function scheduledReasonsInLibRs(): Set<string> {
  const src = readFileSync(LIB_RS, "utf8");
  const reasons = new Set<string>();
  const callRe = /\bschedule(?:_split)?_payout\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    const args = src.slice(start, i);
    for (const lit of args.matchAll(/"([a-z][a-z0-9_]*)"\s*\.to_string\(\)/g)) reasons.add(lit[1]);
  }
  // emergency_refund builds (receiver, asset, amount, reason) tuples, then schedules in a loop.
  for (const lit of src.matchAll(/"(emergency_refund_[a-z_]+)"\.to_string\(\)/g)) reasons.add(lit[1]);
  return reasons;
}

test("MON3 drift guard: lib.rs reason literals are all in REASON_ROW_CAPS (and vice versa)", () => {
  const found = scheduledReasonsInLibRs();
  assert.ok(found.size >= 20, `expected to find the contract's reasons, found ${found.size}`);
  const missing = [...found].filter((r) => !(r in REASON_ROW_CAPS));
  assert.deepEqual(missing, [], `lib.rs schedules reason(s) missing from REASON_ROW_CAPS (add a cap + lib.rs line): ${missing.join(", ")}`);
  const stale = Object.keys(REASON_ROW_CAPS).filter((r) => !found.has(r));
  assert.deepEqual(stale, [], `REASON_ROW_CAPS has reason(s) no longer in lib.rs: ${stale.join(", ")}`);
});

test("MON3: every table entry carries a lib.rs call-site citation and a valid cap", () => {
  for (const [reason, c] of Object.entries(REASON_ROW_CAPS)) {
    assert.match(c.src, /^lib\.rs:\d+/, reason);
    assert.ok(c.cap === "per_bond" || c.cap === "per_objection" || (Number.isInteger(c.cap) && c.cap >= 1), reason);
  }
});
