// CFIX1 (PM, live mainnet 11-13 19:55 ET): New bet -> Anything else -> Deadline 25 Nov 12:59 PM ET showed "Counts from (UTC)"
// 11/25/2026 05:59 PM, i.e. the deadline. Rules under test:
//  1. picking the deadline sets windowStart to NOW (UTC, minute floor) unless the person typed it; it is never the deadline;
//  2. a typed windowStart is kept; one at/after the deadline is a problem that blocks Next (and maps to the windowStart field);
//  3. the source check re-stamps an untouched windowStart to the check minute (the OFIX1 rule), never a typed one.
process.env.TZ = "America/New_York";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WINDOW_START_ORDER_PROBLEM, detailFieldsFor, localInputToUtc, windowOrderProblems, windowStartIsAuto, withDeadline, withWindowStart } from "../lib/betDetails";
import { blankFill, customSheetFor, fillProblems, type FillState } from "../lib/betTypePicker";
import { blankCustomForm, type CustomForm } from "../lib/customBuilder";
import { stampForCheck } from "../lib/openRefresh";
import { canonicalTerms, termsHash } from "../lib/templates";
import { plainProblem } from "../lib/plainErrors";
import { parseAiBet } from "../lib/betPrompt";

const NOW = Date.parse("2026-11-14T00:55:41Z"); // Fri 11-13 19:55:41 ET
const base = (): CustomForm => ({
  ...blankCustomForm(),
  claim: "Apple makes a foldable iPhone available to buy in the US during 2027.",
  sources: [{ publisher: "", url: "https://www.apple.com/newsroom/", partyControlled: false }, { publisher: "", url: "https://www.reuters.com/technology/", partyControlled: false }],
});
const fill = (c: CustomForm): FillState => ({ ...blankFill("custom"), custom: c });
const DEADLINE = localInputToUtc("2026-11-25T12:59"); // the repro's 25 Nov 12:59 PM ET

test("Live repro: picking the deadline sets Counts from to now (minute floor), not the deadline", () => {
  assert.equal(DEADLINE, "2026-11-25T17:59");
  const f = withDeadline(base(), DEADLINE, NOW);
  assert.equal(f.windowStart, "2026-11-14T00:55");
  assert.notEqual(f.windowStart, f.windowEnd);
  assert.equal(windowStartIsAuto(f), true);
  assert.deepEqual(fillProblems(fill(f), NOW), []);
});

test("every deadline pick re-stamps an untouched Counts from to that moment, whatever was there", () => {
  let f = withDeadline(base(), "2026-12-01T00:00", NOW);
  f = withDeadline(f, DEADLINE, NOW + 7 * 60_000);
  assert.equal(f.windowStart, "2026-11-14T01:02");
  // an untouched value that somehow equals the deadline is replaced by now on the next pick
  f = withDeadline({ ...f, windowStart: DEADLINE }, DEADLINE, NOW);
  assert.equal(f.windowStart, "2026-11-14T00:55");
  // clearing the deadline clears the app's stamp
  assert.equal(withDeadline(f, "", NOW).windowStart, "");
});

test("a Counts from typed by hand is kept when the deadline changes", () => {
  let f = withDeadline(base(), DEADLINE, NOW);
  f = withWindowStart(f, "2026-11-10T09:00", NOW);
  assert.equal(windowStartIsAuto(f), false);
  f = withDeadline(f, "2026-12-31T12:00", NOW + 3_600_000);
  assert.equal(f.windowStart, "2026-11-10T09:00");
  assert.deepEqual(fillProblems(fill(f), NOW), []);
  // clearing it hands it back to the app: now
  const cleared = withWindowStart(f, "", NOW);
  assert.equal(cleared.windowStart, "2026-11-14T00:55");
  assert.equal(windowStartIsAuto(cleared), true);
});

test("a preset/copied Counts from (no app stamp) is kept, as before", () => {
  const f = withDeadline({ ...base(), windowStart: "2026-11-01T00:00" }, DEADLINE, NOW);
  assert.equal(f.windowStart, "2026-11-01T00:00");
  assert.equal(windowStartIsAuto(f), false);
});

test("Counts from at or after the deadline is a problem: blocks Next, points at the windowStart field, plain words", () => {
  const at = withWindowStart(withDeadline(base(), DEADLINE, NOW), DEADLINE, NOW);
  const after = withWindowStart(withDeadline(base(), DEADLINE, NOW), "2026-11-26T00:00", NOW);
  for (const f of [at, after]) {
    assert.deepEqual(windowOrderProblems(f), [WINDOW_START_ORDER_PROBLEM]);
    const p = fillProblems(fill(f), NOW);
    assert.ok(p.includes(WINDOW_START_ORDER_PROBLEM), p.join("|"));
    assert.deepEqual(detailFieldsFor(p, f), ["windowStart"]);
    assert.match(plainProblem(WINDOW_START_ORDER_PROBLEM).text, /Counts from.*before the deadline/);
  }
  const ok = withWindowStart(withDeadline(base(), DEADLINE, NOW), "2026-11-25T17:58", NOW);
  assert.deepEqual(windowOrderProblems(ok), []);
  assert.deepEqual(windowOrderProblems(withDeadline(base(), "", NOW)), [], "nothing to compare yet");
});

test("the flag is UI state only: the sheet is the same with or without it", () => {
  const f = withDeadline(base(), DEADLINE, NOW);
  assert.deepEqual(customSheetFor(f, false), customSheetFor({ ...f, windowStartAuto: undefined }, false));
  assert.equal((customSheetFor(f, false) as any).time.window_start, "2026-11-14T00:55:00Z");
});

test("source check: an untouched Counts from is re-stamped to the check minute; a typed one, and no flag, leave it alone", () => {
  const sheet: any = customSheetFor(withDeadline(base(), DEADLINE, NOW), false);
  const later = NOW + 6 * 60_000 + 20_000;
  const p = stampForCheck(sheet, later, { windowStart: true });
  assert.equal(p.sheet.time.window_start, "2026-11-14T01:02:00Z");
  assert.equal(p.refreshed, true);
  assert.equal(p.termsHash, termsHash(canonicalTerms(p.sheet)));
  assert.equal(JSON.parse(p.terms).time.window_start, "2026-11-14T01:02:00Z");
  assert.deepEqual({ ...p.sheet, time: { ...p.sheet.time, window_start: null } }, { ...sheet, time: { ...sheet.time, window_start: null } }, "nothing else changes");
  const same = stampForCheck(sheet, NOW + 10_000, { windowStart: true });
  assert.equal(same.refreshed, false, "same minute: same terms");
  assert.deepEqual(stampForCheck(sheet, later).sheet, sheet, "typed by hand (no flag): kept");
  assert.deepEqual(stampForCheck(sheet, later, { windowStart: false }).sheet, sheet);
});

test("the AI paste stamps now too (and is re-stamped on the next deadline pick)", () => {
  const r = parseAiBet(JSON.stringify({
    claim: "Apple makes a foldable iPhone available to buy in the US during 2027.", deadline_utc: "2026-11-25T17:59Z",
    sources: [{ url: "https://www.apple.com/newsroom/" }, { url: "https://www.reuters.com/technology/" }],
  }), NOW);
  assert.ok(r.ok, JSON.stringify(r));
  if (r.ok) { assert.equal(r.form.windowStart, "2026-11-14T00:55"); assert.equal(windowStartIsAuto(r.form), true); }
});
