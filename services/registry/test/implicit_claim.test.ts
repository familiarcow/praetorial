// WALLET1 (b): a brand-new Privy NEAR wallet is an implicit account (64 hex = its ed25519 public key) that does not exist on chain until
// funded, so view_access_key_list returns no keys and the claim was refused 403. An implicit account that does NOT exist yet is accepted
// iff the signing key's hex IS the account id (whoever holds that key is the only one who can ever control it). Every other case is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { claimBody, start, fullKey, type Actor } from "./helpers.js";
import { createRpcClient, type RegistryRpc } from "../src/rpc.js";
import { implicitAccountKeyMatches } from "../src/core.js";

/** A fresh, never-funded implicit account: account id = hex(public key). */
function freshImplicit(): Actor {
  const kp = nacl.sign.keyPair();
  return { account: Buffer.from(kp.publicKey).toString("hex"), kp, pub: "ed25519:" + bs58.encode(kp.publicKey) };
}
/** RPC as seen live for a missing account: view_access_key_list -> [] ; view_account -> UNKNOWN_ACCOUNT (exists=false). */
const rpcWith = (keys: Record<string, any[]>, exists: (id: string) => Promise<boolean> = async (id) => id in keys): RegistryRpc =>
  ({ async viewAccessKeyList(id) { return keys[id] ?? []; }, accountExists: exists });

test("fresh unfunded implicit account, signed by its own key -> claim accepted 200", async () => {
  const me = freshImplicit();
  const t = await start([me], { rpc: rpcWith({}) });
  const r = await t.post("/claim", claimBody(me, "newbie"));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.deepEqual(await r.json(), { username: "newbie", account_id: me.account });
  assert.equal((await t.get("/lookup/account/" + me.account)).status, 200);
  await t.close();
});

test("nonexistent implicit account signed by a DIFFERENT key (valid signature) -> 403", async () => {
  const victim = freshImplicit(), attacker = freshImplicit();
  const spoof: Actor = { account: victim.account, kp: attacker.kp, pub: attacker.pub };
  const t = await start([], { rpc: rpcWith({}) });
  const r = await t.post("/claim", claimBody(spoof, "squat"));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "key_not_full_access");
  await t.close();
});

test("implicit account that EXISTS on chain but no longer has that key -> 403 (existing-account rule unchanged)", async () => {
  const me = freshImplicit(), other = freshImplicit();
  const t = await start([me], { rpc: rpcWith({ [me.account]: [fullKey(other)] }) });
  assert.equal((await t.post("/claim", claimBody(me, "newbie"))).status, 403);
  await t.close();
});

test("implicit account that exists with the key as full access -> 200 (existing path)", async () => {
  const me = freshImplicit();
  const t = await start([me], { rpc: rpcWith({ [me.account]: [fullKey(me)] }, async () => { throw new Error("not consulted"); }) });
  assert.equal((await t.post("/claim", claimBody(me, "funded"))).status, 200);
  await t.close();
});

test("named account that does not exist -> still 403 (no implicit shortcut for named accounts)", async () => {
  const kp = nacl.sign.keyPair();
  const named: Actor = { account: "ghost.testnet", kp, pub: "ed25519:" + bs58.encode(kp.publicKey) };
  const t = await start([], { rpc: rpcWith({}) });
  assert.equal((await t.post("/claim", claimBody(named, "ghost"))).status, 403);
  await t.close();
});

test("existence check RPC down on the implicit fallback -> fails closed 502, nothing stored", async () => {
  const me = freshImplicit();
  const t = await start([me], { rpc: rpcWith({}, async () => { throw new Error("rpc down"); }) });
  assert.equal((await t.post("/claim", claimBody(me, "newbie"))).status, 502);
  assert.equal((await t.get("/lookup/account/" + me.account)).status, 404);
  await t.close();
});

test("RPC without an existence check -> fallback unavailable -> 403 (fail closed)", async () => {
  const me = freshImplicit();
  const t = await start([me], { rpc: { async viewAccessKeyList() { return []; } } });
  assert.equal((await t.post("/claim", claimBody(me, "newbie"))).status, 403);
  await t.close();
});

test("implicitAccountKeyMatches: exact lowercase 64-hex of the 32-byte key only", () => {
  const kp = nacl.sign.keyPair(); const hex = Buffer.from(kp.publicKey).toString("hex");
  assert.equal(implicitAccountKeyMatches(hex, kp.publicKey), true);
  assert.equal(implicitAccountKeyMatches(hex.toUpperCase(), kp.publicKey), false);
  assert.equal(implicitAccountKeyMatches(hex + ".testnet", kp.publicKey), false);
  assert.equal(implicitAccountKeyMatches(hex, nacl.sign.keyPair().publicKey), false);
  assert.equal(implicitAccountKeyMatches("0x" + hex.slice(0, 40), kp.publicKey), false);
  assert.equal(implicitAccountKeyMatches(hex, kp.publicKey.slice(0, 31)), false);
});

test("createRpcClient.accountExists: view_account result -> true; UNKNOWN_ACCOUNT -> false; any other error -> throws", async () => {
  const calls: any[] = [];
  const mk = (body: unknown) => createRpcClient("https://rpc.example", (async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify(body)); }) as unknown as typeof fetch);
  assert.equal(await mk({ result: { amount: "1", block_height: 1 } }).accountExists!("x.testnet"), true);
  assert.equal(calls[0].params.request_type, "view_account");
  assert.equal(calls[0].params.account_id, "x.testnet");
  assert.equal(calls[0].params.finality, "final");
  // verbatim shape of the live testnet reply for a fresh implicit account (2026-11-09)
  const unknown = { jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { info: {}, name: "UNKNOWN_ACCOUNT" }, code: -32000, message: "Server error", data: "account abc does not exist while viewing" }, id: 1 };
  assert.equal(await mk(unknown).accountExists!("abc"), false);
  await assert.rejects(() => mk({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } } }).accountExists!("abc"));
  await assert.rejects(() => mk({ error: { name: "INTERNAL_ERROR", cause: { name: "TIMEOUT_ERROR" } } }).accountExists!("abc"));
});
