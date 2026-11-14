// CF1b CPU budget: p99 CPU per relay invocation must be <= 5 ms (Workers Free, 10 ms limit, 2x headroom).
// Same method as CF1a (see keeper/test/cpuBudget.test.ts): the real handler path runs IN-PROCESS on V8 with
// an instantly-answering fetch (no IPC): RelayerDO.fetch -> body parse -> borsh decode -> WebCrypto Ed25519
// verify + sha256 -> policy -> guard SQL (node:sqlite behind the DO SQL shape) -> WebCrypto tx signing ->
// JSON. CPU = main-thread CPU (process.threadCpuUsage user+system), not wall time. It excludes libuv-pool
// crypto work (tens of microseconds; workerd does it inline) and the real DO hop; it is a proxy, not
// Cloudflare's billed CPU -- confirm with `wrangler tail` after the first deploy. Never faked.
import { minOfBatchP99, p50, cpuDeltaMs } from "../../common/test/cpuBench.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { RelayerDO } from "../src/index.js";
import { buildDelegate, fakeDoStorage, outboundFetch, rpcWorld, workerBindings } from "../test/helpers.js";

const BUDGET_MS = 5;
const K = 5; // CPUFLAKE1: CPU p99 = min over K independent batches of the per-batch p99 (see common/test/cpuBench.ts); threshold unchanged

test(`CPU budget: p99 relay CPU <= ${BUDGET_MS} ms (accept path with signing; reject path; 2000-nonce history)`, async () => {
  const real = globalThis.fetch; const w = rpcWorld(); globalThis.fetch = outboundFetch(w) as any;
  try {
    const st = fakeDoStorage();
    const d = new RelayerDO(st.ctx as any, workerBindings({ RELAYER_MAX_REQUESTS_PER_WINDOW: "1000000", RELAYER_DAILY_BUDGET_YOCTO: "1" + "0".repeat(40), INDEXER_URL: "" }) as any);
    const call = (b64: string) => d.fetch(new Request("https://relayer.do/relay", { method: "POST", body: JSON.stringify({ signedDelegate: b64 }) }));
    let n = 1n;
    for (let i = 0; i < 2000; i++) await call(buildDelegate({ senderId: `h${i % 50}.testnet`, nonce: n++ }).base64); // history + warm JIT
    const measure = async (accept: boolean, count: number) => {
      const fixtures = Array.from({ length: count }, (_, i) => accept ? buildDelegate({ senderId: `m${i % 20}.testnet`, nonce: n++ }).base64 : buildDelegate({ senderId: "rej.testnet", receiverId: "other.testnet", nonce: n++ }).base64);
      const cpu: number[] = [];
      for (const f of fixtures) {
        const c0 = process.threadCpuUsage(); const r = await call(f); const c1 = process.threadCpuUsage(c0);
        assert.equal(r.status, accept ? 200 : 400, accept ? "accepted path must really sign + broadcast" : "reject path");
        cpu.push(cpuDeltaMs(c1));
      }
      return cpu;
    };
    const accAll: number[] = [];
    const acc = await minOfBatchP99(async () => { const c = await measure(true, 300); accAll.push(...c); return c; }, K);
    const rej = await minOfBatchP99(() => measure(false, 300), K);
    const res = { accept_cpu_p99: acc.value, reject_cpu_p99: rej.value, accept_cpu_batches: acc.perBatch, reject_cpu_batches: rej.perBatch, accept_cpu_p50: p50(accAll) };
    console.log("CF1b-CPU-INPROC " + JSON.stringify(res));
    assert.ok(res.accept_cpu_p99 <= BUDGET_MS, `accept p99 = ${res.accept_cpu_p99.toFixed(2)} ms > ${BUDGET_MS}`);
    assert.ok(res.reject_cpu_p99 <= BUDGET_MS, `reject p99 = ${res.reject_cpu_p99.toFixed(2)} ms > ${BUDGET_MS}`);
    st.close();
  } finally { globalThis.fetch = real; }
});

// CF1b2: same method on the bettor-fallback path (indexer down => escrow get_bet scan, SQLite cache).
test(`CPU budget (CF1b2 bettor fallback): p99 <= ${BUDGET_MS} ms for cold 40-view scan requests and warm-cache lookups`, async () => {
  const real = globalThis.fetch; const w = rpcWorld(); w.indexerDown = true; globalThis.fetch = outboundFetch(w) as any;
  try {
    for (let i = 1; i <= 38; i++) w.bets.set(i, { envelope: { maker: `bm${i}.testnet` }, taker: i % 2 ? `bt${i}.testnet` : null });
    const extra = { RELAYER_MAX_REQUESTS_PER_WINDOW: "1000000", RELAYER_DAILY_BUDGET_YOCTO: "1" + "0".repeat(40), RELAYER_GLOBAL_DAILY_BUDGET_YOCTO: "1" + "0".repeat(40), RELAYER_RESERVED_SHARE: "0.9999999999" };
    let n = 1n;
    const timed = async (d: RelayerDO, sender: string) => {
      const f = buildDelegate({ senderId: sender, nonce: n++ }).base64;
      const c0 = process.threadCpuUsage();
      const r = await d.fetch(new Request("https://relayer.do/relay", { method: "POST", body: JSON.stringify({ signedDelegate: f }) }));
      const c1 = process.threadCpuUsage(c0);
      return { status: r.status, cpu: cpuDeltaMs(c1) };
    };
    // warm JIT + fill history on one storage
    const hist = fakeDoStorage(); const hd = new RelayerDO(hist.ctx as any, workerBindings(extra) as any);
    for (let i = 0; i < 300; i++) await timed(hd, `bm${(i % 38) + 1}.testnet`);
    const coldAll: number[] = [];
    const coldStat = await minOfBatchP99(async () => {
    const cold: number[] = [];
    for (let i = 0; i < 100; i++) { // each: brand-new storage => the request performs the full 38-bet scan (41 get_bet views)
      const st = fakeDoStorage(); const d = new RelayerDO(st.ctx as any, workerBindings(extra) as any);
      const before = w.views; const r = await timed(d, "bm7.testnet");
      assert.equal(r.status, 200, "cold scan request must find the bettor and relay"); assert.ok(w.views - before >= 38, "cold request really scanned");
      cold.push(r.cpu); coldAll.push(r.cpu); st.close();
    }
    return cold;
    }, K);
    const warmAll: number[] = [];
    const warmStat = await minOfBatchP99(async () => {
    const warm: number[] = [];
    for (let i = 0; i < 300; i++) { const before = w.views; const r = await timed(hd, `bm${(i % 38) + 1}.testnet`); assert.equal(r.status, 200); assert.equal(w.views, before, "warm lookup makes no RPC"); warm.push(r.cpu); warmAll.push(r.cpu); }
    return warm;
    }, K);
    const res = { scan_cold_cpu_p99: coldStat.value, scan_cold_cpu_batches: coldStat.perBatch, scan_cold_cpu_p50: p50(coldAll), warm_cache_cpu_p99: warmStat.value, warm_cache_cpu_batches: warmStat.perBatch };
    console.log("CF1b2-CPU-INPROC " + JSON.stringify(res));
    assert.ok(res.scan_cold_cpu_p99 <= BUDGET_MS, `cold scan p99 = ${res.scan_cold_cpu_p99.toFixed(2)} ms > ${BUDGET_MS}`);
    assert.ok(res.warm_cache_cpu_p99 <= BUDGET_MS, `warm p99 = ${res.warm_cache_cpu_p99.toFixed(2)} ms > ${BUDGET_MS}`);
    hist.close();
  } finally { globalThis.fetch = real; }
});
