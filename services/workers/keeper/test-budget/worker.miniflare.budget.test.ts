// CF1a wall budget (moved to the serial budget step by CPUFLAKE1/D-CPUFLAKE1a; threshold unchanged).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { medianOfBatchP99 } from "../../common/test/cpuBench.js";
import { bundle, expiredOpenBet, mockWorld, startMf } from "../test/miniflareHelpers.js";

// ---- end-to-end wall time in workerd ---------------------------------------------
// workerd exposes no per-invocation CPU time locally. The strict 5 ms CPU budget is asserted in
// cpuBudget.test.ts (in-process V8, no IPC). THIS test measures wall time of the whole
// scheduled() round trip through miniflare (dispatch + DO hop + SQLite + JSON + WebCrypto sign +
// mocked fetches). Each mocked outbound fetch here is a workerd->node IPC round trip costing
// real wall time that is NOT Worker CPU, so the bound is a loose regression guard (25 ms) and
// the numbers are printed. KEEPER_RPC_PER_SEC is raised so the paced client's wait is not counted.
const BUDGET_MS = 25;
const p99 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.99) - 1)];

test(`e2e wall: p99 scheduled() wall time <= ${BUDGET_MS} ms (idle ticks and action ticks)`, async () => {
  const w = mockWorld(); w.bets[1] = { ...expiredOpenBet(), status: "Settled" };
  const mf = await startMf(await bundle(), w, fs.mkdtempSync(path.join(os.tmpdir(), "cf1a-do-")), { TELEGRAM_BOT_TOKEN: "", KEEPER_ALERT_TELEGRAM_CHAT_ID: "" });
  try {
    const worker: any = await mf.getWorker();
    for (let i = 0; i < 10; i++) await worker.scheduled({ cron: "* * * * *" }); // warm
    // CPUFLAKE1: this is a genuine WALL-time check (workerd<->node IPC, not Worker CPU), so it uses the median over
    // 3 independent batches of each batch's p99 (cpuBench.ts); threshold unchanged. One contended batch cannot flip it.
    const idleAll: number[] = [], actionAll: number[] = []; let nextBet = 2;
    const idleStat = await medianOfBatchP99(async () => {
      const idle: number[] = [];
      for (let i = 0; i < 100; i++) { const t = performance.now(); await worker.scheduled({ cron: "* * * * *" }); idle.push(performance.now() - t); }
      idleAll.push(...idle); return idle;
    }, 3);
    const actionStat = await medianOfBatchP99(async () => {
      const action: number[] = [];
      for (const id of Object.keys(w.bets)) if (Number(id) !== 1) w.bets[id as any] = { ...w.bets[id as any], status: "Settled" }; // batches independent: earlier action bets are done, state does not grow batch over batch
      for (let i = 0; i < 50; i++) {
        w.bets[nextBet++] = expiredOpenBet(); // a new bet each tick -> one signed tx per tick
        const t = performance.now(); await worker.scheduled({ cron: "* * * * *" }); action.push(performance.now() - t);
      }
      actionAll.push(...action); return action;
    }, 3);
    const report = { idle_p50: [...idleAll].sort((a, b) => a - b)[150], idle_p99: idleStat.value, idle_batches: idleStat.perBatch, action_p50: [...actionAll].sort((a, b) => a - b)[75], action_p99: actionStat.value, action_batches: actionStat.perBatch, samples: { idle: idleAll.length, action: actionAll.length } };
    console.log("CF1a-CPU-WALL " + JSON.stringify(report));
    assert.ok(w.txs.length >= 150, `action ticks must really sign (${w.txs.length})`);
    assert.ok(report.idle_p99 <= BUDGET_MS, `idle p99 ${report.idle_p99.toFixed(2)} ms > ${BUDGET_MS}`);
    assert.ok(report.action_p99 <= BUDGET_MS, `action p99 ${report.action_p99.toFixed(2)} ms > ${BUDGET_MS}`);
  } finally { await mf.dispose(); }
});
