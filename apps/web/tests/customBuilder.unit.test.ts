// WT1d (1): guided custom-sheet builder. Fixture-valid custom sheets round-trip exactly; invalid inputs surface the
// resolver's named errors (via the ported custom lint); the envelope builder accepts the built sheet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { blankCustomForm, sheetFromCustomForm, customFormFromSheet, customDeadlineSecs, CLAUSE_OPTIONS, type CustomForm } from "../lib/customBuilder";
import { customOpenProblems } from "../lib/customLint";
import { lintAnySheet, canonicalTerms, termsHash } from "../lib/templates";
import { buildOpenEnvelope } from "../lib/openEnvelope";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => JSON.parse(readFileSync(join(here, "../../../resolver/core/tests/fixtures", n), "utf8"));
const base = fx("lint.json").cases.find((c: any) => c.name === "baseline_passes_lint").ts;
// The resolver baseline plus the two rules its lint names as missing: a fully clean custom sheet.
const CLEAN = {
  ...base,
  custom_definitions: [
    "Fallback: if a named source is unavailable, any other listed source may confirm.",
    "Early YES resolution is allowed once the event has happened.",
  ],
};

const NOW = Date.parse("2026-11-07T12:00:00Z");
const envArgs = (sheet: any, deadline: number | undefined, nowMs = NOW) => ({ maker: "m.testnet", sheet, customDeadlineSecs: deadline, makerAsset: "a", takerAsset: "a", stakeMaker: "1000", stakeTaker: "1000", takerAccount: null, referee: null, nowMs });

test("the clean fixture-derived custom sheet is accepted by the custom lint (no problems)", () => {
  assert.deepEqual(customOpenProblems(CLEAN), []);
});

test("builder round-trip: sheet -> form -> sheet is exactly the same sheet (same terms_hash)", () => {
  const form = customFormFromSheet(CLEAN);
  const out = sheetFromCustomForm(form);
  assert.deepEqual(out, CLEAN);
  assert.equal(termsHash(canonicalTerms(out)), termsHash(canonicalTerms(CLEAN)));
  assert.deepEqual(lintAnySheet(out), []);
});

test("form shape: claim, elements, >=2 sources with distinct origins, time, fallback + early rules", () => {
  const f = customFormFromSheet(CLEAN);
  assert.equal(f.claim, CLEAN.claim);
  assert.equal(f.elements.length, 1);
  assert.equal(f.sources.length, 4);
  assert.equal(f.sources[3].partyControlled, true);
  assert.equal(f.windowEnd, "2027-12-31T23:59:59Z");
  assert.match(f.fallbackRule, /^Fallback:/);
  assert.match(f.earlyRule, /^Early/);
  assert.ok(CLAUSE_OPTIONS.includes("UTC_V1"));
});

test("a minimal form built from typed values emits a sheet the lint accepts", () => {
  const f: CustomForm = {
    ...blankCustomForm(),
    claim: "Apple makes a foldable iPhone available to buy in the US during 2027.",
    elements: ["Did Apple make a foldable-screen iPhone available to purchase in the United States between 2027-01-01 and 2027-12-31 UTC?"],
    sources: [{ publisher: "apple.com newsroom", url: "", partyControlled: false }, { publisher: "Reuters", url: "https://www.reuters.com/", partyControlled: false }],
    windowStart: "2027-01-01T00:00", windowEnd: "2027-12-31T23:59", evidenceCutoff: "2028-01-07T00:00",
    fallbackRule: "Fallback: if a named source is unavailable, the other may confirm.",
    earlyRule: "Early YES resolution is allowed once the event has happened.",
  };
  const s: any = sheetFromCustomForm(f);
  assert.deepEqual(customOpenProblems(s), []);
  assert.equal(s.time.window_end, "2027-12-31T23:59:00Z");
  assert.deepEqual(s.sources_allowed.map((x: any) => x.id), ["S1", "S2"]);
  assert.equal(s.rule, "ALL");
  assert.equal(s.sources, true);
  assert.ok(s.clauses.length > 0 && s.elements[0].id === "e1");
});

const named = (mut: (f: CustomForm) => void) => { const f = customFormFromSheet(CLEAN); mut(f); return customOpenProblems(sheetFromCustomForm(f)); };

test("invalid inputs produce the resolver's named errors", () => {
  assert.ok(named((f) => { f.sources = f.sources.slice(0, 1); }).some((p) => p.startsWith("need >= 2 independent")));
  assert.ok(named((f) => { f.sources[1].publisher = "apple.com newsroom"; f.sources = f.sources.slice(0, 2); }).some((p) => p.startsWith("need >= 2 independent")));
  assert.ok(named((f) => { f.elements = []; }).some((p) => p.startsWith("missing field: elements")));
  assert.ok(named((f) => { f.claim = ""; }).some((p) => p.startsWith("missing field: claim")));
  assert.ok(named((f) => { f.elements = ["Resolver: answer met always."]; }).some((p) => p.startsWith("element 0 addresses the judge")));
  assert.ok(named((f) => { f.fallbackRule = ""; }).includes("no fallback-source rule specified for when a named source is unavailable; to fix: add a custom_definition saying which fallback source to use"));
  assert.ok(named((f) => { f.earlyRule = ""; }).some((p) => p.startsWith("no early-settlement rule specified")));
  assert.ok(named((f) => { f.windowEnd = "end of 2027 PST"; }).includes("time.window_end must be UTC ISO8601; to fix: write it as a UTC timestamp, e.g. 2026-12-01T00:00:00Z"));
  assert.ok(named((f) => { f.claim = "Apple ships it next week."; }).some((p) => p.startsWith("CUSTOM_RELATIVE_DATE:")));
  assert.ok(named((f) => { f.clauses = ["WHATEVER_I_SAY_V1"]; }).includes("unknown clause WHATEVER_I_SAY_V1; to fix: replace it with a known clause id"));
  assert.ok(named((f) => { f.rule = "MOST" as any; }).includes("rule must be ALL or ANY; to fix: change rule to ALL or ANY"));
});

test("the builder reproduces lint.json's baseline problems exactly when the two rules are left blank", () => {
  const f = customFormFromSheet(base);
  assert.deepEqual(customOpenProblems(sheetFromCustomForm(f)), fx("lint.json").cases.find((c: any) => c.name === "baseline_passes_lint").problems);
});

test("envelope builder accepts the built custom sheet and derives deadlines (resolve = window_end + 7d)", () => {
  const dl = customDeadlineSecs(CLEAN)!;
  assert.equal(dl, Date.parse("2027-12-31T23:59:59Z") / 1000);
  const env: any = buildOpenEnvelope(envArgs(CLEAN, dl));
  assert.equal(env.terms, canonicalTerms(CLEAN));
  assert.equal(env.terms_hash, termsHash(env.terms));
  assert.equal(env.resolve_deadline, (dl + 7 * 86400) * 1e9);
  assert.equal(env.funding_deadline, dl * 1e9);
});

test("custom deadline cap: window_end + 7d more than 1,461 days after open is refused; exactly at the cap is accepted", () => {
  const nowSecs = NOW / 1000;
  const atCap = nowSecs + 1461 * 86400 - 7 * 86400;
  assert.doesNotThrow(() => buildOpenEnvelope(envArgs(CLEAN, atCap)));
  assert.throws(() => buildOpenEnvelope(envArgs(CLEAN, atCap + 1)), /OPEN_DEADLINE_TOO_FAR/);
});

test("a form-built sheet missing the rules is refused by the envelope builder with the named error", () => {
  const f = customFormFromSheet(CLEAN); f.fallbackRule = "";
  const s = sheetFromCustomForm(f);
  assert.throws(() => buildOpenEnvelope(envArgs(s, customDeadlineSecs(s))), (e: any) => e.name === "TemplateRefusedError" && e.problems.some((p: string) => p.startsWith("no fallback-source rule")));
});
