// STG1b (D-STORAGE1): I-2 funds-in uses each side's stored storage charge (Bet.storage_maker / storage_taker) in its own asset;
// the envelope's storage_charge_per_side is "0" and must not be used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fundsInForBet, fundsInByAsset } from "../src/snapshot.js";

const bet = (over: Record<string, unknown> = {}): any => ({
  envelope: { maker_asset: "nep141:btc", taker_asset: "nep141:usdc", stake_maker: "10000", stake_taker: "5000000", storage_charge_per_side: "0" },
  storage_maker: "159375", storage_taker: "6528", bonds: [], objection_deposits: [], ...over,
});

test("fundsInForBet = both stakes + storage_maker + storage_taker", () => {
  assert.equal(fundsInForBet(bet()), 10000n + 5000000n + 159375n + 6528n);
});

test("fundsInByAsset: each side's own storage lands in its own asset", () => {
  const m = fundsInByAsset(bet());
  assert.equal(m.get("nep141:btc"), 10000n + 159375n);
  assert.equal(m.get("nep141:usdc"), 5000000n + 6528n);
});

test("same-asset bet: the two stored charges add up in the one asset", () => {
  const m = fundsInByAsset(bet({ envelope: { maker_asset: "a", taker_asset: "a", stake_maker: "1", stake_taker: "2", storage_charge_per_side: "0" }, storage_maker: "7", storage_taker: "9" }));
  assert.equal(m.get("a"), 1n + 2n + 7n + 9n);
});
