// LNT1: the web builder gate vs the resolver custom lint, from ONE shared table (fixtures/lint_parity/cases.json, also read by
// resolver/core/tests/lint_parity.rs). Every ambiguous phrasing is refused with the case's AMBIGUOUS_* code; every control passes;
// and EVERY problem the web gate / lint ports return carries a "what to change" hint (PT1's strict form, restored).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { blankCustomForm, sheetFromCustomForm, type CustomForm } from "../lib/customBuilder";
import { lintAnySheet, problemCode } from "../lib/templates";
import { lintCustom } from "../lib/customLint";
import { builderGate } from "../lib/builderGate";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const table = JSON.parse(readFileSync(join(root, "fixtures/lint_parity/cases.json"), "utf8"));
const fx = (n: string) => JSON.parse(readFileSync(join(root, "resolver/core/tests/fixtures", n), "utf8"));
const FIX_HINT = /\b(state|write|use|name|replace|remove|add|change|pin|say|pick|specify|give)\b/i;

const typed = (phrasing: string): CustomForm => ({
  ...blankCustomForm(), claim: phrasing, elements: [phrasing],
  sources: [{ publisher: "Reuters", url: "https://www.reuters.com/", partyControlled: false }, { publisher: "Associated Press", url: "https://apnews.com/", partyControlled: false }],
  windowStart: "2026-11-08T00:00", windowEnd: "2026-11-09T17:00", evidenceCutoff: "2026-11-09T18:00",
});
const gate = (ph: string) => builderGate(sheetFromCustomForm(typed(ph)));
const AMB = (c: string) => c.startsWith("AMBIGUOUS_") || c === "CUSTOM_RELATIVE_DATE";

test("shared table is non-trivial and covers every AMBIGUOUS_* rule in builderGate", () => {
  const src = readFileSync(join(here, "../lib/builderGate.ts"), "utf8");
  const rules = [...src.matchAll(/code: "(AMBIGUOUS_[A-Z_]+)"/g)].map((m) => m[1]).sort();
  assert.ok(rules.length >= 8);
  assert.deepEqual(table.ambiguous.map((g: any) => g.code).sort(), rules);
  for (const g of table.ambiguous) assert.ok(g.variants.length >= 5, g.code);
});

for (const grp of table.ambiguous) {
  for (const ph of grp.variants as string[]) {
    test(`web gate refuses ${JSON.stringify(ph)} with ${grp.code}`, () => {
      const g = gate(ph);
      assert.ok(g.refused && g.openDisabled);
      assert.ok(g.problems.map(problemCode).includes(grp.code), `want ${grp.code}, got ${g.problems.map(problemCode)}`);
    });
  }
}

for (const c of table.controls) {
  test(`control ${c.id} passes the web gate`, () => {
    const g = gate(c.phrasing);
    assert.deepEqual(g.problems.map(problemCode).filter(AMB), []);
    if (c.full_pass) { assert.deepEqual(g.problems, []); assert.equal(g.openDisabled, false); }
  });
}

test("EVERY web problem carries a what-to-change hint (ambiguous cases, controls, lint.json, template_cases, examples)", () => {
  const all: string[] = [];
  for (const grp of table.ambiguous) for (const ph of grp.variants) all.push(...gate(ph).problems);
  for (const c of table.controls) all.push(...gate(c.phrasing).problems);
  for (const c of fx("lint.json").cases) all.push(...lintCustom(c.ts), ...builderGate(c.ts).problems);
  for (const c of fx("template_cases.json")) all.push(...lintAnySheet(c.ts), ...builderGate(c.ts).problems);
  for (const e of JSON.parse(readFileSync(join(root, "services/e2e/live-L1/examples.json"), "utf8")).examples) if (e.sheet) all.push(...builderGate(e.sheet).problems);
  assert.ok(all.length >= 100, `sample too small: ${all.length}`);
  const missing = [...new Set(all.filter((p) => !FIX_HINT.test(p)))];
  assert.deepEqual(missing, [], "problems with no what-to-change hint");
});
