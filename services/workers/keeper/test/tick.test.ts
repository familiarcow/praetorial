// CF1a RED: behaviour parity of the Worker tick with the node keeper's tickMulti on a
// mocked chain, plus the bounded-batch rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tickMulti } from "../../../keeper/src/runner.js";
import { TxLogger } from "@praetorial/common/logger.js";
import { runKeeperTick, MemoryStateStore } from "../src/tick.js";
import { dueBet } from "../../../keeper/test/helpers/dueBet.js";

const NOW = dueBet.nowMs;
function chain(extra: Record<number, any> = {}, shutdown = false) {
  const bets: Record<number, any> = { 1: dueBet(), 2: { ...dueBet(), status: "Settled" }, ...extra };
  const calls: string[] = [];
  const views: string[] = [];
  const client: any = {
    async view(c: string, m: string, a: any) {
      views.push(m);
      if (m === "get_bet") return bets[a.bet_id] ?? null;
      if (m === "pending_payouts_view") return [];
      if (m === "is_shutdown") return shutdown;
      throw new Error(`unexpected view ${m}`);
    },
    async call(c: string, m: string, a: any) { calls.push(`${c}:${m}:${a.bet_id}`); return { transaction: { hash: "h" } }; },
    async callPayable(c: string, m: string, a: any) { calls.push(`${c}:${m}:${a.bet_id}`); return {}; },
  };
  return { client, calls, views };
}
const contracts = [{ id: "escrow.testnet", version: "v1" }];
const mkAlerts = () => { const sent: string[] = []; return { sent, send: async (t: string) => { sent.push(t); } }; };

test("parity: same actions as node tickMulti on the same mocked chain", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf1a-"));
  const a = chain(); const b = chain();
  const node = await tickMulti({ client: a.client, contracts, logger: new TxLogger(path.join(dir, "l.jsonl")), statePath: path.join(dir, "s.json"), nowMs: () => NOW });
  const worker = await runKeeperTick({ client: b.client, contracts, store: new MemoryStateStore(), nowMs: () => NOW, alerts: mkAlerts() });
  assert.ok(node.length > 0, "fixture must trigger an action");
  assert.deepEqual(b.calls, a.calls);
  assert.deepEqual(worker.map((x) => `${x.contractId}:${x.action.kind}:${x.action.bet_id}`), node.map((x) => `${x.contractId}:${x.action.kind}:${x.action.bet_id}`));
});

test("parity: shut-down contract triggers emergency_refund like node", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf1a-"));
  const a = chain({}, true); const b = chain({}, true);
  await tickMulti({ client: a.client, contracts, logger: new TxLogger(path.join(dir, "l.jsonl")), statePath: path.join(dir, "s.json"), nowMs: () => NOW });
  await runKeeperTick({ client: b.client, contracts, store: new MemoryStateStore(), nowMs: () => NOW, alerts: mkAlerts() });
  assert.deepEqual(b.calls, a.calls);
  assert.ok(b.calls.some((c) => c.includes("emergency_refund")));
});

test("30 s per-action rate limit persists in the store (second tick does not re-fire)", async () => {
  const c = chain(); const store = new MemoryStateStore();
  await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW, alerts: mkAlerts() });
  const n = c.calls.length;
  await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW + 10_000, alerts: mkAlerts() });
  assert.equal(c.calls.length, n);
  await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW + 31_000, alerts: mkAlerts() });
  assert.equal(c.calls.length, 2 * n);
});

test("bounded batch: at most maxActions actions and maxViews views per tick; backlog drains over ticks", async () => {
  const many: Record<number, any> = {};
  for (let i = 1; i <= 30; i++) many[i] = dueBet();
  const c = chain(many); const store = new MemoryStateStore();
  const limits = { maxActions: 3, maxViews: 10 };
  let ticks = 0;
  const seen = new Set<string>();
  while (seen.size < 30 && ticks < 40) {
    c.views.length = 0; c.calls.length = 0;
    await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW + ticks * 31_000, alerts: mkAlerts(), limits });
    assert.ok(c.calls.length <= 3, `actions ${c.calls.length} > 3`);
    assert.ok(c.views.filter((v) => v === "get_bet").length <= 10, "get_bet views exceed budget");
    for (const x of c.calls) seen.add(x);
    ticks++;
  }
  assert.equal(seen.size, 30, `all 30 due bets eventually acted on (took ${ticks} ticks)`);
});

test("terminal bets are not re-read after they are seen terminal", async () => {
  const c = chain(); const store = new MemoryStateStore();
  await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW, alerts: mkAlerts() });
  c.views.length = 0;
  await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW + 60_000, alerts: mkAlerts() });
  const reads = c.views.filter((v) => v === "get_bet").length;
  assert.ok(reads <= 4, `second tick re-read ${reads} bets (settled bet 2 must be skipped)`);
});

test("action failure raises a deduped alert; 3 consecutive request_resolution failures raise outlayer_unhealthy", async () => {
  const c = chain();
  c.client.call = async () => { throw new Error("boom"); };
  const alerts = mkAlerts(); const store = new MemoryStateStore();
  // LIFE1 (SVC-2): a failed action is retried after a persisted backoff (5 min, then 10 min ...), not every 30 s.
  const at = [0, 31_000, 5 * 60_000, 15 * 60_000];
  for (let i = 0; i < at.length; i++) {
    await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW + at[i], alerts });
    if (i === 2) assert.equal(alerts.sent.filter((t) => /keeper_action_error/.test(t)).length, 1, "action-error alert deduped within cooldown");
  }
  assert.ok(alerts.sent.some((t) => /outlayer_unhealthy/.test(t)), alerts.sent.join("|"));
});

test("heartbeat message at most once per interval", async () => {
  const c = chain(); const store = new MemoryStateStore(); const alerts = mkAlerts();
  const limits = { heartbeatEveryMs: 60_000 };
  await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW, alerts, limits });
  await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW + 30_000, alerts, limits });
  await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW + 61_000, alerts, limits });
  assert.equal(alerts.sent.filter((t) => /keeper heartbeat/.test(t)).length, 2);
});
