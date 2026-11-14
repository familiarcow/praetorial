// SECREV1 SR-2: the limiter Durable Object also stores verified attestations by spec_hash (the Worker's AttestationCache).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceCheckLimiterDO, doAttestationCache } from "../src/index.js";

function fakeCtx() {
  const m = new Map<string, unknown>();
  return { m, storage: { async get<T>(k: string) { return m.get(k) as T | undefined; }, async put(k: string, v: unknown) { m.set(k, v); } } };
}
test("SECREV1 SR-2: DO cache round-trips by spec_hash; bad input is refused; the limiter route is unchanged", async () => {
  const ctx = fakeCtx();
  const obj = new SourceCheckLimiterDO(ctx);
  const stub = { fetch: (u: string, i?: any) => obj.fetch(new Request(u, i)) };
  const cache = doAttestationCache(stub);
  const H = "a".repeat(64);
  assert.equal(await cache.get(H), undefined);
  await cache.put(H, { checked_at: "1700000000000000000", signature_hex: "bb".repeat(64) });
  assert.deepEqual(await cache.get(H), { checked_at: "1700000000000000000", signature_hex: "bb".repeat(64) });
  assert.equal(await cache.get("not-a-hash"), undefined);
  await cache.put("x", { checked_at: "1", signature_hex: "zz" });
  assert.ok(![...ctx.m.keys()].some((k) => k.includes("x")), "malformed puts are dropped");
  const r = await (await stub.fetch("https://limiter/consume", { method: "POST", body: JSON.stringify({ ip: "1.1.1.1", nowMs: 0 }) })).json();
  assert.deepEqual(r, { ok: true });
});
