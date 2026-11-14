// KEEPSUBMIT1 RED: the deployed Worker tick (runKeeperTick) relays signed resolver output too, inside its own bounded budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runKeeperTick, MemoryStateStore, BACKOFF_BASE_MS } from "../src/tick.js";
import { generateResolverKeypair } from "@praetorial/common/resolverSign.js";
import { makeRaw, makeBet } from "../../../keeper/test/helpers/signedRaw.js";

const kp = generateResolverKeypair();
const contracts = [{ id: "frz3.testnet", version: "v1" }, { id: "frz2.testnet", version: "v1" }];
const alerts = () => { const sent: string[] = []; return { sent, send: async (t: string) => { sent.push(t); } }; };
function chain(bets: Record<string, Record<number, any>>, fail = 0) {
  const calls: { c: string; m: string; a: any }[] = [];
  let f = fail;
  const client: any = {
    async view(c: string, m: string, a: any) { if (m === "get_bet") return bets[c]?.[a.bet_id] ?? null; if (m === "pending_payouts_view") return []; if (m === "is_shutdown") return false; throw new Error(m); },
    async call(c: string, m: string, a: any) {
      calls.push({ c, m, a });
      if (m === "submit_outcome") { if (f > 0) { f--; throw new Error("boom"); } const b = bets[c][a.result.bet_id]; b.status = "Proposed"; }
      return {};
    },
    async callPayable(c: string, m: string, a: any) { return client.call(c, m, a); },
  };
  return { client, calls };
}
const raw = (c: string, id: number, o: any = {}) => makeRaw({ contract: c, betId: id, runNo: 1, kp, ...o });
const NOW = Date.now();

test("Worker tick relays the stored signed result on both escrows (frz3 + frz2), then is a no-op", async () => {
  const c = chain({ "frz3.testnet": { 1: makeBet("Resolving", raw("frz3.testnet", 1)) }, "frz2.testnet": { 1: makeBet("Resolving", raw("frz2.testnet", 1)) } });
  const store = new MemoryStateStore();
  await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW, alerts: alerts(), limits: { maxRelays: 4 } });
  assert.deepEqual(c.calls.filter((x) => x.m === "submit_outcome").map((x) => x.c).sort(), ["frz2.testnet", "frz3.testnet"]);
  await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW + 61_000, alerts: alerts(), limits: { maxRelays: 4 } });
  assert.equal(c.calls.filter((x) => x.m === "submit_outcome").length, 2);
});

test("Worker tick never relays unsigned (NOKEY1) / malformed / wrong-run output", async () => {
  const c = chain({ "frz3.testnet": {
    1: makeBet("Resolving", raw("frz3.testnet", 1, { signed: false })),
    2: makeBet("Resolving", "nope"),
    3: makeBet("Resolving", raw("frz3.testnet", 3, { runNo: 5 })),
  } });
  await runKeeperTick({ client: c.client, contracts, store: new MemoryStateStore(), nowMs: () => NOW, alerts: alerts(), limits: { maxRelays: 4 } });
  assert.equal(c.calls.filter((x) => x.m === "submit_outcome").length, 0);
});

test("Worker tick: failed submit raises an alert, does not throw, retries after its backoff; relays are capped by maxRelays", async () => {
  const bets: any = { "frz3.testnet": {} };
  for (let i = 1; i <= 3; i++) bets["frz3.testnet"][i] = makeBet("Resolving", raw("frz3.testnet", i), { betId: i });
  const c = chain(bets, 1);
  const store = new MemoryStateStore(); const a = alerts();
  await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW, alerts: a, limits: { maxRelays: 2 } });
  assert.equal(c.calls.filter((x) => x.m === "submit_outcome").length, 2, "capped at maxRelays");
  assert.ok(a.sent.some((s) => /submit_outcome/.test(s) && /boom/.test(s)));
  // LIFE1 (SVC-2): the failed relay waits out its backoff (BACKOFF_BASE_MS) instead of the 30 s attempt window.
  await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW + 31_000, alerts: alerts(), limits: { maxRelays: 4 } });
  assert.equal(Object.values(bets["frz3.testnet"]).filter((b: any) => b.status === "Proposed").length, 2, "the failed relay is backed off");
  await runKeeperTick({ client: c.client, contracts, store, nowMs: () => NOW + BACKOFF_BASE_MS + 1_000, alerts: alerts(), limits: { maxRelays: 4 } });
  assert.equal(Object.values(bets["frz3.testnet"]).filter((b: any) => b.status === "Proposed").length, 3);
});
