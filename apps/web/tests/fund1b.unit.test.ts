// FUND1b (1): the in-modal "Add money" notice: exact missing amount (pay-now minus balance), the hand-off path.
import test from "node:test";
import assert from "node:assert/strict";
import { fundingShort } from "../lib/fundingGate";

const NEAR = 10n ** 24n;

test("short: exact missing = pay-now minus balance, plain sentence, hand-off carries the full need + return", async () => {
  const s = await fundingShort({ account: "a", symbol: "NEAR", payNowUnits: 3n * NEAR, returnTo: "/bet/7", view: async () => String(NEAR) });
  assert.ok(s);
  assert.equal(s!.missingText, "2 NEAR");
  assert.equal(s!.sentence, "You need 2 NEAR more in your betting balance to do this.");
  assert.equal(s!.path, "/add-money?asset=NEAR&need=3&return=%2Fbet%2F7");
});

test("short: USDC shows dollars", async () => {
  const s = await fundingShort({ account: "a", symbol: "USDC", payNowUnits: 5_000_000n, view: async () => "1500000" });
  assert.equal(s!.missingText, "3.50 USDC");
});

test("short: covered -> null; failed read -> null (never blocks)", async () => {
  assert.equal(await fundingShort({ account: "a", symbol: "NEAR", payNowUnits: NEAR, view: async () => String(NEAR) }), null);
  assert.equal(await fundingShort({ account: "a", symbol: "NEAR", payNowUnits: NEAR, view: async () => { throw new Error("rpc"); } }), null);
});
