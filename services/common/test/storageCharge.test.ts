// E2S1 (D-STORAGE1): services port of the contract's per-side storage charge, pinned to the same fixtures as
// contracts/escrow/src/stg1.rs (and apps/web/tests/storageCharge.unit.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimatedStorageBytes, storageForRate, sideDeposit, envelopeDeposits } from "../src/storageCharge.js";

const USDC = "nep141:usdc.testnet", BTC = "nep141:wbtc.testnet", WNEAR = "wrap.testnet";
const RATES: Record<string, string> = { [USDC]: "4096", [BTC]: "100000", [WNEAR]: "10240000000000000000000000" };
const TABLE = [
  { termsLen: 0, bytes: 3264, charge: { [USDC]: "6528", [BTC]: "159375", [WNEAR]: "16320000000000000000000000" } },
  { termsLen: 1000, bytes: 4264, charge: { [USDC]: "8528", [BTC]: "208204", [WNEAR]: "21320000000000000000000000" } },
  { termsLen: 8192, bytes: 11456, charge: { [USDC]: "22912", [BTC]: "559375", [WNEAR]: "57280000000000000000000000" } },
];

test("parity with stg1.rs: 3 assets x 3 term sizes", () => {
  for (const row of TABLE) {
    const bytes = estimatedStorageBytes("t".repeat(row.termsLen), "a".repeat(64), "b".repeat(64));
    assert.equal(bytes, row.bytes);
    for (const a of [USDC, BTC, WNEAR]) assert.equal(storageForRate(bytes, RATES[a]).toString(), (row.charge as any)[a]);
  }
});

test("storageForRate floors at 1 unit", () => {
  assert.equal(storageForRate(3264, "0"), 1n);
  assert.equal(storageForRate(1, "1"), 1n);
});

test("sideDeposit = stake + per-side charge from the asset's storage_per_kib", () => {
  const bytes = estimatedStorageBytes("", "a".repeat(64), "b".repeat(64));
  assert.equal(sideDeposit(1_000_000n, bytes, "4096"), 1_000_000n + 6528n);
});

test("envelopeDeposits reads each side's rate from the asset table (get limits view)", async () => {
  const asked: string[] = [];
  const view = async (asset: string) => { asked.push(asset); return { storage_per_kib: RATES[asset] }; };
  const env = { terms: "t".repeat(1000), terms_hash: "a".repeat(64), models_snapshot_hash: "b".repeat(64),
    stake_maker: "5000", stake_taker: "7000", maker_asset: BTC, taker_asset: USDC };
  const d = await envelopeDeposits(view, env);
  assert.equal(d.maker, 5000n + 208204n);
  assert.equal(d.taker, 7000n + 8528n);
  assert.deepEqual(asked.sort(), [BTC, USDC].sort());
});

test("envelopeDeposits throws when the asset is not whitelisted", async () => {
  await assert.rejects(envelopeDeposits(async () => null, { terms: "", terms_hash: "", models_snapshot_hash: "", stake_maker: "1", stake_taker: "1", maker_asset: "x", taker_asset: "x" }), /asset_limit/);
});
