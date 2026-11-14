// BROWSE1: pure logic for the Explore rows (filter by contract, dedupe). H1: the card text (stakes, @maker, decider, closes in)
// comes from betView via the kit BetCard "offer" (tests/h1Home.unit.test.ts, tests/browse-cards.spec.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { keepOffers, offerKey, BROWSE_EMPTY } from "../lib/browseCards";

const FRZ3 = "praetorial-frz3-2611100414.praetorial-dev-1101.testnet";
const FRZ2 = "praetorial-frz2-2611091111.praetorial-dev-1101.testnet";
const row = (bet_id: number, contract_id: string | undefined, over: Record<string, unknown> = {}): any => ({
  bet_id, contract_id, contract_version: 1, maker: "maker.testnet", maker_side: "YES", stake_maker: "10000000", stake_taker: "10000000", funding_deadline: 0, taker_allow: "Any", ...over,
});

test("keepOffers drops rows from another contract and rows with no contract_id", () => {
  const out = keepOffers([row(1, FRZ3), row(2, FRZ2), row(3, undefined)], FRZ3);
  assert.deepEqual(out.map((o) => o.bet_id), [1]);
});

test("keepOffers dedupes by contract_id + bet_id, first row wins", () => {
  const out = keepOffers([row(7, FRZ3, { maker: "a.testnet" }), row(7, FRZ3, { maker: "b.testnet" })], FRZ3);
  assert.equal(out.length, 1);
  assert.equal(out[0].maker, "a.testnet");
});

test("keepOffers drops targeted (non-Any) offers", () => {
  assert.equal(keepOffers([row(1, FRZ3, { taker_allow: JSON.stringify({ Account: "x.testnet" }) })], FRZ3).length, 0);
});

test("offerKey is contract_id + bet_id", () => {
  assert.equal(offerKey(row(7, FRZ3)), `${FRZ3}:7`);
  assert.notEqual(offerKey(row(7, FRZ3)), offerKey(row(7, FRZ2)));
});

test("empty-state copy is exact", () => {
  assert.equal(BROWSE_EMPTY, "No open bets yet. Make one.");
});
