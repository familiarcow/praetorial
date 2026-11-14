// RFRZ2c offline unit test (written BEFORE the live run): expected money per party for an AI wNEAR bet that the taker concedes,
// the >5h event-window rule, and the "real storage line" check for the review card. Numbers in FIXTURE are the raw chain values
// of DR6 bet 8 (wNEAR 3/side on frz2; same escrow wasm caf134a4 as frz3), so the expectation is anchored to a real settlement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedMoney, windowDeadlineUtc, WINDOW_HOURS, MIN_WINDOW_HOURS, storageLineIsReal, STAKE_TOKEN_ID } from "../plan.js";

const FIXTURE = {
  envelope: { maker: "m", stake_maker: "3000000000000000000000000", stake_taker: "3000000000000000000000000", fee_bps: 100, maker_side: "YES", maker_asset: "nep141:wrap.testnet", taker_asset: "nep141:wrap.testnet" },
  status: "Taken", taker: "t", fee_min_maker: "135869565217391304347826", fee_min_taker: "135869565217391304347826", storage_maker: "17160000000000000000000", storage_taker: "17160000000000000000000",
};

test("taker concedes: maker gets 2*(stake - side_fee), fee account 2*(side_fee+storage), taker 0, escrow residue 0 (DR6 bet 8 raw numbers)", () => {
  const m = expectedMoney(FIXTURE);
  assert.equal(m.maker, 5_728_260_869_565_217_391_304_348n);
  assert.equal(m.fee, 306_059_130_434_782_608_695_652n);
  assert.equal(m.taker, 0n);
  assert.equal(m.maker + m.fee + m.taker, 2n * 3_000_000_000_000_000_000_000_000n + 2n * 17_160_000_000_000_000_000_000n); // conservation
  assert.equal(m.escrowResidue, 0n);
});

test("stake token is nep141:wrap.testnet (the app's NEAR) and the window is longer than 5 h", () => {
  assert.equal(STAKE_TOKEN_ID, "nep141:wrap.testnet");
  assert.ok(MIN_WINDOW_HOURS === 5 && WINDOW_HOURS > 5);
  const now = new Date("2026-11-10T12:00:30Z");
  const dl = windowDeadlineUtc(now);
  assert.equal(dl, "2026-11-10T18:00"); // minute resolution, UTC, WINDOW_HOURS = 6
  assert.ok(new Date(dl + ":00Z").getTime() - now.getTime() > 5 * 3_600_000);
});

test("review card storage line must be a real NEAR amount, not the placeholder", () => {
  assert.equal(storageLineIsReal("0.01716 NEAR"), true);
  assert.equal(storageLineIsReal("≈ 0.017 NEAR"), true);
  assert.equal(storageLineIsReal("not available"), false);
  assert.equal(storageLineIsReal("Not available yet"), false);
  assert.equal(storageLineIsReal(""), false);
  assert.equal(storageLineIsReal("— NEAR"), false);
});

test("the 'loading from the contract...' placeholder is not a real storage line either", () => {
  assert.equal(storageLineIsReal("loading from the contract..."), false);
});

// RFRZ2d: the web renders no "concede-tx" element (only concede-result), so the run captured null. The tx hash is taken from chain history by method.
import { findTxByMethod, moneyMismatches } from "../plan.js";
const HIST = [
  { hash: "K1", methods: ["request_resolution"], tsNs: "5" },
  { hash: "C1", methods: ["Delegate", "concede", "on_payout_result"], tsNs: "4" },
  { hash: "O1", methods: ["mt_on_transfer"], tsNs: "1" },
];
test("findTxByMethod returns the hash of the tx whose receipts include the method, undefined if none", () => {
  assert.equal(findTxByMethod(HIST, "concede"), "C1");
  assert.equal(findTxByMethod(HIST, "mt_on_transfer"), "O1");
  assert.equal(findTxByMethod(HIST, "cancel"), undefined);
});

test("moneyMismatches: exact deltas pass; any off-by-one or residue is reported", () => {
  const exp = { maker: 10n, taker: 0n, fee: 2n, escrowResidue: 0n };
  const mid = { maker: 100n, taker: 50n, fee: 7n, escrow: 12n }, before = { escrow: 0n };
  assert.deepEqual(moneyMismatches(exp, mid, { maker: 110n, taker: 50n, fee: 9n, escrow: 0n }, { escrow: 0n }), []);
  assert.equal(moneyMismatches(exp, mid, { maker: 109n, taker: 50n, fee: 9n, escrow: 0n }, before).length, 1);
  assert.equal(moneyMismatches(exp, mid, { maker: 110n, taker: 51n, fee: 9n, escrow: 1n }, before).length, 2);
});
