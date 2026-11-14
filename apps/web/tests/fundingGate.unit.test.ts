// FE2b: S7/S11 balance gate. Compares in base units (bigint, no floats) and builds the /add-money hand-off.
import test from "node:test";
import assert from "node:assert/strict";
import { needFor, fundingNeed, addMoneyPath } from "../lib/fundingGate";
import { parseNeed } from "../lib/intentsBalance";
import { INTENTS_CONTRACT_ID } from "../lib/config";
import { assetId } from "../lib/assets";

test("needFor: null when the balance covers 'You pay now' (equal or more)", () => {
  assert.equal(needFor("USDC", 12550000n, "12550000"), null);
  assert.equal(needFor("USDC", 12550000n, "99999999"), null);
});
test("needFor: short balance returns the FULL pay-now amount as a decimal string (the add-money screen derives the shortfall)", () => {
  assert.deepEqual(needFor("USDC", 12550000n, "5000000"), { symbol: "USDC", amount: "12.55" });
  assert.deepEqual(needFor("USDC", 12550000n, "0"), { symbol: "USDC", amount: "12.55" });
});
test("needFor is exact in base units: one unit short of a 24-decimal asset is still short", () => {
  assert.deepEqual(needFor("NEAR", 10n ** 24n, (10n ** 24n - 1n).toString()), { symbol: "NEAR", amount: "1" });
  assert.equal(needFor("NEAR", 10n ** 24n, (10n ** 24n).toString()), null);
  assert.deepEqual(needFor("NEAR", 1n, "0"), { symbol: "NEAR", amount: "0.000000000000000000000001" });
});
test("addMoneyPath round-trips through parseNeed", () => {
  const n = { symbol: "USDC", amount: "12.55" };
  assert.equal(addMoneyPath(n), "/add-money?asset=USDC&need=12.55");
  const q = addMoneyPath(n).slice("/add-money".length);
  assert.deepEqual(parseNeed(q), n);
});
test("fundingNeed reads only the stake asset's mt_balance_of on the intents contract", async () => {
  const calls: any[] = [];
  const usdc = assetId("USDC")!;
  const out = await fundingNeed({ account: "me.testnet", symbol: "USDC", payNowUnits: 12550000n, view: async (c, m, a) => { calls.push({ c, m, a }); return "5000000"; } });
  assert.deepEqual(calls, [{ c: INTENTS_CONTRACT_ID, m: "mt_balance_of", a: { account_id: "me.testnet", token_id: usdc } }]);
  assert.deepEqual(out, { symbol: "USDC", amount: "12.55" });
});
test("fundingNeed: enough balance -> null; a failed read never blocks (the contract still refunds a bad deposit)", async () => {
  assert.equal(await fundingNeed({ account: "me.testnet", symbol: "USDC", payNowUnits: 1n, view: async () => "1" }), null);
  assert.equal(await fundingNeed({ account: "me.testnet", symbol: "USDC", payNowUnits: 1n, view: async () => { throw new Error("rpc"); } }), null);
});

import { safeReturn, parseReturn } from "../lib/fundingGate";
test("return target is limited to /new and /bet/:id; hand-off carries it", () => {
  assert.equal(addMoneyPath({ symbol: "USDC", amount: "12.55" }, "/bet/7"), "/add-money?asset=USDC&need=12.55&return=%2Fbet%2F7");
  assert.equal(addMoneyPath({ symbol: "USDC", amount: "1" }, "https://evil.example"), "/add-money?asset=USDC&need=1");
  assert.equal(parseReturn("?asset=USDC&need=1&return=%2Fbet%2F7"), "/bet/7");
  assert.equal(parseReturn("?return=%2F%2Fevil.example"), null);
  assert.equal(safeReturn("/bet/7/x"), null);
  assert.equal(parseNeed("?asset=USDC&need=12.55&return=%2Fnew")?.amount, "12.55");
});
