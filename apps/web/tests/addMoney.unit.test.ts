// FE2 / S1c: intents balances, shortfall, money formatting, the ?asset=&need= hand-off.
import test from "node:test";
import assert from "node:assert/strict";
import { fetchIntentsBalances, shortfallUnits, formatMoney, parseNeed, needQuery, balanceHeadline } from "../lib/intentsBalance";
import { INTENTS_CONTRACT_ID } from "../lib/config";
import { findAsset, listEnabledAssets, assetId } from "../lib/assets";
import { matchRoute, routeRequiresLogin, legacyRedirect } from "../lib/router";

// F2: the read is now ONE mt_batch_balance_of (tests/funding/balances.unit.test.ts covers it and the per-token fallback); this
// checks the fallback path, which is exactly the previous per-token behaviour.
test("fetchIntentsBalances reads mt_balance_of on the intents contract for every enabled asset when the batch read is unavailable", async () => {
  const calls: any[] = [];
  const usdc = assetId("USDC")!;
  const out = await fetchIntentsBalances("me.testnet", async (c: string, m: string, a: any) => { calls.push({ c, m, a }); if (m === "mt_batch_balance_of") throw new Error("no batch"); return a.token_id === usdc ? "12550000" : "0"; });
  assert.equal(calls[0].m, "mt_batch_balance_of");
  const single = calls.slice(1);
  assert.ok(single.every((x) => x.c === INTENTS_CONTRACT_ID && x.m === "mt_balance_of" && x.a.account_id === "me.testnet"));
  assert.deepEqual(single.map((x) => x.a.token_id).sort(), listEnabledAssets().map((a) => assetId(a.symbol)!).sort());
  assert.equal(out.USDC, "12550000");
  assert.equal(Object.keys(out).length, listEnabledAssets().length);
});
test("a failed read for one asset throws (the screen shows 'can't read your balance')", async () => {
  await assert.rejects(fetchIntentsBalances("me.testnet", async () => { throw new Error("rpc"); }));
});
test("shortfallUnits is exact in base units and never negative", () => {
  assert.equal(shortfallUnits("0", "12550000"), 12550000n);
  assert.equal(shortfallUnits("12550000", "12550000"), 0n);
  assert.equal(shortfallUnits("20000000", "12550000"), 0n);
});
test("formatMoney: USDC as dollars, other assets as amount + symbol", () => {
  assert.equal(formatMoney("USDC", "0"), "0.00 USDC");
  assert.equal(formatMoney("USDC", "12550000"), "12.55 USDC");
  assert.equal(formatMoney("USDC", "1000000"), "1.00 USDC");
  const near = findAsset("NEAR")!;
  assert.equal(formatMoney("NEAR", "500000000000000000000000"), `0.5 NEAR`);
  assert.ok(near);
});
test("parseNeed / needQuery round-trip and reject junk", () => {
  assert.deepEqual(parseNeed("?asset=USDC&need=12.55"), { symbol: "USDC", amount: "12.55" });
  assert.equal(needQuery("USDC", "12.55"), "?asset=USDC&need=12.55");
  for (const q of ["", "?asset=XYZ&need=1", "?asset=USDC&need=abc", "?asset=USDC", "?need=3", "?asset=USDC&need=-1"]) assert.equal(parseNeed(q), null, q);
});
test("balanceHeadline: spec copy for empty, funded, and shortfall", () => {
  assert.equal(balanceHeadline("USDC", "0", null), "Your balance: 0.00 USDC. Add USDC to place a bet.");
  assert.equal(balanceHeadline("USDC", "5000000", null), "Your balance: 5.00 USDC.");
  assert.equal(balanceHeadline("USDC", "0", { symbol: "USDC", amount: "12.55" }), "Your balance: 0.00 USDC. You need 12.55 USDC more.");
  assert.equal(balanceHeadline("USDC", "5000000", { symbol: "USDC", amount: "12.55" }), "Your balance: 5.00 USDC. You need 7.55 USDC more.");
  assert.equal(balanceHeadline("USDC", "20000000", { symbol: "USDC", amount: "12.55" }), "Your balance: 20.00 USDC. You have enough for this bet.");
});
// NAV1 (UX-31): Add money is now the Wallet page (F3: renamed Account); old /add-money links (incl. the funding hand-off query) redirect there.
test("/add-money redirects to the login-gated /account, keeping the hand-off query", () => {
  assert.equal(legacyRedirect("/add-money", "?asset=USDC&need=12.55", ""), "/account?asset=USDC&need=12.55");
  assert.deepEqual(matchRoute("/account"), { name: "account" });
  assert.equal(routeRequiresLogin({ name: "account" }), true);
});
