// LIVE1: username claim by a brand-new UNFUNDED implicit account (64 lowercase hex = the ed25519 public key). Such an account does not exist on
// chain yet, so view_access_key_list returns { keys: [] } (verified against testnet RPC: no error for a missing account) and the claim was
// refused 403 key_not_full_access. The implicit id IS the key, so for a NON-EXISTENT implicit account the claim is accepted iff hex(pk) == id.
// An EXISTING implicit account keeps the on-chain check (its original key may have been deleted). Runs against the node server and, through
// parity.test.ts (REGISTRY_BACKEND=worker), the Worker.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { claimBody, start as startServer, fullKey, type Actor } from "./helpers.js";
import { createRpcClient, type AccessKeyInfo } from "../src/rpc.js";

// close every server even when an assertion throws before t.close() (a leaked server would hang the run)
const open: Array<() => Promise<void>> = [];
after(() => Promise.all(open.map((c) => c())));
const start: typeof startServer = async (...a) => { const t = await startServer(...a); let closed = false; const close = async () => { if (!closed) { closed = true; await t.close(); } }; open.push(close); return { ...t, close }; };
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
function implicitActor(): Actor { const kp = nacl.sign.keyPair(); return { account: hex(kp.publicKey), kp, pub: "ed25519:" + bs58.encode(kp.publicKey) }; }

/** A fake NEAR RPC speaking the real JSON shapes: view_access_key_list -> { keys } (also [] for a missing account), view_account -> UNKNOWN_ACCOUNT. */
function chainRpc(chain: Record<string, AccessKeyInfo[]>) {
  const calls: { type: string; id: string }[] = [];
  const f = (async (_url: string, init: any) => {
    const { params } = JSON.parse(init.body);
    calls.push({ type: params.request_type, id: params.account_id });
    const exists = params.account_id in chain;
    if (params.request_type === "view_access_key_list") return new Response(JSON.stringify({ jsonrpc: "2.0", id: "reg", result: { block_height: 1, keys: chain[params.account_id] ?? [] } }));
    if (params.request_type === "view_account") {
      return new Response(JSON.stringify(exists
        ? { jsonrpc: "2.0", id: "reg", result: { amount: "1", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 182, block_height: 1 } }
        : { jsonrpc: "2.0", id: "reg", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: { requested_account_id: params.account_id } }, code: -32000, message: "Server error", data: `account ${params.account_id} does not exist while viewing` } }));
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "reg", error: { name: "REQUEST_VALIDATION_ERROR" } }));
  }) as unknown as typeof fetch;
  return { rpc: createRpcClient("https://rpc.example", f), calls };
}

test("RED->GREEN: brand-new unfunded implicit account (not on chain) claims with the key its id encodes -> 200, stored", async () => {
  const a = implicitActor();
  const { rpc } = chainRpc({});
  const t = await start([a], { rpc });
  const r = await t.post("/claim", claimBody(a, "fresh_wallet"));
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.deepEqual(await r.json(), { username: "fresh_wallet", account_id: a.account });
  assert.equal((await t.get(`/lookup/account/${a.account}`)).status, 200);
  await t.close();
});

test("unfunded implicit account: the signature is still verified (wrong signer -> 401)", async () => {
  const a = implicitActor();
  const t = await start([a], { rpc: chainRpc({}).rpc });
  assert.equal((await t.post("/claim", claimBody(a, "fresh", { signWith: nacl.sign.keyPair() }))).status, 401);
  await t.close();
});

test("non-existent implicit account, signing key hex != account id -> 403, nothing stored", async () => {
  const a = implicitActor(), other = implicitActor();
  const victim: Actor = { ...a, account: other.account }; // a signs (valid sig) for someone else's implicit id
  const t = await start([victim], { rpc: chainRpc({}).rpc });
  const r = await t.post("/claim", claimBody(victim, "squat"));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "key_not_full_access");
  assert.equal((await t.get(`/lookup/account/${other.account}`)).status, 404);
  await t.close();
});

test("named account that does not exist on chain -> 403 (no implicit shortcut for named ids)", async () => {
  const kp = nacl.sign.keyPair();
  const a: Actor = { account: "ghost.testnet", kp, pub: "ed25519:" + bs58.encode(kp.publicKey) };
  const t = await start([a], { rpc: chainRpc({}).rpc });
  assert.equal((await t.post("/claim", claimBody(a, "ghost"))).status, 403);
  await t.close();
});

test("EXISTING implicit account whose original key (== its id) was deleted -> 403 (the hex-equals-key shortcut is not used for existing accounts)", async () => {
  const a = implicitActor(), newOwner = implicitActor();
  const t = await start([a], { rpc: chainRpc({ [a.account]: [fullKey(newOwner)] }).rpc });
  const r = await t.post("/claim", claimBody(a, "stale_key"));
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "key_not_full_access");
  // ...and with every key deleted (view_access_key_list [] exactly like a missing account) it is still refused: existence decides.
  const t2 = await start([a], { rpc: chainRpc({ [a.account]: [] }).rpc });
  assert.equal((await t2.post("/claim", claimBody(a, "stale_key"))).status, 403);
  await t.close(); await t2.close();
});

test("EXISTING implicit account with its original key still on chain -> 200 via the on-chain key list (no existence lookup needed)", async () => {
  const a = implicitActor();
  const { rpc, calls } = chainRpc({ [a.account]: [fullKey(a)] });
  const t = await start([a], { rpc });
  assert.equal((await t.post("/claim", claimBody(a, "funded"))).status, 200);
  assert.deepEqual(calls.map((c) => c.type), ["view_access_key_list"]);
  await t.close();
});

test("existence lookup failing (RPC down) for an unfunded implicit account fails closed 502", async () => {
  const a = implicitActor();
  const rpc = { async viewAccessKeyList() { return []; }, async accountExists(): Promise<boolean> { throw new Error("rpc down"); } };
  const t = await start([a], { rpc });
  assert.equal((await t.post("/claim", claimBody(a, "fresh"))).status, 502);
  await t.close();
});

test("createRpcClient.accountExists: view_account result -> true, UNKNOWN_ACCOUNT -> false, any other error -> throws", async () => {
  const a = implicitActor();
  const { rpc } = chainRpc({ "alice.near": [] });
  assert.equal(await rpc.accountExists!("alice.near"), true);
  assert.equal(await rpc.accountExists!(a.account), false);
  const bad = createRpcClient("https://rpc.example", (async () => new Response(JSON.stringify({ error: { name: "INTERNAL_ERROR", cause: { name: "TIMEOUT_ERROR" } } }))) as unknown as typeof fetch);
  await assert.rejects(() => bad.accountExists!("alice.near"));
});
