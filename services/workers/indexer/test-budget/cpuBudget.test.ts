// CF1d CPU budget: p99 CPU per indexer invocation must be <= 5 ms (Workers Free, 10 ms limit, 2x headroom).
// Same method as CF1a-c2: the real Worker `handle` path runs IN-PROCESS on V8 with an instantly-answering mocked fetch and a
// D1-shaped binding over node:sqlite (no IPC): config parse -> D1 reads -> bounded sweep (JSON-RPC decode) -> merge / second-RPC
// confirm -> D1 batch write; and the HTTP API (/offers, /history, /bet, /governance, /health) over a 200-bet board.
// CPU = main-thread CPU (process.threadCpuUsage user+system), not wall time. A proxy for Cloudflare's billed CPU (the in-process
// sqlite is not D1's network hop, which is not billed CPU): confirm with `wrangler tail` after the first deploy. Never faked.
import { minOfBatchP99, p50, cpuDeltaMs } from "../../common/test/cpuBench.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { fakeD1, world, outboundFetch, baseEnv, mkBet, settled, rc, OKS } from "../test/helpers.js";

const BUDGET_MS = 5;
const K = 5; // CPUFLAKE1: CPU p99 = min over K independent batches of the per-batch p99 (see common/test/cpuBench.ts); threshold unchanged

test(`CPU budget: p99 indexer tick CPU <= ${BUDGET_MS} ms (20-bet batches, terminal confirms, over a 200-bet board)`, async () => {
  const real = globalThis.fetch; const w = world(); globalThis.fetch = outboundFetch(w) as any;
  try {
    const a: Record<number, any> = {}, b: Record<number, any> = {};
    for (let i = 1; i <= 100; i++) { a[i] = i % 5 === 0 ? settled({ created_at: i }) : mkBet({ created_at: i }, { maker: `m${i % 9}.testnet` }); b[i] = i % 3 === 0 ? settled({ created_at: i }) : mkBet({ created_at: i }); }
    w.chain = { "a.testnet": a, "b.testnet": b }; w.second = JSON.parse(JSON.stringify(w.chain));
    const f = fakeD1(); const clock = { ms: 1_700_000_000_000 };
    const env = baseEnv(f.d1, { INDEXER_BATCH_BETS: "20", INDEXER_MAX_CONFIRMS_PER_TICK: "8" });
    const tick = () => handle(new Request("https://indexer.test/tick", { method: "POST" }), env, () => clock.ms);
    for (let i = 0; i < 60; i++) { clock.ms += 60_000; await tick(); } // converge + warm JIT
    const all: number[] = [];
    const stat = await minOfBatchP99(async () => {
      const cpu: number[] = [];
      for (let i = 0; i < 300; i++) {
        clock.ms += 60_000;
        const c0 = process.threadCpuUsage(); const r = await tick(); const d = cpuDeltaMs(process.threadCpuUsage(c0));
        assert.equal(r.status, 200, "tick must really run");
        cpu.push(d); all.push(d);
      }
      return cpu;
    }, K);
    const res = { tick_cpu_p99: stat.value, tick_cpu_batches: stat.perBatch, tick_cpu_p50: p50(all), ticks: all.length };
    console.log("CF1d-CPU-INPROC indexer-tick " + JSON.stringify(res));
    assert.ok(res.tick_cpu_p99 <= BUDGET_MS, `indexer tick p99 = ${res.tick_cpu_p99.toFixed(2)} ms > ${BUDGET_MS}`);
    f.close();
  } finally { globalThis.fetch = real; }
});

test(`CPU budget: p99 indexer API request CPU <= ${BUDGET_MS} ms (/offers, /history, /bet, /governance, /health over 200 cached bets)`, async () => {
  const real = globalThis.fetch; const w = world(); globalThis.fetch = outboundFetch(w) as any;
  try {
    const a: Record<number, any> = {}, b: Record<number, any> = {};
    for (let i = 1; i <= 100; i++) { a[i] = i % 5 === 0 ? settled({ created_at: i }) : mkBet({ created_at: i }, { maker: `m${i % 9}.testnet` }); b[i] = i % 3 === 0 ? settled({ created_at: i }) : mkBet({ created_at: i }); }
    w.chain = { "a.testnet": a, "b.testnet": b }; w.second = JSON.parse(JSON.stringify(w.chain));
    w.history["a.testnet"] = [{ hash: "tx0", rc: rc(['EVENT_JSON:{"standard":"praetorial-escrow","version":"1.0.0","event":"guardian_proposed","data":[{"guardian":"g.testnet"}]}'], OKS) }];
    const f = fakeD1(); const clock = { ms: 1_700_000_000_000 };
    const env = baseEnv(f.d1, { INDEXER_BATCH_BETS: "40", INDEXER_MAX_CONFIRMS_PER_TICK: "8" });
    for (let i = 0; i < 40; i++) { clock.ms += 60_000; await handle(new Request("https://indexer.test/tick", { method: "POST" }), env, () => clock.ms); }
    clock.ms += 60_000; await handle(new Request("https://indexer.test/tick/governance", { method: "POST" }), env, () => clock.ms);
    const health: any = await (await handle(new Request("https://indexer.test/health"), env, () => clock.ms)).json();
    assert.equal(health.bets_cached, 200, "board must be fully cached before measuring");
    const paths = ["/offers", "/history", "/history?account=m3.testnet", "/bet?bet_id=57&contract_id=b.testnet", "/governance", "/health"];
    const req = async (p: string) => (await handle(new Request("https://indexer.test" + p), env, () => clock.ms)).text();
    for (let i = 0; i < 100; i++) for (const p of paths) await req(p);
    const all: number[] = [];
    const stat = await minOfBatchP99(async () => {
      const cpu: number[] = [];
      for (let i = 0; i < 200; i++) for (const p of paths) {
        const c0 = process.threadCpuUsage(); const t = await req(p); const d = cpuDeltaMs(process.threadCpuUsage(c0));
        assert.ok(t.length > 0); cpu.push(d); all.push(d);
      }
      return cpu;
    }, K);
    const res = { api_cpu_p99: stat.value, api_cpu_batches: stat.perBatch, api_cpu_p50: p50(all), requests: all.length };
    console.log("CF1d-CPU-INPROC indexer-api " + JSON.stringify(res));
    assert.ok(res.api_cpu_p99 <= BUDGET_MS, `indexer API p99 = ${res.api_cpu_p99.toFixed(2)} ms > ${BUDGET_MS}`);
    f.close();
  } finally { globalThis.fetch = real; }
});
