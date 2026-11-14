// CF1a CPU budget: p99 CPU per keeper invocation must be <= 5 ms (Workers Free).
// workerd exposes no per-invocation CPU time locally, so this measures the real handler path
// IN-PROCESS on V8 (same engine as workerd): PacedRpcClient + WorkerNearClient + real WebCrypto
// Ed25519 signing + runKeeperTick + JSON state (de)serialisation, with a fetch that answers
// instantly (no IPC, no sockets). CPU is the main thread's CPU time (process.threadCpuUsage, user+system):
// unlike wall time it is not inflated by other test files running concurrently, and it excludes
// only the libuv-pool WebCrypto sign (tens of microseconds; workerd signs inline). The asserted
// number is thread CPU; wall time is recorded and printed but is contention-sensitive, so it only
// gets a generous 3x ceiling. Limits: no SQLite DO hop (memory store does
// the same JSON work), Node's V8 flags/JIT warmup differ slightly from workerd; the number is a
// proxy for, not the same as, Cloudflare's billed CPU. Real numbers come from `wrangler tail`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyPair } from "near-api-js";
import bs58 from "bs58";
import { PacedRpcClient, RateLimiter } from "@praetorial/common/rpc.js";
import { WorkerNearClient } from "../../common/src/nearWebClient.js";
import { runKeeperTick, MemoryStateStore } from "../src/tick.js";
import { minOfBatchP99, medianOfBatchP99, cpuDeltaMs } from "../../common/test/cpuBench.js";
import { DEPLOYED_TARGET_MS, KEEPER_TICK_FACTOR, deployedEquivMs } from "../../common/test/cpuCalib.js";
import { dueBet } from "../../../keeper/test/helpers/dueBet.js";

const BUDGET_MS = 5;
const K = 5; // independent batches (CPUFLAKE1): CPU = min of batch p99s, wall = median of batch p99s; thresholds unchanged

function world() {
  const bets: Record<number, any> = {};
  for (let i = 1; i <= 400; i++) bets[i] = { ...dueBet(), status: "Settled" }; // long-lived terminal history
  let txs = 0;
  const fetchImpl = async (_u: any, init: any) => {
    const body = JSON.parse(init.body);
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    const p = body.params;
    if (body.method === "query" && p.request_type === "call_function") {
      const args = JSON.parse(atob(p.args_base64));
      const v = p.method_name === "get_bet" ? (bets[args.bet_id] ?? null) : p.method_name === "pending_payouts_view" ? [] : false;
      return ok({ result: Array.from(new TextEncoder().encode(JSON.stringify(v))) });
    }
    if (body.method === "query") return ok({ nonce: 5 });
    if (body.method === "block") return ok({ header: { hash: bs58.encode(new Uint8Array(32).fill(3)) } });
    txs++; return ok({ status: { SuccessValue: "" } });
  };
  return { bets, fetchImpl: fetchImpl as any, txCount: () => txs };
}

test(`CPU budget: p99 keeper tick CPU <= ${BUDGET_MS} ms (idle + action ticks, 400-bet history)`, async () => {
  const w = world();
  const key = (KeyPair.fromRandom("ed25519") as any).toString();
  const store = new MemoryStateStore();
  let now = dueBet.nowMs;
  const tick = async () => {
    const paced = new PacedRpcClient({ urls: ["https://rpc.test"], limiter: new RateLimiter(1e9, 1e9), fetchImpl: w.fetchImpl, sleepImpl: async () => {} });
    const client = new WorkerNearClient({ rpc: paced, accountId: "k.testnet", privateKey: key, maxAttachedYocto: 1n, maxSubrequests: 44 });
    return runKeeperTick({ client, contracts: [{ id: "e.testnet", version: "v1" }], store, nowMs: () => now, alerts: { async send() {} } });
  };
  for (let i = 0; i < 40; i++) { now += 31_000; await tick(); } // warm JIT + build state
  let nextId = 401;
  const measure = async (action: boolean, n: number) => {
    const cpu: number[] = [], wall: number[] = [];
    for (let i = 0; i < n; i++) {
      now += 31_000;
      if (action) w.bets[nextId++] = { ...dueBet() }; // the next id past the frontier
      const c0 = process.threadCpuUsage(); const t0 = performance.now();
      await tick();
      wall.push(performance.now() - t0);
      cpu.push(cpuDeltaMs(process.threadCpuUsage(c0)));
    }
    return { cpu, wall };
  };
  const wallOf: Record<string, number[][]> = { idle: [], action: [] };
  const batch = (kind: "idle" | "action") => async () => { const r = await measure(kind === "action", 300); wallOf[kind].push(r.wall); return r.cpu; };
  const before = w.txCount();
  const idleCpu = await minOfBatchP99(batch("idle"), K);
  const actCpu = await minOfBatchP99(batch("action"), K);
  assert.ok(w.txCount() - before >= 100 * K, `action ticks must really sign (${w.txCount() - before} txs)`);
  const wallMedian = (kind: "idle" | "action") => medianOfBatchP99(async (b) => wallOf[kind][b], K).then((x) => x.value);
  const r = { idle_cpu_p99: idleCpu.value, idle_wall_p99: await wallMedian("idle"), action_cpu_p99: actCpu.value, action_wall_p99: await wallMedian("action"), idle_cpu_batches: idleCpu.perBatch, action_cpu_batches: actCpu.perBatch };
  console.log("CF1a-CPU-INPROC " + JSON.stringify(r));
  for (const k of ["idle_cpu_p99", "action_cpu_p99"] as const) assert.ok(r[k] <= BUDGET_MS, `${k} = ${r[k].toFixed(2)} ms > ${BUDGET_MS} ms`);
  for (const k of ["idle_wall_p99", "action_wall_p99"] as const) assert.ok(r[k] <= 3 * BUDGET_MS, `${k} = ${r[k].toFixed(2)} ms > ${3 * BUDGET_MS} ms`);
});

// CF1e3: same 30%-headroom check as the indexer: local p99 x calibration (common/test/cpuCalib.ts) must be <= 7 ms deployed-equivalent.
test(`CF1e3: keeper tick deployed-equivalent p99 CPU <= ${DEPLOYED_TARGET_MS} ms (default limits, action ticks)`, async () => {
  const w = world();
  const key = (KeyPair.fromRandom("ed25519") as any).toString();
  const store = new MemoryStateStore();
  let now = dueBet.nowMs;
  const tick = async () => {
    const paced = new PacedRpcClient({ urls: ["https://rpc.test"], limiter: new RateLimiter(1e9, 1e9), fetchImpl: w.fetchImpl, sleepImpl: async () => {} });
    const client = new WorkerNearClient({ rpc: paced, accountId: "k.testnet", privateKey: key, maxAttachedYocto: 1n, maxSubrequests: 44 });
    return runKeeperTick({ client, contracts: [{ id: "e.testnet", version: "v1" }], store, nowMs: () => now, alerts: { async send() {} } });
  };
  for (let i = 0; i < 40; i++) { now += 31_000; await tick(); }
  let nextId = 401;
  const stat = await minOfBatchP99(async () => {
    const cpu: number[] = [];
    for (let i = 0; i < 300; i++) { now += 31_000; w.bets[nextId++] = { ...dueBet() }; const c0 = process.threadCpuUsage(); await tick(); cpu.push(cpuDeltaMs(process.threadCpuUsage(c0))); }
    return cpu;
  }, K);
  const eq = deployedEquivMs(stat.value, KEEPER_TICK_FACTOR);
  console.log("CF1e3-CPU keeper-tick " + JSON.stringify({ local_p99: stat.value, local_batches: stat.perBatch, deployed_equiv_p99: eq, factor: KEEPER_TICK_FACTOR }));
  assert.ok(eq <= DEPLOYED_TARGET_MS, `keeper tick deployed-equivalent p99 = ${eq.toFixed(2)} ms (local ${stat.value.toFixed(3)} x ${KEEPER_TICK_FACTOR.toFixed(2)}) > ${DEPLOYED_TARGET_MS}`);
});
