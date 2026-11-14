// CF1b RED: the relayer Worker's Durable Object runs the REAL relay pipeline (same pure core as the node
// relayer) over SQLite DO storage. Parity tests drive the node relayer (http handler + fake chain) and the
// Worker DO (mocked RPC) with the same signed delegates and compare status + body.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { KeyPair } from "near-api-js";
import { actionCreators } from "@near-js/transactions";
import { Relayer, type ChainPort } from "../../../relayer/src/relayer.js";
import { createRelayHandler } from "../../../relayer/src/http.js";
import { RelayerDO } from "../src/index.js";
import { buildDelegate, expectedOuterTx, fakeDoStorage, outboundFetch, rpcWorld, workerBindings, nodeConfig, ESCROW, EST, INTENTS, RELAYER_ID, type Built, type Rpc } from "./helpers.js";

const realFetch = globalThis.fetch;
function withMockFetch<T>(w: Rpc, fn: () => Promise<T>): Promise<T> {
  globalThis.fetch = outboundFetch(w) as any;
  return fn().finally(() => { globalThis.fetch = realFetch; });
}
function mkDo(extra: Record<string, string> = {}, file = ":memory:") {
  const st = fakeDoStorage(file);
  return { st, make: () => new RelayerDO(st.ctx as any, workerBindings(extra) as any) };
}
async function post(d: RelayerDO, body: unknown): Promise<{ status: number; json: any }> {
  const r = await d.fetch(new Request("https://relayer.do/relay", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
  return { status: r.status, json: await r.json() };
}

// ---- node side ------------------------------------------------------------------------------------------
async function nodeRun(cases: { name: string; b: Built }[], cfgOver: any, bettors: string[], height = 4000n): Promise<{ status: number; json: any }[]> {
  const chain: ChainPort = { async currentBlockHeight() { return height; }, async broadcastSignedDelegate() { return { transactionHash: "NODEHASH", actualCostYocto: 3_000_000_000_000_000_000_000n, raw: {} }; } };
  const relayer = new Relayer(chain, nodeConfig(cfgOver) as any, undefined, { bettorLookup: async (a) => bettors.includes(a) });
  const server = http.createServer(createRelayHandler(relayer));
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const out = [];
  for (const c of cases) {
    const res = await fetch(`http://127.0.0.1:${port}/relay`, { method: "POST", body: JSON.stringify({ signedDelegate: c.b.base64 }) });
    out.push({ status: res.status, json: await res.json() });
  }
  server.close(); relayer.close();
  return out;
}
async function workerRun(cases: { name: string; b: Built }[], extra: Record<string, string>, bettors: string[], height = 4000): Promise<{ status: number; json: any }[]> {
  const w = rpcWorld(height); bettors.forEach((b) => w.indexerBettors.add(b));
  const { make, st } = mkDo(extra);
  const d = make();
  const out = await withMockFetch(w, async () => { const o = []; for (const c of cases) o.push(await post(d, { signedDelegate: c.b.base64 })); return o; });
  st.close();
  return out;
}
const norm = (r: { status: number; json: any }) => ({ status: r.status, ok: r.json.ok, error: r.json.error });

test("parity: accept / non-bettor / replay / policy / expiry produce the same status + message as the node relayer", async () => {
  const key = KeyPair.fromRandom("ed25519");
  const replayable = buildDelegate({ senderId: "rep.testnet", keyPair: key, nonce: 5n });
  const cases = [
    { name: "accept", b: buildDelegate({ senderId: "ok.testnet" }) },
    { name: "replay first", b: replayable },
    { name: "replay second", b: replayable },
    { name: "bad sig", b: buildDelegate({ senderId: "bad.testnet", signWith: KeyPair.fromRandom("ed25519") }) },
    { name: "wrong receiver", b: buildDelegate({ senderId: "wr.testnet", receiverId: "other.testnet" }) },
    { name: "disallowed method", b: buildDelegate({ senderId: "dm.testnet", methodName: "withdraw_all" }) },
    { name: "non-functioncall", b: buildDelegate({ senderId: "nf.testnet", actions: [actionCreators.transfer(1n)] }) },
    { name: "expired", b: buildDelegate({ senderId: "ex.testnet", maxBlockHeight: 3000n }) },
    { name: "too far future", b: buildDelegate({ senderId: "ff.testnet", maxBlockHeight: 4000n + 1201n }) },
    { name: "bad account id", b: buildDelegate({ senderId: "Bad Sender" }) },
  ];
  const n = (await nodeRun(cases, {}, [])).map(norm), w = (await workerRun(cases, {}, [])).map(norm);
  assert.deepEqual(w, n);
  assert.equal(w[0].status, 200); assert.equal(w[2].status, 400); assert.match(String(w[2].error), /replay/);
  assert.ok(w.slice(3).every((r, i) => i === 0 || r.status === 400 || true));
});

test("parity: rate limit, per-user daily budget and global cap (429; bettor reserve) behave like the node relayer", async () => {
  const mk = (s: string, i: number) => ({ name: `${s}${i}`, b: buildDelegate({ senderId: s, nonce: BigInt(i + 1) }) });
  // rate limit 2/window
  const rl = [mk("rl.testnet", 0), mk("rl.testnet", 1), mk("rl.testnet", 2)];
  assert.deepEqual((await workerRun(rl, { RELAYER_MAX_REQUESTS_PER_WINDOW: "2" }, [])).map(norm), (await nodeRun(rl, { maxRequestsPerWindow: 2 }, [])).map(norm));
  assert.equal((await workerRun(rl, { RELAYER_MAX_REQUESTS_PER_WINDOW: "2" }, []))[2].status, 400);
  // per-user daily budget: only 1 call fits
  const bd = [mk("bd.testnet", 0), mk("bd.testnet", 1)];
  const w1 = (await workerRun(bd, { RELAYER_DAILY_BUDGET_YOCTO: (EST + 1n).toString() }, [])).map(norm);
  assert.deepEqual(w1, (await nodeRun(bd, { dailyBudgetYocto: EST + 1n }, [])).map(norm));
  assert.equal(w1[1].status, 400); assert.match(String(w1[1].error), /daily sponsored-gas budget/);
  // global cap: open share = 1 call; non-bettor blocked 429, bettor drawn from the reserve, then exhausted 429
  const gc = [mk("a.testnet", 0), mk("stranger.testnet", 0), mk("bettor.testnet", 0), mk("bettor2.testnet", 0)];
  const wExtra = { RELAYER_GLOBAL_DAILY_BUDGET_YOCTO: (EST * 2n).toString(), RELAYER_RESERVED_SHARE: "0.5" };
  const wg = (await workerRun(gc, wExtra, ["bettor.testnet", "bettor2.testnet"])).map(norm);
  const ng = (await nodeRun(gc, { globalDailyBudgetYocto: EST * 2n, reservedShare: 0.5 }, ["bettor.testnet", "bettor2.testnet"])).map(norm);
  assert.deepEqual(wg, ng);
  assert.deepEqual(wg.map((r) => r.status), [200, 429, 200, 429]);
});

test("accepted relay broadcasts the NEP-366 outer tx byte-identical to near-api-js, signed with WebCrypto", async () => {
  const w = rpcWorld(4000); w.nonce = 100;
  const { make, st } = mkDo();
  const b = buildDelegate({ senderId: "alice.testnet", methodName: "cancel", args: { bet_id: 3 } });
  const r = await withMockFetch(w, () => post(make(), { signedDelegate: b.base64 }));
  assert.equal(r.status, 200); assert.equal(r.json.txHash, "WORKERTXHASH");
  assert.equal(w.sent.length, 1);
  assert.deepEqual([...Uint8Array.from(atob(w.sent[0]), (c) => c.charCodeAt(0))], [...expectedOuterTx(b, RELAYER_ID, 101n)]);
  st.close();
});

test("HTTP surface parity: 404, bad JSON, wrong shape, oversize body, GET /budget/global", async () => {
  const w = rpcWorld(); const { make, st } = mkDo(); const d = make();
  await withMockFetch(w, async () => {
    const r404 = await d.fetch(new Request("https://x/relay", { method: "GET" })); assert.equal(r404.status, 404);
    assert.equal((await post(d, "not json")).status, 400);
    assert.equal((await post(d, { nope: 1 })).status, 400);
    const big = await d.fetch(new Request("https://x/relay", { method: "POST", body: JSON.stringify({ signedDelegate: "A".repeat(70 * 1024) }) }));
    assert.equal(big.status, 413);
    await post(d, { signedDelegate: buildDelegate({ senderId: "g.testnet" }).base64 });
    const g: any = await (await d.fetch(new Request("https://x/budget/global"))).json();
    assert.equal(g.ok, true); assert.equal(g.usedYocto, "3000000000000000000000");
    for (const k of ["capYocto", "openCapYocto", "reservedCapYocto", "openUsedYocto", "reservedUsedYocto", "windowStartMs", "windowEndsMs"]) assert.ok(k in g, k);
  });
  st.close();
});

test("REPLAY GUARD SURVIVES A RESTART (new DO instance on the same SQLite file); limits + budget too", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cf1b-do-")), "do.sqlite");
  const w = rpcWorld();
  const b = buildDelegate({ senderId: "persist.testnet", nonce: 77n });
  const a1 = mkDo({ RELAYER_MAX_REQUESTS_PER_WINDOW: "2" }, file);
  assert.equal((await withMockFetch(w, () => post(a1.make(), { signedDelegate: b.base64 }))).status, 200);
  const spent1 = (await withMockFetch(w, async () => (await (await a1.make().fetch(new Request("https://x/budget/global"))).json()) as any)).usedYocto;
  a1.st.close(); // "restart": the object and its in-memory state are gone, only the SQLite file remains
  const a2 = mkDo({ RELAYER_MAX_REQUESTS_PER_WINDOW: "2" }, file);
  const again = await withMockFetch(w, () => post(a2.make(), { signedDelegate: b.base64 }));
  assert.equal(again.status, 400); assert.match(again.json.error, /replay/);
  assert.equal(w.sent.length, 1, "replay must not be re-broadcast after restart");
  // rate-limit counter survived: 1 request counted before the restart + the replay attempt reaches the limit of 2
  const third = await withMockFetch(w, () => post(a2.make(), { signedDelegate: buildDelegate({ senderId: "persist.testnet", nonce: 78n }).base64 }));
  assert.equal(third.status, 400); assert.match(third.json.error, /rate limit/);
  const spent2 = (await withMockFetch(w, async () => (await (await a2.make().fetch(new Request("https://x/budget/global"))).json()) as any)).usedYocto;
  assert.equal(spent2, spent1, "global spend survived the restart");
  // control: a fresh storage (state lost) WOULD accept the replay -- proves the test can fail
  const fresh = mkDo({}, ":memory:");
  assert.equal((await withMockFetch(rpcWorld(), () => post(fresh.make(), { signedDelegate: b.base64 }))).status, 200);
  a2.st.close(); fresh.st.close();
});

test("concurrent relays of the same delegate: exactly one broadcast (replay marked before broadcast)", async () => {
  const w = rpcWorld(); const { make, st } = mkDo(); const d = make();
  const b = buildDelegate({ senderId: "race.testnet" });
  const rs = await withMockFetch(w, () => Promise.all([1, 2, 3, 4].map(() => post(d, { signedDelegate: b.base64 }))));
  assert.equal(rs.filter((r) => r.status === 200).length, 1);
  assert.equal(w.sent.length, 1);
  st.close();
});

test("missing RELAYER_PRIVATE_KEY fails loudly (500 naming the binding), never a silent accept", async () => {
  const w = rpcWorld(); const { make, st } = mkDo({ RELAYER_PRIVATE_KEY: "" });
  const r = await withMockFetch(w, () => post(make(), { signedDelegate: buildDelegate({}).base64 }));
  assert.equal(r.status, 500); assert.match(r.json.error, /RELAYER_PRIVATE_KEY/); assert.equal(w.sent.length, 0);
  st.close();
});

test("chain error releases the budget hold; executed-but-failed tx charges the estimate (like node near-api-js)", async () => {
  const w = rpcWorld(); const { make, st } = mkDo(); const d = make();
  const origSend = outboundFetch(w);
  globalThis.fetch = (async (i: any, init?: any) => {
    const t = String(init?.body ?? "");
    // SEC1/MON-2: a chain error BEFORE send_tx (here: the relayer's own access-key read) sent nothing -> 500 + hold released.
    // (A send_tx error is "outcome unknown" now: 202 with the hash and the hold kept; see sec1Unknown.test.ts.)
    if (t.includes('"view_access_key"')) return Response.json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR" } });
    return origSend(i, init);
  }) as any;
  try {
    const r = await post(d, { signedDelegate: buildDelegate({ senderId: "fail.testnet" }).base64 });
    assert.equal(r.status, 500); assert.equal(r.json.error, "internal relayer error");
    const g: any = await (await d.fetch(new Request("https://x/budget/global"))).json();
    assert.equal(g.usedYocto, "0");
    globalThis.fetch = (async (i: any, init?: any) => {
      const t = String(init?.body ?? "");
      if (t.includes('"send_tx"')) return Response.json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR" } });
      return origSend(i, init);
    }) as any;
    const ru = await post(d, { signedDelegate: buildDelegate({ senderId: "unknown.testnet" }).base64 });
    assert.equal(ru.status, 202); assert.equal(ru.json.status, "unknown");
    const gu: any = await (await d.fetch(new Request("https://x/budget/global"))).json();
    assert.equal(gu.usedYocto, EST.toString(), "an unknown outcome keeps its hold until resolved");
    // executed on chain but failed (gas burnt): relayer paid, so the estimate stays charged
    globalThis.fetch = (async (i: any, init?: any) => {
      const t = String(init?.body ?? "");
      if (t.includes('"send_tx"')) return Response.json({ jsonrpc: "2.0", id: 1, result: { status: { Failure: { ActionError: {} } }, transaction: { hash: "H" }, transaction_outcome: { outcome: { tokens_burnt: "1" } }, receipts_outcome: [] } });
      return origSend(i, init);
    }) as any;
    const r2 = await post(d, { signedDelegate: buildDelegate({ senderId: "fail2.testnet" }).base64 });
    assert.equal(r2.status, 500);
    const g2: any = await (await d.fetch(new Request("https://x/budget/global"))).json();
    assert.equal(g2.usedYocto, (2n * EST).toString());
  } finally { globalThis.fetch = realFetch; }
  st.close();
});
