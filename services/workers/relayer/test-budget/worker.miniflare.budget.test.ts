// CF1b wall budget (moved to the serial budget step by CPUFLAKE1/D-CPUFLAKE1a; threshold unchanged).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { medianOfBatchP99 } from "../../common/test/cpuBench.js";
import { buildDelegate, rpcWorld } from "../test/helpers.js";
import { bundle, start, relay } from "../test/miniflareHelpers.js";

test("wall time through workerd: p99 relay <= 25 ms (regression guard; mocked-fetch IPC is not Worker CPU)", async () => {
  const w = rpcWorld(); const mf = start(await bundle(), w, fs.mkdtempSync(path.join(os.tmpdir(), "cf1b-do-")), { RELAYER_MAX_REQUESTS_PER_WINDOW: "100000", RELAYER_DAILY_BUDGET_YOCTO: "1" + "0".repeat(30), INDEXER_URL: "" });
  try {
    // CPUFLAKE1: genuine WALL-time check (workerd IPC); median over 3 independent batches of each batch's p99, threshold unchanged.
    let nonce = 1; const all: number[] = [];
    const stat = await medianOfBatchP99(async () => {
      const ts: number[] = [];
      for (let i = 0; i < 70; i++) { const b = buildDelegate({ senderId: `w${i % 7}.testnet`, nonce: BigInt(nonce++) }); const t = performance.now(); const r = await relay(mf, b.base64); ts.push(performance.now() - t); assert.equal(r.status, 200, JSON.stringify(r.json)); }
      const s = ts.slice(10); all.push(...s); return s;
    }, 3);
    const p99 = stat.value; const sa = [...all].sort((a, b) => a - b);
    console.log("CF1b-CPU-WALL " + JSON.stringify({ p50: sa[Math.floor(sa.length / 2)], p99, batches: stat.perBatch }));
    assert.ok(p99 <= 25, `p99 ${p99.toFixed(2)} ms > 25`);
  } finally { await mf.dispose(); }
});
