// CF1c CPU budget: p99 CPU per monitor tick invocation must be <= 5 ms (Workers Free, 10 ms limit, 2x headroom).
// Same method as CF1a/CF1b: the real MonitorDO.fetch path runs IN-PROCESS on V8 with an instantly-answering mocked fetch
// (no IPC): config parse -> state load (node:sqlite behind the DO SQL shape) -> bounded 20-bet sweep (JSON-RPC view
// decode, invariants, keeper policy) -> runAlertTick -> state save. CPU = main-thread CPU (process.threadCpuUsage
// user+system), not wall time. It is a proxy, not Cloudflare's billed CPU -- confirm with `wrangler tail` after the first
// deploy. Never faked.
import { minOfBatchP99, p50, cpuDeltaMs } from "../../common/test/cpuBench.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { MonitorDO } from "../src/index.js";
import { ESC, USDC, INT, NS, mkBet, world, outboundFetch, fakeDoStorage } from "../test/helpers.js";

const BUDGET_MS = 5;
const K = 5; // CPUFLAKE1: CPU p99 = min over K independent batches of the per-batch p99 (see common/test/cpuBench.ts); threshold unchanged

test(`CPU budget: p99 monitor tick CPU <= ${BUDGET_MS} ms (20-bet batches over 100 bets, with alerts firing)`, async () => {
  const real = globalThis.fetch; const w = world(); globalThis.fetch = outboundFetch(w) as any;
  try {
    for (let i = 1; i <= 100; i++) w.bets.set(i, mkBet(i, i % 5 === 0 ? { status: "Settled", outcome: "YES" } : { status: "Open", taker: null }));
    const st = fakeDoStorage(); const clock = { ms: 1_000_000 };
    const env = { NEAR_NETWORK_ID: "testnet", ESCROW_CONTRACT_ID: ESC, INTENTS_CONTRACT_ID: INT, USDC_TOKEN_ID: USDC, MONITOR_RPC_PER_SEC: "100000", MONITOR_MIN_TICK_INTERVAL_MS: "0", MONITOR_BATCH_BETS: "20" };
    const d = new MonitorDO(st.ctx as any, env as any, () => clock.ms);
    const tick = () => d.fetch(new Request("https://monitor.do/tick", { method: "POST" }));
    for (let i = 0; i < 300; i++) { clock.ms += 60_000; await tick(); } // warm JIT + history
    const all: number[] = [];
    const stat = await minOfBatchP99(async () => {
      const cpu: number[] = [];
      for (let i = 0; i < 400; i++) {
        clock.ms += 60_000;
        const c0 = process.threadCpuUsage(); const r = await tick(); const d = cpuDeltaMs(process.threadCpuUsage(c0));
        assert.equal(r.status, 200, "tick must really run");
        cpu.push(d); all.push(d);
      }
      return cpu;
    }, K);
    const res = { tick_cpu_p99: stat.value, tick_cpu_batches: stat.perBatch, tick_cpu_p50: p50(all), ticks: all.length };
    console.log("CF1c-CPU-INPROC monitor " + JSON.stringify(res));
    assert.ok(res.tick_cpu_p99 <= BUDGET_MS, `monitor tick p99 = ${res.tick_cpu_p99.toFixed(2)} ms > ${BUDGET_MS}`);
    st.close();
  } finally { globalThis.fetch = real; }
});
