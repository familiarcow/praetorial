// DR-TREAS-2: treasury must never be the escrow contract; slippage must be sane.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planTreasuryRun } from "../src/treasuryJob.js";
import { parseSlippageBps } from "../src/runner.js";

const reader: any = { async getFeeBalances() { return []; } };
const floats: any = { async getFloatBalances() { return { relayer: 0n, keeper: 0n }; } };
const client: any = { async getQuote() { throw new Error("no network"); } };

function cfg(over: any = {}): any {
  return {
    nearAssetId: "nep141:wrap.near", usdAssetId: "nep141:usdc.near",
    relayerFloatTarget: 0n, keeperFloatTarget: 0n, minSwapSize: {}, defaultMinSwapSize: 1n,
    slippageToleranceBps: 100, treasuryAccountId: "fees.near", escrowContractId: "escrow.near",
    live: false, logger: () => {}, ...over,
  };
}

test("planTreasuryRun throws when treasuryAccountId is the escrow contract", async () => {
  await assert.rejects(planTreasuryRun(reader, floats, client, cfg({ treasuryAccountId: "escrow.near" })), /escrow/i);
});

test("planTreasuryRun throws when escrowContractId is missing", async () => {
  await assert.rejects(planTreasuryRun(reader, floats, client, cfg({ escrowContractId: "" })), /escrow/i);
});

test("planTreasuryRun accepts a distinct treasury account", async () => {
  const r = await planTreasuryRun(reader, floats, client, cfg());
  assert.equal(r.dryRun, true);
});

test("parseSlippageBps: default, valid, and invalid values", () => {
  assert.equal(parseSlippageBps(undefined), 100);
  assert.equal(parseSlippageBps("0"), 0);
  assert.equal(parseSlippageBps("10000"), 10000);
  for (const bad of ["abc", "-1", "10001", "1.5", "", " ", "NaN", "Infinity"]) {
    if (bad === "") continue; // empty env == unset => default
    assert.throws(() => parseSlippageBps(bad), /TREASURY_SLIPPAGE_BPS/, bad);
  }
});
