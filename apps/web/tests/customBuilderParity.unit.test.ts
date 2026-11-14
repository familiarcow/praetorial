// FE3b Q5 (D-FE3b / D-DEMO1): the generic custom builder, filled in through its own fields, emits the canonical
// jason_terms_with_urls.json EXACTLY (deep-equal; key order is normalised by canonicalTerms). No preset, no Jason-specific code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { blankCustomForm, sheetFromCustomForm, customFormFromSheet, type CustomForm } from "../lib/customBuilder";
import { canonicalTerms } from "../lib/templates";
import { builderGate } from "../lib/builderGate";

const here = dirname(fileURLToPath(import.meta.url));
const canon = JSON.parse(readFileSync(join(here, "../../../services/e2e/live-run8/jason_terms_with_urls.json"), "utf8"));
const d = canon.custom_definitions as string[];

// Typed exactly as a person would fill the builder's fields (every value is a general builder field).
const form: CustomForm = {
  ...blankCustomForm(),
  claim: canon.claim,
  elements: [canon.elements[0].q],
  rule: "ALL",
  sources: [
    { publisher: "Coinbase BTC-USD", url: canon.sources_allowed[0].url, partyControlled: false, id: "S_CB", tier: "primary", ticker: "BTC-USD" },
    { publisher: "Bitstamp btcusd", url: canon.sources_allowed[1].url, partyControlled: false, id: "S_BS", tier: "primary", ticker: "btcusd" },
    { publisher: "Kraken XBT/USD", url: canon.sources_allowed[2].url, partyControlled: false, id: "S_KR", tier: "data", ticker: "XBT/USD" },
  ],
  windowStart: "2026-11-04T00:00", windowEnd: "2028-10-28T19:00", evidenceCutoff: "2028-11-04T19:00", windowClose: "2028-11-06T19:00",
  clauses: [...canon.clauses],
  leadingDefinitions: d.slice(0, 4),
  fallbackRule: d[4],
  earlyRule: "",
  otherDefinitions: d.slice(5),
  notes: [{ name: "comment", text: canon._comment }, { name: "source_class_note", text: canon._source_class_note }],
};

test("the generic builder, fully filled in, emits the canonical D-DEMO1 sheet exactly", () => {
  const s = sheetFromCustomForm(form);
  assert.deepEqual(s, canon);
  assert.equal(canonicalTerms(s), canonicalTerms(canon));
});

test("the canonical sheet loads into the builder form and re-emits identically (inverse)", () => {
  const f = customFormFromSheet(canon);
  assert.deepEqual(sheetFromCustomForm(f), canon);
});

test("the built sheet passes the open gate with zero problems (AI and person modes)", () => {
  assert.deepEqual(builderGate(sheetFromCustomForm(form), { humanReferee: false }).problems, []);
});

test("the new builder fields are general: absent -> not emitted; a sheet without them is unchanged", () => {
  const s: any = sheetFromCustomForm({ ...blankCustomForm(), claim: "c", elements: ["q?"], sources: [{ publisher: "A", url: "", partyControlled: false }, { publisher: "B", url: "", partyControlled: false }] });
  for (const k of ["ticker_pins", "source_classes", "window_close", "_comment"]) assert.equal(k in s, false, k);
  assert.deepEqual(s.sources_allowed.map((x: any) => x.id), ["S1", "S2"]);
});
