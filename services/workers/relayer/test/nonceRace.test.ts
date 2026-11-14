// RELAYFUND2 (1), Worker side: WorkerRelayChain must survive a lagging view_access_key (sequential), concurrent
// relays, and refetch+retry once on InvalidNonce.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkerRelayChain } from "../src/chain.js";
import { RELAYER_KEY, RELAYER_ID } from "./helpers.js";

function world(opts: { lag?: boolean; racerBumps?: number } = {}) {
  let racer = opts.racerBumps ?? 0;
  const st = { akNonce: 100n, viewNonce: 100n, sent: [] as bigint[], inFlight: 0, maxInFlight: 0, invalidNonceOnce: 0 };
  const rpc: any = {
    async sendJsonRpc(method: string, params: any) {
      if (method === "block") return { result: { header: { height: 1000, hash: "11111111111111111111111111111111" } } };
      if (method === "query") return { result: { nonce: Number(opts.lag ? st.viewNonce : st.akNonce), permission: "FullAccess" } };
      if (method === "send_tx") {
        st.inFlight++; st.maxInFlight = Math.max(st.maxInFlight, st.inFlight);
        try {
          await new Promise((r) => setTimeout(r, 5));
          const bytes = Uint8Array.from(atob(params.signed_tx_base64), (c) => c.charCodeAt(0));
          // nonce is the u64 right after signer id (4+len) + key type (1) + 32-byte key
          if (racer > 0) { racer--; st.akNonce += 50n; } // RELAY500: another writer on the shared relayer key lands a tx right before ours
          const off = 4 + RELAYER_ID.length + 1 + 32;
          const nonce = new DataView(bytes.buffer).getBigUint64(off, true);
          if (nonce <= st.akNonce) { st.viewNonce = st.akNonce; return { error: { data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { ak_nonce: Number(st.akNonce), tx_nonce: Number(nonce) } } } } } }; }
          st.akNonce = nonce; st.sent.push(nonce);
          return { result: { status: { SuccessValue: "" }, transaction: { hash: `TX${nonce}` }, transaction_outcome: { outcome: { tokens_burnt: "1" } }, receipts_outcome: [] } };
        } finally { st.inFlight--; }
      }
      throw new Error("unmocked " + method);
    },
  };
  const chain = new WorkerRelayChain({ rpc, accountId: RELAYER_ID, privateKey: RELAYER_KEY.toString(), maxSubrequests: 100 });
  const send = () => { const d: any = { senderId: "alice.testnet" }; chain.register({ delegateAction: d, signedBytes: new Uint8Array([1, 2, 3]) }); return chain.broadcastSignedDelegate(d, new Uint8Array(64)); };
  return { st, send };
}

test("worker: sequential relays with a lagging access-key view both succeed", async () => {
  const { st, send } = world({ lag: true });
  await send(); await send();
  assert.deepEqual(st.sent, [101n, 102n]);
});

test("worker: concurrent relays are serialized", async () => {
  const { st, send } = world();
  await Promise.all([send(), send(), send()]);
  assert.equal(st.maxInFlight, 1);
  assert.deepEqual(st.sent, [101n, 102n, 103n]);
});

test("worker: InvalidNonce (out-of-band bump, stale view) is refetched and retried once", async () => {
  const { st, send } = world({ lag: true });
  await send();
  st.akNonce += 50n; // other writer used the key; the (lagging) view only catches up after the first rejection
  const r = await send().catch((e) => e);
  assert.equal(r.transactionHash, `TX${st.akNonce}`);
});

test("worker: RELAY500 repeated out-of-band nonce bumps (shared relayer key contention) still relay within a bounded retry", async () => {
  const { st, send } = world({ lag: true, racerBumps: 2 });
  const r = await send().catch((e) => e);
  assert.equal(r.transactionHash, `TX${st.akNonce}`, String(r?.message ?? r));
});

test("worker: RELAY500 persistent InvalidNonce is bounded (gives up after 3 attempts, no infinite loop)", async () => {
  const { st, send } = world({ lag: true, racerBumps: 99 });
  const r = await send().catch((e) => e);
  assert.match(String(r?.message), /InvalidNonce/);
  assert.equal(st.sent.length, 0);
});
