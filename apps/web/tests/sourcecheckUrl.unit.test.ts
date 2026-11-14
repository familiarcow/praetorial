// WEBSRC1 (D-SRCW1): the source-check endpoint is network-selected exactly like the registry (lib/networkSelect.ts); never localhost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  resolveSourcecheckUrl, assertSourcecheckDeployReady, isSourcecheckPlaceholder,
  TESTNET_SOURCECHECK_URL, MAINNET_SOURCECHECK_URL,
} from "../lib/networkSelect";
import { SOURCECHECK_URL } from "../lib/sourceCheckClient";

const TESTNET = "https://praetorial-sourcecheck-testnet.familiarcow.workers.dev/sourcecheck";
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

test("testnet constant is the deployed Worker; unset/testnet env selects it", () => {
  assert.equal(TESTNET_SOURCECHECK_URL, TESTNET);
  assert.equal(resolveSourcecheckUrl({}), TESTNET);
  assert.equal(resolveSourcecheckUrl({ NETWORK_ID: "testnet" }), TESTNET);
  assert.equal(resolveSourcecheckUrl({ VITE_NETWORK_ID: "testnet" }), TESTNET);
});
test("mainnet selects the mainnet placeholder (same workers.dev subdomain), flagged as unset", () => {
  assert.equal(MAINNET_SOURCECHECK_URL, "https://sourcecheck.praetorial.com/sourcecheck");
  assert.equal(resolveSourcecheckUrl({ NETWORK_ID: "mainnet" }), MAINNET_SOURCECHECK_URL);
  assert.equal(resolveSourcecheckUrl({ VITE_NETWORK_ID: "mainnet" }), MAINNET_SOURCECHECK_URL);
  assert.equal(isSourcecheckPlaceholder(MAINNET_SOURCECHECK_URL), true);
  assert.equal(isSourcecheckPlaceholder(TESTNET), false);
});
test("deploy-ready check refuses a mainnet build on the placeholder; passes with an override or on testnet", () => {
  assert.throws(() => assertSourcecheckDeployReady({ NETWORK_ID: "mainnet" }), /sourcecheck/i);
  assert.doesNotThrow(() => assertSourcecheckDeployReady({ NETWORK_ID: "mainnet", VITE_SOURCECHECK_URL: "https://sc.example/sourcecheck" }));
  assert.doesNotThrow(() => assertSourcecheckDeployReady({ NETWORK_ID: "testnet" }));
  assert.doesNotThrow(() => assertSourcecheckDeployReady({}));
});
test("VITE_SOURCECHECK_URL / SOURCECHECK_URL override wins on both networks; empty override ignored", () => {
  assert.equal(resolveSourcecheckUrl({ VITE_SOURCECHECK_URL: "http://localhost:8790/sourcecheck" }), "http://localhost:8790/sourcecheck");
  assert.equal(resolveSourcecheckUrl({ SOURCECHECK_URL: "https://sc.example/x" }), "https://sc.example/x");
  assert.equal(resolveSourcecheckUrl({ NETWORK_ID: "mainnet", VITE_SOURCECHECK_URL: "https://sc.example/x" }), "https://sc.example/x");
  assert.equal(resolveSourcecheckUrl({ VITE_SOURCECHECK_URL: "" }), TESTNET);
});
test("no build profile without an explicit override resolves to localhost", () => {
  for (const env of [{}, { NETWORK_ID: "testnet" }, { NETWORK_ID: "mainnet" }, { VITE_NETWORK_ID: "mainnet" }]) {
    assert.doesNotMatch(resolveSourcecheckUrl(env), /localhost|127\.0\.0\.1|:8790/);
  }
  assert.doesNotMatch(read("../lib/sourceCheckClient.ts").replace(/\/\/.*$/gm, ""), /localhost|8790/);
});
test("client default SOURCECHECK_URL comes from the selector (no env in the test run => testnet URL)", () => {
  if (!process.env.VITE_SOURCECHECK_URL && !process.env.SOURCECHECK_URL && !process.env.NETWORK_ID && !process.env.VITE_NETWORK_ID) assert.equal(SOURCECHECK_URL, TESTNET);
  assert.match(read("../lib/sourceCheckClient.ts"), /resolveSourcecheckUrl\(readBuildEnv\(\)\)/);
});
test("mocked e2e dev server pins the mocked origin; testnet deploy build does not override it", () => {
  assert.match(read("../playwright.config.ts"), /VITE_SOURCECHECK_URL:\s*"http:\/\/localhost:8790\/sourcecheck"/);
  // MAINPREP: only build:mainnet may set it, and only to the mainnet Worker URL; every other script (testnet build/deploy, e2e) must not.
  const scripts = (JSON.parse(read("../package.json")) as { scripts: Record<string, string> }).scripts;
  for (const [name, s] of Object.entries(scripts)) {
    const set = [...s.matchAll(/VITE_SOURCECHECK_URL=(\S*)/g)].map((m) => m[1]);
    if (name === "build:mainnet") assert.deepEqual(set, [MAINNET_SOURCECHECK_URL], name);
    else assert.deepEqual(set, [], `${name} must not override VITE_SOURCECHECK_URL`);
  }
  assert.doesNotMatch(scripts["build:testnet"]!, /SOURCECHECK/);
});
test("MAINPREP: an EXPLICIT override equal to the mainnet URL is accepted (build:mainnet asserts the Worker is deployed); the implicit default still refuses", () => {
  assert.doesNotThrow(() => assertSourcecheckDeployReady({ NETWORK_ID: "mainnet", VITE_SOURCECHECK_URL: MAINNET_SOURCECHECK_URL }));
  assert.doesNotThrow(() => assertSourcecheckDeployReady({ VITE_NETWORK_ID: "mainnet", SOURCECHECK_URL: MAINNET_SOURCECHECK_URL }));
  assert.throws(() => assertSourcecheckDeployReady({ NETWORK_ID: "mainnet", VITE_SOURCECHECK_URL: "" }), /sourcecheck/i);
});
