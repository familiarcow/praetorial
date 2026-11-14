// PT1 (D-LAUNCH1 / D-L1MESSY2 / D-TPL1): every ambiguous phrasing typed into the custom-sheet builder is refused, with the
// resolver lint's named problem where the resolver has one, the Open path stays closed, and the message says what to change.
// No browser: the Playwright specs need a real Privy login (not mocked, not $0), so this uses the existing node:test runner
// against the exact gate CreateOffer.validate() uses (lib/builderGate). Fixtures: resolver template_cases.json + live-L1 examples.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { blankCustomForm, sheetFromCustomForm, type CustomForm } from "../lib/customBuilder";
import { lintAnySheet, problemCode } from "../lib/templates";
import { builderGate } from "../lib/builderGate";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const templateCases: Array<{ name: string; codes: string[]; ts: any }> = JSON.parse(readFileSync(join(root, "resolver/core/tests/fixtures/template_cases.json"), "utf8"));
const examples: any[] = JSON.parse(readFileSync(join(root, "services/e2e/live-L1/examples.json"), "utf8")).examples;
const FIX_HINT = /\b(state|write|use|name|replace|remove|add|change|pin|say|pick|specify|give)\b/i;

// A builder form filled the way a person would for a non-price claim: two independent non-exchange sources, every rule, UTC window.
const typed = (phrasing: string): CustomForm => ({
  ...blankCustomForm(), claim: phrasing, elements: [phrasing],
  sources: [{ publisher: "Reuters", url: "https://www.reuters.com/", partyControlled: false }, { publisher: "Associated Press", url: "https://apnews.com/", partyControlled: false }],
  windowStart: "2026-11-08T00:00", windowEnd: "2026-11-09T17:00", evidenceCutoff: "2026-11-09T18:00",
});
const gateText = (phrasing: string) => builderGate(sheetFromCustomForm(typed(phrasing)));

test("control: a precise, dated, UTC-stated claim is NOT refused by the gate (no false positive)", () => {
  const g = gateText("Apple ships a foldable iPhone in the US between 2027-01-01 and 2027-12-31 UTC.");
  assert.deepEqual(g.problems, []);
  assert.equal(g.openDisabled, false);
});

test("typed draft sheets from examples.json (builder / custom_open rejects): refused with the resolver's named code, Open closed", () => {
  const rej = examples.filter((e) => e.expected === "REJECT" && (e.kind === "builder" || e.kind === "custom_open"));
  assert.ok(rej.length >= 7, `expected >=7 reject examples, got ${rej.length}`);
  for (const e of rej) {
    const g = builderGate(e.sheet);
    assert.ok(g.refused && g.openDisabled, `${e.id} must be refused`);
    assert.ok(g.problems.some((p: string) => problemCode(p) === e.reject_code), `${e.id}: want ${e.reject_code}, got ${g.problems.map(problemCode)}`);
    assert.ok(g.message.length > 0 && g.problems.every((p: string) => g.message.includes(p)), `${e.id}: message carries every problem`);
  }
});

test("template_cases.json: the gate returns exactly the resolver's ordered codes for every case; any code => Open closed", () => {
  for (const c of templateCases) {
    const g = builderGate(c.ts);
    assert.deepEqual(g.problems.map(problemCode), c.codes, c.name);
    assert.equal(g.openDisabled, c.codes.length > 0, c.name);
  }
});

// [phrasing as typed, resolver code that must appear (if the resolver lint has one), web-side code (if the resolver lint accepts it)]
const L1A: Array<[string, string | null, string | null]> = [
  ["BTC flips 100k", null, "AMBIGUOUS_AMOUNT"],
  ["BTC breaks 76,140 today", null, "AMBIGUOUS_RELATIVE_DATE"],
  ["BTC will be above $76,000 on Friday", "CUSTOM_RELATIVE_DATE", null],
  ["BTC above 100k", null, "AMBIGUOUS_AMOUNT"],
  ["ETH/SOL touches", null, "AMBIGUOUS_MULTI_ASSET"],
  ["BTC up more than 5% on 2026-11-07 (open->close)", null, "AMBIGUOUS_PERCENT_MOVE"],
  ["BTC above $76,000 at 5pm 2026-11-09", null, "AMBIGUOUS_NO_TIMEZONE"],
  // the 4 new phrasings
  ["hotter than 90 tomorrow", "CUSTOM_RELATIVE_DATE", "AMBIGUOUS_NO_STATION"],
  ["Yankees beat Red Sox tonight", "CUSTOM_RELATIVE_DATE", null],
  ["I post by Friday", "CUSTOM_RELATIVE_DATE", "AMBIGUOUS_PARTY_CONTROLLED"],
  ["who is the best player", null, "AMBIGUOUS_SUBJECTIVE"],
];

for (const [ph, resolverCode, webCode] of L1A) {
  test(`builder refuses ${JSON.stringify(ph)} and says what to change`, () => {
    const g = gateText(ph);
    assert.ok(g.refused, "must be refused");
    assert.equal(g.openDisabled, true, "Open stays disabled");
    const codes = g.problems.map(problemCode);
    if (resolverCode) {
      assert.ok(codes.includes(resolverCode), `resolver lint's ${resolverCode} must be reported, got ${codes}`);
      assert.ok(lintAnySheet(sheetFromCustomForm(typed(ph))).map(problemCode).includes(resolverCode), "...and the resolver-port lint itself reports it");
    }
    if (webCode) assert.ok(codes.includes(webCode), `web gate must report ${webCode}, got ${codes}`);
    const target = g.problems.filter((p: string) => problemCode(p) === (resolverCode ?? webCode));
    assert.ok(target.length > 0 && target.every((p: string) => FIX_HINT.test(p)), `the named problem says what to change: ${target}`);
    assert.ok(g.message.startsWith("Fix term sheet before opening:"));
  });
}
