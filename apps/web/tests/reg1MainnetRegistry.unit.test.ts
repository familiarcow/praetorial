// REG1: usernames are on for mainnet. The mainnet network config points at the live mainnet registry Worker, so a signed-in mainnet
// user without a username is gated (G6) instead of counting as "not-required".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAINNET_REGISTRY_URL, resolveRegistryUrl } from "../lib/networkSelect";
import { NETWORKS, resolveNetwork } from "../lib/network";
import { accountStateOf, appCtx, gate } from "../lib/appState";

const MAINNET_REGISTRY = "https://registry.praetorial.com";
const ROOT = join(new URL("..", import.meta.url).pathname, "..", "..");

test("mainnet registry URL is the live mainnet registry Worker", () => {
  assert.equal(MAINNET_REGISTRY_URL, MAINNET_REGISTRY);
  assert.equal(resolveRegistryUrl({ NETWORK_ID: "mainnet" }), MAINNET_REGISTRY);
  assert.equal(resolveRegistryUrl({ VITE_NETWORK_ID: "mainnet" }), MAINNET_REGISTRY);
  assert.equal(NETWORKS.mainnet.registryUrl, MAINNET_REGISTRY);
  assert.equal(resolveNetwork({ NETWORK_ID: "mainnet" }).registryUrl, MAINNET_REGISTRY);
  assert.equal(NETWORKS.mainnet.registryId, "registry.praetorial.near");
});

test("the URL names the Worker in the registry wrangler [env.mainnet], and that Worker allows the mainnet web origin (CORS)", () => {
  const toml = readFileSync(join(ROOT, "services/workers/registry/wrangler.toml"), "utf8");
  const mainnet = toml.slice(toml.indexOf("[env.mainnet]"));
  assert.match(mainnet, /^name = "praetorial-registry-mainnet"$/m);
  const origins = mainnet.match(/^REGISTRY_CORS_ORIGINS = "([^"]*)"(?:\s+#.*)?$/m)![1].split(",").map((s) => s.trim());
  // DOM1: every custom domain of the mainnet web (praetorial.com, www.praetorial.com) is an allowed origin.
  const webToml = readFileSync(join(ROOT, "apps/web/wrangler.mainnet.toml"), "utf8");
  const webHosts = [...webToml.matchAll(/pattern = "([^"]+)", custom_domain = true/g)].map((m) => m[1]);
  assert.deepEqual(webHosts, ["praetorial.com", "www.praetorial.com"]);
  for (const h of webHosts) assert.ok(origins.includes(`https://${h}`), `mainnet registry CORS lacks https://${h}`);
  assert.equal(new URL(NETWORKS.mainnet.registryUrl).host, mainnet.match(/^routes = \[\{ pattern = "([^"]+)", custom_domain = true \}\]$/m)![1]);
  assert.match(mainnet, /^REGISTRY_ID = "registry\.praetorial\.near"$/m);
});

test("mainnet: a signed-in user without a username is gated (pick-username), never 'not-required'", () => {
  const noRegistry = !resolveNetwork({ NETWORK_ID: "mainnet" }).registryUrl;
  assert.equal(noRegistry, false);
  assert.notEqual(accountStateOf("off", noRegistry), "not-required");
  for (const nameState of ["none", "skipped"] as const) {
    const ctx = appCtx({ auth: "ready", account: accountStateOf(nameState, noRegistry) });
    for (const action of ["create", "take", "rule", "challenge"] as const) {
      const g = gate(action, ctx);
      assert.equal(g.allowed, false, `${action} with ${nameState}`);
      assert.equal(g.code, "no-username");
      assert.equal(g.fix, "pick-username");
    }
    // money must always be able to come back: never gated by username
    for (const action of ["finalize", "concede", "cash-out"] as const) assert.equal(gate(action, ctx).allowed, true, action);
  }
  // registry lookup in flight: create/take wait for it
  assert.equal(gate("create", appCtx({ auth: "ready", account: accountStateOf("checking", noRegistry) })).code, "checking-username");
});
