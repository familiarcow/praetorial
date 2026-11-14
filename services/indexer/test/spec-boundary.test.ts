// SPEC: offchain services and surfaces spec v0 §3 Board
// indexer, "Onchain calls it makes" — "**None that write.** Only
// read-only RPC (`view` calls, event subscription). This is the one
// service with zero signing key at all." Also "Secrets it holds: None
// required (no user data, no private keys)."
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("indexer/src/server.ts never requires a private key (view-only client only)", () => {
  const text = fs.readFileSync(path.join(here, "../src/server.ts"), "utf8");
  // The one escape hatch (`privateKey: ""`) is the explicit "no key"
  // marker NearClient treats as view-only (see common/src/nearClient.ts).
  assert.ok(text.includes('privateKey: ""'), "indexer must construct its client with an empty private key");
  assert.ok(!text.includes("loadKeyFile"), "indexer must never load a key file from disk");
});

test("indexer/src/board.ts (the pure logic module) makes zero contract calls", () => {
  const text = fs.readFileSync(path.join(here, "../src/board.ts"), "utf8");
  assert.ok(!text.includes(".call("), "board.ts must never call a contract method");
  assert.ok(!text.includes(".callPayable("), "board.ts must never attach NEAR to a call");
});
