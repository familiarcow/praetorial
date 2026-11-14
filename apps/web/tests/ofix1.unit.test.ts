// OFIX1 (familiarcow, live mainnet 11-13): a btc_touch bet whose deadline was set ~6 min before "Check the sources" failed with
// "<terms>: We couldn't read this source the way the AI needs to." The resolver refuses an open_utc more than 300 s from its own
// clock (OPEN_UTC_SKEW) and reports it as a "<terms>" row. Fixes under test:
//  1. every source check re-stamps open_utc to the current minute (not only past a 240 s threshold), from a freshly-read chain clock;
//     the chain clock also re-reads when the wall clock and the monotonic clock disagree (a Mac asleep pauses performance.now());
//  2. a "<terms>" row shows the resolver's own reason in plain words, never "couldn't read this source".
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { stampForCheck } from "../lib/openRefresh";
import { buildTypedSheet, canonicalTerms, termsHash, lintTemplate } from "../lib/templates";
import { fieldsFromForm } from "../lib/guidedFields";
import { plainPreflightFailure, plainTermsReason, termsCode } from "../lib/sourcePreflight";
import { preflightView } from "../lib/createFlow";
import { createChainClock } from "../lib/chainClock";

const T0 = Date.parse("2026-11-13T22:49:00Z");
const touch = (nowMs: number) => buildTypedSheet("btc_touch", fieldsFromForm("btc_touch", { direction: "at_or_above", x_usd: "68550", deadline_utc: "2026-11-13T23:45" }, nowMs));
const close = (nowMs: number) => buildTypedSheet("btc_close_at_t", fieldsFromForm("btc_close_at_t", { t_utc: "2026-11-14T12:00", op: ">=", x_usd: "76000" }, nowMs));

test("fake clock: set the deadline, wait 6 min, check -> the checked terms carry the check minute's open_utc", () => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  try {
    const sheet: any = touch(Date.now()); // deadline set at 22:49
    mock.timers.tick(6 * 60_000 + 20_000);
    const p = stampForCheck(sheet, Date.now());
    assert.equal(p.sheet.fields.open_utc, "2026-11-13T22:55:00Z");
    assert.equal(JSON.parse(p.terms).fields.open_utc, "2026-11-13T22:55:00Z");
    assert.equal(p.termsHash, termsHash(canonicalTerms(p.sheet)));
    assert.deepEqual(lintTemplate(p.sheet), []);
    assert.deepEqual({ ...p.sheet.fields, open_utc: null }, { ...sheet.fields, open_utc: null }, "nothing else changes");
  } finally { mock.timers.reset(); }
});

test("every check re-stamps, even inside the old 240 s threshold (first check, recheck, auto-recheck are all the same call)", () => {
  for (const mk of [touch, close]) {
    const s: any = mk(T0);
    const p = stampForCheck(s, T0 + 2 * 60_000 + 5_000);
    assert.equal(p.sheet.fields.open_utc, "2026-11-13T22:51:00Z");
    assert.equal(p.refreshed, true);
    // same minute: same sheet, same hash (an approval key / reviewed hash does not churn for nothing)
    const q = stampForCheck(s, T0 + 30_000);
    assert.equal(q.refreshed, false);
    assert.equal(q.termsHash, termsHash(canonicalTerms(s)));
  }
});

test("any typed sheet with open_utc is stamped; typed sheets without it and custom sheets are left alone", () => {
  const futureTyped: any = { template: { id: "some_future_type", version: 1 }, fields: { a: 1, open_utc: "2026-11-13T22:49:00Z" } };
  assert.equal(stampForCheck(futureTyped, T0 + 600_000).sheet.fields.open_utc, "2026-11-13T22:59:00Z");
  const nws = buildTypedSheet("nws_daily_high", fieldsFromForm("nws_daily_high", { station: "KNYC", date: "2027-12-08", op: ">=", x_f: "72" }, T0));
  for (const s of [nws, { claim: "x", sources_allowed: [] }]) {
    const p = stampForCheck(s, T0 + 3_600_000);
    assert.equal(p.refreshed, false);
    assert.deepEqual(p.sheet, s);
  }
});

/** Everything the failure puts on screen (headline, lines, detail); termsCode is internal and never rendered. */
const shown = (f: ReturnType<typeof plainPreflightFailure>) => [f.headline, ...f.lines.map((l) => `${l.source}: ${l.reason}`), f.detail ?? ""].join("\n");
const terms = (reason: string) => plainPreflightFailure("unreachable", [{ id: "<terms>", reason }], undefined, "one or more sources were unreachable or the check failed");
const RAW: Array<[string, string, RegExp]> = [
  ["OPEN_UTC_SKEW", "OPEN_UTC_SKEW: open_utc 2026-11-13T22:49:00Z is more than 300s from the open clock 2026-11-13T22:55:12Z", /^The start time went stale\. Tap Check again\.$/],
  ["OPEN_T_TOO_SOON", "OPEN_T_TOO_SOON: t_utc 2026-11-13T23:30:00Z must be at least 1h after open (2026-11-13T22:55:12Z)", /at least 1 hour/],
  ["OPEN_DEADLINE_NOT_AFTER_OPEN", "OPEN_DEADLINE_NOT_AFTER_OPEN: deadline_utc 2026-11-13T22:00:00Z is not after open (2026-11-13T22:55:12Z)", /deadline has already passed/],
  ["OPEN_DEADLINE_TOO_FAR", "OPEN_DEADLINE_TOO_FAR: deadline_utc 2031-01-01T00:00:00Z is more than 4 years (1,461 days) after open (2026-11-13T22:55:12Z)", /more than 4 years/],
  ["OPEN_WEATHER_DATE_PAST", "OPEN_WEATHER_DATE_PAST: date 2026-11-12 is already past in KNYC local standard time", /already started|already past/],
  ["OPEN_EVENT_NOT_ON_DATE", "OPEN_EVENT_NOT_ON_DATE: MLB event 849799 is not on the league schedule for 2027-12-28", /isn't on the league schedule/],
  ["OPEN_EVENT_DATE_MISMATCH", "OPEN_EVENT_DATE_MISMATCH: the league payload is for 2027-12-27 but scheduled_date is 2027-12-28", /schedule/],
  ["OPEN_EVENT_UNREADABLE", "OPEN_EVENT_UNREADABLE: the league source answered HTTP 503", /league schedule/],
];

test("a <terms> OPEN_* reply renders the mapped copy as the headline, never 'couldn't read this source' and never the raw code", () => {
  for (const [code, raw, re] of RAW) {
    assert.equal(termsCode([{ id: "<terms>", reason: raw }]), code);
    assert.match(plainTermsReason(raw), re, code);
    const f = terms(raw);
    assert.match(f.headline, re, code);
    const all = shown(f);
    assert.doesNotMatch(all, /couldn't read this source|can't read one of the sources|<terms>|OPEN_|unreachable or the check failed|HTTP/, `${code}: ${all}`);
    assert.equal(f.termsCode, code);
  }
});

test("retry is offered only where checking again can help (stale start time, league schedule unreadable)", () => {
  assert.equal(terms(RAW[0][1]).retry, true);
  assert.equal(terms(RAW[7][1]).retry, true);
  for (const i of [1, 2, 3, 4, 5, 6]) assert.equal(terms(RAW[i][1]).retry, false, RAW[i][0]);
});

test("an unknown <terms> reason (lint / schema) still says the terms are the problem, not a source", () => {
  const f = terms("TPL_X_USD_RANGE: btc_touch.x_usd must be a whole number");
  assert.doesNotMatch(shown(f), /couldn't read this source|can't read one of the sources|<terms>|TPL_/);
  assert.match(f.headline, /terms/i);
});

test("ordinary unreachable sources keep their per-source lines (unchanged)", () => {
  const f = plainPreflightFailure("unreachable", [{ id: "coinbase", reason: "HTTP 403 (non-2xx)" }]);
  assert.match(f.headline, /can't read one of the sources/);
  assert.equal(f.lines[0].source, "coinbase");
  assert.equal(f.termsCode, undefined);
});

test("the button under a stale-start-time failure reads 'Check again' (matches the copy); other failures keep 'Retry'", () => {
  assert.equal(preflightView({ state: "failed", failure: terms(RAW[0][1]), waiting: false }).button?.label, "Check again");
  assert.equal(preflightView({ state: "failed", failure: plainPreflightFailure("timeout", []), waiting: false }).button?.label, "Retry");
});

test("chain clock: a Mac asleep 6 min (performance.now() paused, wall clock moved) is re-read by ensure()", async () => {
  let perf = 1_000, wall = T0, chain = T0;
  let reads = 0;
  const realNow = Date.now;
  (Date as any).now = () => wall;
  try {
    const c = createChainClock({ readBlockMs: async () => { reads++; return chain; }, perfNow: () => perf });
    assert.equal(await c.ensure(60_000), T0);
    // asleep: wall + chain move 6 min, perf does not
    wall += 360_000; chain += 360_000;
    assert.equal(await c.ensure(60_000), T0 + 360_000, "re-read: the monotonic clock missed the sleep");
    assert.equal(reads, 2);
    // awake and in step: no extra read
    perf += 10_000; wall += 10_000; chain += 10_000;
    assert.equal(await c.ensure(60_000), T0 + 370_000);
    assert.equal(reads, 2);
  } finally { (Date as any).now = realNow; }
});
