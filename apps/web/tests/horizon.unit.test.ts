// H1b / D-HORIZON1a (supersedes D-HORIZON1 365d): the web form + bet builder mirror the contract rule
// (resolve_deadline at most 1,461 days (4 years) after open).
import { test } from "node:test";
import assert from "node:assert/strict";
import { blankCustomTermSheet, validateTermSheet, HORIZON_MESSAGE, MAX_HORIZON_MS } from "../lib/termSheet";
import { buildOpenMsg, MAX_HORIZON_NS } from "../lib/escrowAdapter";

const NOW_MS = Date.UTC(2026, 10, 7, 12, 0, 0);
const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function sheet(deadlineMs: number) {
  const ts = blankCustomTermSheet();
  ts.claimText = "BTC above 100k";
  ts.sources = [{ venue: "Coinbase", pair: "BTC-USD", timezone: "UTC" }];
  ts.deadlineUtcIso = iso(deadlineMs);
  return ts;
}

test("H1b: horizon constants are pinned to 1,461 days", () => {
  assert.equal(MAX_HORIZON_MS, 1_461 * 86_400_000);
  assert.equal(MAX_HORIZON_NS, 1_461n * 86_400n * 1_000_000_000n);
});

test("H1b: exactly 1,461 days after now passes the term-sheet validator", () => {
  const flags = validateTermSheet(sheet(NOW_MS + 1461 * DAY_MS), NOW_MS);
  assert.ok(!flags.includes(HORIZON_MESSAGE), flags.join("|"));
});

test("H1b: 366 days and 2 years now pass (D-HORIZON1a ruling change)", () => {
  for (const d of [366, 730]) {
    const flags = validateTermSheet(sheet(NOW_MS + d * DAY_MS), NOW_MS);
    assert.ok(!flags.includes(HORIZON_MESSAGE), flags.join("|"));
  }
});

test("H1b: 1,461 days + 1 ms is flagged with the 4-year message", () => {
  const flags = validateTermSheet(sheet(NOW_MS + 1461 * DAY_MS + 1), NOW_MS);
  assert.ok(flags.includes("Bets can last at most 4 years (D-HORIZON1a)."), flags.join("|"));
});

const att = { checked_at: 1, signature_hex: "b".repeat(128) } as never;
const env = (rdNs: number) => ({ maker_asset: "a", taker_asset: "a", resolve_deadline: rdNs, funding_deadline: 1 }) as never;

test("H1b: web buildOpenMsg refuses resolve_deadline > 1,461d after now", () => {
  const nowNs = NOW_MS * 1e6;
  assert.throws(() => buildOpenMsg(env(nowNs + 1462 * DAY_MS * 1e6), att, null, nowNs), /Bets can last at most 4 years \(D-HORIZON1a\)/);
});

test("H1b: web buildOpenMsg accepts 366 days and 1,460 days", () => {
  const nowNs = NOW_MS * 1e6;
  assert.doesNotThrow(() => buildOpenMsg(env(nowNs + 366 * DAY_MS * 1e6), att, null, nowNs));
  assert.doesNotThrow(() => buildOpenMsg(env(nowNs + 1460 * DAY_MS * 1e6), att, null, nowNs));
});

// JP1 -> D-HORIZON1a: the Jason preset (2028-10-28, ~721 days out) now fits
// via the general horizon rule (no special case); a >4-year preset is still blocked.
import { JASON_TERM_SHEET, PRESET_HORIZON_MESSAGE } from "../lib/termSheet";

test("D-HORIZON1a: Jason preset is no longer flagged for horizon", () => {
  const flags = validateTermSheet(JASON_TERM_SHEET, NOW_MS);
  assert.ok(!flags.includes(PRESET_HORIZON_MESSAGE), flags.join("|"));
  assert.ok(!flags.includes(HORIZON_MESSAGE), flags.join("|"));
});

test("D-HORIZON1a: a preset past 4 years is still blocked", () => {
  const far = { ...JASON_TERM_SHEET, deadlineUtcIso: iso(NOW_MS + 1462 * DAY_MS) };
  const flags = validateTermSheet(far, NOW_MS);
  assert.ok(flags.includes("This bet runs past 4 years; it needs a later contract (D-HORIZON1a)"), flags.join("|"));
  assert.equal(PRESET_HORIZON_MESSAGE, "This bet runs past 4 years; it needs a later contract (D-HORIZON1a)");
});

test("JP1: preset text and deadline unchanged", () => {
  assert.equal(JASON_TERM_SHEET.deadlineUtcIso, "2028-10-28T19:00:00Z");
  assert.ok(JASON_TERM_SHEET.isPreset);
});
