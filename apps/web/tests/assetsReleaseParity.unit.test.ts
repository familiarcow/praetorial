// D-VA1 (1): the web's per-asset limits must equal the release args new() is deployed with, for every asset and field.
// Source of truth: release/mainnet-night/args.mainnet.json (the FINAL args the live mainnet escrow was deployed with) when
// present, else release/draft-args.mainnet.json -- the same choice the mainnet deploy guard makes (limitsArgsSource). The
// testnet args carry only the testnet-capable subset. storage_per_kib is not part of the web table (storageCharge.ts reads it on-chain).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ASSET_TABLE } from "../lib/assets";
import { limitsArgsSource } from "../scripts/mainnetDeployGuard";

const here = dirname(fileURLToPath(import.meta.url));
const src = limitsArgsSource(join(here, "../../.."));
const args = JSON.parse(readFileSync(src.path, "utf8"));
const limits = new Map<string, Record<string, string>>(args.asset_limits);

const FIELDS: Array<[keyof (typeof ASSET_TABLE)[number], string]> = [
  ["minStakePerSide", "min_per_side"],
  ["maxStakePerSide", "max_per_side"],
  ["minFeePerSide", "min_fee_per_side"],
  ["runPrice", "run_price"],
  ["minBond", "min_bond"],
  ["minObjection", "min_objection"],
];

test("release args cover exactly the web's six assets", () => {
  assert.deepEqual([...limits.keys()].sort(), ASSET_TABLE.map((a) => a.ids.mainnet!).sort());
  assert.equal(ASSET_TABLE.length, 6);
});

for (const a of ASSET_TABLE) {
  test(`${a.symbol}: ASSET_TABLE limits equal ${src.label} asset_limits`, () => {
    const l = limits.get(a.ids.mainnet!);
    assert.ok(l, `${a.symbol} missing from release args`);
    for (const [webField, argField] of FIELDS) {
      assert.equal(a[webField], l![argField], `${a.symbol}.${String(webField)} != args ${argField}`);
    }
  });
}

test(`lib/assetLimits.generated.ts is current with ${src.label} (run \`npm run gen:limits -- --args <file>\`)`, async () => {
  const { render, OUT_PATH } = await import("../scripts/genAssetLimits");
  assert.equal(readFileSync(OUT_PATH, "utf8"), render(readFileSync(src.path, "utf8"), src.label));
});
