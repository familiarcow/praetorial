// B1 (keep LIFE1's concede path): the contract lets a bettor concede while the AI is deciding (Resolving; escrowAdapter
// CONCEDABLE_STATUSES / canConcede). betView must offer it in the "judging" phase too, not only stuck/live/ruling.
import test from "node:test";
import assert from "node:assert/strict";
import { betView } from "../lib/betView";
import { canConcede } from "../lib/escrowAdapter";
import { fixtureByKey, NAMES } from "./fixtures/bets";

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

test("B1: a bettor can concede while the AI is deciding (judging), as the contract allows", () => {
  const f = fixtureByKey(NOW, "judging");
  assert.ok(canConcede(f.bet, f.me, false));
  const v = betView(f.bet, f.me, NOW, { names: NAMES, pending: [], contractId: "bets.praetorial.near" });
  assert.equal(v.phase, "judging");
  assert.ok(v.secondary.some((a) => a.id === "concede"));
});

test("B1: a viewer is never offered concede while judging", () => {
  const f = fixtureByKey(NOW, "judging");
  const v = betView(f.bet, "someone-else.near", NOW, { names: NAMES, pending: [], contractId: "bets.praetorial.near" });
  assert.ok(!v.secondary.some((a) => a.id === "concede"));
});
