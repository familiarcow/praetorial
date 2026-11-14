// IDX2 RED: after a successful Open / Take the web nudges the indexer (POST /refresh {"bet_id": N}, fire-and-forget) and re-reads
// Explore; the maker's own just-opened bet shows on Explore at once (optimistic row from the open result), replaced by the indexed
// row once the indexer has it. A failing nudge never blocks or fails the user's flow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, UPSTREAMS, MAINNET_UPSTREAMS } from "../worker/index";
import { nudgeIndexer, afterBetChange, afterOpened, BETS_CHANGED, NUDGE_RETRY_MS } from "../lib/indexerRefresh";
import { rememberOpened, justOpened, forgetOpened, JUST_OPENED_TTL_MS, memoryStore } from "../lib/justOpened";
import { myNewOffers, myNewCards } from "../lib/homeSections";
import { fixtureByKey, ME, DAY, FIXTURE_CONTRACT } from "./fixtures/bets";
import { createChainClock } from "../lib/chainClock";

const NOW = Date.UTC(2026, 10, 13, 23);
const CTX = { contractId: FIXTURE_CONTRACT };
const myBet = (id: number, o: { status?: string; taker?: string | null } = {}) => {
  const b = structuredClone(fixtureByKey(NOW, "open-theirs").bet) as any;
  b.envelope.bet_id = id; b.envelope.maker = ME; b.envelope.funding_deadline = (NOW + 2 * DAY) * 1e6;
  b.status = o.status ?? "Open"; b.taker = o.taker ?? null;
  return b;
};

// ------------------------------------------------------------------ nudge
type Call = { url: string; init: any };
const fakeFetch = (answers: Array<number | "throw" | "hang">, calls: Call[]) => (async (url: any, init?: any) => {
  calls.push({ url: String(url), init });
  const a = answers[Math.min(calls.length - 1, answers.length - 1)];
  if (a === "throw") throw new TypeError("Failed to fetch");
  if (a === "hang") return new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
  return new Response(JSON.stringify({ ok: a === 200 }), { status: a, headers: { "content-type": "application/json" } });
}) as typeof fetch;
const noSleep = async () => {};

test("nudge: POST <indexer>/refresh with ONLY {bet_id} (no bet data, no account), json; 'ok' on 200", async () => {
  const calls: Call[] = [];
  const r = await nudgeIndexer(7, { fetch: fakeFetch([200], calls), base: "/_proxy/indexer", sleep: noSleep });
  assert.equal(r, "ok");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "/_proxy/indexer/refresh");
  assert.equal(calls[0]!.init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0]!.init.body), { bet_id: 7 });
  assert.equal(new Headers(calls[0]!.init.headers).get("content-type"), "application/json");
});

test("nudge: a 404 (the indexer's RPC has not seen the new bet yet) is retried once after a short wait; other refusals are not", async () => {
  const calls: Call[] = []; const waits: number[] = [];
  assert.equal(await nudgeIndexer(8, { fetch: fakeFetch([404, 200], calls), base: "x", sleep: async (ms) => { waits.push(ms); } }), "ok");
  assert.equal(calls.length, 2); assert.deepEqual(waits, [NUDGE_RETRY_MS]);
  assert.ok(NUDGE_RETRY_MS >= 500 && NUDGE_RETRY_MS <= 2000);
  for (const s of [429, 400, 403, 500, 502]) {
    const c: Call[] = [];
    assert.equal(await nudgeIndexer(8, { fetch: fakeFetch([s, 200], c), base: "x", sleep: noSleep }), "failed", `status ${s}`);
    assert.equal(c.length, 1, `no retry on ${s}`);
  }
  const c2: Call[] = [];
  assert.equal(await nudgeIndexer(8, { fetch: fakeFetch([404, 404, 200], c2), base: "x", sleep: noSleep }), "failed");
  assert.equal(c2.length, 2, "one retry only");
});

test("nudge never throws: network error, hung request (timeout), indexer not configured, bad id", async () => {
  assert.equal(await nudgeIndexer(9, { fetch: fakeFetch(["throw"], []), base: "x", sleep: noSleep }), "failed");
  const t0 = Date.now();
  assert.equal(await nudgeIndexer(9, { fetch: fakeFetch(["hang"], []), base: "x", sleep: noSleep, timeoutMs: 50 }), "failed");
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(await nudgeIndexer(9, { fetch: fakeFetch([200], []), base: () => { throw new Error("indexer is not configured"); }, sleep: noSleep }), "failed");
  const calls: Call[] = [];
  for (const bad of [0, -1, 1.5, NaN]) assert.equal(await nudgeIndexer(bad, { fetch: fakeFetch([200], calls), base: "x", sleep: noSleep }), "failed");
  assert.equal(calls.length, 0);
});

test("afterBetChange: fire-and-forget -- returns at once (void), then emits BETS_CHANGED after the nudge settles, ok or failed", async () => {
  for (const answer of [200, 500, "throw"] as const) {
    const events: number[] = [];
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const f = (async (...a: any[]) => { await gate; return fakeFetch([answer], [])(a[0], a[1]); }) as typeof fetch;
    const ret = afterBetChange(11, { fetch: f, base: "x", sleep: noSleep, emit: (id) => events.push(id) });
    assert.equal(ret, undefined, "nothing to await: the user flow never waits on it");
    assert.deepEqual(events, []);
    release();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(events, [11], `emitted after a ${answer} nudge`);
  }
  // a throwing emit (a listener blew up) is swallowed too: no unhandled rejection
  afterBetChange(12, { fetch: fakeFetch([200], []), base: "x", sleep: noSleep, emit: () => { throw new Error("listener"); } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(typeof BETS_CHANGED, "string");
});

test("afterOpened: remembers the bet under its chain maker for Explore, nudges its id; void, never throws (bad bet, blocked storage)", async () => {
  const s = memoryStore(); const calls: Call[] = []; const events: number[] = [];
  const ret = afterOpened({ betId: 6, bet: myBet(6) }, { store: s, nowMs: NOW, fetch: fakeFetch([200], calls), base: "/_proxy/indexer", sleep: noSleep, emit: (id) => events.push(id) });
  assert.equal(ret, undefined);
  assert.deepEqual(justOpened(s, ME, NOW).map((e) => e.id), [6]);
  assert.deepEqual(events, [6], "Explore re-reads at once (optimistic row), before the nudge answers");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls.map((c) => JSON.parse(c.init.body)), [{ bet_id: 6 }]); assert.deepEqual(events, [6, 6], "and again once it settled");
  const blocked = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => {} };
  assert.doesNotThrow(() => afterOpened({ betId: 7, bet: {} as any }, { store: blocked, fetch: fakeFetch(["throw"], []), base: "x", sleep: noSleep, emit: () => {} }));
  await new Promise((r) => setTimeout(r, 10));
});

// ------------------------------------------------------------------ just-opened store
test("justOpened: remembered per maker for the session, newest first, expires after the TTL, survives a blocked storage", () => {
  const s = memoryStore();
  rememberOpened(s, { id: 5, bet: myBet(5), maker: ME, atMs: NOW });
  rememberOpened(s, { id: 6, bet: myBet(6), maker: ME, atMs: NOW + 1 });
  rememberOpened(s, { id: 7, bet: myBet(7), maker: "bob.near", atMs: NOW });
  assert.deepEqual(justOpened(s, ME, NOW + 2).map((e) => e.id), [6, 5]);
  assert.deepEqual(justOpened(s, null, NOW).map((e) => e.id), [], "logged out: nothing");
  assert.deepEqual(justOpened(s, ME, NOW + JUST_OPENED_TTL_MS + 2).map((e) => e.id), []);
  rememberOpened(s, { id: 6, bet: myBet(6), maker: ME, atMs: NOW + 5 }); // same id again: one entry
  assert.equal(justOpened(s, ME, NOW + 6).filter((e) => e.id === 6).length, 1);
  forgetOpened(s, 6);
  assert.deepEqual(justOpened(s, ME, NOW + 6).map((e) => e.id), [5]);
  assert.ok(JUST_OPENED_TTL_MS >= 5 * 60_000);
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} };
  rememberOpened(blocked, { id: 1, bet: myBet(1), maker: ME, atMs: NOW });
  assert.deepEqual(justOpened(blocked, ME, NOW).map((e) => e.id), [], "blocked storage never throws");
  const junk = memoryStore(); junk.setItem("praetorial:just-opened", "{not json");
  assert.deepEqual(justOpened(junk, ME, NOW), []);
});

// ------------------------------------------------------------------ Explore rows
test("Explore: my just-opened bet is an optimistic row until the index lists it, then the indexed (freshly read) one", () => {
  const entries = [{ id: 6, bet: myBet(6), maker: ME, atMs: NOW }];
  const before = myNewOffers(entries, [], new Map());
  assert.deepEqual(before.map((x) => [x.id, x.source]), [[6, "optimistic"]]);
  assert.equal(before[0]!.bet, entries[0]!.bet);
  const fresh = myBet(6);
  const after = myNewOffers(entries, [{ bet_id: 6 }], new Map([[6, fresh]]));
  assert.deepEqual(after.map((x) => [x.id, x.source]), [[6, "indexed"]]);
  assert.equal(after[0]!.bet, fresh);
  // indexer down (no list): still the optimistic row
  assert.deepEqual(myNewOffers(entries, null, new Map()).map((x) => x.source), ["optimistic"]);
  // listed but the fresh read failed: keep the row from the open result rather than dropping it
  assert.deepEqual(myNewOffers(entries, [{ bet_id: 6 }], new Map([[6, null]])).map((x) => x.source), ["optimistic"]);
});

test("Explore: my new-offer cards are 'mine' cards of OPEN bets only (taken / cancelled ones drop off), newest first", () => {
  const items = [
    { id: 6, bet: myBet(6), source: "optimistic" as const },
    { id: 9, bet: myBet(9), source: "indexed" as const },
    { id: 4, bet: myBet(4, { status: "Taken", taker: "bob.near" }), source: "indexed" as const },
    { id: 3, bet: myBet(3, { status: "Cancelled" }), source: "indexed" as const },
  ];
  const cards = myNewCards(items, ME, NOW, CTX);
  assert.deepEqual(cards.map((c) => [c.view.id, c.variant, c.source]), [[9, "mine", "indexed"], [6, "mine", "optimistic"]]);
  assert.deepEqual(myNewCards(items, "someone.near", NOW, CTX), [], "only the maker's own");
  assert.deepEqual(myNewCards(items, null, NOW, CTX), []);
  // a malformed stored bet (old format, junk) is dropped, not thrown: Explore sits on the Home page
  const junk = myBet(10) as any; delete junk.envelope.resolve_deadline; junk.envelope.funding_deadline = "x";
  assert.deepEqual(myNewCards([...items, { id: 10, bet: junk, source: "optimistic" as const }, { id: 11, bet: {} as any, source: "optimistic" as const }], ME, NOW, CTX).map((c) => c.view.id), [9, 6]);
});

// ------------------------------------------------------------------ web proxy
const env = () => ({ ASSETS: { fetch: async () => new Response("asset") } });
type PCall = { url: string; method: string; body: string; ip: string | null; ct: string | null; origin: string | null };
const stub = (calls: PCall[]) => (async (u: any, init?: any) => {
  const h = new Headers(init?.headers);
  calls.push({ url: String(u), method: init?.method ?? "GET", body: init?.body ? new TextDecoder().decode(init.body) : "", ip: h.get("x-client-ip"), ct: h.get("content-type"), origin: h.get("origin") });
  return new Response("{\"ok\":true}", { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

test("proxy: POST /_proxy/indexer/refresh reaches the indexer with the body and the edge's client address (a sent x-client-ip is replaced)", async () => {
  const calls: PCall[] = [];
  const r = await handle(new Request("https://w.example/_proxy/indexer/refresh", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.5", "x-client-ip": "1.2.3.4" }, body: "{\"bet_id\":6}" }), env() as any, stub(calls));
  assert.equal(r.status, 200);
  assert.deepEqual(calls, [{ url: `${UPSTREAMS.indexer}/refresh`, method: "POST", body: "{\"bet_id\":6}", ip: "198.51.100.5", ct: "application/json", origin: null }]);
  // mainnet: through the INDEXER binding only
  const via: PCall[] = [];
  const bound = { fetch: stub(via) };
  const m = await handle(new Request("https://w.example/_proxy/indexer/refresh", { method: "POST", headers: { "cf-connecting-ip": "198.51.100.6" }, body: "{\"bet_id\":1}" }), { ...env(), NETWORK_ID: "mainnet", INDEXER: bound } as any, stub([]));
  assert.equal(m.status, 200);
  assert.equal(via[0]!.url, `${MAINNET_UPSTREAMS.indexer}/refresh`); assert.equal(via[0]!.ip, "198.51.100.6");
});

test("proxy: every other indexer POST stays 405 (SR-12): /tick, /tick/governance, /refresh/x, /refresh?x=1; GET /refresh is not a nudge", async () => {
  const calls: PCall[] = [];
  for (const p of ["/tick", "/tick/governance", "/refresh/x", "/refresh?x=1", "/refresh/", "/offers"]) {
    const r = await handle(new Request(`https://w.example/_proxy/indexer${p}`, { method: "POST", body: "{}" }), env() as any, stub(calls));
    assert.equal(r.status, 405, p);
  }
  assert.equal(calls.length, 0);
  const big = await handle(new Request("https://w.example/_proxy/indexer/refresh", { method: "POST", body: "x".repeat(65 * 1024) }), env() as any, stub(calls));
  assert.equal(big.status, 413); assert.equal(calls.length, 0);
});

// ------------------------------------------------------------------ chain clock (found by the IDX2 take e2e)
test("chainClock.nowMs() is whole milliseconds (BetPage does BigInt(nowMs): a fractional performance.now() delta blanked the page)", async () => {
  let perf = 1000.123;
  const c = createChainClock({ readBlockMs: async () => 1_794_614_800_000, perfNow: () => perf } as any);
  await c.sync();
  perf += 1234.567;
  const n = c.nowMs()!;
  assert.ok(Number.isInteger(n), String(n));
  assert.equal(n, 1_794_614_800_000 + 1234, "floored: chain time is never over-estimated");
  assert.doesNotThrow(() => BigInt(n) * 1_000_000n);
});
