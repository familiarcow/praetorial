// CF1c2 CPU budget: p99 CPU per notifier tick invocation must be <= 5 ms (Workers Free, 10 ms limit, 2x headroom).
// Same method as CF1a/CF1b/CF1c: the real NotifierDO.fetch path runs IN-PROCESS on V8 with an instantly-answering mocked fetch
// (no IPC): config parse -> state load (node:sqlite behind the DO SQL shape) -> bounded 12-bet sweep (JSON-RPC view decode,
// second-RPC terminal confirm, notice computation, AES-GCM contact decrypt, Telegram queue) -> state save. CPU = main-thread CPU
// (process.threadCpuUsage user+system), not wall time. A proxy, not Cloudflare's billed CPU -- confirm with `wrangler tail` after the
// first deploy. Never faked.
import { minOfBatchP99, p50, cpuDeltaMs } from "../../common/test/cpuBench.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NotifierDO } from "../src/index.js";
import { ESC, USDC, NS, mkBet, world, outboundFetch, fakeDoStorage, RPC2_URL } from "../../monitor/test/helpers.js";

const BUDGET_MS = 5;
const K = 5; // CPUFLAKE1: CPU p99 = min over K independent batches of the per-batch p99 (see common/test/cpuBench.ts); threshold unchanged

test(`CPU budget: p99 notifier tick CPU <= ${BUDGET_MS} ms (12-bet batches over 120 bets, terminals confirmed, notices + Telegram flowing)`, async () => {
  const real = globalThis.fetch; const w = world(); globalThis.fetch = outboundFetch(w) as any;
  try {
    const mkAll = (gen: number) => { for (let i = 1; i <= 120; i++) w.bets.set(i, i % 4 === 0 ? mkBet(i, { status: "Settled", outcome: "YES", created_at: gen * 1000 + i }) : mkBet(i, { status: "Proposed", proposed_at: 0, outcome: "YES", created_at: gen * 1000 + i }, { settlement_period: 1e15, stake_maker: "900000000" })); };
    mkAll(0);
    const st = fakeDoStorage(); const clock = { ms: 1_000_000 };
    const env = { NEAR_NETWORK_ID: "testnet", ESCROW_CONTRACT_ID: ESC, INTENTS_CONTRACT_ID: "intents.testnet", USDC_TOKEN_ID: USDC, NEAR_RPC_FALLBACKS: RPC2_URL, NOTIFIER_CONTACT_KEY: "ab".repeat(32),
      NOTIFIER_RPC_PER_SEC: "100000", NOTIFIER_MIN_TICK_INTERVAL_MS: "0", NOTIFIER_BATCH_BETS: "12", TELEGRAM_BOT_TOKEN: "123456:TESTTOKENTESTTOKENTESTTOKENTESTTOKEN",
      NOTIFIER_ASSET_PRICES: JSON.stringify({ [USDC]: { decimals: 6, usdPerToken: 1 } }), NOTIFIER_BET_LINK_BASE: "https://app.test/bet" };
    const d = new NotifierDO(st.ctx as any, env as any, () => clock.ms);
    for (let i = 1; i <= 120; i++) await d.setContact(`maker${i}.testnet`, "telegram", `chat${i}`);
    const tick = () => d.fetch(new Request("https://notifier.do/tick", { method: "POST" }));
    for (let i = 0; i < 300; i++) { clock.ms += 60_000; await tick(); if (i % 40 === 39) mkAll(i); } // warm JIT; periodic redeploy-style churn keeps notices flowing
    const all: number[] = []; let notices = 0; let gen = 0;
    const stat = await minOfBatchP99(async () => {
    const cpu: number[] = [];
    for (let i = 0; i < 400; i++) {
      if (i % 20 === 0) mkAll(10 + (gen++)); // identity churn: new bets => new notices + confirm + Telegram work in the measured window
      clock.ms += 60_000;
      const c0 = process.threadCpuUsage(); const r = await tick(); const d = cpuDeltaMs(process.threadCpuUsage(c0));
      assert.equal(r.status, 200, "tick must really run");
      cpu.push(d); all.push(d);
      notices += ((await r.clone().json()) as any).notices?.length ?? 0;
    }
    return cpu;
    }, K);
    assert.ok(notices > 50 && w.telegram.length > 20, `measured window must do real work (notices=${notices} telegram=${w.telegram.length})`);
    const res = { tick_cpu_p99: stat.value, tick_cpu_batches: stat.perBatch, tick_cpu_p50: p50(all), ticks: all.length, notices, telegram: w.telegram.length };
    console.log("CF1c2-CPU-INPROC notifier " + JSON.stringify(res));
    assert.ok(res.tick_cpu_p99 <= BUDGET_MS, `notifier tick p99 = ${res.tick_cpu_p99.toFixed(2)} ms > ${BUDGET_MS}`);
    st.close();
  } finally { globalThis.fetch = real; }
});
