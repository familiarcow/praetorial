// SM2 gap B1-6: with no challenge, the contract's challenge window is min(settlement_period, 24h) but finalize waits the FULL
// settlement_period (lib.rs; betLifecycle.finalizeNotBeforeNs). In between, nobody can challenge and nobody can finalize yet, so the
// page must not say "Final" / "Paying out shortly": it says when the ruling becomes final.
import test from "node:test";
import assert from "node:assert/strict";
import { betView } from "../lib/betView";
import { finalizeNotBeforeNs, finalizeRefusal } from "../lib/betLifecycle";
import { fixtureByKey, NAMES, DAY, HOUR } from "./fixtures/bets";

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const CONTRACT = "bets.praetorial.near";

/** The ruling-final fixture (proposed 2 days ago) with a 3-day settlement period: challenges closed, finalize not open yet. */
function longSettlement() {
  const f = fixtureByKey(NOW, "ruling-final");
  const bet = { ...f.bet, envelope: { ...f.bet.envelope, settlement_period: 3 * DAY * 1e6 } } as unknown as typeof f.bet;
  return { f, bet };
}

test("B1-6: challenge window over but settlement_period not elapsed: not 'Final', says when it becomes final, no Finalize", () => {
  const { f, bet } = longSettlement();
  assert.equal(finalizeRefusal(bet, NOW), "settlement_period not elapsed");
  const v = betView(bet, f.me, NOW, { names: NAMES, pending: [], contractId: CONTRACT });
  assert.notEqual(v.pill.id, "final");
  assert.doesNotMatch(v.sentence, /Paying out shortly/);
  assert.match(v.sentence, /can't be challenged any more/i);
  const at = Math.floor(finalizeNotBeforeNs(bet)! / 1e6);
  assert.deepEqual(v.next && { at: v.next.at, label: v.next.label }, { at, label: "Final" });
  assert.equal(v.primary, null);
  assert.ok(!v.secondary.some((a) => a.id === "challenge" || a.id === "finalize"));
});

test("B1-6: once settlement_period has elapsed it is 'Final' and Finalize is offered", () => {
  const { f, bet } = longSettlement();
  const later = NOW + DAY + HOUR;
  assert.equal(finalizeRefusal(bet, later), null);
  const v = betView(bet, f.me, later, { names: NAMES, pending: [], contractId: CONTRACT });
  assert.equal(v.pill.id, "final");
  assert.equal(v.sentence, "The ruling stands. Paying out shortly.");
  assert.equal(v.primary?.id, "finalize");
});

test("B1-6: the normal 1-day settlement is unchanged (window closed = Final + Finalize)", () => {
  const f = fixtureByKey(NOW, "ruling-final");
  const v = betView(f.bet, f.me, NOW, { names: NAMES, pending: [], contractId: CONTRACT });
  assert.equal(v.pill.id, "final");
  assert.equal(v.primary?.id, "finalize");
});
