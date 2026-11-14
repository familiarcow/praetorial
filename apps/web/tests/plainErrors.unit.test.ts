// FE3b Q1 (D-FE3b): display-only plain-English map for every lint/resolver problem the S2/S3 steps can show.
// The lints and their messages are unchanged (tests/lintParity, customLint, templates keep pinning them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { plainProblem, GENERIC_PLAIN } from "../lib/plainErrors";
import { lintTemplate } from "../lib/templates";
import { lintCustom } from "../lib/customLint";

const here = dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(join(here, "../lib", f), "utf8");
const SOURCES = ["templates.ts", "customLint.ts", "builderGate.ts", "lintHints.ts", "assetPriceSheet.ts", "outperformSheet.ts"].map(src).join("\n");

// every named code any lint can emit
const codes = [...new Set([...SOURCES.matchAll(/\b((?:TPL|AMBIGUOUS|CUSTOM|PRICE)_[A-Z0-9_]+)(?=[:\"'`])/g)].map((m) => m[1]))];
// every legacy (un-coded) message start a lint pushes
const starts = [...new Set([...src("customLint.ts").matchAll(/p\.push\((?:\.\.\.)?[`"]([^`"$]+)/g)].map((m) => m[1]))].filter((x) => !x.endsWith(" "));
const EXTRA_STARTS = ["source name 'x' is not allowed", "element 0 too long", "element 0 addresses the judge", "element 0 names a vague", "source 'x' is a vague/undefined venue", "unknown clause X", "time.window_end must be UTC ISO8601", "missing field: claim", "models: judge models", "custom definition contains an instruction: x"];

test("the scan found the lint codes (guards the completeness test itself)", () => {
  assert.ok(codes.length >= 25, `found ${codes.length}`);
  assert.ok(starts.length >= 8, `found ${starts.length}`);
});

test("every named lint code has a plain-English mapping", () => {
  const missing = codes.filter((c) => !plainProblem(`${c}: x`).mapped);
  assert.deepEqual(missing, []);
});

test("every legacy custom-lint message has a plain-English mapping", () => {
  const missing = [...starts, ...EXTRA_STARTS].filter((s) => !plainProblem(s).mapped);
  assert.deepEqual(missing, []);
});

test("a mapped problem reads as a plain sentence: no code, no snake_case, no resolver words", () => {
  for (const c of codes) {
    const p = plainProblem(`${c}: x`);
    assert.ok(!/[A-Z]{3,}_[A-Z_]+|\bts\.|JSON|custom_definition|ticker_pins|resolver/.test(p.text), `${c} -> ${p.text}`);
    assert.match(p.text, /^[A-Z].*[.?]$/, p.text);
  }
});

test("the raw lint message is always kept for the details toggle", () => {
  const raw = lintTemplate({ template: { id: "btc_touch", version: 1 }, fields: { direction: "at_or_above", x_usd: 126210.5, deadline_utc: "2027-10-28T19:00:00Z", open_utc: "2026-11-08T00:00:00Z" } })[0];
  const p = plainProblem(raw);
  assert.equal(p.raw, raw);
  assert.ok(p.text !== raw && /whole/i.test(p.text), p.text);
});

test("an unmapped code shows the generic plain sentence and keeps the code for the details toggle", () => {
  const p = plainProblem("TPL_BRAND_NEW_CODE: whatever");
  assert.equal(p.mapped, false);
  assert.equal(p.text, GENERIC_PLAIN);
  assert.equal(p.raw, "TPL_BRAND_NEW_CODE: whatever");
});

test("real custom-lint output for an empty sheet maps fully", () => {
  for (const m of lintCustom({})) assert.equal(plainProblem(m).mapped, true, m);
});
