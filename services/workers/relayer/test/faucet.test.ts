// FUND1b (2) RED: POST /faucet on the testnet relayer Worker. Testnet only, capped, rate-limited per account + IP + global,
// key stays in the Worker (the relayer account's existing secret). Mocked RPC; no real chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RelayerDO } from "../src/index.js";
import { fakeDoStorage, outboundFetch, rpcWorld, workerBindings, type Rpc } from "./helpers.js";

const realFetch = globalThis.fetch;
const IMPLICIT = "ab".repeat(32);
function mk(extra: Record<string, string> = {}) {
  const st = fakeDoStorage();
  return new RelayerDO(st.ctx as any, workerBindings(extra) as any);
}
async function faucet(d: RelayerDO, w: Rpc, account: unknown, ip = "1.2.3.4", method = "POST") {
  globalThis.fetch = outboundFetch(w) as any;
  try {
    const r = await d.fetch(new Request("https://relayer.do/faucet", { method, headers: { "x-client-ip": ip }, body: method === "POST" ? JSON.stringify({ account }) : undefined }));
    return { status: r.status, json: await r.json() as any };
  } finally { globalThis.fetch = realFetch; }
}
const sentTransfer = (w: Rpc) => w.sent.length;

test("testnet: funds a .testnet account with the capped amount (1 NEAR) and returns the tx hash", async () => {
  const w = rpcWorld(); const d = mk();
  const r = await faucet(d, w, "alice.testnet");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.txHash, "WORKERTXHASH");
  assert.equal(r.json.amountNear, "1");
  assert.equal(sentTransfer(w), 1);
});

test("a 64-hex implicit testnet account (every Privy user) is accepted", async () => {
  const r = await faucet(mk(), rpcWorld(), IMPLICIT);
  assert.equal(r.status, 200);
});

test("refuses anything that is not a testnet account: .near, mainnet-looking, malformed, missing", async () => {
  for (const a of ["bob.near", "alice.testnet.evil", "UPPER.testnet", "", "x", undefined, 5, "a b.testnet"]) {
    const w = rpcWorld(); const r = await faucet(mk(), w, a);
    assert.equal(r.status, 400, String(a)); assert.equal(sentTransfer(w), 0);
  }
});

test("mainnet Worker: 404, nothing sent, even for a .testnet account", async () => {
  const w = rpcWorld(); const r = await faucet(mk({ NEAR_NETWORK_ID: "mainnet" }), w, "alice.testnet");
  assert.equal(r.status, 404); assert.equal(sentTransfer(w), 0);
});

test("only POST", async () => {
  const r = await faucet(mk(), rpcWorld(), "alice.testnet", "1.2.3.4", "GET");
  assert.equal(r.status, 404);
});

test("rate limit: one grant per account per day (429 with a plain reason), a different account is fine", async () => {
  const w = rpcWorld(); const d = mk({ FAUCET_PER_IP_PER_DAY: "10" });
  assert.equal((await faucet(d, w, "alice.testnet")).status, 200);
  const again = await faucet(d, w, "alice.testnet", "9.9.9.9");
  assert.equal(again.status, 429); assert.match(again.json.error, /already got test NEAR today/);
  assert.equal((await faucet(d, w, "carol.testnet", "9.9.9.9")).status, 200);
  assert.equal(sentTransfer(w), 2);
});

test("rate limit: per IP (default 3 a day), different accounts", async () => {
  const w = rpcWorld(); const d = mk();
  for (const n of ["a1", "a2", "a3"]) assert.equal((await faucet(d, w, `${n}.testnet`, "5.5.5.5")).status, 200);
  const r = await faucet(d, w, "a4.testnet", "5.5.5.5");
  assert.equal(r.status, 429); assert.equal(sentTransfer(w), 3);
  assert.equal((await faucet(d, w, "a4.testnet", "6.6.6.6")).status, 200);
});

test("global daily cap stops a spoofed-IP flood", async () => {
  const w = rpcWorld(); const d = mk({ FAUCET_GLOBAL_PER_DAY: "2" });
  assert.equal((await faucet(d, w, "g1.testnet", "1.1.1.1")).status, 200);
  assert.equal((await faucet(d, w, "g2.testnet", "2.2.2.2")).status, 200);
  assert.equal((await faucet(d, w, "g3.testnet", "3.3.3.3")).status, 429);
});

test("the amount is capped: a configured amount above 1 NEAR is clamped; the body can't choose the amount", async () => {
  const w = rpcWorld(); const d = mk({ FAUCET_AMOUNT_YOCTO: "50000000000000000000000000" });
  const r = await faucet(d, w, "alice.testnet");
  assert.equal(r.status, 200); assert.equal(r.json.amountNear, "1");
});

test("a failed send is not counted against the user's day and never leaks a key", async () => {
  const w = rpcWorld(); w.sendTx = () => ({ error: { name: "HANDLER_ERROR" } }); const d = mk();
  const bad = await faucet(d, w, "alice.testnet");
  assert.equal(bad.status, 502); assert.doesNotMatch(JSON.stringify(bad.json), /ed25519:/);
  w.sendTx = undefined;
  assert.equal((await faucet(d, w, "alice.testnet")).status, 200);
});
