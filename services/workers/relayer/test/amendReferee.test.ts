// RELAYREF1 / D-FE10B1: the Workers relayer (shared policy) relays amend_referee identically to the node relayer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { actionCreators } from "@near-js/transactions";
import { RelayerDO } from "../src/index.js";
import { buildDelegate, fakeDoStorage, outboundFetch, rpcWorld, workerBindings } from "./helpers.js";

const realFetch = globalThis.fetch;
async function run(b: ReturnType<typeof buildDelegate>) {
  const w = rpcWorld(4000); w.indexerBettors.add("ok.testnet");
  const st = fakeDoStorage(":memory:");
  const d = new RelayerDO(st.ctx as any, workerBindings({}) as any);
  globalThis.fetch = outboundFetch(w) as any;
  try {
    const r = await d.fetch(new Request("https://relayer.do/relay", { method: "POST", body: JSON.stringify({ signedDelegate: b.base64 }) }));
    return { status: r.status, json: await r.json() as any, sent: w.sent.length };
  } finally { globalThis.fetch = realFetch; st.close(); }
}
const mk = (args: Record<string, unknown>, deposit = 0n) =>
  buildDelegate({ senderId: "ok.testnet", methodName: "amend_referee", actions: [actionCreators.functionCall("amend_referee", args, 30_000_000_000_000n, deposit)] });
const good = { bet_id: 3, new_referee_json: '{"kind":"mutual"}' };

test("worker: amend_referee with exact args and 0 deposit is relayed", async () => {
  const r = await run(mk(good));
  assert.equal(r.status, 200); assert.equal(r.sent, 1);
});

test("worker: amend_referee refused (non-2xx, nothing broadcast) for deposit / bad args", async () => {
  const cases: [string, ReturnType<typeof mk>][] = [
    ["deposit", mk(good, 1n)],
    ["extra key", mk({ ...good, x: 1 })],
    ["missing key", mk({ bet_id: 3 })],
    ["bet_id string", mk({ ...good, bet_id: "3" })],
    ["bet_id negative", mk({ ...good, bet_id: -1 })],
    ["json not string", mk({ bet_id: 3, new_referee_json: { a: 1 } })],
    ["json invalid", mk({ bet_id: 3, new_referee_json: "{bad" })],
    ["json array", mk({ bet_id: 3, new_referee_json: "[]" })],
    ["json too long", mk({ bet_id: 3, new_referee_json: JSON.stringify({ p: "x".repeat(4100) }) })],
  ];
  for (const [name, b] of cases) {
    const r = await run(b);
    assert.ok(r.status >= 400 && r.status < 500, `${name}: status ${r.status}`);
    assert.equal(r.sent, 0, name);
    assert.match(String(r.json.error), /amend_referee/, name);
  }
});
