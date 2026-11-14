// CAP3b: the contract's MAX_PER_SIDE_CEILING (parsed from lib.rs, not copied) must equal the release tooling's launchMaxPerSide().
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { launchMaxPerSide } from "../src/stakeCap.js";
import { LIB_RS_PATH } from "../src/contractConstants.js";

test("CAP3b: contract MAX_PER_SIDE_CEILING equals launchMaxPerSide()", () => {
  const src = readFileSync(LIB_RS_PATH, "utf8");
  const m = /pub const MAX_PER_SIDE_CEILING\s*:\s*u128\s*=\s*([0-9_]+);/.exec(src);
  assert.ok(m, "lib.rs: MAX_PER_SIDE_CEILING not found");
  assert.equal(BigInt(m![1].replace(/_/g, "")), launchMaxPerSide());
  assert.equal(launchMaxPerSide(), 10n ** 34n);
});
