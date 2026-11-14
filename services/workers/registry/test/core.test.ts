// CF1f RED: host-neutral core + D1 schema + D1 rate limiter + Worker-only behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashNep413 } from "@praetorial/common/nep413.js";
import { nep413Digest } from "../../../registry/src/nep413Core.js";
import { actor, claimBody, fakeRpc, fullKey, REGISTRY_ID } from "../../../registry/test/helpers.js";
import { fakeD1 } from "../../indexer/test/helpers.js";
import { handle } from "../src/index.js";
import { registryMigrationSql } from "./workerBackend.js";

const alice = actor("alice.near"), bob = actor("bob.near");
async function world() {
  const f = fakeD1(":memory:", false); await f.d1.exec(registryMigrationSql());
  const env: any = { REGISTRY_DB: f.d1, REGISTRY_ID, REGISTRY_RATE_CAPACITY: "1000", REGISTRY_RATE_REFILL_PER_SEC: "1000" };
  const rpc = fakeRpc({ "alice.near": [fullKey(alice)], "bob.near": [fullKey(bob)] });
  const call = (p: string, init?: RequestInit, now = () => Date.now()) => handle(new Request("https://registry.test" + p, init), env, { rpc, now });
  return { f, env, call };
}

test("host-neutral NEP-413 digest equals the node hashNep413 (random messages/recipients/nonces)", () => {
  for (let i = 0; i < 20; i++) {
    const nonce = Buffer.alloc(32, i + 1); const message = `praetorial-username:user_${i}é`; const recipient = `registry${i}.testnet`;
    assert.deepEqual(Buffer.from(nep413Digest({ message, nonce: new Uint8Array(nonce), recipient })), hashNep413({ message, nonce, recipient }));
  }
});

test("migration: users has UNIQUE folded username and UNIQUE account_id (the DB itself refuses duplicates)", async () => {
  const { f } = await world();
  const ins = (u: string, fo: string, a: string) => f.d1.prepare("INSERT INTO users (username, folded, account_id, public_key, discoverable, claimed_at) VALUES (?,?,?,?,1,0)").bind(u, fo, a, "ed25519:x").run();
  await ins("alice", "alloe", "a.near");
  await assert.rejects(() => ins("a1ice", "alloe", "b.near"), /UNIQUE/);
  await assert.rejects(() => ins("other", "othor", "a.near"), /UNIQUE/);
  await ins("other", "othor", "b.near");
});

test("claim via the Worker stores a row; re-claim by the same account renames and frees the old name (D1 upsert)", async () => {
  const { f, call } = await world();
  const post = (b: unknown) => call("/claim", { method: "POST", headers: { "cf-connecting-ip": "1.1.1.1" }, body: JSON.stringify(b) });
  assert.equal((await post(claimBody(alice, "alice"))).status, 200);
  assert.equal((await post(claimBody(alice, "alicia"))).status, 200);
  assert.equal((await call("/lookup/username/alice")).status, 404);
  assert.equal(((await (await call("/lookup/account/alice.near")).json()) as any).username, "alicia");
  assert.equal((await post(claimBody(bob, "alice"))).status, 200, "old name is free again");
  assert.equal(((await f.d1.prepare("SELECT COUNT(*) AS n FROM users").first()) as any).n, 2);
});

test("old nonces are pruned from D1 on claim", async () => {
  const { f, call } = await world();
  let now = 10_000_000_000;
  const post = (b: unknown) => call("/claim", { method: "POST", headers: { "cf-connecting-ip": "1.1.1.1" }, body: JSON.stringify(b) }, () => now);
  assert.equal((await post(claimBody(alice, "alice", { ts: now }))).status, 200);
  now += 3_600_000;
  assert.equal((await post(claimBody(bob, "bobby", { ts: now }))).status, 200);
  assert.equal(((await f.d1.prepare("SELECT COUNT(*) AS n FROM nonces").first()) as any).n, 1);
});

test("rate limiter is a D1 token bucket: persists per IP, refills with time, /lookup/account and /health are free", async () => {
  const { f, env, call } = await world();
  env.REGISTRY_RATE_CAPACITY = "2"; env.REGISTRY_RATE_REFILL_PER_SEC = "1";
  let now = 5_000_000; const hit = (ip: string) => call("/search?q=ali", { headers: { "cf-connecting-ip": ip } }, () => now);
  assert.equal((await hit("9.9.9.9")).status, 200); assert.equal((await hit("9.9.9.9")).status, 200);
  const r = await hit("9.9.9.9"); assert.equal(r.status, 429); assert.ok(r.headers.get("retry-after"));
  assert.equal((await hit("8.8.8.8")).status, 200);
  assert.equal((await call("/health")).status, 200); assert.equal((await call("/lookup/account/x.near")).status, 404);
  assert.ok(((await f.d1.prepare("SELECT COUNT(*) AS n FROM rate").first()) as any).n >= 2, "bucket state lives in D1");
  now += 1000; assert.equal((await hit("9.9.9.9")).status, 200);
});

test("misconfigured Worker (no REGISTRY_ID or no D1) fails loudly with 500, never silently serves", async () => {
  const { env } = await world();
  assert.equal((await handle(new Request("https://registry.test/health"), { ...env, REGISTRY_ID: undefined } as any)).status, 500);
  assert.equal((await handle(new Request("https://registry.test/search?q=abc"), { ...env, REGISTRY_DB: undefined } as any)).status, 500);
});

test("unknown route 404, wrong method 404, /health ok JSON", async () => {
  const { call } = await world();
  assert.equal((await call("/nope")).status, 404);
  assert.equal((await call("/search", { method: "POST" })).status, 404);
  // STACK1: /health keeps {ok:true} for existing callers and adds exactly the deployed-stack fields (no escrow id for the registry).
  const h: any = await (await call("/health")).json();
  assert.equal(h.ok, true);
  assert.deepEqual(Object.keys(h).sort(), ["git_sha", "network", "ok", "registry_id", "service"]);
  assert.equal(h.service, "registry");
});
