// IDX1 RED (Worker host): the indexer serves ONLY the configured escrow (ESCROW_CONTRACT_ID). Live bug 2026-11-10: /offers
// listed 6 open offers from the previous escrow (frz2) while the indexer and the web were configured for frz3; the web then
// called get_bet on frz3 and showed '?' / 'terms unavailable'. Rows of other contracts stay in D1 (never deleted) but are
// never served, and the tick never reads them (no get_bet, no second-RPC confirmation) once ESCROW_CONTRACT_ID is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { loadIndexerConfig } from "../src/env.js";
import { fakeD1, world, outboundFetch, baseEnv, mkBet, settled, type World } from "./helpers.js";

const OLD = "old.testnet", CUR = "cur.testnet";
const ref = (a: string) => ({ referee: { account: a, mode: "Human" } });
const clock = { ms: 1_800_000_000_000 };
const env0 = (d1: unknown) => baseEnv(d1, { ESCROW_CONTRACT_ID: CUR, ESCROW_CONTRACTS: `${CUR}@v1,${OLD}@v1` });
async function withFetch<T>(w: World, fn: () => Promise<T>): Promise<T> { const real = globalThis.fetch; globalThis.fetch = outboundFetch(w) as any; try { return await fn(); } finally { globalThis.fetch = real; } }
const get = async (env: any, p: string) => { const r = await handle(new Request(`https://indexer.test${p}`), env, () => clock.ms); return { status: r.status, json: JSON.parse(await r.text()) as any }; };
const tick = async (env: any, p = "/tick") => { clock.ms += 60_000; const r = await handle(new Request(`https://indexer.test${p}`, { method: "POST" }), env, () => clock.ms); return { status: r.status, json: (await r.json()) as any }; };

/** D1 as the live testnet indexer left it: old-escrow rows (open, taken, settled-unconfirmed) cached before the switch. */
function seedOld(f: ReturnType<typeof fakeD1>) {
  const rows: [number, any, number | null][] = [
    [1, mkBet({}, { maker: "m.testnet" }), null],
    [2, mkBet({ status: "Taken", taker: "t.testnet" }, ref("x.testnet")), null],
    [3, settled({}), 0],
    [7, mkBet({}, { maker: "olduser.testnet" }), null],
  ];
  for (const [id, bet, confirmed] of rows) {
    f.d1.prepare("INSERT INTO indexer_bets (key, contract_id, bet_id, ord, version, confirmed, bet) VALUES (?,?,?,?,?,?,?)")
      .bind(`${OLD}:${id}`, OLD, id, 1, "v1", confirmed, JSON.stringify(bet))._exec();
  }
  f.d1.prepare("INSERT INTO indexer_governance (contract_id, events) VALUES (?, ?)").bind(OLD, JSON.stringify([{ contract_id: OLD, kind: "guardian", hash: "old" }]))._exec();
  f.d1.prepare("INSERT INTO indexer_governance (contract_id, events) VALUES (?, ?)").bind(CUR, JSON.stringify([{ contract_id: CUR, kind: "guardian", hash: "cur" }]))._exec();
}
const curWorld = (): World => { const w = world({
  [CUR]: { 1: mkBet({ created_at: 11 }, { maker: "m.testnet" }), 2: mkBet({ status: "Taken", taker: "t.testnet", created_at: 12 }, ref("x.testnet")) },
  [OLD]: "dead", // reading the old escrow at all would make this tick report it as failed
}); w.second = JSON.parse(JSON.stringify(w.chain)); return w; };

async function setup() {
  const f = fakeD1(); seedOld(f); const env = env0(f.d1); const w = curWorld();
  const r = await withFetch(w, () => tick(env)); assert.equal(r.status, 200, JSON.stringify(r.json));
  return { f, env, w, tickRes: r.json };
}
const keys = (rows: any[]) => rows.map((e: any) => `${e.contract_id}:${e.bet_id}`);

test("config: ESCROW_CONTRACT_ID set -> the indexer ingests ONLY that contract (version label from ESCROW_CONTRACTS)", () => {
  const cfg = loadIndexerConfig(baseEnv(null, { ESCROW_CONTRACT_ID: CUR, ESCROW_CONTRACTS: `${OLD}@v1,${CUR}@v2` }));
  assert.deepEqual(cfg.contracts, [{ id: CUR, version: "v2" }]);
  assert.deepEqual(loadIndexerConfig(baseEnv(null, { ESCROW_CONTRACT_ID: CUR, ESCROW_CONTRACTS: OLD })).contracts, [{ id: CUR, version: "v1" }]);
});

test("tick never reads the old escrow (no get_bet, no confirmation of its unconfirmed backlog) and never deletes its rows", async () => {
  const { f, w, tickRes } = await setup();
  assert.deepEqual(tickRes.failed, [], "old escrow must not be read at all");
  assert.equal(w.secondViews, 0, "old escrow's unconfirmed terminal row must not be confirmed via the second RPC");
  const stored = f.d1.prepare("SELECT key, confirmed FROM indexer_bets WHERE contract_id = ? ORDER BY bet_id").bind(OLD)._exec().results;
  assert.deepEqual(stored.map((r: any) => [r.key, r.confirmed]), [[`${OLD}:1`, null], [`${OLD}:2`, null], [`${OLD}:3`, 0], [`${OLD}:7`, null]], "old rows kept untouched");
  f.close();
});

test("/offers serves only the current escrow's open offers, each tagged with contract_id", async () => {
  const { f, env } = await setup();
  const r = await get(env, "/offers");
  assert.equal(r.status, 200);
  assert.deepEqual(keys(r.json), [`${CUR}:1`]);
  f.close();
});

test("/history (all, ?account=, ?referee=) serves only the current escrow's bets", async () => {
  const { f, env } = await setup();
  assert.deepEqual(keys((await get(env, "/history")).json), [`${CUR}:1`, `${CUR}:2`]);
  assert.deepEqual(keys((await get(env, "/history?account=t.testnet")).json), [`${CUR}:2`]);
  assert.deepEqual(keys((await get(env, "/history?account=olduser.testnet")).json), []);
  assert.deepEqual(keys((await get(env, "/history?referee=x.testnet")).json), [`${CUR}:2`]);
  f.close();
});

test("/bet: old-escrow ids are not served (with or without contract_id); current ones are", async () => {
  const { f, env } = await setup();
  assert.equal((await get(env, "/bet?bet_id=7")).json, null);
  assert.equal((await get(env, `/bet?bet_id=1&contract_id=${OLD}`)).json, null);
  assert.equal((await get(env, `/bet?bet_id=3&contract_id=${OLD}`)).json, null);
  const b = (await get(env, "/bet?bet_id=1")).json;
  assert.equal(b.contractId, CUR); assert.equal(b.bet.created_at, 11);
  assert.equal((await get(env, `/bet?bet_id=2&contract_id=${CUR}`)).json.contractId, CUR);
  f.close();
});

test("/governance serves only the current escrow's events; /health counts only served rows", async () => {
  const { f, env } = await setup();
  assert.deepEqual((await get(env, "/governance")).json.map((e: any) => e.contract_id), [CUR]);
  assert.deepEqual((await get(env, `/governance?contract_id=${OLD}`)).json, []);
  assert.equal((await get(env, "/health")).json.bets_cached, 2);
  f.close();
});

test("governance tick fetches only the current escrow's history", async () => {
  const f = fakeD1(); seedOld(f); const env = env0(f.d1); const w = curWorld();
  const seen: string[] = [];
  const real = globalThis.fetch; const inner = outboundFetch(w);
  globalThis.fetch = (async (i: any, init?: any) => { const b = JSON.parse(String(init?.body ?? "{}")); if (b.account_id) seen.push(b.account_id); return inner(i, init); }) as any;
  try { const r = await tick(env, "/tick/governance"); assert.equal(r.status, 200); assert.deepEqual(r.json.updated, [CUR]); } finally { globalThis.fetch = real; }
  assert.ok(!seen.includes(OLD), `old escrow history fetched: ${seen}`);
  f.close();
});
