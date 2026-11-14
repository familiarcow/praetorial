// Orchestrator follow-up to DR-WEB-ASSET-MISMATCH-1 (2026-11-05): the Open
// handler scaled every stake by 1e24 (wNEAR decimals) whatever asset was
// picked, so a 10 USDC stake (6 decimals) was sent as 10e24 base units.
// Stakes must be scaled by the deposited asset's own decimals, exactly
// (no float rounding).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { toBaseUnits } from "../lib/assets";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "../src/App.tsx"), "utf8");
const start = app.indexOf("const openBet = async") /* MODAL1c1: the handler moved out of the button into openBet */;
const handler = app.slice(start, app.indexOf("signRawHash", start));

test("toBaseUnits scales by each asset's own decimals, exactly", () => {
  assert.equal(toBaseUnits("USDC", 10), "10000000");
  assert.equal(toBaseUnits("USDC", 0.1), "100000");
  assert.equal(toBaseUnits("NEAR", 1.5), "1500000000000000000000000");
  assert.equal(toBaseUnits("ETH", 0.3), "300000000000000000");
  assert.equal(toBaseUnits("BTC", 0.00012345), "12345");
  assert.throws(() => toBaseUnits("USDC", 0.0000001), /precision/);
  assert.throws(() => toBaseUnits("NOPE", 1), /unknown asset/);
});

test("open handler scales stakes by the asset's decimals, not a hardcoded 1e24", () => {
  assert.ok(start >= 0, "open-offer-btn handler not found");
  assert.ok(!/1e24/.test(handler), "handler still hardcodes 1e24 scaling");
  assert.ok(/stake_maker:\s*toBaseUnits\(/.test(handler), "stake_maker must use toBaseUnits");
  assert.ok(/stake_taker:\s*toBaseUnits\(/.test(handler), "stake_taker must use toBaseUnits");
});
