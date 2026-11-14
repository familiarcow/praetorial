// CF1f RED: the real bundle in workerd (miniflare) with a real D1 persisted across a full runtime restart; RPC is the only outbound call (mocked).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { actor, claimBody, fullKey, REGISTRY_ID } from "../../../registry/test/helpers.js";
import { registryMigrationSql } from "./workerBackend.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bundle = async () => (await build({ entryPoints: [path.join(HERE, "../src/index.ts")], bundle: true, format: "esm", platform: "browser", target: "es2022", write: false, logLevel: "silent" })).outputFiles[0].text;
const alice = actor("alice.testnet");
const oneLine = () => registryMigrationSql().split("\n").filter((l) => l.trim() && !l.trim().startsWith("--")).join("\n");
const start = (script: string, persist: string) => new Miniflare({
  modules: true, script, compatibilityDate: "2026-01-01", d1Databases: { REGISTRY_DB: "reg-test" }, d1Persist: persist,
  bindings: { REGISTRY_ID, NEAR_RPC_URL: "https://rpc.test", REGISTRY_CORS_ORIGINS: "https://app.example", REGISTRY_RATE_CAPACITY: "1000", REGISTRY_RATE_REFILL_PER_SEC: "1000" },
  outboundService: async (req: Request) => { const j: any = await req.json(); assert.equal(j.params.account_id, "alice.testnet"); return new Response(JSON.stringify({ jsonrpc: "2.0", id: "reg", result: { keys: [fullKey(alice)] } })); },
});

test("workerd + real D1: claim, search, lookup both ways, CORS; data survives a full runtime restart", async () => {
  const script = await bundle(); const persist = fs.mkdtempSync(path.join(os.tmpdir(), "cf1f-d1-"));
  let mf = start(script, persist);
  try {
    await (await mf.getD1Database("REGISTRY_DB")).exec(oneLine());
    const c = await mf.dispatchFetch("https://registry.test/claim", { method: "POST", body: JSON.stringify(claimBody(alice, "alice_w")) });
    assert.equal(c.status, 200, await c.text());
    const bad = await mf.dispatchFetch("https://registry.test/claim", { method: "POST", body: "not json" });
    assert.equal(bad.status, 400);
    const s: any = await (await mf.dispatchFetch("https://registry.test/search?q=lice", { headers: { origin: "https://app.example" } })).json();
    assert.equal(s.length, 1); assert.equal(s[0].username, "alice_w");
    assert.equal(((await (await mf.dispatchFetch("https://registry.test/lookup/username/ALICE_W")).json()) as any).account_id, "alice.testnet");
    const o = await mf.dispatchFetch("https://registry.test/health", { headers: { origin: "https://app.example" } });
    assert.equal(o.headers.get("access-control-allow-origin"), "https://app.example");
  } finally { await mf.dispose(); }
  mf = start(script, persist);
  try {
    assert.equal(((await (await mf.dispatchFetch("https://registry.test/lookup/account/alice.testnet")).json()) as any).username, "alice_w");
  } finally { await mf.dispose(); }
});
