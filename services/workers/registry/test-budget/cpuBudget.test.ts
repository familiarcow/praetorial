// CF1f CPU budget (D-CF1F1 local gate): p99 CPU per registry request must be <= 7 ms (never raised). Method as CF1d: the real Worker
// `handle` runs IN-PROCESS on V8, RPC answered instantly, D1-shaped binding over node:sqlite (no IPC, D1's network hop is not billed CPU).
// Mix: /search, /lookup/username, /lookup/account, /health, and REAL claims (NEP-413 digest + ed25519 verify + D1 batch) over a 200-user board.
// CPU = main-thread CPU (process.threadCpuUsage). Confirmed on the DEPLOYED worker with `wrangler tail` (e2e/live-CF1f/).
import { test } from "node:test";
import assert from "node:assert/strict";
import { minOfBatchP99, p50, cpuDeltaMs } from "../../common/test/cpuBench.js";
import { actor, claimBody, fakeRpc, fullKey, REGISTRY_ID } from "../../../registry/test/helpers.js";
import { fakeD1 } from "../../indexer/test/helpers.js";
import { handle } from "../src/index.js";
import { registryMigrationSql } from "../test/workerBackend.js";

const BUDGET_MS = 7;
const K = 5;

test(`CPU budget: p99 registry request CPU <= ${BUDGET_MS} ms (search/lookup/health + real claims over a 200-user board)`, async () => {
  const f = fakeD1(":memory:", false); await f.d1.exec(registryMigrationSql());
  const env: any = { REGISTRY_DB: f.d1, REGISTRY_ID, REGISTRY_RATE_CAPACITY: "1000000", REGISTRY_RATE_REFILL_PER_SEC: "1000000" };
  const keys: Record<string, any[]> = {}; const actors = Array.from({ length: 200 + K * 40 }, (_, i) => { const a = actor(`acct${i}.testnet`); keys[a.account] = [fullKey(a)]; return a; });
  const rpc = fakeRpc(keys); const clock = { ms: 1_700_000_000_000 };
  const call = (p: string, init?: RequestInit) => handle(new Request("https://registry.test" + p, { ...init, headers: { "cf-connecting-ip": "7.7.7.7" } }), env, { rpc, now: () => clock.ms });
  for (let i = 0; i < 200; i++) { const r = await call("/claim", { method: "POST", body: JSON.stringify(claimBody(actors[i], `user_${i}`, { ts: clock.ms })) }); assert.equal(r.status, 200, await r.text()); }
  const reads = ["/search?q=user_1", "/search?q=ser_19", "/lookup/username/user_77", "/lookup/account/acct42.testnet", "/health"];
  for (let i = 0; i < 100; i++) for (const p of reads) await (await call(p)).text();
  const all: number[] = []; let next = 200;
  const stat = await minOfBatchP99(async () => {
    const cpu: number[] = [];
    const claims = Array.from({ length: 40 }, () => { const a = actors[next]; const body = JSON.stringify(claimBody(a, `fresh_${next}`, { ts: clock.ms })); next++; return body; }); // signing is the CLIENT's CPU, not ours
    for (let i = 0; i < 400; i++) {
      const isClaim = i % 10 === 0; const p = reads[i % reads.length];
      const c0 = process.threadCpuUsage();
      const r = isClaim ? await call("/claim", { method: "POST", body: claims[i / 10] }) : await call(p); const t = await r.text();
      const d = cpuDeltaMs(process.threadCpuUsage(c0)); assert.equal(r.status, 200, t); cpu.push(d); all.push(d);
    }
    return cpu;
  }, K);
  const res = { registry_cpu_p99: stat.value, batches: stat.perBatch, p50: p50(all), requests: all.length, claims: K * 40 };
  console.log("CF1f-CPU-INPROC registry " + JSON.stringify(res));
  assert.ok(res.registry_cpu_p99 <= BUDGET_MS, `registry p99 = ${res.registry_cpu_p99.toFixed(2)} ms > ${BUDGET_MS}`);
  f.close();
});
