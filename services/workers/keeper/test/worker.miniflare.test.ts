// CF1a RED: the real bundle running in workerd (miniflare) with every outbound fetch mocked.
// Covers: scheduled() end-to-end incl. WebCrypto signing, DO (SQLite) state surviving a
// restart, Telegram heartbeat via fetch; the wall-time budget lives in test-budget/worker.miniflare.budget.test.ts (./test.sh full).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundle, expiredOpenBet, mockWorld, startMf } from "./miniflareHelpers.js";

test("scheduled() signs with WebCrypto and sends an expire tx; heartbeat goes to Telegram", async () => {
  const w = mockWorld(); w.bets[1] = expiredOpenBet();
  const mf = await startMf(await bundle(), w, fs.mkdtempSync(path.join(os.tmpdir(), "cf1a-do-")));
  try {
    await ((await mf.getWorker()) as any).scheduled({ cron: "* * * * *" });
    assert.equal(w.txs.length, 1, "one signed tx");
    assert.ok(w.txs[0].sig);
    assert.ok(w.telegram.some((t) => /keeper heartbeat/.test(t)), w.telegram.join("|"));
  } finally { await mf.dispose(); }
});

test("Durable Object state survives a restart: rate limit blocks a repeat after reboot", async () => {
  const persist = fs.mkdtempSync(path.join(os.tmpdir(), "cf1a-do-"));
  const script = await bundle();
  const w = mockWorld(); w.bets[1] = expiredOpenBet();
  let mf = await startMf(script, w, persist);
  await ((await mf.getWorker()) as any).scheduled({ cron: "* * * * *" });
  await mf.dispose();
  assert.equal(w.txs.length, 1);
  mf = await startMf(script, w, persist);
  try {
    await ((await mf.getWorker()) as any).scheduled({ cron: "* * * * *" });
    assert.equal(w.txs.length, 1, "restart must not re-fire the action inside the 30 s window");
  } finally { await mf.dispose(); }
  // control: a fresh persist dir (state lost) WOULD re-fire
  const w2 = mockWorld(); w2.bets[1] = expiredOpenBet();
  const mf2 = await startMf(script, w2, fs.mkdtempSync(path.join(os.tmpdir(), "cf1a-do-")));
  try { await ((await mf2.getWorker()) as any).scheduled({ cron: "* * * * *" }); assert.equal(w2.txs.length, 1); } finally { await mf2.dispose(); }
});

test("a missing KEEPER_PRIVATE_KEY fails loudly, never silently no-ops", async () => {
  const w = mockWorld();
  const mf = await startMf(await bundle(), w, fs.mkdtempSync(path.join(os.tmpdir(), "cf1a-do-")), { KEEPER_PRIVATE_KEY: "" });
  try {
    const r: any = await ((await mf.getWorker()) as any).scheduled({ cron: "* * * * *" });
    assert.notEqual(r.outcome, "ok", "scheduled() must report failure");
    const ns: any = await mf.getDurableObjectNamespace("KEEPER");
    const res = await ns.get(ns.idFromName("keeper")).fetch("https://x/tick", { method: "POST" });
    assert.equal(res.status, 500);
    assert.match(await res.text(), /KEEPER_PRIVATE_KEY/);
    assert.equal(w.rpcCalls, 0);
  } finally { await mf.dispose(); }
});
