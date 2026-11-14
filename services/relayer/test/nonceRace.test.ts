// RELAYFUND2 (1): two back-to-back / concurrent relays through ONE NearClient must not collide on the relayer
// access-key nonce. The fake account mimics @near-js/accounts: it caches the access key (never bumping the
// cached nonce), signs nonce = cached+1, and the fake chain rejects tx_nonce <= ak_nonce with InvalidNonce
// (surfaced by the paced provider as a plain Error carrying the JSON, no .type).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chainPortFromClient } from "../src/relayer.js";

function fakeClient(opts: { startNonce?: bigint; externalBump?: () => void } = {}) {
  const st = { akNonce: opts.startNonce ?? 100n, sent: [] as bigint[], inFlight: 0, maxInFlight: 0, queries: 0 };
  const pk = "ed25519:FAKEKEY";
  const account: any = {
    accessKeyByPublicKeyCache: {} as Record<string, any>,
    connection: { signer: { getPublicKey: async () => ({ toString: () => pk }) }, provider: { block: async () => ({ header: { height: 1000, hash: "H" } }) } },
    async findAccessKey() {
      const c = account.accessKeyByPublicKeyCache[pk];
      if (c) return { publicKey: pk, accessKey: c };
      st.queries++;
      await new Promise((r) => setTimeout(r, 5));
      const accessKey = { nonce: st.akNonce };
      return { publicKey: pk, accessKey: (account.accessKeyByPublicKeyCache[pk] ??= accessKey) };
    },
    async signAndSendTransaction({ receiverId }: any) {
      const { accessKey } = await account.findAccessKey();
      const txNonce = accessKey.nonce + 1n;
      st.inFlight++; st.maxInFlight = Math.max(st.maxInFlight, st.inFlight);
      try {
        await new Promise((r) => setTimeout(r, 10));
        if (txNonce <= st.akNonce) {
          throw new Error(`NEAR RPC error (send_tx): {"data":{"TxExecutionError":{"InvalidTxError":{"InvalidNonce":{"ak_nonce":${st.akNonce},"tx_nonce":${txNonce}}}}}}`);
        }
        st.akNonce = txNonce; st.sent.push(txNonce);
        return { transaction: { hash: `TX${txNonce}` }, transaction_outcome: { outcome: { tokens_burnt: "1" } }, receipts_outcome: [] };
      } finally { st.inFlight--; }
    },
  };
  return { client: { account } as any, st, account };
}
const delegate: any = { senderId: "alice.testnet", receiverId: "wrap.testnet", actions: [], nonce: 1n, maxBlockHeight: 2000n, publicKey: {} };
const sig = new Uint8Array(64);

test("two sequential relays through one client both succeed with increasing nonces", async () => {
  const { client, st } = fakeClient();
  const port = chainPortFromClient(client);
  const a = await port.broadcastSignedDelegate(delegate, sig);
  const b = await port.broadcastSignedDelegate(delegate, sig);
  assert.equal(a.transactionHash, "TX101");
  assert.equal(b.transactionHash, "TX102");
  assert.deepEqual(st.sent, [101n, 102n]);
});

test("concurrent relays through one client are serialized and all succeed", async () => {
  const { client, st } = fakeClient();
  const port = chainPortFromClient(client);
  const res = await Promise.all([1, 2, 3].map(() => port.broadcastSignedDelegate(delegate, sig)));
  assert.equal(res.length, 3);
  assert.equal(st.maxInFlight, 1);
  assert.deepEqual(st.sent, [101n, 102n, 103n]);
});

test("an out-of-band bump of the key nonce (InvalidNonce) is refetched and retried once", async () => {
  const { client, st } = fakeClient();
  const port = chainPortFromClient(client);
  await port.broadcastSignedDelegate(delegate, sig);
  st.akNonce += 50n; // another process used the same key
  const r = await port.broadcastSignedDelegate(delegate, sig);
  assert.equal(r.transactionHash, `TX${st.akNonce}`);
});

test("a non-nonce failure is not retried", async () => {
  const { client, account } = fakeClient();
  let n = 0;
  account.signAndSendTransaction = async () => { n++; throw new Error("boom"); };
  await assert.rejects(chainPortFromClient(client).broadcastSignedDelegate(delegate, sig), /boom/);
  assert.equal(n, 1);
});
