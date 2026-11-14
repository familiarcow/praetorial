// DR-WEB-FLOAT-STAKE-1: exact decimal multiply helper. Float multiply
// (10 * 1.1 === 11.000000000000002) breaks toBaseUnits for ordinary
// odds/stake combos; mulDecimal must produce the exact decimal-string
// product using BigInt math, with no float rounding artifacts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mulDecimal, toBaseUnits } from "../lib/assets";

test("mulDecimal(10, 1.1) is exactly '11', not the float artifact", () => {
  assert.equal(mulDecimal(10, 1.1), "11");
});

test("mulDecimal(7, 0.1) is exactly '0.7'", () => {
  assert.equal(mulDecimal(7, 0.1), "0.7");
});

test("mulDecimal(0.1, 3) is exactly '0.3'", () => {
  assert.equal(mulDecimal(0.1, 3), "0.3");
});

test("toBaseUnits composes with mulDecimal without throwing on precision", () => {
  assert.equal(toBaseUnits("USDC", mulDecimal(10, 1.1)), "11000000");
});
