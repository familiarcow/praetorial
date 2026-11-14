// DR0 part 4: the Playwright LIVE config is separate from apps/web's mock config, has tracing/video/screenshots off,
// never reads/logs an OTP or env value, defines maker/taker/referee contexts, taker+referee via window.__e2eTestWallet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import liveConfig from "../playwright.live.config.js";
import { CONTEXTS, testWalletInitScript, SEAM } from "../liveContexts.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..", "..", "..");
const read = (...p: string[]) => readFileSync(join(REPO, ...p), "utf8");
const CFG_SRC = readFileSync(join(here, "..", "playwright.live.config.ts"), "utf8");
const CTX_SRC = readFileSync(join(here, "..", "liveContexts.ts"), "utf8");

test("live config: tracing, video and screenshots are off; headless; serial", () => {
  const use = (liveConfig as any).use;
  assert.equal(use.trace, "off"); assert.equal(use.video, "off"); assert.equal(use.screenshot, "off"); assert.equal(use.headless, true);
  assert.equal((liveConfig as any).workers, 1);
  assert.notEqual((liveConfig as any).reporter?.[0]?.[0], "html", "html reporter embeds page data");
  assert.ok(!/trace:\s*["'](on|retain|on-first-retry)/.test(CFG_SRC + CTX_SRC));
  assert.ok(!/tracing\.start|recordVideo|recordHar|screenshot:\s*["']on/.test(CFG_SRC + CTX_SRC));
});

test("live config never reads or logs env values (OTP, keys, emails): no process.env value reaches a log or a file", () => {
  const src = CFG_SRC + CTX_SRC;
  assert.ok(!/console\.(log|info|warn|error)/.test(src), "no console output in config/contexts");
  assert.ok(!/OTP/.test(src.replace(/never[^\n]*OTP[^\n]*/gi, "")), "config never references an OTP variable");
  assert.ok(!/writeFile|appendFile/.test(src));
  // the only env reads allowed are the base URL and the (non-secret) account ids
  const reads = [...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
  for (const r of reads) assert.match(r, /^(PLAYWRIGHT_BASE_URL|DR_[A-Z_]*ACCOUNT)$/, `unexpected env read ${r}`);
});

test("maker, taker and referee contexts exist; taker and referee use the __e2eTestWallet seam, maker does not", () => {
  assert.deepEqual(CONTEXTS.map((c) => c.role).sort(), ["maker", "referee", "taker"]);
  const by = Object.fromEntries(CONTEXTS.map((c) => [c.role, c]));
  assert.equal(by.taker.wallet, "e2eTestWallet"); assert.equal(by.referee.wallet, "e2eTestWallet");
  assert.equal(by.maker.wallet, "privy");
  assert.equal(SEAM, "__e2eTestWallet");
  const projects = ((liveConfig as any).projects as { name: string }[]).map((p) => p.name).sort();
  assert.deepEqual(projects, ["maker", "referee", "taker"]);
});

test("test-wallet init script installs the seam with the (address, hashHex) signature the app expects; no key in the script text", () => {
  const s = testWalletInitScript("taker1.example.testnet");
  assert.match(s, /window\.__e2eTestWallet\s*=/);
  assert.match(s, /nearAddress:\s*"taker1\.example\.testnet"/);
  assert.match(s, /signRawHash:\s*\(address, hashHex\)/);
  assert.match(s, /e2e-wallet-changed/);
  assert.ok(!/[0-9a-f]{64}/i.test(s), "no key material baked into the init script");
});

test("the seam shape matches apps/web (read-only reference to the app's declaration)", () => {
  const app = read("apps", "web", "src", "App.tsx");
  assert.match(app, /__e2eTestWallet\?:\s*\{\s*nearAddress: string;\s*signRawHash: \(address: string, hashHex: string\) => Promise<string>;/);
});

test("live config is outside apps/web, and apps/web's own config/test:e2e/test.sh never pick it up", () => {
  assert.ok(existsSync(join(here, "..", "playwright.live.config.ts")));
  assert.ok(!existsSync(join(REPO, "apps", "web", "playwright.live.config.ts")));
  const webCfg = read("apps", "web", "playwright.config.ts");
  assert.match(webCfg, /testDir:\s*"\.\/tests"/);
  assert.ok(!/live-DR|playwright\.live/.test(webCfg));
  const webPkg = JSON.parse(read("apps", "web", "package.json"));
  for (const [k, v] of Object.entries<string>(webPkg.scripts)) assert.ok(!/live-DR|playwright\.live/.test(v), `apps/web script ${k}`);
  assert.equal(webPkg.scripts["test:e2e"], "playwright test"); // default config = apps/web/playwright.config.ts
  const testSh = read("test.sh");
  const fast = testSh.slice(testSh.indexOf("run_fast()"), testSh.indexOf("run_full()"));
  assert.ok(!/playwright\.live|live-DR.*playwright|--config/.test(fast), "test.sh fast must not run the live config");
  // nothing under apps/web/tests is a live-DR spec, and the live testDir never points into apps/web
  assert.ok(!/apps[\\/]web/.test(String((liveConfig as any).testDir)));
  const live = readdirSync(join(REPO, "apps", "web", "tests")).filter((f) => /live-DR|dr\d/i.test(f));
  assert.deepEqual(live, []);
});

test("services `npm test` globs cannot load live specs or the live config; the harness unit tests ARE wired in", () => {
  const pkg = JSON.parse(read("services", "package.json"));
  const glob: string = pkg.scripts.test;
  assert.match(glob, /e2e\/live-DR\/harness\/test\/\*\*\/\*\.test\.ts/);
  assert.ok(!/\.spec\.ts|playwright/.test(glob));
  // the live config's testMatch only matches *.live.spec.ts, which no *.test.ts glob matches
  assert.match(String((liveConfig as any).testMatch), /live\.spec\.ts/);
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (n === "node_modules" ? [] : statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  for (const f of walk(join(here, ".."))) if (/\.live\.spec\.ts$/.test(f)) assert.ok(!/\.test\.ts$/.test(f), relative(REPO, f));
});

test("live config targets the dev server by URL only (baseURL from PLAYWRIGHT_BASE_URL, default localhost:3000); it does not start apps/web itself", () => {
  const use = (liveConfig as any).use;
  assert.match(use.baseURL, /^https?:\/\//);
  assert.equal((liveConfig as any).webServer, undefined);
});
