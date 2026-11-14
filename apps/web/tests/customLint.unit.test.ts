// WT1b (d): custom sheets go through the resolver-format lint too, with the resolver's named errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { lintCustom, customOpenProblems } from "../lib/customLint";
import { lintAnySheet, problemCode } from "../lib/templates";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => JSON.parse(readFileSync(join(here, "../../../resolver/core/tests/fixtures", n), "utf8"));

test("lint.json: every legacy custom case yields the resolver's exact problem strings, in order", () => {
  const cases = fx("lint.json").cases;
  assert.ok(cases.length >= 6);
  for (const c of cases) assert.deepEqual(lintCustom(c.ts), c.problems, c.name);
});

test("template_cases.json: lintAnySheet (typed or custom) matches the resolver's ordered codes for ALL cases", () => {
  const cases: Array<{ name: string; codes: string[]; ts: any }> = fx("template_cases.json");
  assert.ok(cases.length >= 30);
  for (const c of cases) assert.deepEqual(lintAnySheet(c.ts).map(problemCode), c.codes, c.name);
});

test("a lean custom sheet (claim only) is refused with named resolver errors, not opened", () => {
  const p = lintAnySheet({ claim: "Foo happens", sources_allowed: [{ id: "S1", publisher: "x" }], time: { window_end: "2027-01-01T00:00:00Z" } });
  assert.ok(p.some((x) => x.startsWith("missing field: elements")));
  assert.ok(p.some((x) => x.startsWith("need >= 2 independent")));
});

test("custom relative date and price-reading checks use the resolver's named errors", () => {
  assert.ok(lintCustom({ claim: "It rains next Friday" })[0].startsWith("CUSTOM_RELATIVE_DATE:"));
  const sheet = { claim: "BTC breaks 80000", sources_allowed: [{ publisher: "Coinbase", url: "https://api.coinbase.com/x" }] };
  assert.ok(customOpenProblems(sheet).some((x) => x.startsWith("PRICE_READING_UNDEFINED:")));
});

test("buildOpenEnvelope refuses a custom sheet the resolver lint rejects (named error), before any hash is made", async () => {
  const { buildOpenEnvelope } = await import("../lib/openEnvelope");
  assert.throws(
    () => buildOpenEnvelope({ maker: "m.testnet", sheet: { claim: "Foo", time: { window_end: "2027-01-01T00:00:00Z" } }, customDeadlineSecs: 1_800_000_000, makerAsset: "a", takerAsset: "a", stakeMaker: "1", stakeTaker: "1", takerAccount: null, referee: null, nowMs: Date.parse("2026-11-07T12:00:00Z") }),
    (e: any) => e.name === "TemplateRefusedError" && e.problems.some((p: string) => p.startsWith("missing field:")),
  );
});
