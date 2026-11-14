// CF1b RED: the relayer's periodic work (heartbeat) hangs off the shared dispatcher via a service binding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { relayerHeartbeatJob } from "../src/job.js";
import { RelayerDO } from "../src/index.js";
import { runDispatcher } from "../../common/src/dispatcher.js";
import { fakeDoStorage, outboundFetch, rpcWorld, workerBindings, buildDelegate } from "./helpers.js";

test("job calls the RELAYER_SERVICE binding; absent binding is a clean no-op; failure propagates", async () => {
  const seen: string[] = [];
  const env = { RELAYER_SERVICE: { fetch: async (u: any, i: any) => { seen.push(`${i?.method} ${new URL(typeof u === "string" ? u : u.url).pathname}`); return new Response("{}"); } } };
  await relayerHeartbeatJob.run(env as any, Date.now());
  assert.deepEqual(seen, ["POST /heartbeat"]);
  await relayerHeartbeatJob.run({} as any, Date.now());
  const bad = { RELAYER_SERVICE: { fetch: async () => new Response("{}", { status: 500 }) } };
  await assert.rejects(relayerHeartbeatJob.run(bad as any, Date.now()), /relayer heartbeat/);
  const ran = await runDispatcher([relayerHeartbeatJob as any], env, 5 * 60_000);
  assert.deepEqual(ran, ["relayer-heartbeat"]);
});

test("DO /heartbeat sends one Telegram heartbeat per interval (persisted), never throws on missing telegram", async () => {
  const real = globalThis.fetch; const w = rpcWorld(); globalThis.fetch = outboundFetch(w) as any;
  try {
    const st = fakeDoStorage();
    const mk = (extra = {}) => new RelayerDO(st.ctx as any, workerBindings({ TELEGRAM_BOT_TOKEN: "123456:TESTTOKENTESTTOKENTESTTOKENTESTTOK", RELAYER_ALERT_TELEGRAM_CHAT_ID: "42", RELAYER_HEARTBEAT_INTERVAL_MS: "900000", ...extra }) as any);
    const hb = (d: RelayerDO) => d.fetch(new Request("https://x/heartbeat", { method: "POST" }));
    assert.equal((await hb(mk())).status, 200);
    assert.equal(w.telegram.length, 1); assert.match(w.telegram[0], /relayer heartbeat ok/);
    assert.equal((await hb(mk())).status, 200); // a "restarted" instance on the same storage
    assert.equal(w.telegram.length, 1, "interval persisted across instances");
    const st2 = fakeDoStorage();
    const r = await new RelayerDO(st2.ctx as any, workerBindings() as any).fetch(new Request("https://x/heartbeat", { method: "POST" }));
    assert.equal(r.status, 200);
    void buildDelegate;
  } finally { globalThis.fetch = real; }
});
