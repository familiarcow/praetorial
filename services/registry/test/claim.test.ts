import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { actor, claimBody, start, fnKey, fullKey, makeNonce, REGISTRY_ID } from "./helpers.js";
import { createRpcClient } from "../src/rpc.js";

const alice = actor("alice.near");
const bob = actor("b".repeat(64));

test("valid claim stores the name", async () => {
  const t = await start([alice]);
  const r = await t.post("/claim", claimBody(alice, "Alice"));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { username: "alice", account_id: "alice.near" });
  const l = await t.get("/lookup/account/alice.near");
  assert.equal(l.status, 200);
  await t.close();
});
test("leading @ is stripped, message is over the normalized name", async () => {
  const t = await start([alice]);
  assert.equal((await t.post("/claim", claimBody(alice, "@Alice"))).status, 200);
  await t.close();
});
test("signature by a different key is rejected 401", async () => {
  const t = await start([alice]);
  const r = await t.post("/claim", claimBody(alice, "alice", { signWith: nacl.sign.keyPair() }));
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, "bad_signature");
  await t.close();
});
test("signature over a different username or recipient is rejected", async () => {
  const t = await start([alice]);
  assert.equal((await t.post("/claim", claimBody(alice, "alice", { message: "praetorial-username:other" }))).status, 401);
  assert.equal((await t.post("/claim", claimBody(alice, "alice", { recipient: "evil.near" }))).status, 401);
  await t.close();
});
test("public key that is function-call only is rejected 403", async () => {
  const t = await start([alice], {}, { "alice.near": [fnKey(alice)] });
  const r = await t.post("/claim", claimBody(alice, "alice"));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "key_not_full_access");
  await t.close();
});
test("public key not on the account is rejected 403", async () => {
  const other = actor("alice.near");
  const t = await start([alice], {}, { "alice.near": [fullKey(other)] });
  assert.equal((await t.post("/claim", claimBody(alice, "alice"))).status, 403);
  await t.close();
});
test("RPC failure fails closed (502), nothing stored", async () => {
  const t = await start([alice], { rpc: { async viewAccessKeyList() { throw new Error("rpc down"); } } });
  assert.equal((await t.post("/claim", claimBody(alice, "alice"))).status, 502);
  assert.equal((await t.get("/lookup/account/alice.near")).status, 404);
  await t.close();
});
test("nonce older than 10 minutes rejected; 9 minutes accepted", async () => {
  const t = await start([alice]);
  const r = await t.post("/claim", claimBody(alice, "alice", { ts: Date.now() - 11 * 60_000 }));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "nonce_expired");
  assert.equal((await t.post("/claim", claimBody(alice, "alice", { ts: Date.now() - 9 * 60_000 }))).status, 200);
  await t.close();
});
test("nonce from the future (>1 min skew) rejected", async () => {
  const t = await start([alice]);
  assert.equal((await t.post("/claim", claimBody(alice, "alice", { ts: Date.now() + 5 * 60_000 }))).status, 400);
  await t.close();
});
test("replay of the same nonce is rejected 409", async () => {
  const t = await start([alice]);
  const nonce = makeNonce(Date.now());
  assert.equal((await t.post("/claim", claimBody(alice, "alice", { nonce }))).status, 200);
  const r = await t.post("/claim", claimBody(alice, "alice", { nonce }));
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "nonce_replay");
  await t.close();
});
test("a failed claim does not burn the nonce", async () => {
  const t = await start([alice]);
  const nonce = makeNonce(Date.now());
  assert.equal((await t.post("/claim", claimBody(alice, "ab", { nonce }))).status, 400);
  assert.equal((await t.post("/claim", claimBody(alice, "alice", { nonce }))).status, 200);
  await t.close();
});
test("malformed bodies are 400 (not JSON, missing fields, bad nonce length)", async () => {
  const t = await start([alice]);
  assert.equal((await t.post("/claim", "not json")).status, 400);
  assert.equal((await t.post("/claim", { username: "alice" })).status, 400);
  const b = claimBody(alice, "alice");
  assert.equal((await t.post("/claim", { ...b, nonce: Buffer.alloc(8).toString("base64") })).status, 400);
  await t.close();
});
test("claim state survives in the store the server was given", async () => {
  const t = await start([alice]);
  await t.post("/claim", claimBody(alice, "alice"));
  const st = await t.store.read();
  assert.equal(st.users["alice.near"].username, "alice");
  assert.equal(REGISTRY_ID.length > 0, true);
  await t.close();
});
test("createRpcClient posts view_access_key_list to the RPC and returns keys; throws on RPC error", async () => {
  const calls: any[] = [];
  const f = (async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ result: { keys: [{ public_key: "ed25519:k", access_key: { permission: "FullAccess" } }] } }));
  }) as unknown as typeof fetch;
  const rpc = createRpcClient("https://rpc.example", f);
  const keys = await rpc.viewAccessKeyList("alice.near");
  assert.equal(keys[0].public_key, "ed25519:k");
  assert.equal(calls[0].body.method, "query");
  assert.equal(calls[0].body.params.request_type, "view_access_key_list");
  assert.equal(calls[0].body.params.account_id, "alice.near");
  assert.equal(calls[0].body.params.finality, "final");
  const bad = createRpcClient("https://rpc.example", (async () => new Response(JSON.stringify({ error: { name: "x" } }))) as unknown as typeof fetch);
  await assert.rejects(() => bad.viewAccessKeyList("alice.near"));
});
