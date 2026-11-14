// DR-WEB-FLOAT-STAKE-1 (drift review 2026-11-05 07:32, RED until fixed).
// CreateOffer computes the taker stake as `makerAmount * odds` in JS float
// math, then App.tsx's Open handler feeds that into toBaseUnits, which
// (correctly) refuses amounts with more fractional digits than the asset
// supports. Float artifacts (3 * 1.1 = 3.3000000000000003) therefore make
// ordinary odds/stake combos impossible to open (toBaseUnits throws), or,
// for 24-decimal assets, encode the float garbage into the on-chain stake.
// The product we want: the taker stake for maker X at odds k is exactly X*k
// in the taker asset's base units (decimal math, no float multiply).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { toBaseUnits } from "../lib/assets";

const here = dirname(fileURLToPath(import.meta.url));
const createOffer = readFileSync(join(here, "../src/components/CreateOffer.tsx"), "utf8");

test("float artifact from makerAmount * odds is real (precondition)", () => {
  assert.notEqual(3 * 1.1, 3.3);
  assert.throws(() => toBaseUnits("USDC", 3 * 1.1), /precision/);
});

test("CreateOffer must not derive the taker stake with a raw float multiply", () => {
  assert.ok(
    !/const\s+takerAmount\s*=\s*makerAmount\s*\*\s*odds\b/.test(createOffer),
    "takerAmount = makerAmount * odds (float) breaks toBaseUnits for e.g. 3 USDC at odds 1.1; compute the taker stake with exact decimal/BigInt math",
  );
});
