// FE16b (S18): no money from stale reads, 429 "Busy, retrying in Ns" + auto retry, "This page is out of date. Refresh."
import { test } from "node:test";
import assert from "node:assert/strict";
import { COPY, moneyBlocked, showMoney, busyText, parseRetryAfter, outOfDateReason, globalBanners } from "../lib/globalStates";
import { retryOn429 } from "../lib/rateLimit";

test("moneyBlocked: offline, failed view, or out of date blocks money; otherwise not", () => {
  assert.equal(moneyBlocked({ offline: false, viewFailed: false, outOfDate: false }), false);
  assert.equal(moneyBlocked({ offline: true, viewFailed: false, outOfDate: false }), true);
  assert.equal(moneyBlocked({ offline: false, viewFailed: true, outOfDate: false }), true);
  assert.equal(moneyBlocked({ offline: false, viewFailed: false, outOfDate: true }), true);
});

test("showMoney: figure when fresh, a dash when stale", () => {
  assert.equal(showMoney("10 USDC", false), "10 USDC");
  assert.equal(showMoney("10 USDC", true), "—");
});

test("busyText / parseRetryAfter", () => {
  assert.equal(busyText(7), "Busy, retrying in 7s");
  assert.equal(busyText(0), "Busy, retrying now");
  assert.equal(parseRetryAfter("3"), 3);
  assert.equal(parseRetryAfter(null), 5);
  assert.equal(parseRetryAfter("abc"), 5);
  assert.equal(parseRetryAfter("9999"), 60);
  assert.equal(parseRetryAfter("0"), 1);
});

test("retryOn429: waits out each 429 with a countdown, then returns the good answer", async () => {
  const seen: number[] = []; const slept: number[] = [];
  let calls = 0;
  const res = await retryOn429(async () => (++calls < 3 ? { status: 429, retryAfter: "2" } : { status: 200, retryAfter: null }), {
    sleep: async (ms) => { slept.push(ms); }, onWait: (s) => seen.push(s),
  });
  assert.equal(res.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(slept, [2000, 2000]);
  assert.deepEqual(seen.filter((s) => s > 0).slice(0, 2), [2, 2]);
  assert.equal(seen[seen.length - 1], 0, "countdown cleared at the end");
});

test("retryOn429: gives up after the max tries and hands back the 429", async () => {
  let calls = 0;
  const res = await retryOn429(async () => { calls++; return { status: 429, retryAfter: "1" }; }, { sleep: async () => {}, onWait: () => {}, max: 3 });
  assert.equal(res.status, 429);
  assert.equal(calls, 4);
});

test("outOfDateReason: wrong network or pins mismatch; unknown reads never flag", () => {
  const rel = { network: "testnet", resolver_wasm_hash: "a".repeat(64) };
  assert.equal(outOfDateReason(rel, { chainId: "testnet", resolverKeys: ["x", "y", "a".repeat(64)] }), null);
  assert.equal(outOfDateReason(rel, { chainId: "mainnet", resolverKeys: null }), "network");
  assert.equal(outOfDateReason(rel, { chainId: "testnet", resolverKeys: ["x", "y", "b".repeat(64)] }), "release");
  assert.equal(outOfDateReason(rel, { chainId: undefined, resolverKeys: null }), null);
  assert.equal(outOfDateReason(rel, { chainId: "testnet", resolverKeys: [] as string[] }), null);
});

test("banners: busy and out-of-date join the list with plain English", () => {
  const b = globalBanners({ paused: false, shutdown: false, offline: false, busySeconds: 4, outOfDate: true });
  assert.deepEqual(b.map((x) => x.kind), ["out-of-date", "busy"]);
  assert.equal(COPY.outOfDate, "This page is out of date. Refresh.");
  assert.equal(b[1].text, "Busy, retrying in 4s");
  assert.deepEqual(globalBanners({ paused: false, shutdown: false, offline: false }), []);
});
