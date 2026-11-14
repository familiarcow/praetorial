// K0: the /kit playground (fixture bets, mocked network) is compiled only into VITE_KIT=1 builds and never into a mainnet bundle.
// Real `vite build`s: the mainnet bundle has no playground code (marker, chunk or "/kit" route), a mainnet build with VITE_KIT=1
// is refused, and (positive control, so the scan is known to see it) the `build:kit` preview bundle does contain it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { kitMode, kitDefines, isKitPath, blockedRequest } from "../lib/kitBuild";
import { scanBundle, KIT_MARKERS } from "../scripts/mainnetDeployGuard";
import { writeFileSync, mkdirSync } from "node:fs";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAINNET_ENV = { NETWORK_ID: "mainnet", VITE_NETWORK_ID: "mainnet", VITE_INDEXER_URL: "/_proxy/indexer", VITE_RELAYER_URL: "/_proxy/relayer",
  VITE_REGISTRY_URL: "/_proxy/registry", VITE_SOURCECHECK_URL: "https://sourcecheck.praetorial.com/sourcecheck" };

function build(env: Record<string, string>): { status: number | null; out: string; stderr: string } {
  const out = mkdtempSync(join(tmpdir(), "k0-kit-dist-"));
  const e: Record<string, string | undefined> = { ...process.env, ...env };
  for (const k of ["VITE_KIT", "KIT_ONLY", "VITE_E2E_HOOKS"]) if (!(k in env)) delete e[k];
  const r = spawnSync("npx", ["vite", "build", "--outDir", out, "--emptyOutDir", "--logLevel", "error"], { cwd: web, env: e, encoding: "utf8" });
  return { status: r.status, out, stderr: r.stderr || r.stdout };
}
const jsOf = (dist: string) => readdirSync(join(dist, "assets")).filter((f) => f.endsWith(".js"));
// The chunk's own name, without Vite's content-hash suffixes: a hash like "lkItCO4k" must not read as "kit".
const chunkName = (f: string) => f.replace(/(-[A-Za-z0-9_]{8})+\.js$/, "");
const kitChunks = (files: string[]) => files.filter((f) => /kit|playground/i.test(chunkName(f)));
const allJs = (dist: string) => jsOf(dist).map((f) => readFileSync(join(dist, "assets", f), "utf8")).join("\n");

test("chunk-name scan ignores content hashes but sees the playground chunks", () => {
  assert.equal(chunkName("ConnectionStatusScreen-Cq9OxZkc-lkItCO4k.js"), "ConnectionStatusScreen");
  assert.deepEqual(kitChunks(["ConnectionStatusScreen-Cq9OxZkc-lkItCO4k.js", "index-AbCdEfGh.js", "Playground-Ab12Cd34.js", "kitEntry-x_9Yz8Wv.js"]),
    ["Playground-Ab12Cd34.js", "kitEntry-x_9Yz8Wv.js"]);
});

test("kitMode: off unless VITE_KIT=1; refused outright with a mainnet network; KIT_ONLY=1 for the preview build", () => {
  assert.equal(kitMode({}), "off");
  assert.equal(kitMode({ NETWORK_ID: "mainnet" }), "off");
  assert.equal(kitMode({ VITE_KIT: "1" }), "route");
  assert.equal(kitMode({ VITE_KIT: "1", NETWORK_ID: "testnet", KIT_ONLY: "1" }), "only");
  assert.throws(() => kitMode({ VITE_KIT: "1", NETWORK_ID: "mainnet" }), /never allowed with a mainnet network/);
  assert.throws(() => kitMode({ VITE_KIT: "1", VITE_NETWORK_ID: "mainnet" }), /never allowed/);
  assert.deepEqual(kitDefines({}), { __PRAETORIAL_KIT__: '"off"' });
  assert.equal(isKitPath("/kit"), true);
  assert.equal(isKitPath("/kit/x"), true);
  assert.equal(isKitPath("/kite"), false);
});

test("kit preview network rule: only same-origin static files load", () => {
  const o = "https://kit.example.dev";
  assert.equal(blockedRequest("/assets/index.js", o), false);
  assert.equal(blockedRequest("https://kit.example.dev/src/kit/kit.css", o), false);
  for (const u of ["https://rpc.mainnet.near.org", "https://1click.chaindefuser.com/v0/tokens", "/_proxy/relayer/relay", "/api/ticker?venue=coinbase", "https://auth.privy.io/api/v1/apps"]) {
    assert.equal(blockedRequest(u, o), true, u);
  }
});

test("deploy guard: a bundle with the playground is refused", () => {
  const dist = mkdtempSync(join(tmpdir(), "k0-guard-"));
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "assets", "index-1.js"), 'a="bets.praetorial.near";b="intents.near";');
  writeFileSync(join(dist, "assets", "Playground-2.js"), `x={"data-testid":"${KIT_MARKERS[0]}"}`);
  assert.deepEqual(scanBundle(dist).kit.map((h) => `${h.file}:${h.match}`), [`Playground-2.js:${KIT_MARKERS[0]}`]);
});

test("a real mainnet production build has no /kit: no marker, no playground chunk, no route", () => {
  const r = build(MAINNET_ENV);
  assert.equal(r.status, 0, r.stderr);
  const files = jsOf(r.out);
  assert.ok(files.length > 0);
  assert.deepEqual(scanBundle(r.out).kit, [], "mainnet bundle contains the /kit playground");
  assert.deepEqual(kitChunks(files), [], "a playground chunk was emitted");
  const js = allJs(r.out);
  assert.ok(!js.includes('"/kit"'), "the /kit route path is in the mainnet bundle");
  assert.ok(!js.includes("tests/fixtures") && !js.includes("a1b2cccc"), "fixture bets are in the mainnet bundle");
});

test("a mainnet build with VITE_KIT=1 fails instead of shipping the playground", () => {
  const r = build({ ...MAINNET_ENV, VITE_KIT: "1" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /never allowed with a mainnet network/);
});

test("positive control: the build:kit preview bundle does contain the playground", () => {
  const r = build({ NETWORK_ID: "testnet", VITE_NETWORK_ID: "testnet", VITE_KIT: "1", KIT_ONLY: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(scanBundle(r.out).kit.some((h) => h.match === KIT_MARKERS[0]), "kit build lacks the playground marker");
  assert.ok(kitChunks(jsOf(r.out)).length > 0, "the chunk-name scan does not see the kit build's playground chunks");
});
