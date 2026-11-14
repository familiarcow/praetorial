// LIVE1 defect 2 (relayer side), against the Worker Durable Object:
//  (b) an outer meta-tx that "succeeded" while its inner receipt panicked (tx 3WoNrAfT..., wrap.testnet
//      "The account doesn't have enough balance") must NOT be reported as a plain success;
//  (c) a send_tx that failed (or timed out: SEC1 202 unknown) must not brick the sender with "replay" on retry;
//  and every 4xx reason is logged (no secrets) so `wrangler tail` shows why a user got a 400.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RelayerDO } from "../src/index.js";
import { buildDelegate, fakeDoStorage, outboundFetch, rpcWorld, workerBindings, type Rpc } from "./helpers.js";

const realFetch = globalThis.fetch;
async function run<T>(w: Rpc, fn: (d: RelayerDO) => Promise<T>): Promise<T> {
  const st = fakeDoStorage(":memory:");
  const d = new RelayerDO(st.ctx as any, workerBindings() as any);
  globalThis.fetch = outboundFetch(w) as any;
  try { return await fn(d); } finally { globalThis.fetch = realFetch; st.close(); }
}
async function post(d: RelayerDO, b64: string) {
  const r = await d.fetch(new Request("https://relayer.do/relay", { method: "POST", body: JSON.stringify({ signedDelegate: b64 }) }));
  return { status: r.status, json: (await r.json()) as any };
}

test("LIVE1 2b: inner receipt failure is reported as receiptFailure (not a plain success)", async () => {
  const w = rpcWorld();
  w.sendTx = () => ({ result: {
    status: { SuccessValue: "" }, transaction: { hash: "INNERFAILHASH" }, transaction_outcome: { outcome: { tokens_burnt: "1" } },
    receipts_outcome: [
      { id: "r1", outcome: { executor_id: "alice.testnet", status: { SuccessValue: "" }, tokens_burnt: "1" } },
      { id: "r2", outcome: { executor_id: "wrap.testnet", status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: The account doesn't have enough balance" } } } } }, tokens_burnt: "1" } },
    ] } });
  const r = await run(w, (d) => post(d, buildDelegate({ senderId: "alice.testnet" }).base64));
  assert.equal(r.status, 200);
  assert.equal(r.json.txHash, "INNERFAILHASH");
  assert.equal(r.json.ok, false, "a tx whose action failed is not a success");
  assert.match(String(r.json.receiptFailure), /enough balance/);
  assert.match(String(r.json.error), /enough balance/);
});

test("LIVE1 2c: send_tx that failed without executing -> the SAME delegate can be retried (no permanent replay 400)", async () => {
  const w = rpcWorld();
  let fail = true;
  w.sendTx = () => fail ? { error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" } } }
    : { result: { status: { SuccessValue: "" }, transaction: { hash: "RETRYOK" }, transaction_outcome: { outcome: { tokens_burnt: "1" } }, receipts_outcome: [] } };
  const b = buildDelegate({ senderId: "bob.testnet", nonce: 9n });
  const [first, second] = await run(w, async (d) => {
    const a = await post(d, b.base64);
    fail = false;
    return [a, await post(d, b.base64)];
  });
  // SEC1/MON-2: a send_tx timeout is "outcome unknown" (202 + hash), not a 500; resending the SAME delegate still works
  // (the chain runs a delegate nonce at most once), so the LIVE1 "bricked by replay" bug stays fixed.
  assert.equal(first.status, 202, JSON.stringify(first.json));
  assert.equal(first.json.status, "unknown");
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal(second.json.txHash, "RETRYOK");
});

test("LIVE1 2c: every 4xx reason is logged for wrangler tail", async () => {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const r = await run(rpcWorld(), (d) => post(d, buildDelegate({ senderId: "carol.testnet", methodName: "withdraw_all" }).base64));
    assert.equal(r.status, 400);
  } finally { console.warn = orig; }
  assert.ok(lines.some((l) => /\[relayer\] 400 carol\.testnet/.test(l) && /withdraw_all/.test(l)), lines.join("\n"));
});

test("LIVE1 2c: a user stuck on a stale replay mark (chain nonce below the delegate nonce) is unstuck on retry", async () => {
  const w = rpcWorld(); // view_access_key answers nonce 100 for every key: the delegate (nonce 500) never executed
  let refuse = true;
  w.sendTx = () => refuse
    ? { result: { status: { Failure: { ActionError: { index: 0, kind: { DelegateActionSenderDoesNotExist: { sender_id: "dave.testnet" } } } } }, transaction: { hash: "T1" }, transaction_outcome: { outcome: { tokens_burnt: "1" } }, receipts_outcome: [] } }
    : { result: { status: { SuccessValue: "" }, transaction: { hash: "UNSTUCK" }, transaction_outcome: { outcome: { tokens_burnt: "1" } }, receipts_outcome: [] } };
  const b = buildDelegate({ senderId: "dave.testnet", nonce: 500n });
  const st = fakeDoStorage(":memory:");
  const d = new RelayerDO(st.ctx as any, workerBindings({ RELAYER_REPLAY_STALE_MS: "0" }) as any);
  globalThis.fetch = outboundFetch(w) as any;
  try {
    const first = await post(d, b.base64);
    assert.equal(first.status, 500); // executed, delegate refused: charged, mark kept
    refuse = false;
    const second = await post(d, b.base64);
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(second.json.txHash, "UNSTUCK");
  } finally { globalThis.fetch = realFetch; st.close(); }
});
