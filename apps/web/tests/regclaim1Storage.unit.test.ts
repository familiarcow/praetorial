// REGCLAIM1: review card storage line must not say "loading from the contract..." forever when the contract has no asset_limit for an asset (testnet wrap.testnet).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchStorageRates, unavailableStorageAssets } from "../lib/storageCharge";
import { storagePlaceholder } from "../lib/reviewCard";

test("assets the contract returns null for are reported unavailable", async () => {
  const rates = await fetchStorageRates(["nep141:usdc.testnet", "nep141:wrap.testnet"], async (a) => (a.includes("usdc") ? { storage_per_kib: "100" } : null));
  assert.deepEqual(unavailableStorageAssets(["nep141:usdc.testnet", "nep141:wrap.testnet"], rates), ["nep141:wrap.testnet"]);
});
test("placeholder: loading until the read settles, then a final message", () => {
  assert.match(storagePlaceholder(false), /loading from the contract/);
  assert.doesNotMatch(storagePlaceholder(true), /loading/);
  assert.match(storagePlaceholder(true), /not available/i);
});
