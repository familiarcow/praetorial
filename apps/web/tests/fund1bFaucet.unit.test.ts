// FUND1b (2): the web client for the testnet faucet endpoint. Plain results, never throws, never mainnet.
import test from "node:test";
import assert from "node:assert/strict";
import { requestTestNear } from "../lib/faucet";

const resp = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("ok: tx hash and amount", async () => {
  const calls: any[] = [];
  const f = (async (u: any, i: any) => { calls.push([String(u), JSON.parse(i.body)]); return new Response(JSON.stringify({ ok: true, txHash: "TX1", amountNear: "1" })); }) as unknown as typeof fetch;
  const r = await requestTestNear("alice.testnet", { fetchImpl: f, base: "https://r.example", network: "testnet" });
  assert.deepEqual(r, { ok: true, txHash: "TX1", amountNear: "1" });
  assert.deepEqual(calls, [["https://r.example/faucet", { account: "alice.testnet" }]]);
});
test("server refusal (429): the server's plain sentence is returned", async () => {
  const r = await requestTestNear("a.testnet", { fetchImpl: resp(429, { ok: false, error: "This account already got test NEAR today. Try again tomorrow." }), base: "https://r", network: "testnet" });
  assert.deepEqual(r, { ok: false, message: "This account already got test NEAR today. Try again tomorrow." });
});
test("network down / non-JSON: plain message, no throw", async () => {
  const boom = (async () => { throw new Error("x"); }) as unknown as typeof fetch;
  assert.equal((await requestTestNear("a.testnet", { fetchImpl: boom, base: "https://r", network: "testnet" })).ok, false);
  assert.equal((await requestTestNear("a.testnet", { fetchImpl: (async () => new Response("<html>", { status: 502 })) as any, base: "https://r", network: "testnet" })).ok, false);
});
test("mainnet: refused locally, no request is made", async () => {
  let n = 0; const f = (async () => { n++; return new Response("{}"); }) as unknown as typeof fetch;
  const r = await requestTestNear("a.near", { fetchImpl: f, base: "https://r", network: "mainnet" });
  assert.equal(r.ok, false); assert.equal(n, 0);
});
