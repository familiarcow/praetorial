// REG1 (f): HttpUserRegistry + claimUsername against a mocked fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpUserRegistry, claimUsername, MockUserRegistry, type UserRegistry } from "../lib/refereeRegistry";
import { REGISTRY_URL, REGISTRY_ID } from "../lib/config";

function mockFetch(handler: (url: string, init?: any) => { status?: number; body?: unknown }) {
  const calls: { url: string; init?: any }[] = [];
  const f = (async (url: string, init?: any) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("REGISTRY_URL / REGISTRY_ID config exist as strings", () => {
  assert.equal(typeof REGISTRY_URL, "string");
  assert.equal(typeof REGISTRY_ID, "string");
});
test("HttpUserRegistry implements UserRegistry and keeps MockUserRegistry alongside", () => {
  const r: UserRegistry = new HttpUserRegistry("https://reg.example", (async () => new Response("[]")) as any);
  assert.equal(typeof r.search, "function");
  assert.equal(typeof new MockUserRegistry([]).search, "function");
});
test("search: GETs /search?q= (encoded, @ stripped, trimmed), maps account_tail -> account", async () => {
  const { f, calls } = mockFetch(() => ({ body: [{ username: "alice", account_tail: "alice.near" }, { username: "bob", account_tail: "89abcdef" }] }));
  const r = new HttpUserRegistry("https://reg.example/", f);
  const out = await r.search("  @Al ice ");
  assert.equal(calls[0].url, "https://reg.example/search?q=" + encodeURIComponent("Al ice"));
  assert.deepEqual(out, [{ username: "alice", account: "alice.near" }, { username: "bob", account: "89abcdef" }]);
});
test("search: empty query makes no request; failures return [] (never throw into the UI)", async () => {
  const { f, calls } = mockFetch(() => ({ status: 500 }));
  const r = new HttpUserRegistry("https://reg.example", f);
  assert.deepEqual(await r.search("  "), []);
  assert.equal(calls.length, 0);
  assert.deepEqual(await r.search("al"), []);
  const thrower = new HttpUserRegistry("https://reg.example", (async () => { throw new Error("net"); }) as any);
  assert.deepEqual(await thrower.search("al"), []);
});
test("byAccount: 200 -> user, 404 -> null, other failure -> throws (so a registered ref isn't mistaken for unregistered)", async () => {
  const { f, calls } = mockFetch((u) => u.endsWith("alice.near") ? { body: { username: "alice" } } : u.endsWith("nobody.near") ? { status: 404 } : { status: 500 });
  const r = new HttpUserRegistry("https://reg.example", f);
  assert.deepEqual(await r.byAccount("alice.near"), { username: "alice", account: "alice.near" });
  assert.equal(calls[0].url, "https://reg.example/lookup/account/alice.near");
  assert.equal(await r.byAccount("nobody.near"), null);
  await assert.rejects(() => r.byAccount("boom.near"));
});
test("claimUsername: builds timestamped nonce, signs message praetorial-username:<name>, POSTs the body", async () => {
  const { f, calls } = mockFetch(() => ({ body: { username: "alice", account_id: "alice.near" } }));
  let signed: any;
  const res = await claimUsername({
    registryUrl: "https://reg.example", registryId: "registry.praetorial.near", username: "@Alice", accountId: "alice.near", publicKey: "ed25519:PK",
    signMessage: async (p) => { signed = p; return { signature: new Uint8Array(64).fill(7) }; },
    fetchImpl: f, now: () => 1_700_000_000_000,
  });
  assert.deepEqual(res, { ok: true, username: "alice", account_id: "alice.near" });
  assert.equal(signed.message, "praetorial-username:alice");
  assert.equal(signed.recipient, "registry.praetorial.near");
  assert.equal(signed.nonce.length, 32);
  assert.equal(Buffer.from(signed.nonce).readBigUInt64BE(0), 1_700_000_000_000n);
  assert.equal(calls[0].url, "https://reg.example/claim");
  assert.equal(calls[0].init.method, "POST");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.username, "alice");
  assert.equal(body.account_id, "alice.near");
  assert.equal(body.public_key, "ed25519:PK");
  assert.equal(body.nonce, Buffer.from(signed.nonce).toString("base64"));
  assert.equal(body.signature, Buffer.alloc(64, 7).toString("base64"));
});
test("claimUsername: server refusal surfaces the error code, no throw", async () => {
  const { f } = mockFetch(() => ({ status: 409, body: { error: "username_taken" } }));
  const res = await claimUsername({ registryUrl: "https://r", registryId: "r.near", username: "alice", accountId: "a.near", publicKey: "ed25519:PK", signMessage: async () => ({ signature: new Uint8Array(64) }), fetchImpl: f });
  assert.deepEqual(res, { ok: false, error: "username_taken", status: 409 });
});
test("claimUsername: a rejected wallet signature is returned as an error, nothing is POSTed", async () => {
  const { f, calls } = mockFetch(() => ({}));
  const res = await claimUsername({ registryUrl: "https://r", registryId: "r.near", username: "alice", accountId: "a.near", publicKey: "ed25519:PK", signMessage: async () => { throw new Error("user rejected"); }, fetchImpl: f });
  assert.equal(res.ok, false);
  assert.equal(calls.length, 0);
});

// REG2: exact username lookup (full account id), no UI wiring yet (FE4b).
test("MockUserRegistry.lookupUsername: exact, case-insensitive, @-stripped; null for partial", async () => {
  const r = new MockUserRegistry([{ username: "Alice", account: "alice.testnet" }, { username: "bob", account: "bob.testnet" }]);
  assert.deepEqual(await r.lookupUsername("@ALICE"), { username: "Alice", account: "alice.testnet" });
  assert.equal(await r.lookupUsername("ali"), null);
  assert.equal(await r.lookupUsername(""), null);
});
test("HttpUserRegistry.lookupUsername: GET /lookup/username/<encoded>, maps account_id -> account (full id)", async () => {
  const HEX = "ab".repeat(32);
  const { f, calls } = mockFetch(() => ({ body: { username: "bob", account_id: HEX } }));
  const r = new HttpUserRegistry("https://reg.example/", f);
  assert.deepEqual(await r.lookupUsername("  @Bob "), { username: "bob", account: HEX });
  assert.equal(calls[0].url, "https://reg.example/lookup/username/Bob");
});
test("HttpUserRegistry.lookupUsername: 404 -> null, empty name -> null w/o fetch, 429/5xx throw", async () => {
  const m404 = mockFetch(() => ({ status: 404, body: { error: "not_found" } }));
  assert.equal(await new HttpUserRegistry("https://r", m404.f).lookupUsername("zed"), null);
  const m = mockFetch(() => ({ body: {} }));
  assert.equal(await new HttpUserRegistry("https://r", m.f).lookupUsername(" @ "), null);
  assert.equal(m.calls.length, 0);
  await assert.rejects(new HttpUserRegistry("https://r", mockFetch(() => ({ status: 429 })).f).lookupUsername("zed"));
  await assert.rejects(new HttpUserRegistry("https://r", mockFetch(() => ({ status: 500 })).f).lookupUsername("zed"));
});
