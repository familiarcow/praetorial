// KEEPDRAIN1 RED: the Worker tick must drain cancel/expire refund payout lines promptly.
// Live finding (RLYDEP1): cancel_expire_refund lines for bets 10..23 sat at attempts 0 for >3 min.
// Root causes reproduced here: (1) ONE shared action budget (maxActions=1) served drain_payouts and
// resolution/expire actions in the same queue, so a backlog of N pending bets drained 1 per minute;
// (2) the payout scan reads at most 3x200 lines from id 0 and ids are never pruned, so a line past
// id 600 is never seen once the ledger grows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runKeeperTick, MemoryStateStore } from "../src/tick.js";
import { dueBet } from "../../../keeper/test/helpers/dueBet.js";

const NOW = dueBet.nowMs;
const contracts = [{ id: "escrow.testnet", version: "v1" }];
const mkAlerts = () => { const sent: string[] = []; return { sent, send: async (t: string) => { sent.push(t); } }; };

interface Line { id: number; bet_id: number; reason: string; attempts: number; done: boolean; in_flight: boolean; amount: string; token_id: string; receiver: string }
const line = (id: number, bet_id: number, done: boolean): Line => ({ id, bet_id, reason: "cancel_expire_refund", attempts: done ? 1 : 0, done, in_flight: false, amount: "10", token_id: "t", receiver: "r" });

/** mock chain: bets (get_bet) + a real from/limit pending_payouts_view; drain_payouts marks the lines done (as the contract would). */
function chain(bets: Record<number, any>, lines: Line[]) {
  const calls: string[] = []; const pageReads: number[] = [];
  const client: any = {
    async view(_c: string, m: string, a: any) {
      if (m === "get_bet") return bets[a.bet_id] ?? null;
      if (m === "pending_payouts_view") { pageReads.push(a.from); return lines.filter((l) => l.id >= Math.max(1, a.from)).slice(0, a.limit); }
      if (m === "is_shutdown") return false;
      throw new Error(`unexpected view ${m}`);
    },
    async call(_c: string, m: string, a: any) {
      calls.push(`${m}:${a.bet_id}`);
      if (m === "drain_payouts") for (const l of lines) if (l.bet_id === a.bet_id) { l.done = true; l.attempts++; }
      return { transaction: { hash: "h" } };
    },
    async callPayable() { return {}; },
  };
  return { client, calls, lines, pageReads };
}
const cancelledBets = (n: number) => { const b: Record<number, any> = {}; for (let i = 1; i <= n; i++) b[i] = { ...dueBet(), status: "Cancelled" }; return b; };

test("backlog: 10 bets with undone refund lines are all drained within 3 default-limit ticks (was 1 per tick)", async () => {
  const lines = Array.from({ length: 10 }, (_, i) => line(i + 1, i + 1, false));
  const c = chain(cancelledBets(10), lines); const store = new MemoryStateStore();
  let ticks = 0;
  while (lines.some((l) => !l.done) && ticks < 3) { await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW + ticks * 60_000, alerts: mkAlerts() }); ticks++; }
  assert.deepEqual(lines.filter((l) => !l.done).map((l) => l.bet_id), [], `still undrained after ${ticks} ticks; calls=${c.calls.join(",")}`);
});

test("a drain is not starved by a due resolution action: both fire in the same default tick", async () => {
  const lines = [line(1, 2, false)];
  const c = chain({ 1: dueBet(), 2: { ...dueBet(), status: "Cancelled" } }, lines);
  const done = await runKeeperTick({ client: c.client, contracts, store: new MemoryStateStore(), nowMs: () => NOW, alerts: mkAlerts() });
  assert.ok(c.calls.includes("drain_payouts:2"), `drain missing; calls=${c.calls.join(",")}`);
  assert.ok(c.calls.includes("request_resolution:1"), `resolution missing; calls=${c.calls.join(",")}`);
  assert.equal(done.length, 2);
});

test("non-drain actions still obey maxActions (drains have their own budget, never loosened)", async () => {
  const many: Record<number, any> = {}; for (let i = 1; i <= 5; i++) many[i] = dueBet();
  const c = chain(many, []);
  await runKeeperTick({ client: c.client, contracts, store: new MemoryStateStore(), nowMs: () => NOW, alerts: mkAlerts(), limits: { maxActions: 1 } });
  assert.equal(c.calls.filter((x) => !x.startsWith("drain_payouts")).length, 1);
});

test("maxDrains bounds drains per tick (subrequest budget)", async () => {
  const lines = Array.from({ length: 10 }, (_, i) => line(i + 1, i + 1, false));
  const c = chain(cancelledBets(10), lines);
  await runKeeperTick({ client: c.client, contracts, store: new MemoryStateStore(), nowMs: () => NOW, alerts: mkAlerts(), limits: { maxDrains: 2 } as any });
  assert.equal(c.calls.filter((x) => x.startsWith("drain_payouts")).length, 2);
});

test("an undone line past id 600 (ledger grown beyond 3 pages of done lines) is still found and drained", async () => {
  const lines: Line[] = Array.from({ length: 700 }, (_, i) => line(i + 1, 1, true));
  lines.push(line(701, 2, false));
  const c = chain({ 1: { ...dueBet(), status: "Settled" }, 2: { ...dueBet(), status: "Cancelled" } }, lines);
  // cold start: 3 pages/tick (subrequest cap) advance the persisted floor, so line 701 is reached by tick 2 at the latest.
  const store = new MemoryStateStore();
  for (let t = 0; t < 2; t++) await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW + t * 60_000, alerts: mkAlerts() });
  assert.ok(c.calls.includes("drain_payouts:2"), `line 701 never drained; calls=${c.calls.join(",")}`);
});

test("payout scan resumes from the all-done floor: 2nd tick does not re-read the done prefix", async () => {
  const lines: Line[] = Array.from({ length: 500 }, (_, i) => line(i + 1, 1, true));
  const c = chain({ 1: { ...dueBet(), status: "Settled" } }, lines); const store = new MemoryStateStore();
  await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW, alerts: mkAlerts() });
  c.pageReads.length = 0;
  await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW + 60_000, alerts: mkAlerts() });
  assert.ok(c.pageReads.every((f) => f >= 500), `re-read from ${c.pageReads.join(",")}`);
});
