// FUND2 RED: POST /activate on the relayer Worker creates a deposit-only user's implicit account (see relayer/test/activation.test.ts
// for the gate). The outer tx is a relayer-signed Transfer to the implicit id, byte-identical to near-api-js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { actionCreators, createTransaction, encodeTransaction, SignedTransaction, Signature } from "@near-js/transactions";
import { RelayerDO } from "../src/index.js";
import { DEFAULT_ACTIVATION_YOCTO } from "../../../relayer/src/activation.js";
import { fakeDoStorage, outboundFetch, rpcWorld, workerBindings, RELAYER_ID, RELAYER_KEY, BLOCK_HASH } from "./helpers.js";

const ID = "12c24877c6fa5fb58eea8400bde5f9d7b0f74787536c34f619ba840b081b21ab";
const STAKE = { STAKE_ASSET_IDS: "nep141:usdc.testnet,nep141:wrap.testnet" };
const realFetch = globalThis.fetch;
async function call(extra: Record<string, string>, w: ReturnType<typeof rpcWorld>, body: unknown) {
  const st = fakeDoStorage();
  const d = new RelayerDO(st.ctx as any, workerBindings({ ...STAKE, ...extra }) as any);
  globalThis.fetch = outboundFetch(w) as any;
  try {
    const r = await d.fetch(new Request("https://relayer.do/activate", { method: "POST", body: JSON.stringify(body) }));
    return { status: r.status, json: await r.json() as any };
  } finally { globalThis.fetch = realFetch; st.close(); }
}

test("unfunded implicit id holding USDC on intents: 200 activated, one relayer Transfer of the activation amount to the id", async () => {
  const w = rpcWorld(); w.missing = new Set([ID]); w.mt = new Map([[`${ID}|nep141:usdc.testnet`, "20000000"]]);
  const r = await call({}, w, { accountId: ID });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { ok: true, activated: true, txHash: "WORKERTXHASH" });
  assert.equal(w.sent.length, 1);
  const tx = createTransaction(RELAYER_ID, RELAYER_KEY.getPublicKey() as any, ID, BigInt(w.nonce), [actionCreators.transfer(DEFAULT_ACTIVATION_YOCTO)], bs58.decode(BLOCK_HASH));
  const hash = createHash("sha256").update(encodeTransaction(tx)).digest();
  const expected = encodeTransaction(new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: 0, data: RELAYER_KEY.sign(hash).signature }) }));
  assert.equal(w.sent[0], Buffer.from(expected).toString("base64"));
});

test("RELAYER_ACTIVATION_YOCTO overrides the amount; already-existing account -> 200 activated:false, nothing sent", async () => {
  const w = rpcWorld(); w.missing = new Set([ID]); w.mt = new Map([[`${ID}|nep141:wrap.testnet`, "1"]]);
  assert.equal((await call({ RELAYER_ACTIVATION_YOCTO: "1900000000000000000000" }, w, { accountId: ID })).json.activated, true);
  const w2 = rpcWorld(); w2.mt = new Map([[`${ID}|nep141:usdc.testnet`, "1"]]);
  const r2 = await call({}, w2, { accountId: ID });
  assert.deepEqual(r2.json, { ok: true, activated: false, txHash: null });
  assert.equal(w2.sent.length, 0);
});

test("no betting balance -> 400 with the plain reason; bad body -> 400; switched off -> 400", async () => {
  const w = rpcWorld(); w.missing = new Set([ID]);
  const r = await call({}, w, { accountId: ID });
  assert.equal(r.status, 400); assert.match(r.json.error, /no betting balance/); assert.equal(w.sent.length, 0);
  assert.equal((await call({}, rpcWorld(), { nope: 1 })).status, 400);
  const w3 = rpcWorld(); w3.missing = new Set([ID]); w3.mt = new Map([[`${ID}|nep141:usdc.testnet`, "5"]]);
  const off = await call({ RELAYER_ACTIVATION_YOCTO: "0" }, w3, { accountId: ID });
  assert.equal(off.status, 400); assert.match(off.json.error, /off/); assert.equal(w3.sent.length, 0);
});

test("SEC1/MON-9: a balance below the escrow's min stake (asset_limit) -> 400, nothing sent", async () => {
  const w = rpcWorld(); w.missing = new Set([ID]); w.mt = new Map([[`${ID}|nep141:usdc.testnet`, "4999999"]]); w.minStake = new Map([["nep141:usdc.testnet", "5000000"]]);
  const r = await call({}, w, { accountId: ID });
  assert.equal(r.status, 400); assert.match(r.json.error, /minimum stake/); assert.equal(w.sent.length, 0);
  const w2 = rpcWorld(); w2.missing = new Set([ID]); w2.mt = new Map([[`${ID}|nep141:usdc.testnet`, "5000000"]]); w2.minStake = new Map([["nep141:usdc.testnet", "5000000"]]);
  assert.equal((await call({}, w2, { accountId: ID })).json.activated, true);
});
