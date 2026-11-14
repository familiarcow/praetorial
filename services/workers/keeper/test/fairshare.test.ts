// KEEPSUBMIT1c RED: discovery must give every escrow contract a fair share of maxViews (frz3 must not starve frz2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runKeeperTick, MemoryStateStore } from "../src/tick.js";
import { generateResolverKeypair } from "@praetorial/common/resolverSign.js";
import { makeRaw, makeBet } from "../../../keeper/test/helpers/signedRaw.js";

const kp = generateResolverKeypair();
const A = "frz3.testnet", B = "frz2.testnet";
const contracts = [{ id: A, version: "v1" }, { id: B, version: "v1" }];
const alerts = { send: async (_: string) => {} };
function chain(bets: Record<string, Record<number, any>>) {
  const calls: { c: string; m: string; a: any }[] = [];
  const reads: { c: string; id: number }[] = [];
  const client: any = {
    async view(c: string, m: string, a: any) {
      if (m === "get_bet") { reads.push({ c, id: a.bet_id }); return bets[c]?.[a.bet_id] ?? null; }
      if (m === "pending_payouts_view") return [];
      if (m === "is_shutdown") return false;
      throw new Error(m);
    },
    async call(c: string, m: string, a: any) { calls.push({ c, m, a }); if (m === "submit_outcome") bets[c][a.result.bet_id].status = "Proposed"; return {}; },
    async callPayable(c: string, m: string, a: any) { return client.call(c, m, a); },
  };
  return { client, calls, reads };
}
const raw = (c: string, id: number) => makeRaw({ contract: c, betId: id, runNo: 1, kp });
const open = (c: string, n: number) => { const o: Record<number, any> = {}; for (let i = 1; i <= n; i++) o[i] = makeBet("Taken", null, { betId: i }); return o; };
const NOW = Date.now();
const seed = (a: number, b: number) => { const s = new MemoryStateStore(); return s.save({ maxBetIds: { [A]: a, [B]: b }, terminal: {}, cursor: {}, payoutFloor: {}, lastAttempt: {}, lastAlert: {}, outlayerFails: [], outlayerAlerting: false, lastHeartbeat: 0 } as any).then(() => s); };

test("second contract gets >= floor(maxViews/n) get_bet reads per tick and all its bets are read within ceil(known/share) ticks", async () => {
  const bets = { [A]: open(A, 8), [B]: open(B, 6) };
  const c = chain(bets); const store = await seed(8, 6);
  const seen = new Set<number>();
  for (let t = 0; t < 2; t++) {
    c.reads.length = 0;
    await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW + t * 61_000, alerts, limits: { maxViews: 8 } });
    const b = c.reads.filter((r) => r.c === B);
    assert.ok(b.length >= 4, `tick ${t}: frz2 reads ${b.length} < 4`);
    for (const r of b) if (r.id <= 6) seen.add(r.id);
  }
  assert.equal(seen.size, 6, "all 6 frz2 bets read within ceil(6/4)=2 ticks");
});

test("every non-terminal bet of the first contract is also read within ceil(known/share) ticks", async () => {
  const bets = { [A]: open(A, 8), [B]: open(B, 6) };
  const c = chain(bets); const store = await seed(8, 6);
  const seen = new Set<number>();
  // share 4 = 3 known reads + 1 frontier probe per tick, so 8 known bets take ceil(8/3)=3 ticks
  for (let t = 0; t < 3; t++) {
    await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW + t * 61_000, alerts, limits: { maxViews: 8 } });
    for (const r of c.reads) if (r.c === A && r.id <= 8) seen.add(r.id);
  }
  assert.equal(seen.size, 8, "all 8 frz3 bets read within ceil(8/(4-1)) ticks");
});

test("frontier probing stops after the first miss per contract per tick", async () => {
  const bets = { [A]: open(A, 1), [B]: open(B, 1) };
  const c = chain(bets); const store = await seed(1, 1);
  await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW, alerts, limits: { maxViews: 8 } });
  const misses = c.reads.filter((r) => r.id === 2);
  assert.equal(misses.filter((r) => r.c === A).length, 1);
  assert.equal(misses.filter((r) => r.c === B).length, 1);
});

test("a relayable bet on the second contract is relayed within 2 ticks even when the first has >= maxViews open bets", async () => {
  const bets = { [A]: open(A, 8), [B]: { ...open(B, 5), 6: makeBet("Resolving", raw(B, 6), { betId: 6 }) } };
  const c = chain(bets); const store = await seed(8, 6);
  for (let t = 0; t < 2; t++) await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW + t * 61_000, alerts, limits: { maxViews: 8 } });
  const sub = c.calls.filter((x) => x.m === "submit_outcome");
  assert.equal(sub.length, 1);
  assert.equal(sub[0].c, B);
  assert.equal(sub[0].a.result.bet_id, 6);
});
