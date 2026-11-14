// STACK1 RED: keeper GET /health through the real bundle in workerd: last_tick_at null before the first scheduled() run, then the run time;
// plus the private monitor/notifier Workers' /health proxied read-only through the keeper's existing service bindings.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import worker from "../src/index.js";
import { bundle, expiredOpenBet, mockWorld, startMf, KEY } from "./miniflareHelpers.js";
import { assertHealth } from "../../common/test/healthAssert.js";

const TOKEN = "123456:TESTTOKENTESTTOKENTESTTOKENTESTTOK";

test("keeper /health in workerd: last_tick_at null before first scheduled(), the run time after; no key/token leak", async () => {
  const w = mockWorld(); w.bets[1] = expiredOpenBet();
  const mf = await startMf(await bundle(), w, fs.mkdtempSync(path.join(os.tmpdir(), "stack1-do-")), { GIT_SHA: "eee5555" });
  const exp = (tick: null | number) => ({ service: "keeper", network: "testnet", escrow: "escrow.testnet", sha: "eee5555", secrets: [TOKEN, KEY], tick });
  try {
    await assertHealth(await mf.dispatchFetch("https://keeper.test/health") as any, exp(null));
    const before = Date.now();
    await ((await mf.getWorker()) as any).scheduled({ cron: "* * * * *" });
    const after = Date.now();
    const b: any = await (await mf.dispatchFetch("https://keeper.test/health")).json();
    const t = Date.parse(b.last_tick_at);
    assert.ok(t >= before - 1000 && t <= after + 1000, `last_tick_at ${b.last_tick_at} not within the scheduled() window`);
    await assertHealth(await mf.dispatchFetch("https://keeper.test/health") as any, exp(t));
  } finally { await mf.dispose(); }
});

test("keeper proxies GET /health/monitor and /health/notifier to the private Workers' service bindings (read-only, health only)", async () => {
  const seen: string[] = [];
  const svc = (name: string) => ({ async fetch(u: string, i?: any) { seen.push(`${name} ${i?.method ?? "GET"} ${new URL(u).pathname}`); return Response.json({ ok: true, service: name }); } });
  const env: any = { MONITOR_SERVICE: svc("monitor"), NOTIFIER_SERVICE: svc("notifier") };
  const m: any = await (await worker.fetch(new Request("https://keeper.test/health/monitor"), env)).json();
  const n: any = await (await worker.fetch(new Request("https://keeper.test/health/notifier"), env)).json();
  assert.equal(m.service, "monitor"); assert.equal(n.service, "notifier");
  assert.deepEqual(seen, ["monitor GET /health", "notifier GET /health"]);
  for (const [method, p] of [["POST", "/health/monitor"], ["GET", "/health/other"], ["GET", "/tick"]] as const) {
    const r = await worker.fetch(new Request("https://keeper.test" + p, { method }), env);
    assert.equal(r.status, 404, `${method} ${p}`);
  }
  assert.equal(seen.length, 2, "no other service call was made");
});
