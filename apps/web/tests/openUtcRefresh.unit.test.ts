// WT1d (2): open_utc for BTC types is refreshed at Open time; a review screen held past OPEN_UTC_SKEW still opens.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { OPEN_UTC_SKEW_SECS, openUtcSkewProblems, prepareSheetForOpen } from "../lib/openRefresh";
import { buildTypedSheet, canonicalTerms, termsHash, lintTemplate } from "../lib/templates";
import { fieldsFromForm } from "../lib/guidedFields";
import { buildOpenEnvelope } from "../lib/openEnvelope";

const here = dirname(fileURLToPath(import.meta.url));
const cases: any[] = JSON.parse(readFileSync(join(here, "../../../resolver/core/tests/fixtures/template_cases.json"), "utf8"));
const fxs = (n: string) => cases.find((c) => c.name === n)!.ts;
const T0 = Date.parse("2026-11-07T12:00:00Z");
const form = { t_utc: "2026-11-09T12:00", op: ">=", x_usd: "76000" };
const mkBtc = (nowMs: number) => buildTypedSheet("btc_close_at_t", fieldsFromForm("btc_close_at_t", form, nowMs));
const args = (sheet: any, nowMs: number) => ({ maker: "m.testnet", sheet, makerAsset: "a", takerAsset: "a", stakeMaker: "1000", stakeTaker: "1000", takerAccount: null, referee: null, nowMs });

test("skew constant matches the resolver (300s)", () => { assert.equal(OPEN_UTC_SKEW_SECS, 300); });

test("openUtcSkewProblems names OPEN_UTC_SKEW like the resolver (> 300s either side), clean within", () => {
  const s = mkBtc(T0);
  assert.deepEqual(openUtcSkewProblems(s, T0 + 300_000), []);
  assert.ok(openUtcSkewProblems(s, T0 + 301_000)[0].startsWith("OPEN_UTC_SKEW:"));
  assert.ok(openUtcSkewProblems(s, T0 - 301_000)[0].startsWith("OPEN_UTC_SKEW:"));
  assert.deepEqual(openUtcSkewProblems(fxs("nws_ok"), T0), []); // non-BTC types carry no open_utc
});

test("buildOpenEnvelope refuses a stale BTC sheet with the named skew error (never opens a sheet the resolver would refuse)", () => {
  assert.throws(() => buildOpenEnvelope(args(mkBtc(T0), T0 + 10 * 60_000)), (e: any) => e.name === "TemplateRefusedError" && e.problems[0].startsWith("OPEN_UTC_SKEW:"));
});

test("a review held 20 minutes: prepareSheetForOpen re-stamps open_utc to the Open minute, lints clean, and rehashes", () => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  try {
    const reviewed = mkBtc(Date.now());
    const reviewedHash = termsHash(canonicalTerms(reviewed));
    mock.timers.tick(20 * 60_000);
    const p = prepareSheetForOpen(reviewed, Date.now(), reviewedHash);
    assert.equal(p.refreshed, true);
    assert.equal(p.from, "2026-11-07T12:00:00Z");
    assert.equal((p.sheet as any).fields.open_utc, "2026-11-07T12:20:00Z");
    assert.deepEqual(lintTemplate(p.sheet), []);
    assert.deepEqual(openUtcSkewProblems(p.sheet, Date.now()), []);
    assert.equal(p.termsHash, termsHash(canonicalTerms(p.sheet)));
    assert.notEqual(p.termsHash, reviewedHash);
    assert.equal(p.requiresReconfirm, true, "the user reviewed different terms (and the source-check attestation is bound to the old hash)");
    const env: any = buildOpenEnvelope(args(p.sheet, Date.now()));
    assert.equal(env.terms_hash, p.termsHash);
    assert.equal(env.terms, p.terms);
    assert.equal(JSON.parse(env.terms).fields.open_utc, "2026-11-07T12:20:00Z");
    // all other typed fields are untouched
    assert.deepEqual({ ...(p.sheet as any).fields, open_utc: null }, { ...(reviewed as any).fields, open_utc: null });
  } finally { mock.timers.reset(); }
});

test("a fresh review is left alone: same sheet, same hash, no reconfirm", () => {
  const s = mkBtc(T0);
  const h = termsHash(canonicalTerms(s));
  const p = prepareSheetForOpen(s, T0 + 90_000, h);
  assert.equal(p.refreshed, false);
  assert.equal(p.termsHash, h);
  assert.equal(p.requiresReconfirm, false);
  assert.deepEqual(p.sheet, s);
});

test("btc_touch is refreshed too; non-BTC types (game, nws) and custom sheets are never touched", () => {
  const touch = buildTypedSheet("btc_touch", fieldsFromForm("btc_touch", { direction: "at_or_above", x_usd: "80000", deadline_utc: "2026-12-07T12:00" }, T0));
  const p = prepareSheetForOpen(touch, T0 + 3_600_000, termsHash(canonicalTerms(touch)));
  assert.equal(p.refreshed, true);
  assert.equal((p.sheet as any).fields.open_utc, "2026-11-07T13:00:00Z");
  for (const s of [fxs("game_ok"), fxs("nws_ok"), { claim: "x" }]) {
    const q = prepareSheetForOpen(s, T0 + 3_600_000, termsHash(canonicalTerms(s)));
    assert.equal(q.refreshed, false); assert.deepEqual(q.sheet, s);
  }
});

test("the review card and open handler show/confirm the final hashed terms", () => {
  // C1 (UIR1 §3.4, familiarcow UX-37 #5): the review says in Full terms that the start time is refreshed at Open (and asks again); the raw
  // sha256 fingerprint is no longer printed (the terms hash is checked in Verify on the bet page).
  const rm = readFileSync(join(here, "../lib/reviewCard.ts"), "utf8");
  assert.ok(rm.includes('"restamp"') && rm.includes("open_utc"));
  assert.ok(!readFileSync(join(here, "../src/components/ReviewCard.tsx"), "utf8").includes("review-terms-hash"));
  const app = readFileSync(join(here, "../src/App.tsx"), "utf8");
  // OFIX1: the check stamps open_utc every time (stampForCheck); the Open path re-stamps a stale approval via approvalGate ->
  // prepareSheetForOpen (RESTAMP_MESSAGE). Both halves are pinned.
  assert.ok(app.includes("stampForCheck(offerSheet(offer)"));
  assert.ok(/approvalGate\(/.test(app));
  assert.ok(readFileSync(join(here, "../lib/openApproval.ts"), "utf8").includes("prepareSheetForOpen(approval.sheet"));
  // FE3 (D-UX21): the custom builder moved out of CreateOffer into the fill-in step (FillStep) + lib/betTypePicker.
  // BET1a: the "any page" fields are BetDetails.tsx, mounted by FillStep.
  const fs = readFileSync(join(here, "../src/components/FillStep.tsx"), "utf8") + readFileSync(join(here, "../src/components/BetDetails.tsx"), "utf8");
  const bp = readFileSync(join(here, "../lib/betTypePicker.ts"), "utf8");
  assert.ok(bp.includes("sheetFromCustomForm") && fs.includes("custom-builder"));
});
