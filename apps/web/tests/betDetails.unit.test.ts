// BET1a (UX-33 section 2): the "any web page" Details step shows only claim + deadline (local time, stored UTC) + 2 links;
// everything else sits under "More options" with defaults derived from what was typed. The lint is unchanged: these tests
// pin the defaults (all taken from existing template code) and the lint-problem -> field mapping that opens "More options".
process.env.TZ = "America/New_York";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DETAILS_EVIDENCE_TAIL_MS, MORE_OPTION_FIELDS, defaultQuestion, detailFieldsFor, localInputToUtc, publisherFromUrl,
  utcToLocalInput, withDetailDefaults, withDeadline,
} from "../lib/betDetails";
import { blankFill, customSheetFor, fillProblems, type FillState } from "../lib/betTypePicker";
import { blankCustomForm, type CustomForm } from "../lib/customBuilder";
import { RECOVERY_SECS } from "../lib/templates";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-11-08T12:00:30Z");
const CLAIM = "Apple makes a foldable iPhone available to buy in the US during 2027.";

/** Only what the Details step shows: claim, deadline, two links. */
const minimal = (): CustomForm => withDeadline({
  ...blankCustomForm(),
  claim: CLAIM,
  sources: [{ publisher: "", url: "https://www.apple.com/newsroom/", partyControlled: false }, { publisher: "", url: "https://www.reuters.com/technology/", partyControlled: false }],
}, "2027-12-31T23:59", NOW);
const fill = (c: CustomForm, human = false): FillState => ({ ...blankFill("custom"), custom: c, human });

test("local deadline input <-> stored UTC minute (America/New_York)", () => {
  assert.equal(utcToLocalInput("2027-12-31T23:59"), "2027-12-31T18:59");
  assert.equal(localInputToUtc("2027-12-31T18:59"), "2027-12-31T23:59");
  assert.equal(utcToLocalInput("2027-07-01T12:00"), "2027-07-01T08:00", "daylight time");
  assert.equal(localInputToUtc("2027-07-01T08:00"), "2027-07-01T12:00");
  assert.equal(utcToLocalInput(""), "");
  assert.equal(localInputToUtc(""), "");
  assert.equal(localInputToUtc("2027-12"), "");
});

test("claim + deadline + two links is a complete bet: no lint problems", () => {
  assert.deepEqual(fillProblems(fill(minimal()), NOW), []);
  assert.deepEqual(fillProblems(fill(minimal(), true), NOW), [], "person decides: same minimal form is enough");
});

// CFIX1 (PM, 11-13): was "stamped once and never moved"; the rule is now "set to now every time the deadline is picked, unless typed
// by hand". A preset/copied value (no app stamp) is still kept. More cases in cfix1.unit.test.ts.
test("setting the deadline stamps the window start to now (whole UTC minute); re-picking it re-stamps; a preset value is kept", () => {
  const f = minimal();
  assert.equal(f.windowEnd, "2027-12-31T23:59");
  assert.equal(f.windowStart, "2026-11-08T12:00");
  const later = withDeadline(f, "2028-01-31T00:00", NOW + 86400_000);
  assert.equal(later.windowStart, "2026-11-09T12:00", "the app's own stamp follows the latest deadline pick (now), never the deadline");
  assert.equal(withDeadline({ ...blankCustomForm(), windowStart: "2027-01-01T00:00" }, "2027-02-01T00:00", NOW).windowStart, "2027-01-01T00:00");
});

test("defaults come from the existing template code: evidence tail = 7 days (D-RESOLVE1), question = the claim, publisher = the link's site", () => {
  assert.equal(DETAILS_EVIDENCE_TAIL_MS, RECOVERY_SECS * 1000);
  const d = withDetailDefaults(minimal());
  assert.equal(d.evidenceCutoff, "2028-01-07T23:59");
  assert.deepEqual(d.elements, [defaultQuestion(CLAIM)]);
  assert.equal(defaultQuestion(CLAIM), "Is this true: Apple makes a foldable iPhone available to buy in the US during 2027?");
  assert.equal(defaultQuestion("  "), "");
  assert.deepEqual(d.sources.map((s) => s.publisher), ["apple.com", "reuters.com"]);
  assert.equal(publisherFromUrl("https://news.bbc.co.uk/x"), "news.bbc.co.uk");
  assert.equal(publisherFromUrl("not a url"), "");
  // the fallback / early rules and clauses were already defaults of blankCustomForm; unchanged
  assert.equal(d.fallbackRule, blankCustomForm().fallbackRule);
  assert.equal(d.earlyRule, blankCustomForm().earlyRule);
  assert.deepEqual(d.clauses, blankCustomForm().clauses);
});

test("anything typed in More options wins over the default", () => {
  const f = minimal();
  f.elements = ["Did Apple sell a foldable iPhone in the US between 2027-01-01 and 2027-12-31 UTC?"];
  f.sources[1].publisher = "Reuters";
  f.evidenceCutoff = "2028-01-02T00:00";
  const d = withDetailDefaults(f);
  assert.deepEqual(d.elements, f.elements);
  assert.deepEqual(d.sources.map((s) => s.publisher), ["apple.com", "Reuters"]);
  assert.equal(d.evidenceCutoff, "2028-01-02T00:00");
});

test("the sheet sent for review carries the defaults (and stays the resolver format)", () => {
  const s: any = customSheetFor(minimal(), false);
  assert.equal(s.claim, CLAIM);
  assert.deepEqual(s.elements, [{ id: "e1", q: defaultQuestion(CLAIM) }]);
  assert.deepEqual(s.time, { evidence_cutoff: "2028-01-07T23:59:00Z", window_end: "2027-12-31T23:59:00Z", window_start: "2026-11-08T12:00:00Z" });
  assert.deepEqual(s.sources_allowed, [{ id: "S1", publisher: "apple.com", url: "https://www.apple.com/newsroom/" }, { id: "S2", publisher: "reuters.com", url: "https://www.reuters.com/technology/" }]);
  const h: any = customSheetFor(minimal(), true);
  assert.equal(h.time.evidence_cutoff, "2027-12-31T23:59:00Z", "person decides: cutoff stays the end of the window (unchanged)");
  // deterministic: the same form gives the same sheet (no clock read)
  assert.deepEqual(customSheetFor(minimal(), false), customSheetFor(minimal(), false));
});

test("a lint problem names the field to open; More-options fields are listed", () => {
  const F = (m: string) => detailFieldsFor([m], blankCustomForm());
  assert.deepEqual(F("CUSTOM_RELATIVE_DATE: the claim uses ..."), ["claim"]);
  assert.deepEqual(F("AMBIGUOUS_NO_TIMEZONE: the time ..."), ["claim"]);
  assert.deepEqual(F("missing field: claim"), ["claim"]);
  assert.deepEqual(F("time.window_end must be UTC ISO8601"), ["deadline"]);
  assert.deepEqual(F("need >= 2 independent, non-party-controlled origins"), ["links"]);
  assert.deepEqual(F("element 0 too long (narrow questions only)"), ["elements"]);
  assert.deepEqual(F("time.window_start must be UTC ISO8601"), ["windowStart"]);
  assert.deepEqual(F("time.evidence_cutoff must be UTC ISO8601"), ["evidenceCutoff"]);
  assert.deepEqual(F("no fallback-source rule specified"), ["fallbackRule"]);
  assert.deepEqual(F("no early-settlement rule specified"), ["earlyRule"]);
  assert.deepEqual(F("no wick-vs-close rule: claim references a price level"), ["rules"]);
  assert.deepEqual(F("PRICE_READING_UNDEFINED: the claim is a price-level claim"), ["rules"]);
  assert.deepEqual(F("fork/ticker not pinned per venue (D-RESOLVE1): no ticker_pins"), ["sourceDetails"]);
  assert.deepEqual(F("source name 'x' is not allowed"), ["sourceDetails"]);
  assert.deepEqual(F("unknown clause FOO"), ["clauses"]);
  // a claim problem also points at typed questions, which carry the same wording checks
  const typed = { ...blankCustomForm(), elements: ["Did it happen next week?"] };
  assert.deepEqual(detailFieldsFor(["CUSTOM_RELATIVE_DATE: x"], typed), ["claim", "elements"]);
  for (const f of ["elements", "sourceDetails", "windowStart", "evidenceCutoff", "fallbackRule", "earlyRule", "rules", "clauses"] as const) assert.ok(MORE_OPTION_FIELDS.includes(f), f);
  for (const f of ["claim", "deadline", "links"] as const) assert.ok(!MORE_OPTION_FIELDS.includes(f), f);
});

test("a price claim with exchange links is flagged into More options (rules + market name), never silently defaulted", () => {
  const f = minimal();
  f.claim = "Bitcoin price is at or above $200000 on 2027-12-31 at 23:59 UTC.";
  f.sources = [{ publisher: "", url: "https://www.coinbase.com/", partyControlled: false }, { publisher: "", url: "https://www.bitstamp.net/", partyControlled: false }];
  const p = fillProblems(fill(f), NOW);
  const fields = detailFieldsFor(p, f);
  assert.ok(fields.includes("rules"), JSON.stringify(p));
  assert.ok(fields.includes("sourceDetails"), JSON.stringify(p));
});

test("UI wiring: the person-decides checkbox is gone from Details; Details lives in its own component with More options", () => {
  const fs = readFileSync(join(here, "../src/components/FillStep.tsx"), "utf8");
  const bd = readFileSync(join(here, "../src/components/BetDetails.tsx"), "utf8");
  assert.ok(!fs.includes("fill-human-toggle") && !bd.includes("fill-human-toggle"));
  assert.ok(!fs.includes("A person decides this bet") && !bd.includes("A person decides this bet"));
  assert.ok(fs.includes("BetDetails"));
  for (const id of ["cb-claim", "cb-deadline", "cb-source-url-", "details-more-toggle", "details-more"]) assert.ok(bd.includes(id), id);
  const co = readFileSync(join(here, "../src/components/CreateOffer.tsx"), "utf8");
  assert.ok(co.includes('referee.mode === "human"'), "CreateOffer keeps the human state (Who decides sets it)");
});
