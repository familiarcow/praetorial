// MON4: keeper-side producers. request_resolution failures feed the OutLayer health tracker; NEAR AI 402 in the
// failure text raises nearai_credit_exhausted; 429 raises nothing. Offline, mock client.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tickMulti } from "../src/runner.js";
import { ServiceAlertRaiser } from "../../monitor/src/serviceAlerts.js";
import { OutlayerHealthTracker } from "../../monitor/src/opsAlerts.js";
import { TxLogger } from "@praetorial/common/logger.js";

const CONTRACT = "escrow.test";
const NS = 1_000_000_000;
const MIN = 60 * NS;
// a due request_resolution bet: reuse the LH5 fixture shape via a minimal helper
import { dueBet } from "./helpers/dueBet.js";

function failingClient(msg: string) {
  const b = dueBet();
  return {
    async view(_c: string, method: string, args: any) {
      if (method === "get_bet") return args.bet_id === 1 ? b : null;
      if (method === "pending_payouts_view") return [];
      if (method === "is_shutdown") return false;
      throw new Error(`unexpected view ${method}`);
    },
    async call() { throw new Error(msg); },
    async callPayable() { throw new Error(msg); },
  } as any;
}
async function run(msg: string, ticks: number) {
  const sent: any[] = [];
  const t0 = Date.now();
  const raiser = new ServiceAlertRaiser({ async send(a) { sent.push(a); } }, 15 * MIN, () => t0 * 1e6);
  const outlayer = new OutlayerHealthTracker(3, 30 * MIN);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mon4k-"));
  for (let i = 0; i < ticks; i++) {
    await tickMulti({ client: failingClient(msg), contracts: [{ id: CONTRACT, version: "v1" }], logger: new TxLogger(path.join(dir, "l.jsonl")),
      statePath: path.join(dir, `s${i}.json`), nowMs: () => dueBet.nowMs + i * 15_000, alarm: raiser, outlayer } as any);
  }
  return sent.map((a) => a.kind);
}

test("3 consecutive request_resolution timeouts -> exactly one outlayer_unhealthy", async () => {
  assert.deepEqual(await run("Exceeded the maximum amount of time: timeout", 2), []);
  assert.deepEqual(await run("Exceeded the maximum amount of time: timeout", 4), ["outlayer_unhealthy"]);
});
test("402 in the failure -> nearai_credit_exhausted (once)", async () => {
  const k = await run("HTTP 402 Payment Required from NEAR AI", 2);
  assert.ok(k.includes("nearai_credit_exhausted"));
  assert.equal(k.filter((x) => x === "nearai_credit_exhausted").length, 1);
});
test("429 in the failure -> no nearai alert", async () => {
  const k = await run("HTTP 429 Too Many Requests quota per minute", 2);
  assert.ok(!k.includes("nearai_credit_exhausted"));
});
