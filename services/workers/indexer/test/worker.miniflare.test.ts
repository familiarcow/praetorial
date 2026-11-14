// CF1d RED: the real bundle in workerd (miniflare) with a real D1 database persisted on disk across a full runtime restart,
// every outbound fetch mocked: GET API parity, POST /tick, board survives restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { world, outboundFetch, mkBet, settled, INT, RPC_URL, RPC2_URL, migrationSql } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const oneLine = () => migrationSql().split("\n").filter((l) => l.trim() && !l.trim().startsWith("--")).join("\n");
const bundle = async () => (await build({ entryPoints: [path.join(HERE, "../src/index.ts")], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, logLevel: "silent" })).outputFiles[0].text;
const start = (script: string, w: ReturnType<typeof world>, persist: string) => new Miniflare({
  modules: true, script, compatibilityDate: "2026-01-01", d1Databases: { INDEXER_DB: "idx-test" }, d1Persist: persist,
  bindings: { NEAR_NETWORK_ID: "testnet", ESCROW_CONTRACTS: "a.testnet@v1,b.testnet@v2", INTENTS_CONTRACT_ID: INT, NEAR_RPC_URL: RPC_URL, NEAR_RPC_FALLBACKS: RPC2_URL, INDEXER_RPC_PER_SEC: "100000", INDEXER_MIN_TICK_INTERVAL_MS: "0" },
  outboundService: outboundFetch(w) as any,
});

test("workerd + real D1: migration applies, POST /tick indexes, API serves, board survives a full runtime restart (fresh persist = empty control)", async () => {
  const script = await bundle(); const persist = fs.mkdtempSync(path.join(os.tmpdir(), "cf1d-d1-"));
  const w = world({ "a.testnet": { 1: mkBet(), 2: settled() }, "b.testnet": { 1: mkBet({ created_at: 3 }) } }); w.second = JSON.parse(JSON.stringify(w.chain));
  let mf = start(script, w, persist);
  try {
    const db = await mf.getD1Database("INDEXER_DB"); await db.exec(oneLine());
    const t = await mf.dispatchFetch("https://indexer.test/tick", { method: "POST" });
    assert.equal(t.status, 200, await t.text());
    const offers: any[] = (await (await mf.dispatchFetch("https://indexer.test/offers")).json()) as any;
    assert.deepEqual(offers.map((o) => `${o.contract_id}:${o.bet_id}`), ["a.testnet:1", "b.testnet:1"]);
    assert.equal((await mf.dispatchFetch("https://indexer.test/nope")).status, 404);
    const h: any = await (await mf.dispatchFetch("https://indexer.test/history")).json();
    assert.equal(h.find((e: any) => e.bet_id === 2).display_status, "Settled");
  } finally { await mf.dispose(); }
  mf = start(script, w, persist);
  try {
    const h: any = await (await mf.dispatchFetch("https://indexer.test/health")).json();
    assert.equal(h.bets_cached, 3, "D1 persisted across restart");
  } finally { await mf.dispose(); }
  const fresh = start(script, w, fs.mkdtempSync(path.join(os.tmpdir(), "cf1d-d1-")));
  try {
    const db = await fresh.getD1Database("INDEXER_DB"); await db.exec(oneLine());
    assert.equal(((await (await fresh.dispatchFetch("https://indexer.test/health")).json()) as any).bets_cached, 0);
  } finally { await fresh.dispose(); }
});

test("IDX2 workerd + real D1: POST /refresh writes the chain's bet (body ignored), 404 absent, the D1 limiter refuses the 31st call, tick still runs", async () => {
  const script = await bundle(); const persist = fs.mkdtempSync(path.join(os.tmpdir(), "idx2-d1-"));
  const w = world({ "a.testnet": { 1: mkBet() }, "b.testnet": {} }); w.second = JSON.parse(JSON.stringify(w.chain));
  const mf = start(script, w, persist);
  try {
    const db = await mf.getD1Database("INDEXER_DB"); await db.exec(oneLine());
    const post = (b: unknown, ip = "198.51.100.1") => mf.dispatchFetch("https://indexer.test/refresh", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(b) });
    const r = await post({ bet_id: 1, bet: settled(), status: "Settled" });
    assert.equal(r.status, 200, await r.clone().text());
    const offers: any[] = (await (await mf.dispatchFetch("https://indexer.test/offers")).json()) as any;
    assert.deepEqual(offers.map((o) => `${o.contract_id}:${o.bet_id}`), ["a.testnet:1"]);
    assert.equal((await post({ bet_id: 2 })).status, 404);
    const seen: number[] = []; for (let i = 0; i < 28; i++) seen.push((await post({ bet_id: 1 })).status); // + the 2 above = 30 (the cap)
    assert.deepEqual([...new Set(seen)], [200]);
    const no = await post({ bet_id: 1 });
    assert.equal(no.status, 429); assert.ok(Number(no.headers.get("retry-after")) >= 1);
    assert.equal((await post({ bet_id: 1 }, "198.51.100.2")).status, 200);
    assert.equal((await mf.dispatchFetch("https://indexer.test/tick", { method: "POST" })).status, 200);
  } finally { await mf.dispose(); }
});
