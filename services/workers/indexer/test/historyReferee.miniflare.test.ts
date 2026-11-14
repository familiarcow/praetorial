// IDXREF1 RED: /history?referee= in the real bundle on workerd + real D1.
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
const ref = (a: string) => ({ referee: { account: a, mode: "Human" } });

test("workerd + real D1: /history?referee= filters on current referee; 400 on account+referee and on a malformed referee", async () => {
  const w = world({ "a.testnet": { 1: mkBet(), 2: mkBet({}, ref("x.testnet")), 3: mkBet({ status: "Settled", taker: "t.testnet", outcome: "YES" }, ref("y.testnet")) }, "b.testnet": {} }); w.second = JSON.parse(JSON.stringify(w.chain));
  const mf = new Miniflare({
    modules: true, script: await bundle(), compatibilityDate: "2026-01-01", d1Databases: { INDEXER_DB: "idx-test" }, d1Persist: fs.mkdtempSync(path.join(os.tmpdir(), "idxref1-d1-")),
    bindings: { NEAR_NETWORK_ID: "testnet", ESCROW_CONTRACTS: "a.testnet@v1,b.testnet@v2", INTENTS_CONTRACT_ID: INT, NEAR_RPC_URL: RPC_URL, NEAR_RPC_FALLBACKS: RPC2_URL, INDEXER_RPC_PER_SEC: "100000", INDEXER_MIN_TICK_INTERVAL_MS: "0" },
    outboundService: outboundFetch(w) as any,
  });
  try {
    const db = await mf.getD1Database("INDEXER_DB"); await db.exec(oneLine());
    assert.equal((await mf.dispatchFetch("https://indexer.test/tick", { method: "POST" })).status, 200);
    const ids = async (q: string) => ((await (await mf.dispatchFetch(`https://indexer.test/history${q}`)).json()) as any[]).map((e) => e.bet_id);
    assert.deepEqual(await ids("?referee=x.testnet"), [2]);
    assert.deepEqual(await ids("?referee=y.testnet"), [3]);
    assert.deepEqual(await ids("?referee=nobody.testnet"), []);
    assert.equal((await mf.dispatchFetch("https://indexer.test/history?account=m.testnet&referee=x.testnet")).status, 400);
    assert.equal((await mf.dispatchFetch("https://indexer.test/history?referee=BAD..id")).status, 400);
    assert.deepEqual(await ids("?account=m.testnet"), [1, 2, 3]);
  } finally { await mf.dispose(); }
});
