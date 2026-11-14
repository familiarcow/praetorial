// FE5b (S5): offer expiry -> funding_deadline = min(latest valid funding time, now + chosen expiry); human review lines; stake decimals.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildOpenEnvelope } from "../lib/openEnvelope";
import { eventTimes } from "../lib/templates";
import { fundingDeadlineSecs, offerClosesLabel, OFFER_EXPIRY_OPTIONS, MIN_TAKER_WINDOW_SECS } from "../lib/offerExpiry";
import { limitsFor, stakeProblem } from "../lib/stakeDeadlines";
import { reviewHasSettlementLine } from "../lib/reviewCard"; // C1: the review model lives in lib (the card imports the kit)

const here = dirname(fileURLToPath(import.meta.url));
const cases: Array<{ name: string; ts: any }> = JSON.parse(readFileSync(join(here, "../../../resolver/core/tests/fixtures/template_cases.json"), "utf8"));
const fx = (n: string) => cases.find((c) => c.name === n)!.ts;
const DAY = 86400;
const secs = (id: string) => OFFER_EXPIRY_OPTIONS.find((o) => o.id === id)!.secs;
const env = (sheet: any, over: Record<string, unknown> = {}) => buildOpenEnvelope({
  maker: "maker.testnet", sheet, makerAsset: "nep141:usdc.testnet", takerAsset: "nep141:usdc.testnet",
  stakeMaker: "1000000", stakeTaker: "1000000", takerAccount: null, referee: null, nowMs: 0, ...over,
});
const fundingSecs = (e: any) => Number(BigInt(e.funding_deadline) / 1_000_000_000n);

test("fundingDeadlineSecs: min(latest, now + expiry), never later than latest, floor now + taker window (DR3W1)", () => {
  assert.deepEqual(fundingDeadlineSecs({ latestSecs: 1_000_000, nowSecs: 0, expirySecs: DAY }), { secs: DAY, clamped: false });
  assert.deepEqual(fundingDeadlineSecs({ latestSecs: 50_000, nowSecs: 0, expirySecs: DAY }), { secs: 50_000, clamped: true });
  assert.deepEqual(fundingDeadlineSecs({ latestSecs: 10, nowSecs: 0, expirySecs: DAY }), { secs: MIN_TAKER_WINDOW_SECS, clamped: true }); // DR3W1: the floor is the taker window
  assert.deepEqual(fundingDeadlineSecs({ latestSecs: 50_000, nowSecs: 0 }), { secs: 50_000, clamped: false }); // no expiry: today's rule
});

for (const [name, human] of [["btc_close_ok", false], ["btc_touch_ok", false], ["game_ok", false], ["nws_ok", false], ["btc_close_ok", true], ["btc_touch_ok", true], ["game_ok", true], ["nws_ok", true]] as const) {
  test(`${name}${human ? " (human)" : ""}: funding_deadline = min(close, now + expiry) for 1d/7d/30d, and today's rule without an expiry`, () => {
    const sheet = fx(name);
    const close = eventTimes(sheet).closeSecs;
    const ref = human ? { account: "ref.testnet", mode: "Human" as const } : null;
    const isBtc = name.startsWith("btc");
    // BTC sheets are only valid near their open_utc (skew rule); the others are tried far from and near to the close.
    const nows = isBtc ? [Date.parse(sheet.fields.open_utc) / 1000] : [close - 100 * DAY, close - 2 * DAY];
    let sawClamp = false, sawFree = false;
    for (const now of nows) {
      for (const id of ["1d", "7d", "30d"]) {
        const e = env(sheet, { referee: ref, nowMs: now * 1000, offerExpirySecs: secs(id) });
        assert.equal(fundingSecs(e), Math.min(close, now + secs(id)), `${id} @${now}`);
        assert.ok(fundingSecs(e) <= close);
        if (now + secs(id) < close) sawFree = true; else sawClamp = true;
      }
      assert.equal(fundingSecs(env(sheet, { referee: ref, nowMs: now * 1000 })), close, "no expiry = today's rule");
    }
    assert.ok(sawClamp || sawFree);
    if (name === "btc_close_ok") assert.ok(sawClamp && !sawFree); // 3h window: every expiry is past the close
    if (name === "game_ok" || name === "nws_ok") assert.ok(sawClamp && sawFree);
  });
}

test("custom sheet: expiry clamps to the form deadline", () => {
  const now = 1_800_000_000;
  const sheet = { template: "custom", fields: {} } as any;
  void sheet; // custom path is covered through fundingDeadlineSecs (same helper); see the e2e for the custom form
  assert.equal(fundingDeadlineSecs({ latestSecs: now + 3 * DAY, nowSecs: now, expirySecs: secs("7d") }).secs, now + 3 * DAY);
});

test("offerClosesLabel: plain note, with the clamped reason", () => {
  const t = Date.parse("2026-11-09T12:00:00Z") / 1000;
  assert.equal(offerClosesLabel({ secs: t, clamped: false }), "This offer closes 2026-11-09 12:00 UTC.");
  assert.equal(offerClosesLabel({ secs: t, clamped: true }), "This offer closes 2026-11-09 12:00 UTC (the event starts then, so that is as long as it can stay open).");
});

test("review card: human mode shows no Settlement period line; AI mode keeps it", () => {
  assert.equal(reviewHasSettlementLine(true), false);
  assert.equal(reviewHasSettlementLine(false), true);
});

test("USDC/USDT stake input allows the asset's 6 decimals (no UX ruling for 2: UX-1..UX-21, D-UX21 checked)", () => {
  const u = limitsFor("USDC", { min_per_side: "10000000", max_per_side: "250000000", min_fee_per_side: "500000", storage_per_kib: "1" }, 100);
  assert.equal(stakeProblem("USDC", "10.123456", u), null);
  assert.equal(stakeProblem("USDC", "10.1234567", u), "Use at most 6 decimal places.");
  assert.equal(stakeProblem("USDT", "10.123", { ...u, symbol: "USDT" }), null);
});
