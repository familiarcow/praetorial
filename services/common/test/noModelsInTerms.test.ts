// JM1 (D-JUDGE6): judge models are pinned by the resolver; no term-sheet builder in services may emit a `models` field
// (lint rejects it, so such a sheet could not open). Guards the live round-trip script that builds a sheet inline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("e2e g3_round_trip term sheet carries no models field (D-JUDGE6)", () => {
  const src = readFileSync(new URL("../../e2e/g3_round_trip.ts", import.meta.url), "utf8");
  const start = src.indexOf("const term = {");
  assert.ok(start > 0, "term literal found");
  const end = src.indexOf("};", start);
  assert.doesNotMatch(src.slice(start, end), /\bmodels\s*:/);
});
