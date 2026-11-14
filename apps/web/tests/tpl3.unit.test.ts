// TPL3 (familiarcow 11-12): the custom bet form. (1) no "controlled by a bettor" box: sources are always sent as not party-controlled
// and the plain errors no longer mention a box; (3) "write it with your AI": one prompt (lib/betPrompt, docs/BET-PROMPT.md, the
// /guide/custom-bet page) and a paste box whose JSON fills the form through the SAME lint (never a silent partial fill).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BET_PROMPT, BET_EXAMPLES, AI_FIELDS, parseAiBet } from "../lib/betPrompt";
import { blankCustomForm } from "../lib/customBuilder";
import { blankFill, customSheetFor, fillProblems } from "../lib/betTypePicker";
import { plainProblem } from "../lib/plainErrors";
import { matchRoute, routeRequiresLogin, loginPageLine } from "../lib/router";
import { lintCustom } from "../lib/customLint";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-11-12T17:00:00Z");
const fillOf = (custom: ReturnType<typeof blankCustomForm>) => ({ ...blankFill("custom"), custom });

const VALID = {
  claim: "Apple makes a foldable iPhone available to buy in the US by December 31, 2027.",
  question: "Did Apple make a foldable iPhone available to buy in the US by December 31, 2027?",
  deadline_utc: "2027-12-31T23:59Z",
  sources: [{ name: "Apple Newsroom", url: "https://www.apple.com/newsroom/" }, { name: "Reuters", url: "https://www.reuters.com/technology/" }],
  what_counts: ["A preorder alone does not count; it must be on sale."],
  can_settle_early: true,
};

// ---- ask 1: no party-controlled box --------------------------------------------------------------------------------------

test("TPL3-1: the sheet the UI sends never marks a source party-controlled, even if an old (copied) form had one marked", () => {
  const f = blankCustomForm();
  f.claim = VALID.claim;
  f.sources = [{ publisher: "a", url: "https://a.com/", partyControlled: true }, { publisher: "b", url: "https://b.com/", partyControlled: false }];
  f.windowEnd = "2027-12-31T23:59"; f.windowStart = "2026-11-12T17:00";
  const sheet = customSheetFor(f, false) as { sources_allowed: Array<Record<string, unknown>> };
  assert.equal(sheet.sources_allowed.some((s) => "party_controlled" in s), false);
  assert.deepEqual(sheet.sources_allowed.map((s) => s.id), ["S1", "S2"]);
});

test("TPL3-1: the plain errors for a bettor-controlled claim / too few sources mention no box the user can't see", () => {
  for (const raw of [
    "AMBIGUOUS_PARTY_CONTROLLED: 'I' is something a bettor controls; change it to an outcome neither side controls, or mark the source party-controlled and add two independent sources",
    "need >= 2 independent, non-party-controlled origins (publisher strings that share an origin count once)",
  ]) {
    const p = plainProblem(raw);
    assert.equal(p.mapped, true, raw);
    assert.doesNotMatch(p.text, /controlled by a bettor|mark (that|the) source|box|check/i, p.text);
    assert.match(p.text, /neither of you/i, p.text);
  }
});

// ---- ask 3: the prompt and the paste box ---------------------------------------------------------------------------------

test("TPL3-3: the prompt states the rules and the fixed JSON shape (every field named)", () => {
  for (const k of AI_FIELDS) assert.ok(BET_PROMPT.includes(`"${k}"`), k);
  assert.match(BET_PROMPT, /neither (of us|bettor)/i);
  assert.match(BET_PROMPT, /UTC/);
  assert.match(BET_PROMPT, /YES or NO/);
  assert.match(BET_PROMPT, /evidence/i);
  assert.match(BET_PROMPT, /only the JSON/i);
});

test("TPL3-3: docs/BET-PROMPT.md carries the exact prompt and the 3 worked examples (no drift from the page)", () => {
  const md = readFileSync(join(here, "../../../docs/BET-PROMPT.md"), "utf8");
  assert.ok(md.includes(BET_PROMPT), "prompt text differs from lib/betPrompt.ts BET_PROMPT");
  assert.equal(BET_EXAMPLES.length, 3);
  for (const ex of BET_EXAMPLES) {
    assert.ok(md.includes(ex.ask), ex.title);
    assert.ok(md.includes(JSON.stringify(ex.json, null, 2)), ex.title);
  }
});

test("TPL3-3: every worked example pastes cleanly and passes the normal checks (builder gate + custom lint)", () => {
  for (const ex of BET_EXAMPLES) {
    const r = parseAiBet(JSON.stringify(ex.json), NOW);
    assert.equal(r.ok, true, `${ex.title}: ${!r.ok && r.error}`);
    if (!r.ok) continue;
    assert.deepEqual(fillProblems(fillOf(r.form), NOW), [], ex.title);
    assert.deepEqual(lintCustom(customSheetFor(r.form, false)), [], ex.title);
  }
});

test("TPL3-3 paste valid: fills claim, question, deadline (UTC), sources (never party-controlled), rules, and passes the checks", () => {
  const r = parseAiBet(JSON.stringify(VALID), NOW);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.form.claim, VALID.claim);
  assert.deepEqual(r.form.elements, [VALID.question]);
  assert.equal(r.form.windowEnd, "2027-12-31T23:59");
  assert.equal(r.form.windowStart, "2026-11-12T17:00");
  assert.deepEqual(r.form.sources, [
    { publisher: "Apple Newsroom", url: "https://www.apple.com/newsroom/", partyControlled: false },
    { publisher: "Reuters", url: "https://www.reuters.com/technology/", partyControlled: false },
  ]);
  assert.deepEqual(r.form.leadingDefinitions, VALID.what_counts);
  assert.deepEqual(r.ignored, []);
  assert.deepEqual(fillProblems(fillOf(r.form), NOW), []);
});

test("TPL3-3 paste valid: the AI's usual wrapping (```json fences, text around it) is tolerated; optional fields default", () => {
  const { question: _q, what_counts: _w, can_settle_early: _c, ...min } = VALID;
  const r = parseAiBet("Here is your bet:\n```json\n" + JSON.stringify(min, null, 2) + "\n```\nGood luck!", NOW);
  assert.equal(r.ok, true, !r.ok ? r.error : "");
  if (!r.ok) return;
  assert.deepEqual(r.form.elements, [""]); // blank: the judge checks the claim as written (BET1a default)
  assert.equal(r.form.earlyRule, blankCustomForm().earlyRule);
  assert.deepEqual(fillProblems(fillOf(r.form), NOW), []);
});

test("TPL3-3 paste: can_settle_early false writes an only-at-the-deadline rule the lint accepts", () => {
  const r = parseAiBet(JSON.stringify({ ...VALID, can_settle_early: false }), NOW);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.form.earlyRule, /only at the deadline/i);
  assert.deepEqual(fillProblems(fillOf(r.form), NOW), []);
});

test("TPL3-3 paste invalid: not JSON / empty / not an object -> a plain error, no form", () => {
  for (const bad of ["", "   ", "{ claim: 'x' ", "hello", "[1,2]", "null", "42"]) {
    const r = parseAiBet(bad, NOW);
    assert.equal(r.ok, false, JSON.stringify(bad));
    if (r.ok) continue;
    assert.ok(!("form" in r));
    assert.doesNotMatch(r.error, /JSON\.parse|Unexpected token|SyntaxError|undefined/);
    assert.ok(r.error.length > 10 && r.error.length < 200, r.error);
  }
});

test("TPL3-3 paste missing fields: names every missing field in one plain error, no form", () => {
  const r = parseAiBet(JSON.stringify({ claim: VALID.claim }), NOW);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /deadline_utc/);
  assert.match(r.error, /sources/);
  assert.doesNotMatch(r.error, /claim/);
  const blank = parseAiBet(JSON.stringify({ ...VALID, claim: "  " }), NOW);
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.match(blank.error, /claim/);
});

test("TPL3-3 paste wrong shapes: a deadline without UTC, a past deadline, under 2 sources, a non-https link -> plain error, no form", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...VALID, deadline_utc: "2027-12-31T23:59" }, /UTC/],
    [{ ...VALID, deadline_utc: "Dec 31 2027" }, /deadline_utc/],
    [{ ...VALID, deadline_utc: "2025-01-01T00:00Z" }, /past/],
    [{ ...VALID, sources: [VALID.sources[0]] }, /two/i],
    [{ ...VALID, sources: "reuters" }, /sources/],
    [{ ...VALID, sources: [VALID.sources[0], { name: "x", url: "ftp://x.com" }] }, /link/i],
    [{ ...VALID, what_counts: "x" }, /what_counts/],
    [{ ...VALID, can_settle_early: "yes" }, /can_settle_early/],
    [{ ...VALID, question: 5 }, /question/],
  ];
  for (const [json, re] of cases) {
    const r = parseAiBet(JSON.stringify(json), NOW);
    assert.equal(r.ok, false, JSON.stringify(json));
    if (!r.ok) assert.match(r.error, re, r.error);
  }
});

test("TPL3-3 paste extra fields: ignored (named back to the user), the known fields still fill", () => {
  const r = parseAiBet(JSON.stringify({ ...VALID, party_controlled: true, judge_model: "gpt-9", sources: VALID.sources.map((s) => ({ ...s, party_controlled: true })) }), NOW);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.ignored.sort(), ["judge_model", "party_controlled"]);
  assert.equal(r.form.sources.every((s) => s.partyControlled === false), true);
  assert.deepEqual(fillProblems(fillOf(r.form), NOW), []);
});

test("TPL3-3 paste: a bet the lint refuses still fills, and the normal checks then report it (the paste does not bypass them)", () => {
  const r = parseAiBet(JSON.stringify({ ...VALID, claim: "I post a video by next Friday." }), NOW);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(fillProblems(fillOf(r.form), NOW).length > 0);
});

// ---- the guide page is public ---------------------------------------------------------------------------------------------

test("TPL3-3: /guide/custom-bet is a route that does not require login (familiarcow: reachable without login); others still do", () => {
  assert.deepEqual(matchRoute("/guide/custom-bet"), { name: "guide" });
  assert.deepEqual(matchRoute("/guide/custom-bet/"), { name: "guide" });
  assert.equal(routeRequiresLogin({ name: "guide" }), false);
  // DOCS1: About became the Docs, which are public too (tests/docs1Routes.unit.test.ts); every other route still needs login
  for (const r of [{ name: "home" }, { name: "account" }, { name: "new" }, { name: "bet", id: 7 }, { name: "not-found" }] as const) {
    assert.equal(routeRequiresLogin(r), true, r.name);
  }
  assert.equal(typeof loginPageLine({ name: "guide" }), "string");
});
