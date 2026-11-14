// RELAY500: the 500 catch-all must log the underlying error class + message (redacted) so the next failure is diagnosable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeInternal } from "../src/httpMap.js";

test("describeInternal: class and message, URLs and long keys redacted, bounded", () => {
  class RpcBoom extends Error {}
  const key = "ed25519:" + "1".repeat(64);
  const s = describeInternal(new RpcBoom(`fetch https://rpc.example/?api_key=SECRET failed ${key} ${"x".repeat(1000)}`));
  assert.match(s, /^RpcBoom: fetch <url> failed <key>/);
  assert.ok(!s.includes("SECRET") && !s.includes(key));
  assert.ok(s.length <= 330);
});

test("describeInternal: non-Error throwables don't crash", () => {
  assert.equal(describeInternal("plain"), "Error: plain");
  assert.equal(describeInternal(undefined), "Error: ");
});
