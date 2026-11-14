// DR6FIX1 (PREMAIN1): every live-DR scenario loads the web's testnet config through ONE shared helper, and that helper
// resolves under the Playwright loader path. Playwright's loader does not remap a dynamic `file://.../network.js` URL to
// the .ts source (tsx does, which is why `node --import tsx` unit runs hid the bug DR5 found live); the strict importer
// below behaves like Playwright: it only imports a file that exists on disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const strictImporter = async (url: string): Promise<unknown> => {
  if (!fs.existsSync(fileURLToPath(url))) throw new Error(`Cannot find module '${url}' (strict loader: no .js -> .ts remap)`);
  return import(url);
};

test("harness loadWebTestnetConfig resolves under a strict (Playwright-like) loader: only existing files are imported", async () => {
  const { loadWebTestnetConfig } = await import("../webConfig.js");
  const seen: string[] = [];
  const cfg = await loadWebTestnetConfig(async (u: string) => { seen.push(u); return strictImporter(u); });
  assert.ok(seen.length >= 2, `imported ${JSON.stringify(seen)}`);
  for (const u of seen) assert.ok(fs.existsSync(fileURLToPath(u)), u);
  assert.match(cfg.escrow, /\.testnet$/);
  assert.match(cfg.intents, /\.testnet$/);
  assert.equal(cfg.stakeToken, "nep141:wrap.testnet");
  assert.ok(cfg.usdcTokenId.length > 0);
});

test("DR1, DR5 and DR6 use the shared harness loader (no per-scenario copy that can drift back to .js specifiers)", async () => {
  const shared = (await import("../webConfig.js")).loadWebTestnetConfig;
  // MISS1: every scenario dir that has a webConfig.ts (DR1, DR5, DR6 and any salvaged later), not a hand-kept list.
  const liveDr = fileURLToPath(new URL("../..", import.meta.url));
  const dirs = fs.readdirSync(liveDr).filter((d: string) => /^DR\d+$/.test(d) && fs.existsSync(`${liveDr}/${d}/webConfig.ts`)).sort();
  for (const d of ["DR1", "DR5", "DR6"]) assert.ok(dirs.includes(d), `${d} missing from ${dirs}`);
  for (const dr of dirs) {
    const m = await import(`../../${dr}/webConfig.js`);
    assert.equal(m.loadWebTestnetConfig, shared, `${dr}/webConfig.ts must re-export harness/webConfig.ts`);
  }
});
