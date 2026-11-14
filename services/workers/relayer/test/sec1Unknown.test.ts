// SEC1 / SM1 MON-2 + MON-10 (Worker): a send_tx with no outcome (timeout after the RPC took the tx) is answered 202
// {status:"unknown", txHash} with the REAL outer tx hash (computed before sending), never a 500 "failed"; POST /relay/status
// resolves it from the chain; the heartbeat sweep settles orphaned rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { decodeSignedTransaction, encodeTransaction } from "@near-js/transactions";
import { RelayerDO } from "../src/index.js";
import { buildDelegate, fakeDoStorage, outboundFetch, rpcWorld, workerBindings, type Rpc } from "./helpers.js";

const realFetch = globalThis.fetch;
const TIMEOUT = { error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" }, message: "Timeout" } };
const hashOf = (b64: string) => bs58.encode(createHash("sha256").update(encodeTransaction(decodeSignedTransaction(Buffer.from(b64, "base64")).transaction)).digest());
const executed = (hash: string) => ({ status: { SuccessValue: "" }, transaction: { hash }, transaction_outcome: { outcome: { tokens_burnt: "7" } }, receipts_outcome: [] });

async function withDo<T>(w: Rpc, fn: (d: RelayerDO) => Promise<T>, extra: Record<string, string> = {}): Promise<T> {
  const st = fakeDoStorage(":memory:");
  const d = new RelayerDO(st.ctx as any, workerBindings(extra) as any);
  globalThis.fetch = outboundFetch(w) as any;
  try { return await fn(d); } finally { globalThis.fetch = realFetch; st.close(); }
}
const post = async (d: RelayerDO, path: string, body: unknown) => {
  const r = await d.fetch(new Request(`https://relayer.do${path}`, { method: "POST", body: JSON.stringify(body) }));
  return { status: r.status, json: (await r.json()) as any };
};

test("MON-2: send_tx timeout -> 202 unknown with the real outer tx hash; /relay/status reads the chain (pending, then executed)", async () => {
  const w = rpcWorld();
  w.sendTx = () => TIMEOUT;
  const b = buildDelegate({ senderId: "erin.testnet", nonce: 3n });
  await withDo(w, async (d) => {
    const r = await post(d, "/relay", { signedDelegate: b.base64 });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    assert.equal(r.json.ok, false);
    assert.equal(r.json.status, "unknown");
    assert.equal(r.json.txHash, hashOf(w.attempted![0]));
    assert.deepEqual((await post(d, "/relay/status", { txHash: r.json.txHash })).json, { ok: true, state: "pending", txHash: r.json.txHash });
    assert.equal((await post(d, "/relay/status", { senderId: "erin.testnet", nonce: "3" })).json.state, "pending");
    w.txs = new Map([[r.json.txHash, executed(r.json.txHash)]]);
    assert.deepEqual((await post(d, "/relay/status", { txHash: r.json.txHash })).json, { ok: true, state: "executed", txHash: r.json.txHash });
    // the same delegate sent again now answers with the earlier result: nothing is broadcast a second time
    const again = await post(d, "/relay", { signedDelegate: b.base64 });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json, { ok: true, txHash: r.json.txHash });
    assert.equal(w.attempted!.length, 1);
  });
});

test("MON-2: an RPC refusal of the tx (INVALID_TRANSACTION) is still a definite failure (nothing sent), not unknown", async () => {
  const w = rpcWorld();
  w.sendTx = () => ({ error: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION", info: {} }, message: "Expired" } });
  const r = await withDo(w, (d) => post(d, "/relay", { signedDelegate: buildDelegate({ senderId: "finn.testnet" }).base64 }));
  assert.equal(r.status, 500);
});

test("MON-2: unknown + the delegate's maxBlockHeight passed + its nonce never used -> not_executed (hold and mark released)", async () => {
  const w = rpcWorld(4000); // view_access_key answers nonce 100 < delegate nonce 500
  w.sendTx = () => TIMEOUT;
  const b = buildDelegate({ senderId: "gail.testnet", nonce: 500n });
  await withDo(w, async (d) => {
    const r = await post(d, "/relay", { signedDelegate: b.base64 });
    assert.equal(r.status, 202);
    w.heightFn = () => 999_999;
    assert.equal((await post(d, "/relay/status", { txHash: r.json.txHash })).json.state, "not_executed");
  });
});

test("MON-10: the heartbeat sweep settles an unresolved submission (no 24h-held reservation)", async () => {
  const w = rpcWorld();
  w.sendTx = () => TIMEOUT;
  await withDo(w, async (d) => {
    const r = await post(d, "/relay", { signedDelegate: buildDelegate({ senderId: "hal.testnet", nonce: 4n }).base64 });
    w.txs = new Map([[r.json.txHash, executed(r.json.txHash)]]);
    await post(d, "/heartbeat", {});
    // resolved by the sweep: the status is now final without another chain read
    w.txs = new Map();
    assert.equal((await post(d, "/relay/status", { txHash: r.json.txHash })).json.state, "executed");
  });
});

test("status: bad bodies are 400", async () => {
  await withDo(rpcWorld(), async (d) => {
    assert.equal((await post(d, "/relay/status", { txHash: "not base58!" })).status, 400);
    assert.equal((await post(d, "/relay/status", { senderId: "x.testnet", nonce: "-1" })).status, 400);
    assert.deepEqual((await post(d, "/relay/status", { txHash: "11111111111111111111111111111111" })).json, { ok: true, state: "not_found" });
  });
});
