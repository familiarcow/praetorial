// WEBREG1: registry URL selected by build network (default testnet); env override wins. REG1: mainnet has its own live registry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveNetworkId, resolveRegistryUrl, TESTNET_REGISTRY_URL } from "../lib/networkSelect";
import { REGISTRY_URL } from "../lib/config";

const LIVE = "https://praetorial-registry-testnet.familiarcow.workers.dev";

test("testnet registry constant is the live CF1f Worker", () => {
  assert.equal(TESTNET_REGISTRY_URL, LIVE);
});
test("network id: default testnet; NETWORK_ID or VITE_NETWORK_ID select; unknown values fall back to testnet only when unset, else throw", () => {
  assert.equal(resolveNetworkId({}), "testnet");
  assert.equal(resolveNetworkId({ NETWORK_ID: "mainnet" }), "mainnet");
  assert.equal(resolveNetworkId({ VITE_NETWORK_ID: "mainnet" }), "mainnet");
  assert.equal(resolveNetworkId({ NETWORK_ID: "testnet", VITE_NETWORK_ID: "mainnet" }), "testnet");
  assert.equal(resolveNetworkId({ NETWORK_ID: "" }), "testnet");
  assert.throws(() => resolveNetworkId({ NETWORK_ID: "mainet" }));
});
test("testnet resolves to the live registry URL", () => {
  assert.equal(resolveRegistryUrl({}), LIVE);
  assert.equal(resolveRegistryUrl({ NETWORK_ID: "testnet" }), LIVE);
});
test("mainnet resolves to the mainnet registry (REG1), never the testnet URL", () => {
  assert.equal(resolveRegistryUrl({ NETWORK_ID: "mainnet" }), "https://registry.praetorial.com");
  assert.equal(resolveRegistryUrl({ VITE_NETWORK_ID: "mainnet" }), "https://registry.praetorial.com");
  assert.notEqual(resolveRegistryUrl({ NETWORK_ID: "mainnet" }), LIVE);
});
test("env override wins on both networks; empty override is ignored", () => {
  assert.equal(resolveRegistryUrl({ REGISTRY_URL: "http://localhost:9" }), "http://localhost:9");
  assert.equal(resolveRegistryUrl({ NETWORK_ID: "mainnet", REGISTRY_URL: "https://reg.example" }), "https://reg.example");
  assert.equal(resolveRegistryUrl({ VITE_REGISTRY_URL: "https://v.example" }), "https://v.example");
  assert.equal(resolveRegistryUrl({ REGISTRY_URL: "" }), LIVE);
});
test("config REGISTRY_URL (no env set in the test run) is the testnet URL, so username step + Settings are on", () => {
  if (!process.env.REGISTRY_URL && !process.env.NETWORK_ID) assert.equal(REGISTRY_URL, LIVE);
});
import { readFileSync } from "node:fs";
test("e2e seam: mocked specs default the registry OFF (window.__e2eRegistryUrl = \"\" in e2eGuard) and App honours an empty override", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const guard = readFileSync(new URL("./e2eGuard.ts", import.meta.url), "utf8");
  // NAV1: the seam is read through lib/testHooks.ts (compiled out of a mainnet production bundle); "" must still win over REGISTRY_URL.
  const hooks = readFileSync(new URL("../lib/testHooks.ts", import.meta.url), "utf8");
  assert.match(app, /e2eRegistryUrl\(\)\s*\?\?\s*REGISTRY_URL/);
  assert.match(hooks, /return TEST_HOOKS_ENABLED \? w\(\)\?\.__e2eRegistryUrl : undefined;/);
  assert.match(guard, /__e2eRegistryUrl\s*=\s*""/);
});
