// M1 (SM2 gap M1-2): one balance read before a pay-in. The take (and the challenge bond) used to read mt_balance_of twice: once for
// the "short" notice and once for the refund check. fundingCheck returns both from ONE read.
import test from "node:test";
import assert from "node:assert/strict";
import { fundingCheck } from "../lib/fundingGate";

const USDC_ID = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

test("fundingCheck: covered -> no short, the balance read once", async () => {
  let reads = 0;
  const r = await fundingCheck({ account: "a", tokenId: USDC_ID, payNowUnits: 5_000_000n, view: async () => { reads++; return "7000000"; } });
  assert.equal(reads, 1);
  assert.equal(r.short, null);
  assert.equal(r.balanceUnits, 7_000_000n);
});

test("fundingCheck: short -> the exact missing amount, the Add money path, and the balance, still ONE read", async () => {
  let reads = 0;
  const r = await fundingCheck({ account: "a", tokenId: USDC_ID, payNowUnits: 5_000_000n, returnTo: "/bet/7", view: async () => { reads++; return "1500000"; } });
  assert.equal(reads, 1);
  assert.equal(r.balanceUnits, 1_500_000n);
  assert.ok(r.short);
  assert.match(r.short!.sentence, /3\.50 USDC more/);
  assert.match(r.short!.path, /^\/add-money\?.*return=%2Fbet%2F7/);
});

test("fundingCheck: a failed read never blocks (the contract refunds a wrong deposit) and has no balance", async () => {
  const r = await fundingCheck({ account: "a", tokenId: USDC_ID, payNowUnits: 1n, view: async () => { throw new Error("rpc"); } });
  assert.deepEqual(r, { short: null, balanceUnits: null });
});

test("fundingCheck: a needed amount rounds UP (a 1-unit USDC shortfall is never 'You need 0.00 USDC more'; tiny = '< 0.01', familiarcow's amount rule)", async () => {
  const r = await fundingCheck({ account: "a", tokenId: USDC_ID, payNowUnits: 4_000_000n, view: async () => "3999999" });
  assert.equal(r.short!.missingText, "< 0.01 USDC");
  assert.equal(r.short!.sentence, "You need < 0.01 USDC more in your betting balance to do this.");
});
