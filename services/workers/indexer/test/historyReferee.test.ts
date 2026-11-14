// IDXREF1 RED (Worker host): /history?referee= on the D1-backed Worker, byte-identical to the node indexer.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { TaggedBet } from "@praetorial/common/discovery.js";
import { refreshBets } from "../../../indexer/src/refresh.js";
import { createServer } from "../../../indexer/src/server.js";
import { handle } from "../src/index.js";
import { fakeD1, world, viewClient, outboundFetch, baseEnv, mkBet, settled } from "./helpers.js";

const CONTRACTS = [{ id: "a.testnet", version: "v1" }, { id: "b.testnet", version: "v2" }];
const ref = (a: string) => ({ referee: { account: a, mode: "Human" } });
const chainWorld = () => { const w = world({
  "a.testnet": { 1: mkBet(), 2: mkBet({ status: "Taken", taker: "t.testnet" }, ref("y.testnet")), 3: mkBet({ status: "Taken", taker: "t.testnet" }, { maker: "x.testnet", ...ref("x.testnet") }), 4: settled({}) },
  "b.testnet": { 1: mkBet({ created_at: 9 }, ref("x.testnet")), 2: mkBet({ status: "Settled", taker: "t.testnet", outcome: "YES" }, ref("x.testnet")) } });
  w.second = JSON.parse(JSON.stringify(w.chain)); return w; };
const clock = { ms: 1_700_000_000_000 };
const get = async (env: any, p: string) => { const r = await handle(new Request(`https://indexer.test${p}`), env, () => clock.ms); return { status: r.status, ctype: r.headers.get("content-type"), text: await r.text() }; };
async function withFetch<T>(w: any, fn: () => Promise<T>): Promise<T> { const real = globalThis.fetch; globalThis.fetch = outboundFetch(w) as any; try { return await fn(); } finally { globalThis.fetch = real; } }
const ids = (t: string) => JSON.parse(t).map((e: any) => `${e.contract_id}:${e.bet_id}`);

async function setup() {
  const w = chainWorld(); const f = fakeD1(); const env = baseEnv(f.d1);
  clock.ms += 60_000;
  const r = await withFetch(w, () => handle(new Request("https://indexer.test/tick", { method: "POST" }), env, () => clock.ms)); assert.equal(r.status, 200);
  const nodeRes = await withFetch(w, () => refreshBets(viewClient(w), CONTRACTS, new Map(), {}, { second: viewClient(w, "second") }));
  return { env, f, nodeBets: nodeRes.bets as Map<string, TaggedBet> };
}

test("Worker /history?referee= returns exactly the current-referee bets across contracts (AI-mode excluded, maker-referee included, open included)", async () => {
  const { env, f } = await setup();
  assert.deepEqual(ids((await get(env, "/history?referee=x.testnet")).text), ["a.testnet:3", "b.testnet:1", "b.testnet:2"]);
  assert.deepEqual(ids((await get(env, "/history?referee=y.testnet")).text), ["a.testnet:2"]);
  assert.deepEqual(ids((await get(env, "/history?referee=nobody.testnet")).text), []);
  f.close();
});

test("Worker: referee/account conflict and invalid referee -> 400, ?account= unchanged", async () => {
  const { env, f } = await setup();
  for (const p of ["/history?account=m.testnet&referee=x.testnet", "/history?referee=", "/history?referee=A.testnet", "/history?referee=x..testnet"]) {
    const r = await get(env, p); assert.equal(r.status, 400, p); assert.equal(r.ctype, "application/json"); assert.equal(typeof JSON.parse(r.text).error, "string");
  }
  assert.deepEqual(ids((await get(env, "/history?account=t.testnet")).text), ["a.testnet:2", "a.testnet:3", "a.testnet:4", "b.testnet:2"]);
  f.close();
});

test("node/Worker parity on every referee route (status, content-type, body)", async () => {
  const { env, f, nodeBets } = await setup();
  const srv = createServer(() => nodeBets); await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    for (const p of ["/history?referee=x.testnet", "/history?referee=y.testnet", "/history?referee=nobody.testnet", "/history?referee=", "/history?referee=A.testnet", "/history?account=m.testnet&referee=x.testnet", "/history?account=m.testnet"]) {
      const n = await fetch(base + p), x = await get(env, p);
      assert.equal(x.status, n.status, `${p} status`); assert.equal(x.ctype, n.headers.get("content-type"), `${p} ctype`); assert.equal(x.text, await n.text(), `${p} body`);
    }
  } finally { await new Promise<void>((r) => srv.close(() => r())); f.close(); }
});
