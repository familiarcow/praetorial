// CPUFLAKE1 RED: the old measurement (p99 of ONE batch, or wall time) is load-sensitive; the new one
// (minimum over K independent batches of each batch's p99, from per-call CPU deltas) is not, yet still
// flags a handler that is really over budget. Injected clocks, no real load needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { p99, minOfBatchP99, medianOfBatchP99, cpuDeltaMs } from "./cpuBench.js";

const BUDGET_MS = 5;
// A deterministic fake handler: real CPU 1 ms per call; `spike(batch, call)` adds scheduler/cache noise.
function fakeBatch(cpuMs: number, spike: (b: number, i: number) => number, n = 100) {
  return (b: number) => Array.from({ length: n }, (_, i) => cpuMs + spike(b, i));
}

test("old method (single-batch p99 / wall) flags an under-budget handler under contention", () => {
  const noisy = fakeBatch(1, (_b, i) => (i % 20 === 0 ? 8 : 0)); // 5% of calls hit by a descheduling
  assert.ok(p99(noisy(0)) > BUDGET_MS, "legacy single-batch p99 is fooled by contention (this is the flake)");
});

test("new method: min over K batch p99s passes a handler whose CPU is 1 ms even when most batches are contended", async () => {
  const run = fakeBatch(1, (b, i) => (b < 3 && i % 20 === 0 ? 8 : 0)); // 3 of 5 batches contended
  const r = await minOfBatchP99(async (b) => run(b), 5);
  assert.equal(r.perBatch.length, 5);
  assert.ok(r.value <= BUDGET_MS, `min of batch p99s = ${r.value}`);
});

test("new method still flags a handler that is really over budget (no false pass)", async () => {
  const run = fakeBatch(7, (_b, i) => (i % 20 === 0 ? 3 : 0));
  const r = await minOfBatchP99(async (b) => run(b), 5);
  assert.ok(r.value > BUDGET_MS, `really-slow handler must still fail: ${r.value}`);
});

test("new method flags a handler whose slowness is in the tail of EVERY batch (p99 per batch, not p50)", async () => {
  const run = fakeBatch(1, (_b, i) => (i % 20 === 0 ? 9 : 0)); // genuine, repeatable tail
  const r = await minOfBatchP99(async (b) => run(b), 5);
  assert.ok(r.value > BUDGET_MS);
});

test("wall-time checks: median of batch p99s ignores a single contended batch, keeps the same threshold", async () => {
  const run = fakeBatch(2, (b, i) => (b === 1 && i % 10 === 0 ? 30 : 0));
  const r = await medianOfBatchP99(async (b) => run(b), 3);
  assert.ok(r.value <= 15, `median ${r.value}`);
  const bad = fakeBatch(20, () => 0);
  assert.ok((await medianOfBatchP99(async (b) => bad(b), 3)).value > 15, "slow wall still fails");
});

test("cpuDeltaMs converts a threadCpuUsage delta (us user+system) to ms", () => {
  assert.equal(cpuDeltaMs({ user: 1500, system: 500 }), 2);
  const c0 = process.threadCpuUsage(); let x = 0; for (let i = 0; i < 2e6; i++) x += i;
  assert.ok(x > 0 && cpuDeltaMs(process.threadCpuUsage(c0)) > 0);
});
