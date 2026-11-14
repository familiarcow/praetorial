// MODAL1c2: pure logic of the Take bet FlowModal (steps, exact amounts, result mapping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { TAKE_STEPS, takeTerms, takeFlowResult, takePayRows, takeResultText } from "../lib/takeBetFlow";
import { TAKEN_BY_ME, TAKE_PENDING } from "../lib/takeView";

const NS = 1_800_000_000n * 1_000_000_000n;
const bet = (env: Record<string, any> = {}): any => ({
  status: "Open", taker: null, storage_rates: new Proxy({}, { get: () => "457" }) as any, fee_min_taker: "500000",
  envelope: { maker: "maker.testnet", taker_asset: "nep141:usdc.testnet", stake_taker: "10000000", fee_bps: 100, resolve_deadline: Number(NS), referee: { account: "ref.testnet", mode: "Human" }, taker_options: [], ...env },
});

test("M1 (UX-37 #5): Take is ONE confirm step", () => {
  assert.deepEqual(TAKE_STEPS.map((s) => s.id), ["confirm"]);
});

test("M1: the pay box says what leaves your balance now (stake + tiny storage), the exact fee and its rule; no raw floats", () => {
  const rows = takePayRows(takeTerms(bet(), { tip: false }));
  assert.deepEqual(rows.map((r) => r.id), ["pay-now", "fee"]);
  const pay = rows.find((r) => r.id === "pay-now")!;
  assert.equal(pay.label, "You pay now");
  assert.match(pay.value, /^10\.00 USDC \(\+ (< 0\.01|\d+\.\d\d) USDC storage\)$/);
  const fee = rows.find((r) => r.id === "fee")!;
  assert.match(fee.value, /^0\.50 USDC, taken from your stake only if someone wins$/);
});

test("M1: with the tip on, the pay box names the tip (out of the stake, not on top)", () => {
  const rows = takePayRows(takeTerms(bet(), { tip: true }));
  const tip = rows.find((r) => r.id === "tip")!;
  assert.equal(tip.label, "Referee tip");
  assert.match(tip.value, /^0\.50 USDC, out of your stake$/);
});

test("M1 (SM2 M1-1): the result words come from takeView (TAKEN_BY_ME / TAKE_PENDING), not inline text", () => {
  assert.equal(takeResultText("success", null), TAKEN_BY_ME);
  assert.equal(takeResultText("pending", null), TAKE_PENDING);
  assert.equal(takeResultText("failure", "Someone else took it first."), "Someone else took it first.");
});

test("takeTerms: exact stake, fee (minimum floor), storage and pay-now in the asset's own decimals", () => {
  const t = takeTerms(bet(), { tip: false });
  assert.equal(t.symbol, "USDC");
  assert.equal(t.stakeUnits, 10_000_000n);
  assert.equal(t.feeUnits, 500_000n);
  assert.equal(t.tipUnits, 0n);
  assert.equal(t.payNowUnits, t.stakeUnits + t.storageUnits);
  assert.equal(t.texts.stake, "10.00 USDC");
  assert.equal(t.texts.fee, "0.50 USDC");
  assert.equal(t.texts.tip, null);
  assert.match(t.loseText, /10\.00 USDC/);
});

test("takeTerms: a tip comes out of the stake, never on top", () => {
  const t = takeTerms(bet(), { tip: true });
  assert.equal(t.tipUnits, 500_000n);
  assert.equal(t.texts.tip, "0.50 USDC");
  assert.equal(t.payNowUnits, t.stakeUnits + t.storageUnits);
  assert.match(t.loseText, /out of that stake|not on top/);
});

test("takeTerms: no tip in AI mode even when asked", () => {
  const t = takeTerms(bet({ referee: null }), { tip: true });
  assert.equal(t.tipUnits, 0n);
  assert.equal(t.texts.tip, null);
});

test("takeFlowResult: taken is success with the tx; pending is pending; every other outcome is a failure with a plain reason", () => {
  assert.deepEqual(takeFlowResult({ kind: "taken", message: "You took this bet. It's live now." }, "TX1"), { kind: "success", txHash: "TX1", message: "You took this bet. It's live now." });
  assert.deepEqual(takeFlowResult({ kind: "pending", message: "Still confirming." }, "TX1"), { kind: "pending", txHash: "TX1", message: "Still confirming." });
  for (const k of ["lost", "gone", "refused", "failed", "declined"]) {
    const r = takeFlowResult({ kind: k, message: `m-${k}` }, null);
    assert.deepEqual(r, { kind: "failure", reason: `m-${k}` });
  }
});
