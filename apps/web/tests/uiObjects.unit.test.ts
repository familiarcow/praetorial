// MODAL1b: pure logic behind the shared UI objects (Amount, StatusPill, Countdown, FeeBreakdown, AccountChip, RefereeChip, AssetBadge, Toast).
import test from "node:test";
import assert from "node:assert/strict";
import {
  formatAmount, statusPillFor, countdownText, feeBreakdown, shortAccount, refereeChipFor, assetBadgeFor, toastReducer, MAX_TOASTS, PILL_STATUSES,
} from "../lib/uiObjects";
import { ALL_STATUSES } from "../lib/liveBet";

test("Amount: each of the six assets formats at its own decimals", () => {
  assert.equal(formatAmount("USDC", 1_500_000n), "1.5 USDC");
  assert.equal(formatAmount("USDT", 10_000_000n), "10 USDT");
  assert.equal(formatAmount("BTC", 12_345_678n), "0.12345678 BTC");
  assert.equal(formatAmount("ZEC", 100_000_000n), "1 ZEC");
  assert.equal(formatAmount("ETH", 1_000_000_000_000_000_001n), "1.000000000000000001 ETH");
  assert.equal(formatAmount("NEAR", 1_000_000_000_000_000_000_000_001n), "1.000000000000000000000001 NEAR");
});
test("Amount: dollar coins pad to cents on request; other assets do not", () => {
  assert.equal(formatAmount("USDC", 1_000_000n, { cents: true }), "1.00 USDC");
  assert.equal(formatAmount("USDC", 500_000n, { cents: true }), "0.50 USDC");
  assert.equal(formatAmount("NEAR", 1_000_000_000_000_000_000_000_000n, { cents: true }), "1 NEAR");
});
test("Amount: huge values keep every digit (no float loss); strings and bigints agree; zero; negative", () => {
  const big = "10000000000000000000000000000000000"; // launch max 10^34 raw
  assert.equal(formatAmount("NEAR", big), "10000000000 NEAR");
  assert.equal(formatAmount("ETH", "123456789012345678901234567890"), "123456789012.34567890123456789 ETH");
  assert.equal(formatAmount("ETH", "9007199254740993000000000000"), "9007199254.740993 ETH");
  assert.equal(formatAmount("NEAR", 123n), "0.000000000000000000000123 NEAR");
  assert.equal(formatAmount("USDC", 0n), "0 USDC");
  assert.equal(formatAmount("USDC", "5000000"), formatAmount("USDC", 5_000_000n));
  assert.equal(formatAmount("USDC", -2_500_000n), "-2.5 USDC");
});
test("Amount: symbol-only form and unknown asset", () => {
  assert.equal(formatAmount("USDC", 1_500_000n, { plain: true }), "1.5");
  assert.equal(formatAmount("NEAR", 2_000_000_000_000_000_000_000_000n, { plain: true }), "2");
  assert.throws(() => formatAmount("DOGE", 1n), /unknown asset/);
});

test("StatusPill: a label for every contract status, none duplicated by accident", () => {
  assert.deepEqual([...PILL_STATUSES], ALL_STATUSES);
  const labels: Record<string, string> = {
    Open: "Open", Taken: "Live", Resolving: "Ruling in progress", Proposed: "Ruling made", Challenged: "Challenged", Evidence: "Collecting evidence",
    Rejudge: "Second look", Finalized: "Paying out", Settled: "Done", Voided: "Refunded", Cancelled: "Cancelled", Expired: "Expired",
  };
  for (const s of ALL_STATUSES) {
    const p = statusPillFor(s);
    assert.equal(p.label, labels[s], s);
    assert.ok(p.sentence.length > 0, s);
    assert.ok(["neutral", "info", "warn", "good", "bad"].includes(p.tone), s);
  }
});
test("StatusPill: unknown status is honest, referee name appears in the sentence", () => {
  assert.equal(statusPillFor("Weird").label, "Unknown");
  assert.match(statusPillFor("Taken", "judge.near").sentence, /judge\.near decides/);
  assert.match(statusPillFor("Taken").sentence, /AI decides/);
});

test("Countdown: edge cases", () => {
  const now = 1_000_000_000_000;
  assert.deepEqual(countdownText(now + 65_000, now), { expired: false, text: "1:05", totalSecs: 65 });
  assert.equal(countdownText(now + 59_999, now).text, "0:59");
  assert.equal(countdownText(now + 3_600_000, now).text, "1h 0m");
  assert.equal(countdownText(now + 3 * 3_600_000 + 5 * 60_000 + 59_000, now).text, "3h 5m");
  assert.equal(countdownText(now + 86_400_000, now).text, "1d 0h");
  assert.equal(countdownText(now + 2 * 86_400_000 + 5 * 3_600_000, now).text, "2d 5h");
  assert.deepEqual(countdownText(now, now), { expired: true, text: "0:00", totalSecs: 0 });
  assert.deepEqual(countdownText(now - 5000, now), { expired: true, text: "0:00", totalSecs: 0 });
  assert.equal(countdownText(Number.NaN, now).expired, true);
  assert.equal(countdownText(now + 1, now).expired, false); // sub-second remaining is not expired yet
});

test("FeeBreakdown: parts sum exactly, percent path", () => {
  const b = feeBreakdown({ symbol: "USDC", stakeUnits: 100_000_000n, feeBps: 100, minFeePerSide: 250_000n });
  assert.equal(b.feeUnits, 1_000_000n);
  assert.equal(b.feeUnits + b.afterFeeUnits, b.stakeUnits);
  assert.equal(b.totalUnits, 100_000_000n);
  assert.deepEqual(b.rows.map((r) => r.id), ["stake", "fee"]);
  assert.equal(b.rows[1].text, "1.00 USDC");
});
test("FeeBreakdown: minimum floor, cap at the stake, tip added on top, 24-decimal asset", () => {
  const lo = feeBreakdown({ symbol: "USDC", stakeUnits: 5_000_000n, feeBps: 100, minFeePerSide: 250_000n });
  assert.equal(lo.feeUnits, 250_000n);
  const tiny = feeBreakdown({ symbol: "USDC", stakeUnits: 100_000n, feeBps: 100, minFeePerSide: 250_000n });
  assert.equal(tiny.feeUnits, 100_000n);
  assert.equal(tiny.afterFeeUnits, 0n);
  const tip = feeBreakdown({ symbol: "NEAR", stakeUnits: 3n * 10n ** 24n + 7n, feeBps: 100, minFeePerSide: 0n, tipUnits: 10n ** 23n });
  assert.deepEqual(tip.rows.map((r) => r.id), ["stake", "fee", "tip"]);
  assert.equal(tip.totalUnits, 3n * 10n ** 24n + 7n + 10n ** 23n);
  assert.equal(tip.feeUnits + tip.afterFeeUnits, tip.stakeUnits);
  assert.equal(tip.feeUnits, (3n * 10n ** 24n + 7n) / 100n);
});

test("AccountChip: named accounts stay whole, 64-hex implicit accounts shorten", () => {
  assert.equal(shortAccount("alice.near"), "alice.near");
  const hex = "a".repeat(30) + "b".repeat(34);
  assert.equal(shortAccount(hex), `${"a".repeat(6)}…${"b".repeat(4)}`);
  assert.equal(shortAccount(""), "");
});

test("RefereeChip: AI vs a named person", () => {
  assert.deepEqual(refereeChipFor(null), { kind: "ai", label: "AI referee" });
  assert.deepEqual(refereeChipFor({ account: "judge.near" }), { kind: "human", label: "judge.near" });
});

test("AssetBadge: decimals and enabled state per network", () => {
  const usdc = assetBadgeFor("USDC", "testnet");
  assert.deepEqual([usdc.symbol, usdc.decimals, usdc.enabled, usdc.reason], ["USDC", 6, true, null]);
  const btc = assetBadgeFor("BTC", "testnet");
  assert.equal(btc.enabled, false);
  assert.match(btc.reason ?? "", /mainnet only/);
  assert.equal(assetBadgeFor("BTC", "mainnet").enabled, true);
  assert.equal(assetBadgeFor("ETH", "mainnet").decimals, 18);
  assert.equal(assetBadgeFor("NEAR", "mainnet").decimals, 24);
  assert.equal(assetBadgeFor("ZEC", "mainnet").decimals, 8);
  assert.equal(assetBadgeFor("USDT", "mainnet").decimals, 6);
});

test("Toast: add, dedupe by id, cap, dismiss", () => {
  let s = toastReducer([], { type: "add", toast: { id: "a", tone: "info", text: "One" } });
  s = toastReducer(s, { type: "add", toast: { id: "a", tone: "info", text: "One again" } });
  assert.deepEqual(s.map((t) => t.text), ["One again"]);
  for (let i = 0; i < MAX_TOASTS + 2; i++) s = toastReducer(s, { type: "add", toast: { id: `t${i}`, tone: "success", text: String(i) } });
  assert.equal(s.length, MAX_TOASTS);
  assert.equal(s[s.length - 1].id, `t${MAX_TOASTS + 1}`);
  s = toastReducer(s, { type: "dismiss", id: s[0].id });
  assert.equal(s.length, MAX_TOASTS - 1);
  assert.deepEqual(toastReducer(s, { type: "dismiss", id: "nope" }), s);
});
