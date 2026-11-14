// WKMAIN1b: checkMainnetReady() is the deploy-day check (scripts/check-mainnet-ready.mjs). Its findings today are exactly
// the two known deploy-day D1 placeholders; any other problem is a finding too.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkMainnetReady, MAINNET_WORKERS } from "../src/mainnetReady.js";

const WORKERS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const real = (): Record<string, string> => Object.fromEntries(MAINNET_WORKERS.map((n) => [n, fs.readFileSync(path.join(WORKERS, n, "wrangler.toml"), "utf8")]));
const UUID = "0123abcd-0123-4abc-8abc-0123456789ab";
const fixed = (): Record<string, string> => Object.fromEntries(Object.entries(real()).map(([n, t]) => [n, t.replace(/DEPLOY_DAY_[A-Z0-9_]+/g, UUID)]));

test("MAINNET_WORKERS is the eight Workers (F1 adds funding)", () => {
  assert.deepEqual([...MAINNET_WORKERS].sort(), ["funding", "indexer", "keeper", "monitor", "notifier", "registry", "relayer", "sourcecheck"]);
});
test("today's findings are none (MAINPREP1 filled the two D1 ids; a DEPLOY_DAY_ placeholder is still a finding)", () => {
  assert.deepEqual(checkMainnetReady(real()), []);
  const t = real(); t.indexer = t.indexer.replace(/(\[env\.mainnet[\s\S]*?^database_id = ")[^"]*"/m, '$1DEPLOY_DAY_INDEXER_D1_ID"');
  assert.ok(checkMainnetReady(t).includes("indexer: DEPLOY_DAY_INDEXER_D1_ID placeholder remains"));
});
test("no findings once the placeholders are replaced by real uuids", () => {
  assert.deepEqual(checkMainnetReady(fixed()), []);
});
test("a 'testnet' string in a mainnet section is a finding", () => {
  const t = fixed();
  t.keeper = t.keeper.replace(/^(\[env\.mainnet\]\n)/m, '$1# x\nNEAR_RPC_URL = "https://rpc.testnet.near.org"\n');
  assert.ok(checkMainnetReady(t).some((f) => f.startsWith("keeper:") && /testnet/.test(f)));
});
test("a missing [env.mainnet] is a finding", () => {
  const t = fixed();
  t.relayer = t.relayer.split("\n").filter((l) => !/^\s*\[\[?env\.mainnet/.test(l)).join("\n").replace(/^name = .*$/m, "name = \"x\"");
  t.relayer = t.relayer.slice(0, t.relayer.search(/env\.mainnet/) >= 0 ? t.relayer.search(/env\.mainnet/) : undefined);
  assert.ok(checkMainnetReady(t).some((f) => f.startsWith("relayer:") && /\[env\.mainnet\]/.test(f)));
});
test("REPLACE_ in the mainnet section, key material, and a non-uuid D1 id are findings", () => {
  const a = fixed(); a.monitor += '\n[env.mainnet.vars]\nX = "REPLACE_ME"\n';
  assert.ok(checkMainnetReady(a).some((f) => f.startsWith("monitor:") && /REPLACE_/.test(f)));
  const b = fixed(); b.indexer = b.indexer.replace(/(\[env\.mainnet[\s\S]*?^database_id = ")[^"]*"/m, '$1not-a-uuid"');
  assert.ok(checkMainnetReady(b).some((f) => f.startsWith("indexer:") && /database_id/.test(f)));
  const c = fixed(); c.notifier += "\n[env.mainnet.vars]\nK = \"ed25519:" + "1".repeat(50) + "\"\n";
  assert.ok(checkMainnetReady(c).some((f) => f.startsWith("notifier:") && /key|token/i.test(f)));
});
