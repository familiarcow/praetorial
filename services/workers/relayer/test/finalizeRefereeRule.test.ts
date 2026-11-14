// RLYFIN1 / RLYREF2: the Worker build uses the SAME allowlist as the node relayer (shared policy.ts) and relays finalize / referee_rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { actionCreators } from "@near-js/transactions";
import { ESCROW_DIRECT_METHODS } from "../../../relayer/src/policy.js";
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
const mk = (method: string, args: Record<string, unknown>, deposit = 0n) =>
  buildDelegate({ senderId: "ok.testnet", methodName: method, actions: [actionCreators.functionCall(method, args, 30_000_000_000_000n, deposit)] });

test("worker source takes its allowlist from the shared relayer policy, defines none of its own", () => {
  const dir = new URL("../src/", import.meta.url);
  for (const f of readdirSync(dir)) {
    assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), /ESCROW_DIRECT_METHODS\s*=|new Set\(\[\s*"cancel"/, f);
  }
  assert.ok(ESCROW_DIRECT_METHODS.has("finalize") && ESCROW_DIRECT_METHODS.has("referee_rule"));
});

test("worker: finalize and referee_rule with valid args and 0 deposit are relayed", async () => {
  for (const b of [mk("finalize", { bet_id: 3 }), mk("referee_rule", { bet_id: 3, outcome: "VOID" })]) {
    const r = await run(b);
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.sent, 1);
  }
});

test("worker: finalize / referee_rule refused (nothing broadcast) for deposit / bad args", async () => {
  const cases: [string, string, ReturnType<typeof mk>][] = [
    ["finalize", "extra", mk("finalize", { bet_id: 3, x: 1 })],
    ["finalize", "deposit", mk("finalize", { bet_id: 3 }, 1n)],
    ["finalize", "string id", mk("finalize", { bet_id: "3" })],
    ["referee_rule", "MAYBE", mk("referee_rule", { bet_id: 3, outcome: "MAYBE" })],
    ["referee_rule", "lowercase", mk("referee_rule", { bet_id: 3, outcome: "yes" })],
    ["referee_rule", "deposit", mk("referee_rule", { bet_id: 3, outcome: "YES" }, 1n)],
    ["referee_rule", "missing outcome", mk("referee_rule", { bet_id: 3 })],
  ];
  for (const [m, name, b] of cases) {
    const r = await run(b);
    assert.ok(r.status >= 400 && r.status < 500, `${name}: status ${r.status}`);
    assert.equal(r.sent, 0, name);
    assert.match(String(r.json.error), new RegExp(m), name);
  }
});
