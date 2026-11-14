// CF1d RED: the indexer Worker (D1 storage, bounded tick, same HTTP API) against the node indexer (services/indexer) on
// the same recorded/mocked chain fixtures. The node side is the unchanged reference implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { refreshBets, refreshGovernance } from "../../../indexer/src/refresh.js";
import { createServer } from "../../../indexer/src/server.js";
import { fetchEscrowHistory } from "../../../verifier/src/live.js";
import type { TaggedBet } from "@praetorial/common/discovery.js";
import { handle } from "../src/index.js";
import { fakeD1, world, viewClient, outboundFetch, baseEnv, mkBet, settled, rc, OKS, type World, type Chain } from "./helpers.js";

const CONTRACTS = [{ id: "a.testnet", version: "v1" }, { id: "b.testnet", version: "v2" }];
const REPO_FIXTURE = JSON.parse(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../indexer/test/fixtures/governance_logs.json"), "utf8")) as Record<string, string>;

async function withFetch<T>(w: World, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch; globalThis.fetch = outboundFetch(w) as any;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const clock = { ms: 1_700_000_000_000 };
const tick = async (env: any, p = "/tick") => { clock.ms += 60_000; const r = await handle(new Request(`https://indexer.test${p}`, { method: "POST" }), env, () => clock.ms); return { status: r.status, json: (await r.json()) as any }; };
const get = async (env: any, p: string, method = "GET") => { const r = await handle(new Request(`https://indexer.test${p}`, { method }), env, () => clock.ms); return { status: r.status, ctype: r.headers.get("content-type"), cors: r.headers.get("access-control-allow-origin"), text: await r.text() }; };

async function nodeServer(bets: () => Map<string, TaggedBet>, gov: () => Map<string, any[]>) {
  const srv = createServer(bets, gov); await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => srv.close(() => r())) };
}
const nodeGet = async (base: string, p: string, method = "GET") => { const r = await fetch(base + p, { method }); return { status: r.status, ctype: r.headers.get("content-type"), cors: r.headers.get("access-control-allow-origin"), text: await r.text() }; };

const ROUTES = ["/offers", "/history", "/history?account=m.testnet", "/history?account=t.testnet", "/history?account=nobody.testnet", "/bet?bet_id=1", "/bet?bet_id=2&contract_id=b.testnet", "/bet?bet_id=1&contract_id=b.testnet",
  "/bet?bet_id=99", "/bet", "/bet?bet_id=abc", "/governance", "/governance?contract_id=a.testnet", "/governance?kind=guardian", "/health", "/nope", "/offers/extra"];

async function assertApiParity(env: any, nodeBets: Map<string, TaggedBet>, nodeGov: Map<string, any[]>, label: string) {
  const ns = await nodeServer(() => nodeBets, () => nodeGov);
  try {
    for (const r of ROUTES) {
      const n = await nodeGet(ns.base, r), x = await get(env, r);
      assert.equal(x.status, n.status, `${label} ${r} status`);
      assert.equal(x.ctype, n.ctype, `${label} ${r} content-type`);
      assert.equal(x.cors, n.cors, `${label} ${r} CORS header (node sets none)`);
      if (r === "/health") {
        // STACK1: the Worker's /health keeps every node field with the same value and ADDS exactly the deployed-stack fields.
        const nb = JSON.parse(n.text), xb = JSON.parse(x.text);
        for (const k of Object.keys(nb)) assert.deepEqual(xb[k], nb[k], `${label} ${r} field ${k}`);
        assert.deepEqual(Object.keys(xb).filter((k) => !(k in nb)).sort(), ["escrow_contract_id", "git_sha", "last_tick_at", "network", "service"], `${label} ${r} added fields`);
        continue;
      }
      assert.equal(x.text, n.text, `${label} ${r} body`);
    }
    for (const m of ["POST", "PUT"]) { // node ignores the method
      const n = await nodeGet(ns.base, "/offers", m), x = await get(env, "/offers", m);
      assert.deepEqual([x.status, x.text], [n.status, n.text], `${label} ${m} /offers`);
    }
  } finally { await ns.close(); }
}

const s = (w: World, second: Chain | null = null) => { w.second = second ?? JSON.parse(JSON.stringify(w.chain)); return w; };

test("refresh tick parity: open/taken/settled (confirmed), second contract, version label -- node refreshBets vs Worker tick, every route identical", async () => {
  const w = s(world({ "a.testnet": { 1: mkBet(), 2: mkBet({ status: "Taken", taker: "t.testnet" }), 3: settled() }, "b.testnet": { 1: mkBet({ created_at: 9 }, { maker: "other.testnet" }) } }));
  const f = fakeD1(); const env = baseEnv(f.d1);
  const nodeRes = await refreshBets(viewClient(w), CONTRACTS, new Map(), {}, { second: viewClient(w, "second") });
  const r = await withFetch(w, () => tick(env));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await assertApiParity(env, nodeRes.bets, new Map(), "fresh");
  assert.equal(JSON.parse((await get(env, "/bet?bet_id=3&contract_id=a.testnet")).text).display_status, "Settled");
  f.close();
});

test("desync parity across steps: redeploy (ghost bets vanish), contract RPC failure keeps its cache, lagging/lying reads cannot rewrite a terminal bet", async () => {
  const w = s(world({ "a.testnet": { 1: mkBet({}, { maker: "oldmaker.testnet" }), 2: mkBet(), 3: settled() }, "b.testnet": { 1: mkBet() } }));
  const f = fakeD1(); const env = baseEnv(f.d1);
  let nodeBets = new Map<string, TaggedBet>(); let max: Record<string, number> = {};
  const step = async (label: string) => {
    const nr = await refreshBets(viewClient(w), CONTRACTS, nodeBets, max, { second: viewClient(w, "second") });
    nodeBets = nr.bets; max = nr.maxIds;
    const r = await withFetch(w, () => tick(env)); assert.equal(r.status, 200, JSON.stringify(r.json));
    await assertApiParity(env, nodeBets, new Map(), label);
  };
  await step("initial");
  w.chain["a.testnet"] = "dead"; (w.chain["b.testnet"] as any)[2] = mkBet({ status: "Taken", taker: "t.testnet" }); s(w, w.second as Chain);
  await step("a dead, b grows");
  w.chain["a.testnet"] = { 1: mkBet({ created_at: 99 }, { maker: "newmaker.testnet", terms_hash: "h9" }) }; // redeploy at the same account
  await step("redeploy a");
  assert.deepEqual(JSON.parse((await get(env, "/offers")).text).filter((o: any) => o.contract_id === "a.testnet").map((o: any) => o.bet_id), [1]);
  // lying/lagging read on a settled bet (same identity): cached terminal wins
  w.chain["b.testnet"] = { ...(w.chain["b.testnet"] as any), 3: settled() }; w.second = JSON.parse(JSON.stringify(w.chain));
  await step("b gets settled bet 3");
  (w.chain["b.testnet"] as any)[3] = mkBet({ status: "Taken", taker: "t.testnet" }); // lagging node says Taken
  await step("lagging read");
  assert.equal(JSON.parse((await get(env, "/bet?bet_id=3&contract_id=b.testnet")).text).bet.status, "Settled");
  f.close();
});

test("terminal confirm parity: second RPC disagrees / down => 'settling, confirming' with no winner leaked, on every route", async () => {
  for (const second of ["disagree", "down"] as const) {
    const w = world({ "a.testnet": { 1: settled(), 2: mkBet() }, "b.testnet": {} });
    w.second = second === "down" ? "down" : { "a.testnet": { 1: settled({ outcome: "NO" }), 2: mkBet() }, "b.testnet": {} };
    const f = fakeD1(); const env = baseEnv(f.d1);
    const nodeRes = await refreshBets(viewClient(w), CONTRACTS, new Map(), {}, { second: second === "down" ? null : viewClient(w, "second") });
    await withFetch(w, () => tick(env));
    await assertApiParity(env, nodeRes.bets, new Map(), `confirm-${second}`);
    const h = JSON.parse((await get(env, "/history")).text)[0];
    assert.equal(h.display_status, "settling, confirming"); assert.equal(h.outcome, null);
    f.close();
  }
});

test("governance tick parity: indexed events (successful receipts only) served on /governance, ?contract_id & ?kind filters", async () => {
  const w = s(world({ "a.testnet": {}, "b.testnet": {} }));
  w.history["a.testnet"] = [
    { hash: "tx0", rc: rc([REPO_FIXTURE["guardian_proposed"]!], OKS, "1700000000000000000", "r0") },
    { hash: "tx1", rc: rc([REPO_FIXTURE["judge_pair_applied"]!], OKS, "1700000001000000000", "r1") },
    { hash: "tx2", rc: rc([REPO_FIXTURE["guardian_rotated"]!], { Failure: {} }, "1700000002000000000", "r2") }, // failed receipt: ignored
  ];
  w.history["b.testnet"] = [{ hash: "tx3", rc: rc([REPO_FIXTURE["asset_proposed"]!], OKS, "1700000003000000000", "r3", "b.testnet") }];
  const f = fakeD1(); const env = baseEnv(f.d1);
  const real = globalThis.fetch; globalThis.fetch = outboundFetch(w) as any;
  let gov: Map<string, any[]>;
  try { gov = (await refreshGovernance((id) => fetchEscrowHistory("testnet", id, { fetch: globalThis.fetch }), CONTRACTS.map((c) => c.id), new Map())).events; } finally { globalThis.fetch = real; }
  assert.ok([...gov.values()].flat().length >= 3, "fixture self-check");
  const r = await withFetch(w, () => tick(env, "/tick/governance")); assert.equal(r.status, 200, JSON.stringify(r.json));
  const nb = (await withFetch(w, () => refreshBets(viewClient(w), CONTRACTS, new Map(), {})));
  await withFetch(w, () => tick(env));
  await assertApiParity(env, nb.bets, gov, "governance");
  // a failing history fetch keeps previously indexed events (node behaviour) and does not wipe the table
  w.historyDown = true;
  const bad = await withFetch(w, () => tick(env, "/tick/governance"));
  assert.ok(bad.status === 200 || bad.status === 500);
  assert.equal(JSON.parse((await get(env, "/governance")).text).length, [...gov.values()].flat().length);
  f.close();
});

test("bounded batch: 60 bets, batch 8 => each tick <= 44 outbound subrequests and <= 40 D1 statements, board converges to the node's over several ticks", async () => {
  const chain: Record<number, any> = {};
  for (let i = 1; i <= 60; i++) chain[i] = i % 4 === 0 ? settled({ created_at: i }) : mkBet({ created_at: i }, { maker: `m${i % 7}.testnet` });
  const w = s(world({ "a.testnet": chain, "b.testnet": {} }));
  const f = fakeD1(); const env = baseEnv(f.d1, { INDEXER_BATCH_BETS: "8", INDEXER_MAX_CONFIRMS_PER_TICK: "4" });
  // the node's discovery grows its frontier by 5 per poll (discoverAllBets), so poll it to convergence like the long-running service does
  let nodeRes = await refreshBets(viewClient(w), CONTRACTS, new Map(), {}, { second: viewClient(w, "second") });
  for (let i = 0; i < 20; i++) nodeRes = await refreshBets(viewClient(w), CONTRACTS, nodeRes.bets, nodeRes.maxIds, { second: viewClient(w, "second") });
  assert.equal(nodeRes.bets.size, 60, "node reference converged");
  let ticks = 0, worstOut = 0, worstQ = 0;
  for (; ticks < 60; ticks++) {
    const o0 = w.outbound, q0 = f.counters.queries;
    const r = await withFetch(w, () => tick(env)); assert.equal(r.status, 200, JSON.stringify(r.json));
    worstOut = Math.max(worstOut, w.outbound - o0); worstQ = Math.max(worstQ, f.counters.queries - q0);
    const h = JSON.parse((await get(env, "/health")).text);
    if (h.bets_cached === 60 && JSON.parse((await get(env, "/history")).text).every((e: any) => e.display_status !== "settling, confirming")) break;
  }
  assert.ok(worstOut <= 44, `outbound per tick ${worstOut}`);
  assert.ok(worstQ <= 40, `D1 statements per tick ${worstQ}`);
  assert.ok(ticks > 3 && ticks < 60, `converged over several bounded ticks (${ticks})`);
  await assertApiParity(env, nodeRes.bets, new Map(), "bounded");
  f.close();
});

test("confirm budget: at most INDEXER_MAX_CONFIRMS_PER_TICK second-RPC reads per tick; unconfirmed bets stay 'settling, confirming' (never leak a winner)", async () => {
  const chain: Record<number, any> = {}; for (let i = 1; i <= 12; i++) chain[i] = settled({ created_at: i });
  const w = s(world({ "a.testnet": chain, "b.testnet": {} }));
  const f = fakeD1(); const env = baseEnv(f.d1, { INDEXER_BATCH_BETS: "40", INDEXER_MAX_CONFIRMS_PER_TICK: "5" });
  const s0 = w.secondViews;
  await withFetch(w, () => tick(env));
  assert.ok(w.secondViews - s0 <= 5, `second-RPC reads ${w.secondViews - s0}`);
  const hist = JSON.parse((await get(env, "/history")).text);
  assert.equal(hist.filter((e: any) => e.display_status === "settling, confirming").length, 7);
  assert.ok(hist.filter((e: any) => e.display_status === "settling, confirming").every((e: any) => e.outcome === null && e.status === "settling, confirming"));
  for (let i = 0; i < 4; i++) await withFetch(w, () => tick(env));
  assert.equal(JSON.parse((await get(env, "/history")).text).filter((e: any) => e.display_status === "settling, confirming").length, 0, "backlog drains over ticks");
  f.close();
});

test("state survives a restart: D1 persisted on disk, a fresh Worker instance serves the same board and continues the sweep cursor", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf1d-d1-")); const file = path.join(dir, "idx.sqlite");
  const chain: Record<number, any> = {}; for (let i = 1; i <= 20; i++) chain[i] = mkBet({ created_at: i });
  const w = s(world({ "a.testnet": chain, "b.testnet": {} }));
  let f = fakeD1(file); const env1 = baseEnv(f.d1, { INDEXER_BATCH_BETS: "8" });
  await withFetch(w, () => tick(env1));
  const mid = JSON.parse((await get(env1, "/health")).text).bets_cached; assert.ok(mid > 0 && mid < 20, `partial sweep (${mid})`);
  f.close();
  f = fakeD1(file, false); const env2 = baseEnv(f.d1, { INDEXER_BATCH_BETS: "8" });
  assert.equal(JSON.parse((await get(env2, "/health")).text).bets_cached, mid, "board survives restart");
  for (let i = 0; i < 6; i++) await withFetch(w, () => tick(env2));
  assert.equal(JSON.parse((await get(env2, "/health")).text).bets_cached, 20);
  const control = fakeD1(); assert.equal(JSON.parse((await get(baseEnv(control.d1), "/health")).text).bets_cached, 0, "control: fresh storage is empty");
  f.close(); control.close();
});

test("tick is single-flight and rate-limited by INDEXER_MIN_TICK_INTERVAL_MS (public /tick cannot be used to hammer the RPC); GET /tick is a 404 like node", async () => {
  const w = s(world({ "a.testnet": { 1: mkBet() }, "b.testnet": {} }));
  const f = fakeD1(); const env = baseEnv(f.d1, { INDEXER_MIN_TICK_INTERVAL_MS: "30000" });
  const t1 = await withFetch<Response>(w, () => handle(new Request("https://indexer.test/tick", { method: "POST" }), env, () => 5_000_000));
  const o = w.outbound;
  const t2 = await withFetch<Response>(w, () => handle(new Request("https://indexer.test/tick", { method: "POST" }), env, () => 5_001_000));
  assert.equal(t1.status, 200); assert.equal(((await t2.json()) as any).skipped, true); assert.equal(w.outbound, o, "skipped tick makes no outbound call");
  const both = await withFetch<Response[]>(w, () => Promise.all([1, 2].map(() => handle(new Request("https://indexer.test/tick", { method: "POST" }), env, () => 6_000_000))));
  assert.equal((await Promise.all(both.map(async (r) => ((await r.json()) as any).skipped === true))).filter(Boolean).length, 1, "exactly one of two concurrent ticks runs");
  assert.equal((await get(env, "/tick")).status, 404);
  f.close();
});

test("a tick with every contract unreadable is loud (500) and does not touch stored state", async () => {
  const w = s(world({ "a.testnet": { 1: mkBet() }, "b.testnet": {} }));
  const f = fakeD1(); const env = baseEnv(f.d1);
  await withFetch(w, () => tick(env));
  w.chain = { "a.testnet": "dead", "b.testnet": "dead" };
  const r = await withFetch(w, () => tick(env)); assert.equal(r.status, 500);
  assert.equal(JSON.parse((await get(env, "/health")).text).bets_cached, 1);
  f.close();
});

test("missing DB binding / invalid config is loud, never silently empty", async () => {
  const r = await handle(new Request("https://indexer.test/offers"), { ...baseEnv(null), INDEXER_DB: undefined }, () => 1);
  assert.equal(r.status, 500);
  const f = fakeD1(); const bad = await handle(new Request("https://indexer.test/tick", { method: "POST" }), { ...baseEnv(f.d1), INTENTS_CONTRACT_ID: "" }, () => 1);
  assert.equal(bad.status, 500); f.close();
});

test("FUND2: a NEW bet is served within one tick however many bets exist (frontier read first; the sweep keeps the rest of the budget)", async () => {
  const chain: Record<number, any> = {};
  for (let i = 1; i <= 60; i++) chain[i] = mkBet({ created_at: i }, { maker: `m${i % 7}.testnet` });
  const w = s(world({ "a.testnet": chain, "b.testnet": {} }));
  const f = fakeD1(); const env = baseEnv(f.d1, { INDEXER_BATCH_BETS: "8" });
  for (let i = 0; i < 60; i++) { await withFetch(w, () => tick(env)); if (JSON.parse((await get(env, "/health")).text).bets_cached === 60) break; }
  assert.equal(JSON.parse((await get(env, "/health")).text).bets_cached, 60, "initial board");
  // Live 2026-11-10: bet 40 stayed missing from /history for minutes while the sweep walked bets 1..39 (bounded window).
  for (const [id, maker] of [[61, "new1.testnet"], [62, "new2.testnet"]] as const) {
    (w.chain["a.testnet"] as any)[id] = mkBet({ created_at: id }, { maker }); ((w.second as any)["a.testnet"])[id] = (w.chain["a.testnet"] as any)[id];
    const o0 = w.outbound;
    const r = await withFetch(w, () => tick(env)); assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(w.outbound - o0 <= 44, `outbound per tick ${w.outbound - o0}`);
    const h = JSON.parse((await get(env, `/history?account=${maker}`)).text);
    assert.deepEqual(h.map((e: any) => e.bet_id), [id], `bet ${id} is in /history after ONE tick`);
  }
  // Two at once also land in one tick.
  for (const id of [63, 64]) { (w.chain["a.testnet"] as any)[id] = mkBet({ created_at: id }, { maker: "pair.testnet" }); ((w.second as any)["a.testnet"])[id] = (w.chain["a.testnet"] as any)[id]; }
  await withFetch(w, () => tick(env));
  assert.deepEqual(JSON.parse((await get(env, "/history?account=pair.testnet")).text).map((e: any) => e.bet_id).sort(), [63, 64]);
  f.close();
});
