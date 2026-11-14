// V1: GET /bet/txs?bet_id=N[&contract_id=] serves every on-chain action of one bet (tx hash, signer, who acted, exact amounts),
// indexed from the escrow's public tx history in the governance tick (common/src/betTxIndex.ts). Real testnet receipts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handle } from "../src/index.js";
import { fakeD1, world, outboundFetch, baseEnv, type World } from "./helpers.js";

const fx = JSON.parse(readFileSync(new URL("../../../common/test/fixtures/betTxs.testnet.json", import.meta.url), "utf8")) as { escrow: string; hist: { hash: string; rc: any }[] };
const E = fx.escrow;
const clock = { ms: 1_800_000_000_000 };
const get = async (env: any, p: string) => { const r = await handle(new Request(`https://indexer.test${p}`), env, () => clock.ms); return { status: r.status, json: JSON.parse(await r.text()) as any }; };
const tick = async (env: any) => { clock.ms += 600_000; const r = await handle(new Request("https://indexer.test/tick/governance", { method: "POST" }), env, () => clock.ms); return { status: r.status, json: (await r.json()) as any }; };
async function withFetch<T>(w: World, fn: () => Promise<T>): Promise<T> { const real = globalThis.fetch; globalThis.fetch = outboundFetch(w) as any; try { return await fn(); } finally { globalThis.fetch = real; } }

function setup() {
  const w = world({ [E]: {} });
  w.history[E] = fx.hist.map((h) => ({ hash: h.hash, rc: h.rc }));
  const f = fakeD1();
  return { w, f, env: baseEnv(f.d1, { ESCROW_CONTRACT_ID: E }) };
}

test("/bet/txs serves one bet's actions after the governance tick: hashes, signer, actor, amounts, signed ruling", async () => {
  const { w, f, env } = setup();
  const r = await withFetch(w, () => tick(env));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.updated, [E]);
  const txs = (await get(env, "/bet/txs?bet_id=49")).json as any[];
  assert.ok(txs.length > 5);
  assert.ok(txs.every((t) => t.bet_id === 49));
  const ruling = txs.find((t) => t.hash === "AXvXrG32NxybxRhrxCWBBVCipWG99PhvDsN8t5WqvJ7m");
  assert.equal(ruling.kind, "ruling");
  assert.match(ruling.signed.signature_hex, /^922ee56f/);
  const fin = txs.find((t) => t.hash === "3hJouvbQA5vQQGxX1FazaNUgRmxS3CbyGpv63CXJynaK");
  assert.ok(fin.moved_out.some((m: any) => m.amount === "44000000"));
  assert.deepEqual((await get(env, `/bet/txs?bet_id=49&contract_id=${E}`)).json, txs);
  f.close();
});

test("/bet/txs: unknown bet -> [], other contract -> [], bad id -> 400; a failing history fetch keeps the last index", async () => {
  const { w, f, env } = setup();
  await withFetch(w, () => tick(env));
  assert.deepEqual((await get(env, "/bet/txs?bet_id=12345")).json, []);
  assert.deepEqual((await get(env, "/bet/txs?bet_id=49&contract_id=other.testnet")).json, []);
  assert.equal((await get(env, "/bet/txs?bet_id=abc")).status, 400);
  assert.equal((await get(env, "/bet/txs")).status, 400);
  const before = (await get(env, "/bet/txs?bet_id=44")).json;
  assert.ok(before.length > 0);
  w.historyDown = true;
  await withFetch(w, () => tick(env));
  assert.deepEqual((await get(env, "/bet/txs?bet_id=44")).json, before);
  f.close();
});
