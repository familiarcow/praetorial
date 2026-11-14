// NAV1 (LOGIN1 finding): the window seam that fakes a signed-in wallet (and the other mocked-e2e seams) must not work on the live
// site. They are read only through lib/testHooks.ts, compiled out of a mainnet production bundle by __PRAETORIAL_TEST_HOOKS__,
// and the mainnet deploy guard refuses any bundle that still names one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDefines, testHooksOn } from "../lib/networkSelect";
import { TEST_HOOKS_ENABLED, e2eTestWallet } from "../lib/testHooks";
import { scanBundle, REFUSED_SEAMS } from "../scripts/mainnetDeployGuard";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");

test("testHooksOn: off only for a mainnet production build (unless VITE_E2E_HOOKS=1); dev server and testnet keep them", () => {
  assert.equal(testHooksOn({ NETWORK_ID: "mainnet" }, "build"), false);
  assert.equal(testHooksOn({ VITE_NETWORK_ID: "mainnet" }, "build"), false);
  assert.equal(testHooksOn({ NETWORK_ID: "mainnet", VITE_E2E_HOOKS: "1" }, "build"), true);
  assert.equal(testHooksOn({ NETWORK_ID: "mainnet" }, "serve"), true);
  assert.equal(testHooksOn({ NETWORK_ID: "testnet" }, "build"), true);
  assert.equal(testHooksOn({}, "build"), true);
  assert.deepEqual(buildDefines({ NETWORK_ID: "mainnet" }, "build"), { __PRAETORIAL_BUILD_NETWORK__: '"mainnet"', __PRAETORIAL_TEST_HOOKS__: "false" });
  assert.deepEqual(buildDefines({ NETWORK_ID: "mainnet" }), { __PRAETORIAL_BUILD_NETWORK__: '"mainnet"' });
});

test("in node (no build define) the hooks are on, so the mocked specs and unit tests keep working", () => {
  assert.equal(TEST_HOOKS_ENABLED, true);
  assert.equal(e2eTestWallet(), undefined); // no window in node
});

test("every seam is read only through lib/testHooks.ts (a direct window read would survive in the bundle)", () => {
  const files = (dir: string): string[] => readdirSync(join(web, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : /\.(ts|tsx)$/.test(d.name) ? [join(dir, d.name)] : []);
  const bad: string[] = [];
  for (const f of [...files("src"), ...files("lib")]) {
    if (f === join("lib", "testHooks.ts")) continue;
    readFileSync(join(web, f), "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return; // comments
      if (/^\s*__e2e\w+\?:/.test(line)) return; // the Window type declaration in App.tsx (types are erased)
      for (const s of REFUSED_SEAMS) if (line.includes(s)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, []);
});

test("deploy guard: a bundle naming a seam is refused, file by file", () => {
  const dist = mkdtempSync(join(tmpdir(), "nav1-seam-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "assets", "index-1.js"), 'a="bets.praetorial.near";b="intents.near";c=window.__e2eTestWallet;addEventListener("e2e-wallet-changed",f)');
  writeFileSync(join(dist, "assets", "vendor-2.js"), "x=1");
  assert.deepEqual(scanBundle(dist).seams.map((h) => `${h.file}:${h.match}`), ["index-1.js:__e2eTestWallet", "index-1.js:e2e-wallet-changed"]);
  writeFileSync(join(dist, "assets", "index-1.js"), 'a="bets.praetorial.near";b="intents.near";window.__e2e={ready:!0}');
  assert.deepEqual(scanBundle(dist).seams, []);
});

test("a real mainnet production build does not honour the fake-wallet seam: no seam is left in the bundle", () => {
  const out = mkdtempSync(join(tmpdir(), "nav1-mainnet-dist-"));
  const env = { ...process.env, NETWORK_ID: "mainnet", VITE_NETWORK_ID: "mainnet", VITE_INDEXER_URL: "/_proxy/indexer", VITE_RELAYER_URL: "/_proxy/relayer",
    VITE_REGISTRY_URL: "/_proxy/registry", VITE_SOURCECHECK_URL: "https://sourcecheck.praetorial.com/sourcecheck" };
  delete (env as Record<string, string | undefined>).VITE_E2E_HOOKS;
  const r = spawnSync("npx", ["vite", "build", "--outDir", out, "--emptyOutDir", "--logLevel", "error"], { cwd: web, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const scan = scanBundle(out);
  assert.ok(scan.files.length > 0);
  assert.deepEqual(scan.seams, [], "mainnet bundle still names a test seam");
  assert.deepEqual(scan.missing, []);
});

test("SECREV1 SR-3: window.__e2e only carries signRawHash (sign ANY hash with the user's key) through the compiled-out seam", async () => {
  const th: any = await import("../lib/testHooks");
  assert.equal(typeof th.e2eSignSeam, "function");
  const f = async () => "sig";
  assert.deepEqual(th.e2eSignSeam(f), { signRawHash: f, __e2eSignSeam: true }, "hooks on (node/dev/testnet): exposed for specs");
  assert.ok(REFUSED_SEAMS.includes("__e2eSignSeam"), "the mainnet deploy guard refuses a bundle that still carries it");
  const app = readFileSync(join(web, "src", "App.tsx"), "utf8");
  const block = app.slice(app.indexOf("window.__e2e = {"), app.indexOf("};", app.indexOf("window.__e2e = {")));
  assert.ok(block.length > 0 && !/\bsignRawHash\s*:/.test(block), "App.tsx must not put signRawHash on window.__e2e directly");
});

test("SECREV1 SR-3: no app source reads the signer from window.__e2e (it is absent in a mainnet build)", () => {
  const files = (dir: string): string[] => readdirSync(join(web, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : /\.(ts|tsx)$/.test(d.name) ? [join(dir, d.name)] : []);
  const bad = [...files("src"), ...files("lib")].filter((f) => /__e2e!?\??\.signRawHash/.test(readFileSync(join(web, f), "utf8")));
  assert.deepEqual(bad, []);
});
