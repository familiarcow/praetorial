// IDX2 RED: POST /refresh {"bet_id": N} -- the web nudges the indexer after an Open/Take so the board updates in seconds
// instead of after the next minute sweep. The indexer reads get_bet(N) from the chain ITSELF (caller bet data is ignored) and
// merges it with the tick's own rules (terminal lock, D-DSY1 second-RPC confirmation, sameBet identity); it never takes the
// tick lease, and a running tick cannot overwrite a newer refresh (nor a refresh a terminal row).
import { MAINNET_WEB_ORIGINS } from "../../common/src/mainnetReady.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { REFRESH_IP_PER_MIN, REFRESH_GLOBAL_PER_MIN, REFRESH_ORIGINS, consumeRefresh } from "../src/refresh.js";
import { upsertStmts } from "../src/merge.js";
import { fakeD1, world, outboundFetch, baseEnv, mkBet, settled, type World } from "./helpers.js";

const clock = { ms: 1_700_000_040_000 };
async function withFetch<T>(w: World, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch; globalThis.fetch = outboundFetch(w) as any;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const WEB = "https://praetorial-web-testnet.familiarcow.workers.dev";
interface Opts { ip?: string | null; origin?: string; method?: string; raw?: string; xClientIp?: string }
async function refresh(env: any, w: World, payload: unknown, o: Opts = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (o.ip !== null) headers["cf-connecting-ip"] = o.ip ?? "203.0.113.7";
  if (o.xClientIp) headers["x-client-ip"] = o.xClientIp;
  if (o.origin) headers.origin = o.origin;
  const method = o.method ?? "POST";
  const req = new Request("https://indexer.test/refresh", { method, headers, ...(method === "POST" ? { body: o.raw ?? JSON.stringify(payload) } : {}) });
  const r = await withFetch(w, () => handle(req, env, () => clock.ms));
  const text = await r.text();
  return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : null };
}
const tick = async (env: any, w: World) => { const r = await withFetch(w, () => handle(new Request("https://indexer.test/tick", { method: "POST" }), env, () => clock.ms)); return r.json() as Promise<any>; };
const getJ = async (env: any, p: string) => (await handle(new Request(`https://indexer.test${p}`), env, () => clock.ms)).json() as Promise<any>;
const row = (d1: any, key: string) => d1.prepare("SELECT key, confirmed, bet, read_ms FROM indexer_bets WHERE key = ?").bind(key).first();
const rows = async (d1: any) => (await d1.prepare("SELECT key FROM indexer_bets ORDER BY key").all()).results.map((r: any) => r.key);
const putRow = (d1: any, key: string, bet: any, confirmed: number | null, readMs = 0) => {
  const [cid, id] = key.split(":");
  return d1.prepare("INSERT INTO indexer_bets (key, contract_id, bet_id, ord, version, confirmed, bet, read_ms) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET confirmed = excluded.confirmed, bet = excluded.bet, read_ms = excluded.read_ms").bind(key, cid, Number(id), 0, "v1", confirmed, JSON.stringify(bet), readMs).run();
};
const setup = (chain: World["chain"], extra: Record<string, string> = {}) => {
  const { d1 } = fakeD1();
  const w = world(chain); w.second = JSON.parse(JSON.stringify(chain));
  return { d1, w, env: baseEnv(d1, extra) };
};
const nextMinute = () => { clock.ms = (Math.floor(clock.ms / 60_000) + 1) * 60_000 + 1_000; };

test("refresh reads get_bet from the chain, never the caller's bet data; the board serves the chain's bet at once", async () => {
  nextMinute();
  const { d1, w, env } = setup({ "a.testnet": { 1: mkBet(), 2: mkBet({ created_at: 7 }) }, "b.testnet": {} });
  const fake = { ...settled({ created_at: 7 }), envelope: { ...mkBet().envelope, maker: "evil.testnet" } };
  const r = await refresh(env, w, { bet_id: 2, bet: fake, status: "Settled", maker: "evil.testnet", outcome: "YES", confirmed: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.ok, true); assert.equal(r.json.bet_id, 2); assert.equal(r.json.contract_id, "a.testnet"); assert.equal(r.json.written, true);
  const got = await row(d1, "a.testnet:2");
  assert.deepEqual(JSON.parse(got.bet), mkBet({ created_at: 7 }), "the stored bet is the chain's, byte for byte");
  assert.equal(got.confirmed, null);
  assert.equal(got.read_ms, clock.ms);
  assert.deepEqual(await rows(d1), ["a.testnet:2"], "only the requested bet is read and written");
  const offers = await getJ(env, "/offers");
  assert.deepEqual(offers.map((o: any) => [o.contract_id, o.bet_id, o.maker]), [["a.testnet", 2, "m.testnet"]]);
  assert.equal(JSON.stringify(r.json).includes("evil"), false);
  // the response carries no bet data either (no winner of an unconfirmed bet can leak through it)
  assert.deepEqual(Object.keys(r.json).sort(), ["bet_id", "contract_id", "ok", "written"]);
});

test("absent id (bet_count+1 not opened yet / no such bet) -> 404 and no write; out of bounds -> 400 with no get_bet read", async () => {
  nextMinute();
  const { d1, w, env } = setup({ "a.testnet": { 1: mkBet(), 2: mkBet({ created_at: 6 }) }, "b.testnet": {} });
  w.betCount = { "a.testnet": 2 };
  const a = await refresh(env, w, { bet_id: 3, bet: mkBet() });
  assert.equal(a.status, 404); assert.equal(a.json.ok, false);
  assert.deepEqual(await rows(d1), []);
  const before = w.views;
  const b = await refresh(env, w, { bet_id: 4 });
  assert.equal(b.status, 400); assert.match(b.json.error, /out of range/);
  assert.equal(w.views - before, 1, "only bet_count was read");
  for (const bad of [0, -1, 1.5, "2", null, 2 ** 53]) {
    const r = await refresh(env, w, { bet_id: bad });
    assert.equal(r.status, 400, `bet_id ${JSON.stringify(bad)}`);
  }
  for (const raw of ["", "not json", "[]", "{}", "x".repeat(5000)]) assert.equal((await refresh(env, w, null, { raw })).status, raw.length > 1024 ? 413 : 400, `raw ${raw.slice(0, 10)}`);
  assert.deepEqual(await rows(d1), [], "nothing written by any refusal");
});

test("configured escrow only: an unserved contract_id is refused; a served one is honoured", async () => {
  nextMinute();
  const { d1, w, env } = setup({ "a.testnet": {}, "b.testnet": { 1: mkBet() }, "evil.testnet": { 1: mkBet() } });
  assert.equal((await refresh(env, w, { bet_id: 1, contract_id: "evil.testnet" })).status, 400);
  assert.deepEqual(await rows(d1), []);
  const ok = await refresh(env, w, { bet_id: 1, contract_id: "b.testnet" });
  assert.equal(ok.status, 200); assert.deepEqual(await rows(d1), ["b.testnet:1"]);
  // ESCROW_CONTRACT_ID set (the deployed shape): ONLY that escrow, the rest of ESCROW_CONTRACTS is not served
  const one = setup({ "a.testnet": { 1: mkBet() }, "b.testnet": { 1: mkBet() } }, { ESCROW_CONTRACT_ID: "a.testnet" });
  assert.equal((await refresh(one.env, one.w, { bet_id: 1, contract_id: "b.testnet" })).status, 400);
  assert.equal((await refresh(one.env, one.w, { bet_id: 1 })).status, 200);
  assert.deepEqual(await rows(one.d1), ["a.testnet:1"]);
});

test("terminal lock holds: a confirmed Settled row is never rewritten by a lagging read of the same bet", async () => {
  nextMinute();
  const { d1, w, env } = setup({ "a.testnet": { 1: mkBet({ status: "Taken", taker: "t.testnet" }) }, "b.testnet": {} });
  await putRow(d1, "a.testnet:1", settled(), 1);
  const r = await refresh(env, w, { bet_id: 1 });
  assert.equal(r.status, 200); assert.equal(r.json.written, false);
  const got = await row(d1, "a.testnet:1");
  assert.equal(JSON.parse(got.bet).status, "Settled"); assert.equal(got.confirmed, 1);
  // a different bet under the same id (redeploy identity) is NOT locked
  w.chain["a.testnet"] = { 1: mkBet({ created_at: 99 }) };
  assert.equal((await refresh(env, w, { bet_id: 1 })).json.written, true);
  assert.equal(JSON.parse((await row(d1, "a.testnet:1")).bet).created_at, 99);
});

test("terminal states need the second RPC (D-DSY1): agrees -> confirmed; down -> 'settling, confirming', no winner leaked", async () => {
  nextMinute();
  const { d1, w, env } = setup({ "a.testnet": { 1: settled(), 2: settled({ created_at: 8 }) }, "b.testnet": {} });
  w.second = { "a.testnet": { 1: settled() }, "b.testnet": {} };
  await refresh(env, w, { bet_id: 1 });
  assert.equal((await row(d1, "a.testnet:1")).confirmed, 1);
  w.second = "down";
  await refresh(env, w, { bet_id: 2 });
  assert.equal((await row(d1, "a.testnet:2")).confirmed, 0);
  const h = (await getJ(env, "/history")).find((e: any) => e.bet_id === 2);
  assert.equal(h.display_status, "settling, confirming"); assert.equal(h.outcome, null);
  // the next tick's backlog confirms it once the second RPC answers (the tick merge is shared)
  w.second = JSON.parse(JSON.stringify(w.chain));
  await tick(env, w);
  assert.equal((await row(d1, "a.testnet:2")).confirmed, 1);
});

test("an unchanged re-read writes nothing (same rule as the tick)", async () => {
  nextMinute();
  const { d1, w, env } = setup({ "a.testnet": { 1: mkBet() }, "b.testnet": {} });
  await refresh(env, w, { bet_id: 1 });
  const first = (await row(d1, "a.testnet:1")).read_ms;
  clock.ms += 1_000;
  const r = await refresh(env, w, { bet_id: 1 });
  assert.equal(r.status, 200); assert.equal(r.json.written, false);
  assert.equal((await row(d1, "a.testnet:1")).read_ms, first);
});

test("never takes the tick lease: lock row untouched; works while a tick holds the lease; tick still runs after", async () => {
  nextMinute();
  const { d1, w, env } = setup({ "a.testnet": { 1: mkBet() }, "b.testnet": {} });
  const lock = () => d1.prepare("SELECT until_ms, last_ms FROM indexer_lock WHERE name = 'tick'").first();
  await d1.prepare("UPDATE indexer_lock SET until_ms = ?, last_ms = ? WHERE name = 'tick'").bind(clock.ms + 30_000, clock.ms - 5).run();
  const held = await lock();
  assert.equal((await refresh(env, w, { bet_id: 1 })).status, 200);
  assert.deepEqual(await lock(), held, "refresh never touches indexer_lock");
  assert.deepEqual(await rows(d1), ["a.testnet:1"]);
  await d1.prepare("UPDATE indexer_lock SET until_ms = 0 WHERE name = 'tick'").run();
  clock.ms += 60_000;
  const t = await tick(env, w);
  assert.equal(t.ok, true); assert.notEqual(t.skipped, true);
});

test("safe concurrent write: a tick that read the chain BEFORE a refresh cannot overwrite the refresh's newer row", async () => {
  nextMinute();
  const { d1, w, env } = setup({ "a.testnet": { 1: mkBet() }, "b.testnet": {} });
  let release!: () => void; const paused = new Promise<void>((r) => { release = r; });
  let reached!: () => void; const atRead = new Promise<void>((r) => { reached = r; });
  let gate = true;
  w.onView = async (_c, m, a) => { if (gate && m === "get_bet" && a.bet_id === 1) { gate = false; reached(); await paused; } };
  // the tick reads bet 1 (Open) then stalls before its write; meanwhile the bet is taken and a refresh lands
  const real = globalThis.fetch; globalThis.fetch = outboundFetch(w) as any;
  try {
    const tickP = handle(new Request("https://indexer.test/tick", { method: "POST" }), env, () => clock.ms).then((r) => r.json());
    await atRead;
    (w.chain["a.testnet"] as any)[1] = mkBet({ status: "Taken", taker: "t.testnet" });
    clock.ms += 2_000;
    const r = await handle(new Request("https://indexer.test/refresh", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify({ bet_id: 1 }) }), env, () => clock.ms);
    assert.equal(r.status, 200);
    assert.equal(JSON.parse((await row(d1, "a.testnet:1")).bet).status, "Taken");
    release();
    // the stalled read answers with the bet as it was when the tick asked (Open)
    (w.chain["a.testnet"] as any)[1] = mkBet();
    const t: any = await tickP;
    assert.equal(t.ok, true);
  } finally { globalThis.fetch = real; }
  assert.equal(JSON.parse((await row(d1, "a.testnet:1")).bet).status, "Taken", "the older tick read did not overwrite the newer refresh");
});

test("safe concurrent write: a refresh whose read lags never replaces a terminal row that landed meanwhile", async () => {
  nextMinute();
  const { d1, w, env } = setup({ "a.testnet": { 1: mkBet({ status: "Taken", taker: "t.testnet" }) }, "b.testnet": {} });
  w.onView = async (_c, m) => { if (m === "get_bet") await putRow(d1, "a.testnet:1", settled({ taker: "t.testnet" }), 1, clock.ms - 1); }; // a tick commits Settled during the read
  const r = await refresh(env, w, { bet_id: 1 });
  assert.equal(r.status, 200);
  const got = await row(d1, "a.testnet:1");
  assert.equal(JSON.parse(got.bet).status, "Settled"); assert.equal(got.confirmed, 1);
});

test("the shared upsert guard (tick + refresh) in SQL: newer read wins; a terminal row is never replaced by a non-terminal read of the same bet", async () => {
  const { d1 } = fakeD1();
  const tb = (bet: any) => ({ betId: 1, bet, contractId: "a.testnet", version: "v1" });
  const write = (bet: any, readMs: number) => d1.batch(upsertStmts(d1, ["a.testnet:1"], new Map([["a.testnet:1", tb(bet)]]), new Map([["a.testnet", 0]]), readMs));
  const status = async () => JSON.parse((await row(d1, "a.testnet:1")).bet).status;
  await write(mkBet(), 100);
  await write(mkBet({ status: "Taken", taker: "t.testnet" }), 200);
  assert.equal(await status(), "Taken");
  await write(mkBet(), 150); // an older read committing late
  assert.equal(await status(), "Taken");
  await write(settled({ taker: "t.testnet" }), 300);
  await write(mkBet({ status: "Taken", taker: "t.testnet" }), 400); // newer, but a lagging non-terminal read of the same bet
  assert.equal(await status(), "Settled");
  await write(mkBet({ created_at: 77 }), 500); // a different bet under the id (redeploy identity): replaces
  assert.equal(await status(), "Open");
  assert.equal((await row(d1, "a.testnet:1")).read_ms, 500);
});

test(`rate limit: ${REFRESH_IP_PER_MIN}/min per IP (429 + retry-after, no chain read), other IPs unaffected, next minute ok`, async () => {
  nextMinute();
  const { w, env } = setup({ "a.testnet": { 1: mkBet() }, "b.testnet": {} });
  assert.equal(REFRESH_IP_PER_MIN, 30);
  for (let i = 0; i < REFRESH_IP_PER_MIN; i++) assert.equal((await refresh(env, w, { bet_id: 1 }, { ip: "198.51.100.1" })).status, 200, `call ${i + 1}`);
  const views = w.views;
  const no = await refresh(env, w, { bet_id: 1 }, { ip: "198.51.100.1" });
  assert.equal(no.status, 429); assert.equal(no.json.scope, "ip");
  assert.ok(Number(no.headers.get("retry-after")) >= 1 && Number(no.headers.get("retry-after")) <= 60);
  assert.equal(w.views, views, "a refused refresh reads nothing");
  assert.equal((await refresh(env, w, { bet_id: 1 }, { ip: "198.51.100.2" })).status, 200);
  nextMinute();
  assert.equal((await refresh(env, w, { bet_id: 1 }, { ip: "198.51.100.1" })).status, 200);
});

test("rate limit: the client address is the edge's cf-connecting-ip (an x-client-ip cannot dodge it); x-client-ip only via the web proxy; none -> 400", async () => {
  nextMinute();
  const { w, env } = setup({ "a.testnet": { 1: mkBet() }, "b.testnet": {} });
  for (let i = 0; i < REFRESH_IP_PER_MIN; i++) await refresh(env, w, { bet_id: 1 }, { ip: "198.51.100.3", xClientIp: `10.0.0.${i}` });
  assert.equal((await refresh(env, w, { bet_id: 1 }, { ip: "198.51.100.3", xClientIp: "10.9.9.9" })).status, 429);
  // service-binding call from the web proxy: no cf-connecting-ip, the proxy's x-client-ip names the user
  assert.equal((await refresh(env, w, { bet_id: 1 }, { ip: null, xClientIp: "198.51.100.4" })).status, 200);
  assert.equal((await refresh(env, w, { bet_id: 1 }, { ip: null })).status, 400);
});

test(`rate limit: global cap ${REFRESH_GLOBAL_PER_MIN}/min across all addresses; a per-IP refusal does not eat the global budget`, async () => {
  nextMinute();
  const { d1 } = fakeD1();
  const now = clock.ms;
  for (let i = 0; i < 40; i++) await consumeRefresh(d1, "198.51.100.200", now); // 30 ok + 10 refused per-IP
  let ok = REFRESH_IP_PER_MIN;
  for (let i = 0; ok < REFRESH_GLOBAL_PER_MIN; i++) { const r = await consumeRefresh(d1, `192.0.2.${i}`, now); assert.equal(r.ok, true, `ip ${i}`); ok++; }
  const g = await consumeRefresh(d1, "192.0.2.250", now);
  assert.deepEqual([g.ok, (g as any).scope], [false, "global"]);
  assert.equal((await consumeRefresh(d1, "192.0.2.250", now + 60_000)).ok, true, "next minute");
  // stale buckets are swept, so the table does not grow with every address ever seen
  const n = (await d1.prepare("SELECT COUNT(*) AS n FROM indexer_refresh_limit").first()).n;
  assert.ok(n <= 3, `rows left ${n}`);
});

test("CORS: the web origin(s) only; a foreign Origin is 403 with no write; preflight; GET routes still send no CORS", async () => {
  nextMinute();
  const { d1, w, env } = setup({ "a.testnet": { 1: mkBet() }, "b.testnet": {} });
  // DOM1: mainnet = apex + www + the legacy workers.dev origin (same list as the other Workers' CORS, mainnetReady MAINNET_WEB_ORIGINS).
  assert.ok(REFRESH_ORIGINS.testnet.includes(WEB));
  assert.deepEqual([...REFRESH_ORIGINS.mainnet], [...MAINNET_WEB_ORIGINS]);
  assert.ok(!REFRESH_ORIGINS.mainnet.some((o) => o.includes("localhost")), "no localhost origin on mainnet");
  const ok = await refresh(env, w, { bet_id: 1 }, { origin: WEB });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get("access-control-allow-origin"), WEB);
  const bad = await refresh(env, w, { bet_id: 1 }, { origin: "https://evil.example" });
  assert.equal(bad.status, 403); assert.equal(bad.headers.get("access-control-allow-origin"), null);
  // mainnet build: the testnet web origin is foreign
  const main = setup({ "a.testnet": { 1: mkBet() }, "b.testnet": {} }, { NEAR_NETWORK_ID: "mainnet" });
  assert.equal((await refresh(main.env, main.w, { bet_id: 1 }, { origin: WEB })).status, 403);
  assert.deepEqual(await rows(main.d1), []);
  const pre = await refresh(env, w, null, { method: "OPTIONS", origin: WEB });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), WEB);
  assert.match(pre.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /content-type/);
  assert.equal((await refresh(env, w, null, { method: "GET" })).status, 405);
  const g = await handle(new Request("https://indexer.test/offers", { headers: { origin: WEB } }), env, () => clock.ms);
  assert.equal(g.headers.get("access-control-allow-origin"), null, "read API unchanged (node parity)");
  assert.deepEqual(await rows(d1), ["a.testnet:1"]);
});

test("refresh does not touch the tick's sweep state (cursors/frontier/alert cooldowns stay the tick's)", async () => {
  nextMinute();
  const { d1, w, env } = setup({ "a.testnet": { 1: mkBet(), 2: mkBet({ created_at: 9 }) }, "b.testnet": {} });
  await tick(env, w);
  const st = await d1.prepare("SELECT v FROM indexer_state WHERE k = 'state'").first();
  (w.chain["a.testnet"] as any)[3] = mkBet({ created_at: 10 });
  assert.equal((await refresh(env, w, { bet_id: 3 })).status, 200);
  assert.deepEqual(await d1.prepare("SELECT v FROM indexer_state WHERE k = 'state'").first(), st);
});
