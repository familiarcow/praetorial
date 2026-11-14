// PUB1 (HK1 item 0): the live-DR harness must run from ANY checkout. DR1/DR5/DR6 chain.ts once resolved near-api-js
// through a hardcoded absolute path to the author's checkout, so on every other machine (HK1's clean container)
// `services npm test` was red (Cannot find module 'near-api-js', requireStack: ['/Users/<author>/...']).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIVE_DR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVICES = path.resolve(LIVE_DR, "../..");

// MISS1: also .mjs (DR9's drill scripts are plain Node modules) and .py helpers, not only .ts.
function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "node_modules") return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? tsFiles(p) : /\.(ts|mjs|py)$/.test(p) ? [p] : [];
  });
}

test("no live-DR source file hardcodes an absolute home-directory path (/Users/<name>/ or /home/<name>/)", () => {
  const files = tsFiles(LIVE_DR);
  assert.ok(files.length > 10, `found ${files.length} .ts files under ${LIVE_DR}`);
  const self = fileURLToPath(import.meta.url);
  const bad = files.filter((f) => f !== self).flatMap((f) =>
    fs.readFileSync(f, "utf8").split("\n").flatMap((l, i) => (/["'`]\/(?:Users|home)\/[^/"'`\s]+\//.test(l) ? [`${path.relative(LIVE_DR, f)}:${i + 1}`] : [])));
  assert.deepEqual(bad, []);
});

// MISS1: every scenario dir with a chain.ts (DR1, DR5, DR6 and any salvaged later), not a hand-kept list.
const CHAIN_DIRS = fs.readdirSync(LIVE_DR).filter((d) => /^DR\d+$/.test(d) && fs.existsSync(path.join(LIVE_DR, d, "chain.ts"))).sort();
test("the chain.ts list covers at least DR1, DR5 and DR6", () => {
  for (const d of ["DR1", "DR5", "DR6"]) assert.ok(CHAIN_DIRS.includes(d), `${d} missing from ${CHAIN_DIRS}`);
});

for (const dr of CHAIN_DIRS) {
  test(`${dr}/chain.ts resolves near-api-js from THIS checkout's services/ (repo-relative, Playwright-loader-safe)`, async () => {
    const m = await import(`../../${dr}/chain.js`);
    assert.equal(m.SERVICES_PACKAGE_JSON, path.join(SERVICES, "package.json"));
    assert.equal(fs.existsSync(m.SERVICES_PACKAGE_JSON), true);
    assert.equal(typeof m.acct, "function");
  });
}
