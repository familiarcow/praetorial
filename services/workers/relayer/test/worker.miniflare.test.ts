// CF1b RED: the real bundle in workerd (miniflare), SQLite Durable Object persisted on disk across a full
// restart of the runtime, with every outbound fetch mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDelegate, rpcWorld } from "./helpers.js";
import { bundle, start, relay } from "./miniflareHelpers.js";

test("fetch() relays through the DO; replay is rejected after a full runtime restart; fresh storage control accepts", async () => {
  const script = await bundle(); const persist = fs.mkdtempSync(path.join(os.tmpdir(), "cf1b-do-"));
  const w = rpcWorld(); const b = buildDelegate({ senderId: "mf.testnet", nonce: 9n });
  let mf = start(script, w, persist);
  try {
    const ok = await relay(mf, b.base64);
    assert.equal(ok.status, 200, JSON.stringify(ok.json)); assert.equal(ok.json.txHash, "WORKERTXHASH");
    assert.equal((await relay(mf, b.base64)).status, 400);
  } finally { await mf.dispose(); }
  mf = start(script, w, persist);
  try {
    const again = await relay(mf, b.base64);
    assert.equal(again.status, 400); assert.match(again.json.error, /replay/);
    assert.equal(w.sent.length, 1);
    assert.equal((await mf.dispatchFetch("https://relayer.test/nope")).status, 404);
    const g: any = await (await mf.dispatchFetch("https://relayer.test/budget/global")).json();
    assert.equal(g.usedYocto, w.burnt);
  } finally { await mf.dispose(); }
  const w2 = rpcWorld(); const mf2 = start(script, w2, fs.mkdtempSync(path.join(os.tmpdir(), "cf1b-do-")));
  try { assert.equal((await relay(mf2, b.base64)).status, 200, "control: lost state would accept the replay"); } finally { await mf2.dispose(); }
});
