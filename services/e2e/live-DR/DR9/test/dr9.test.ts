// DR9 offline unit test, written BEFORE the live run: expected refunds per party for drill 4 (emergency_refund: stake + storage, no fee),
// drill verdict rules (drill 2 can never be PASS without the alert token and a confirmed delivery), pause-window rule (< 10 min, unpause verified).
import { test } from "node:test";
import assert from "node:assert/strict";
import { emergencyRefundCredits, checkRefunds, drill2Verdict, drill3Verdict, pauseWindowProblems, readmeProblems } from "../expected.js";

const bet = { maker: "m.t", taker: "t.t", stakeM: 10_000_000n, stakeT: 10_000_000n, storageM: 137_617n, storageT: 137_617n };

test("emergency_refund: each party gets exactly stake + own storage, no fee, fee account gets nothing", () => {
  const c = emergencyRefundCredits(bet, "fee.t");
  assert.equal(c.get("m.t"), 10_137_617n);
  assert.equal(c.get("t.t"), 10_137_617n);
  assert.equal(c.get("fee.t") ?? 0n, 0n);
  assert.equal([...c.values()].reduce((a, b) => a + b, 0n), 2n * 10_137_617n);
});
test("asymmetric stakes/storage are refunded per party, not averaged", () => {
  const c = emergencyRefundCredits({ ...bet, stakeT: 7_000_000n, storageT: 99n }, "fee.t");
  assert.equal(c.get("m.t"), 10_137_617n);
  assert.equal(c.get("t.t"), 7_000_099n);
});
test("a bet with no taker refunds only the maker", () => {
  const c = emergencyRefundCredits({ ...bet, taker: null }, "fee.t");
  assert.equal(c.has("t.t"), false);
  assert.equal(c.get("m.t"), 10_137_617n);
});
test("checkRefunds: exact match passes; any wei off, a fee skim, or escrow residue fails", () => {
  const ok = { "m.t": 10_137_617n, "t.t": 10_137_617n, "fee.t": 0n };
  assert.deepEqual(checkRefunds(bet, "fee.t", ok, 0n), []);
  assert.equal(checkRefunds(bet, "fee.t", { ...ok, "m.t": 10_137_616n }, 0n).length, 1);
  assert.equal(checkRefunds(bet, "fee.t", { ...ok, "fee.t": 5n }, 0n).length, 1);
  assert.equal(checkRefunds(bet, "fee.t", ok, 1n).length, 1);
});
test("drill 2 is NOT-DRILLED without the alert bot token, whatever else is true; PASS only with token AND confirmed delivery", () => {
  assert.equal(drill2Verdict({ tokenPresent: false, alertGeneratedOffline: true, delivered: true }).verdict, "NOT-DRILLED");
  assert.match(drill2Verdict({ tokenPresent: false, alertGeneratedOffline: true, delivered: false }).reason ?? "", /ALERT_TELEGRAM_BOT_TOKEN/);
  assert.equal(drill2Verdict({ tokenPresent: true, alertGeneratedOffline: true, delivered: false }).verdict, "FAIL");
  assert.equal(drill2Verdict({ tokenPresent: true, alertGeneratedOffline: true, delivered: true }).verdict, "PASS");
});
test("drill 3 verdict: NOT-DRILLED needs a reason, never PASS without retry/drain tx evidence", () => {
  assert.equal(drill3Verdict({ causedDelay: false, txs: [] }).verdict, "NOT-DRILLED");
  assert.equal(drill3Verdict({ causedDelay: true, txs: [] }).verdict, "FAIL");
  assert.equal(drill3Verdict({ causedDelay: true, txs: ["abc"] }).verdict, "PASS");
});
test("pause window: must be < 10 min, unpause must be verified by view and the tx recorded", () => {
  const t0 = 1_000_000;
  assert.deepEqual(pauseWindowProblems({ pausedAtMs: t0, unpausedAtMs: t0 + 9 * 60_000, pausedAfterUnpause: false, pauseTx: "a", unpauseTx: "b" }), []);
  assert.equal(pauseWindowProblems({ pausedAtMs: t0, unpausedAtMs: t0 + 11 * 60_000, pausedAfterUnpause: false, pauseTx: "a", unpauseTx: "b" }).length, 1);
  assert.equal(pauseWindowProblems({ pausedAtMs: t0, unpausedAtMs: t0 + 1000, pausedAfterUnpause: true, pauseTx: "a", unpauseTx: "b" }).length, 1);
  assert.equal(pauseWindowProblems({ pausedAtMs: t0, unpausedAtMs: t0 + 1000, pausedAfterUnpause: false, pauseTx: "a", unpauseTx: "" }).length, 1);
});
test("README rule: every drill line is PASS or NOT-DRILLED(reason); a PASS needs a tx hash unless drill 2/3 NOT-DRILLED", () => {
  const good = "Drill 1: PASS tx 4abc\nDrill 2: NOT-DRILLED (missing ALERT_TELEGRAM_BOT_TOKEN)\nDrill 3: NOT-DRILLED (reason)\nDrill 4: PASS tx 5def";
  assert.deepEqual(readmeProblems(good), []);
  assert.ok(readmeProblems("Drill 1: PASS\nDrill 2: PASS tx x\nDrill 3: NOT-DRILLED (r)\nDrill 4: PASS tx y").length >= 1);
  assert.ok(readmeProblems("Drill 1: PASS tx a\nDrill 2: NOT-DRILLED\nDrill 3: NOT-DRILLED (r)\nDrill 4: PASS tx y").length >= 1);
});

import { readFileSync } from "node:fs";
test("the committed README drill lines obey the README rule (PASS needs tx, NOT-DRILLED needs a reason, drill 2 never PASS without the token)", () => {
  const t = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.deepEqual(readmeProblems(t), []);
  assert.match(t, /Drill 2: NOT-DRILLED \(missing ALERT_TELEGRAM_BOT_TOKEN/);
  assert.match(t, /ACTION NEEDED: alert bot token/);
});
