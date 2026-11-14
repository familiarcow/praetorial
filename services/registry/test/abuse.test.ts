import { test } from "node:test";
import assert from "node:assert/strict";
import { actor, claimBody, start } from "./helpers.js";

const alice = actor("alice.near");

test("per-IP token bucket on /search: capacity then 429, refills with time", async () => {
  let now = 1_000_000;
  const t = await start([alice], { rate: { capacity: 2, refillPerSec: 1 }, now: () => now });
  assert.equal((await t.get("/search?q=ali")).status, 200);
  assert.equal((await t.get("/search?q=ali")).status, 200);
  const r = await t.get("/search?q=ali");
  assert.equal(r.status, 429);
  assert.ok(r.headers.get("retry-after"));
  now += 1000;
  assert.equal((await t.get("/search?q=ali")).status, 200);
  await t.close();
});
test("/claim shares the limiter; buckets are per IP (x-forwarded-for when trustProxy)", async () => {
  const t = await start([alice], { rate: { capacity: 1, refillPerSec: 0.001 }, trustProxy: true });
  assert.equal((await t.post("/claim", "bad", { "x-forwarded-for": "1.1.1.1" })).status, 400);
  assert.equal((await t.post("/claim", "bad", { "x-forwarded-for": "1.1.1.1" })).status, 429);
  assert.equal((await t.post("/claim", "bad", { "x-forwarded-for": "2.2.2.2" })).status, 400);
  await t.close();
});
test("x-forwarded-for is ignored without trustProxy", async () => {
  const t = await start([alice], { rate: { capacity: 1, refillPerSec: 0.001 } });
  assert.equal((await t.get("/search?q=a", { "x-forwarded-for": "1.1.1.1" })).status, 200);
  assert.equal((await t.get("/search?q=a", { "x-forwarded-for": "2.2.2.2" })).status, 429);
  await t.close();
});
test("/lookup is not rate limited by the claim/search bucket", async () => {
  const t = await start([alice], { rate: { capacity: 1, refillPerSec: 0.001 } });
  await t.get("/search?q=a");
  assert.equal((await t.get("/lookup/account/x.near")).status, 404);
  await t.close();
});
test("body over 2KB -> 413 (declared and streamed)", async () => {
  const t = await start([alice]);
  const big = JSON.stringify({ username: "alice", pad: "x".repeat(3000) });
  assert.equal((await t.post("/claim", big)).status, 413);
  await t.close();
});
test("CORS: allow-listed origin reflected, others get no ACAO, preflight 204", async () => {
  const t = await start([alice]);
  const ok = await t.get("/search?q=a", { origin: "https://app.example" });
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.example");
  const bad = await t.get("/search?q=a", { origin: "https://evil.example" });
  assert.equal(bad.headers.get("access-control-allow-origin"), null);
  const pre = await fetch(t.base + "/claim", { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "https://app.example");
  const preBad = await fetch(t.base + "/claim", { method: "OPTIONS", headers: { origin: "https://evil.example" } });
  assert.equal(preBad.headers.get("access-control-allow-origin"), null);
  await t.close();
});
test("loadRegistryConfig reads env: CORS list, port, store path, rate", async () => {
  const { loadRegistryConfig } = await import("../src/config.js");
  const c = loadRegistryConfig({ REGISTRY_ID: "r.near", REGISTRY_CORS_ORIGINS: "https://a.example, https://b.example", REGISTRY_PORT: "8791", REGISTRY_STORE_PATH: "/tmp/x.json", REGISTRY_RATE_CAPACITY: "5", REGISTRY_RATE_REFILL_PER_SEC: "0.5", NEAR_RPC_URL: "https://rpc" });
  assert.deepEqual(c.corsOrigins, ["https://a.example", "https://b.example"]);
  assert.equal(c.port, 8791);
  assert.equal(c.storePath, "/tmp/x.json");
  assert.deepEqual(c.rate, { capacity: 5, refillPerSec: 0.5 });
  assert.equal(c.registryId, "r.near");
  assert.throws(() => loadRegistryConfig({}), /REGISTRY_ID/);
  assert.deepEqual(loadRegistryConfig({ REGISTRY_ID: "r.near" }).corsOrigins, []);
});
