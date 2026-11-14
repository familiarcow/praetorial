// DR3W1 (DR3 F1): an offer on an already-started climate day must stay takeable for a real window after review/sourcecheck.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fundingDeadlineSecs, MIN_TAKER_WINDOW_SECS, openWindowProblem } from "../lib/offerExpiry";
import { deriveDeadlines } from "../lib/templates";

const NOW = Date.UTC(2026, 10, 11, 15, 0, 0) / 1000; // 15:00 UTC, mid climate day for KNYC (day 2026-11-11 starts 05:00 UTC)
const sheet = { template: { id: "nws_daily_high", version: 1 }, fields: { station: "KNYC", date: "2026-11-11", op: ">=", x_f: 60 } } as any;

test("floor for a started day is a taker window, not now+60s", () => {
  assert.ok(MIN_TAKER_WINDOW_SECS >= 15 * 60);
  const d = fundingDeadlineSecs({ latestSecs: NOW - 3600, nowSecs: NOW, expirySecs: 86400 });
  assert.equal(d.secs, NOW + MIN_TAKER_WINDOW_SECS);
});

test("deriveDeadlines on a started climate day leaves the taker the window minus a 120s sourcecheck+review", () => {
  const f = Number(deriveDeadlines(sheet, NOW, { expirySecs: 86400 }).fundingDeadlineNs / 1_000_000_000n);
  assert.ok(f - (NOW + 120) >= 10 * 60, `only ${f - (NOW + 120)}s left after a 120s sourcecheck`);
});

test("an event that ends before the taker window is refused with a plain message", () => {
  assert.equal(openWindowProblem({ endSecs: NOW + 3600, nowSecs: NOW }), null);
  assert.match(openWindowProblem({ endSecs: NOW + 60, nowSecs: NOW })!, /too late|not enough time|ends/i);
  assert.throws(() => deriveDeadlines(sheet, Date.UTC(2026, 10, 12, 4, 55, 0) / 1000, {}), /OPEN_WINDOW_TOO_SHORT/);
});
