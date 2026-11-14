// FE5 (S5, D-UX21, D-MINSTAKE1/D-PARAMS1/D-FEEMIN1/2/D-HORIZON1a/UX-11): stake limits, live fee, settlement window, resolve deadline, named taker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SETTLEMENT_OPTIONS, OFFER_EXPIRY_OPTIONS, limitsFor, sideFee, formatUnits, feeInfo, stakeProblem, defaultResolveSecs, resolveProblem, expiryProblem, takerProblem, MAX_RESOLVE_SECS } from "../lib/stakeDeadlines";
import { buildOpenEnvelope } from "../lib/openEnvelope";
import { toBaseUnits, findAsset } from "../lib/assets";
import { feeForSideUnits } from "../lib/escrowAdapter";

const USDC_VIEW = { min_per_side: "10000000", max_per_side: "250000000", min_fee_per_side: "500000", storage_per_kib: "1" };
const usdc = limitsFor("USDC", USDC_VIEW, 100);

test("limits come from the asset_limit view, not the constants (D-PARAMS1 may change with notice)", () => {
  assert.equal(usdc.minPerSide, 10_000_000n);
  assert.equal(usdc.maxPerSide, 250_000_000n);
  const changed = limitsFor("USDC", { ...USDC_VIEW, min_per_side: "20000000", min_fee_per_side: "1000000" }, 100);
  assert.equal(changed.minPerSide, 20_000_000n);
  assert.equal(changed.minFeePerSide, 1_000_000n);
});
test("a view without limit fields falls back to the release-args table; fee_bps from the view when given", () => {
  const l = limitsFor("USDC", { storage_per_kib: "1" }, null);
  assert.equal(l.minPerSide, 10_000_000n);
  assert.equal(l.feeBps, 100);
  assert.equal(limitsFor("USDC", null, 250).feeBps, 250);
});

test("fee display equals side_fee for 10, 50, 100 USDC (6 dp), in token units -- never $ (UX-31/UX-33)", () => {
  for (const [stake, want] of [["10", "0.50 USDC"], ["50", "0.50 USDC"], ["100", "1.00 USDC"]] as const) {
    const units = BigInt(toBaseUnits("USDC", stake));
    const f = feeInfo("USDC", units, usdc);
    assert.equal(f.units, sideFee(units, 100, usdc.minFeePerSide));
    assert.equal(f.units, feeForSideUnits(units, usdc.minFeePerSide));
    assert.equal(f.each, want);
  }
});
test("the $1 floor (D-FEEMIN2) is read live: min fee 1,000,000 floors a $10 and a $50 stake at $1.00", () => {
  const l = limitsFor("USDC", { ...USDC_VIEW, min_fee_per_side: "1000000" }, 100);
  assert.equal(feeInfo("USDC", 10_000_000n, l).each, "1.00 USDC");
  assert.equal(feeInfo("USDC", 50_000_000n, l).each, "1.00 USDC");
  assert.equal(feeInfo("USDC", 200_000_000n, l).each, "2.00 USDC");
});
test("fee never exceeds the stake (min(stake, ...))", () => {
  assert.equal(sideFee(300_000n, 100, 500_000n), 300_000n);
});
test("fee line: minimum and the stake where the percentage takes over come from the view", () => {
  assert.equal(feeInfo("USDC", 10_000_000n, usdc).line, "Fee: 0.50 USDC each (0.50 USDC minimum per person, 1% from 50 USDC).");
  const l = limitsFor("USDC", { ...USDC_VIEW, min_fee_per_side: "1000000" }, 100);
  assert.equal(feeInfo("USDC", 10_000_000n, l).line, "Fee: 1.00 USDC each (1.00 USDC minimum per person, 1% from 100 USDC).");
});
test("fee display per asset decimals: BTC 8 dp, NEAR 24 dp, ETH 18 dp equal side_fee exactly", () => {
  for (const sym of ["BTC", "NEAR", "ETH", "ZEC", "USDT"]) {
    const a = findAsset(sym)!;
    const l = limitsFor(sym, null, null);
    for (const mult of [1n, 7n, 100n, 5000n]) {
      const stake = l.minPerSide * mult;
      const f = feeInfo(sym, stake, l);
      assert.equal(f.units, sideFee(stake, 100, BigInt(a.minFeePerSide!)), sym);
      assert.equal(f.exact, formatUnits(f.units, a.decimals), sym);
    }
  }
  assert.equal(formatUnits(659n, 8), "0.00000659");
});

test("stake validation: minimum, maximum, two decimals, fee (exact messages)", () => {
  assert.equal(stakeProblem("USDC", "10", usdc), null);
  assert.equal(stakeProblem("USDC", "9.99", usdc), "Minimum stake is 10 USDC");
  assert.equal(stakeProblem("USDC", "250.01", usdc), "Maximum stake is 250 USDC");
  assert.equal(stakeProblem("USDC", "250", usdc), null);
  assert.equal(stakeProblem("USDC", "10.1234567", usdc), "Use at most 6 decimal places."); // FE5b: asset decimals (no 2-place ruling)
  assert.equal(stakeProblem("USDC", "", usdc), "Enter your stake.");
  assert.equal(stakeProblem("USDC", "abc", usdc), "Enter your stake.");
  assert.equal(stakeProblem("USDC", "0", usdc), "Minimum stake is 10 USDC");
});
test("the stake must cover the fee when a live minimum fee is raised above the stake", () => {
  const odd = limitsFor("USDC", { ...USDC_VIEW, min_per_side: "1000000", min_fee_per_side: "1000000" }, 100);
  assert.equal(stakeProblem("USDC", "1", odd), "The stake has to be more than the fee (1.00 USDC).");
});
test("the launch max (10^34) is not shown as a user-reachable cap; a lowered max is", () => {
  const l = limitsFor("USDC", { ...USDC_VIEW, max_per_side: "10000000000000000000000000000000000" }, 100);
  assert.equal(stakeProblem("USDC", "1000000", l), null);
});
test("non-dollar assets use the asset's own precision and name", () => {
  const near = limitsFor("NEAR", { min_per_side: "10000000000000000000000000", max_per_side: "50000000000000000000000000", min_fee_per_side: "1" }, 100);
  assert.equal(stakeProblem("NEAR", "9", near), "Minimum stake is 10 NEAR");
  assert.equal(stakeProblem("NEAR", "51", near), "Maximum stake is 50 NEAR");
  assert.equal(stakeProblem("NEAR", "10.000000000000000000000001", near), null);
});

test("settlement window offers 1h, 6h, 24h only; the 7d option is gone", () => {
  assert.deepEqual(SETTLEMENT_OPTIONS.map((o) => o.id), ["1h", "6h", "24h"]);
  assert.deepEqual(SETTLEMENT_OPTIONS.map((o) => o.secs), [3600, 21600, 86400]);
  assert.deepEqual(OFFER_EXPIRY_OPTIONS.map((o) => o.id), ["1d", "7d", "30d"]);
});

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0) / 1000;
const DAY = 86400;
test("human resolve deadline: default = event + 1 year; cap = 4 years (1,461 days) from now", () => {
  const ev = NOW + 30 * DAY;
  assert.equal(defaultResolveSecs(ev), ev + 365 * DAY);
  assert.equal(MAX_RESOLVE_SECS, 1461 * DAY);
  assert.equal(resolveProblem({ resolveSecs: NOW + 1461 * DAY, eventSecs: ev, nowSecs: NOW }), null);
  assert.equal(resolveProblem({ resolveSecs: NOW + 1461 * DAY + 1, eventSecs: ev, nowSecs: NOW }), "That date is more than 4 years away.");
  assert.equal(resolveProblem({ resolveSecs: ev, eventSecs: ev, nowSecs: NOW }), "The deadline has to be after the event.");
  assert.equal(resolveProblem({ resolveSecs: ev + 1, eventSecs: ev, nowSecs: NOW }), null);
});
test("offer expiry has to come before the resolve deadline", () => {
  assert.equal(expiryProblem({ expirySecs: NOW + 30 * DAY, resolveSecs: NOW + 400 * DAY }), null);
  assert.equal(expiryProblem({ expirySecs: NOW + 30 * DAY, resolveSecs: NOW + 20 * DAY }), "The offer has to expire before the resolve deadline.");
});
test("named taker: not the maker, not the referee, a real account", () => {
  assert.equal(takerProblem("", { maker: "me.near", referee: null }), null);
  assert.equal(takerProblem("alice.near", { maker: "me.near", referee: "bob.near" }), null);
  assert.equal(takerProblem("me.near", { maker: "me.near", referee: null }), "You can't name yourself.");
  assert.equal(takerProblem("bob.near", { maker: "me.near", referee: "bob.near" }), "The person who takes the bet can't also be the referee.");
  assert.equal(takerProblem("nodots", { maker: "me.near", referee: null }), "That doesn't look like a valid account.");
});

test("buildOpenEnvelope carries the chosen settlement window and human resolve deadline", () => {
  const sheet = { template: { id: "btc_touch", version: 1 }, fields: { direction: "at_or_above", x_usd: 100000, open_utc: "2026-11-08T12:00:00Z", deadline_utc: "2026-12-08T12:00:00Z" } };
  const nowMs = Date.parse("2026-11-08T12:00:00Z");
  const base = { maker: "m.near", sheet, makerAsset: "a", takerAsset: "a", stakeMaker: "10000000", stakeTaker: "10000000", takerAccount: null, nowMs };
  const ai: any = buildOpenEnvelope({ ...base, referee: null, settlementSecs: 6 * 3600 });
  assert.equal(ai.settlement_period, 6 * 3600 * 1e9);
  const dflt: any = buildOpenEnvelope({ ...base, referee: null });
  assert.equal(dflt.settlement_period, 24 * 3600 * 1e9);
  assert.throws(() => buildOpenEnvelope({ ...base, referee: null, settlementSecs: 7 * 86400 }), /settlement/i);
  const resolveSecs = Date.parse("2028-01-01T00:00:00Z") / 1000;
  const h: any = buildOpenEnvelope({ ...base, referee: { account: "bob.near", mode: "Human" }, resolveSecs });
  assert.equal(BigInt(h.resolve_deadline), BigInt(resolveSecs) * 1_000_000_000n);
  assert.throws(() => buildOpenEnvelope({ ...base, referee: { account: "bob.near", mode: "Human" }, resolveSecs: nowMs / 1000 + 1462 * 86400 }), /OPEN_DEADLINE_TOO_FAR/);
});
