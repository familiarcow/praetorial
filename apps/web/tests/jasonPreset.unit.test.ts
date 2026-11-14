// D-WEBFIX1: the Jason preset loads the canonical structured sheet (D-DEMO1 jason_terms_with_urls.json), so it passes
// the strict custom lint (WT1b(d)) with no lint change and can reach review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { jasonPresetSheet } from "../lib/jasonPreset";
import { JASON_TERM_SHEET, validateTermSheet } from "../lib/termSheet";
import { builderGate } from "../lib/builderGate";
import { lintCustom } from "../lib/customLint";
import { lintAnySheet } from "../lib/templates";
import { customFormFromSheet, sheetFromCustomForm } from "../lib/customBuilder";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const canon = JSON.parse(readFileSync(join(root, "services/e2e/live-run8/jason_terms_with_urls.json"), "utf8"));
const canon7g3 = JSON.parse(readFileSync(join(root, "resolver/live-run7g3/jason_terms_with_urls.json"), "utf8"));

test("the two canonical copies (live-run8, live-run7g3) match", () => {
  assert.deepEqual(canon, canon7g3);
});

test("the web preset sheet deep-equals the canonical D-DEMO1 sheet", () => {
  assert.deepEqual(jasonPresetSheet(), canon);
});

test("the preset sheet passes the custom lint and the builder gate with zero flags", () => {
  assert.deepEqual(lintCustom(jasonPresetSheet()), []);
  assert.deepEqual(lintAnySheet(jasonPresetSheet()), []);
  assert.deepEqual(builderGate(jasonPresetSheet(), { humanReferee: false }).problems, []);
  assert.deepEqual(builderGate(jasonPresetSheet(), { humanReferee: true }).problems, []);
});

test("the lean preset form still validates and the guided-builder form of the sheet is lint-clean", () => {
  assert.deepEqual(validateTermSheet(JASON_TERM_SHEET, Date.parse("2026-11-08T00:00:00Z")), []);
  const form = customFormFromSheet(jasonPresetSheet());
  assert.equal(form.claim, canon.claim);
  assert.equal(form.sources.length, 3);
  // the guided form has no ticker_pins field, so only the canonical sheet (opened directly by the preset) carries them
  assert.deepEqual(builderGate(sheetFromCustomForm(form), { humanReferee: false }).problems.filter((p) => !p.includes("ticker_pins")), []);
});

test("jasonPresetSheet returns a fresh copy (no shared mutation)", () => {
  const a: any = jasonPresetSheet(); a.claim = "x";
  assert.deepEqual(jasonPresetSheet(), canon);
});
