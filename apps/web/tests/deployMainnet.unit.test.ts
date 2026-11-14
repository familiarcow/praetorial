// MAINPREP (2)+(4): mainnet web Worker praetorial-web-mainnet (DOM1: custom domains praetorial.com + www.praetorial.com; workers.dev kept),
// service bindings to the -mainnet Workers, NETWORK_ID=mainnet for the proxy. build:mainnet forces mainnet;
// deploy:mainnet = build -> guard -> wrangler deploy (guard scans the built bundle, so it runs after the build).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const live = () => read("../wrangler.mainnet.toml").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
const scripts = () => (JSON.parse(read("../package.json")) as { scripts: Record<string, string> }).scripts;

test("wrangler.mainnet.toml: praetorial-web-mainnet, workers.dev kept, same assets as testnet, exactly the two praetorial.com custom domains", () => {
  const t = live();
  assert.match(t, /^name\s*=\s*"praetorial-web-mainnet"\s*$/m);
  assert.match(t, /^workers_dev\s*=\s*true\s*$/m);
  assert.match(t, /^main\s*=\s*"worker\/index\.ts"\s*$/m);
  assert.match(t, /^directory\s*=\s*"\.\/dist"\s*$/m);
  assert.match(t, /^binding\s*=\s*"ASSETS"\s*$/m);
  // DOM1: every path runs the Worker first so www.praetorial.com can 301 to the apex (worker/index.ts).
  assert.match(t, /^run_worker_first\s*=\s*true\s*$/m);
  assert.match(t, /^not_found_handling\s*=\s*"single-page-application"\s*$/m);
  // DOM1: exactly two custom-domain routes (apex + www), nothing zone-routed, no other host.
  const routes = t.match(/^\s*routes?\s*=.*$/gm) ?? [];
  assert.deepEqual(routes, ['routes = [{ pattern = "praetorial.com", custom_domain = true }, { pattern = "www.praetorial.com", custom_domain = true }]']);
  assert.doesNotMatch(t, /\[\[routes\]\]|zone_name|zone_id/, "custom domains only");
  assert.deepEqual([...t.matchAll(/pattern\s*=\s*"([^"]+)"/g)].map((m) => m[1]), ["praetorial.com", "www.praetorial.com"]);
});

test("wrangler.mainnet.toml: INDEXER/RELAYER/REGISTRY bind the -mainnet Workers; NETWORK_ID=mainnet; nothing testnet", () => {
  const t = live();
  const pairs = [...t.matchAll(/\[\[services\]\]\s*binding\s*=\s*"([A-Z]+)"\s*service\s*=\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(pairs, [["INDEXER", "praetorial-indexer-mainnet"], ["RELAYER", "praetorial-relayer-mainnet"], ["REGISTRY", "praetorial-registry-mainnet"]]);
  assert.match(t, /\[vars\]\s*NETWORK_ID\s*=\s*"mainnet"/);
  assert.doesNotMatch(t, /testnet|praetorial-dev-1101/);
});

test("build:mainnet forces mainnet, proxies the three services, pins the mainnet sourcecheck URL", () => {
  assert.equal(scripts()["build:mainnet"],
    "NETWORK_ID=mainnet VITE_NETWORK_ID=mainnet VITE_INDEXER_URL=/_proxy/indexer VITE_RELAYER_URL=/_proxy/relayer VITE_REGISTRY_URL=/_proxy/registry VITE_SOURCECHECK_URL=https://sourcecheck.praetorial.com/sourcecheck npm run build");
});

test("deploy:mainnet = build:mainnet -> mainnet guard -> wrangler deploy --config wrangler.mainnet.toml, chained with &&", () => {
  const d = scripts()["deploy:mainnet"]!;
  assert.ok(d, "deploy:mainnet script");
  const parts = d.split(" && ");
  assert.equal(parts.length, 3, d);
  assert.equal(parts[0], "npm run build:mainnet");
  assert.match(parts[1], /^tsx scripts\/mainnetDeployGuard\.ts$/);
  assert.equal(parts[2], "wrangler deploy --config wrangler.mainnet.toml");
  assert.doesNotMatch(d, /testnet/);
});

test("testnet scripts never select mainnet", () => {
  const s = scripts();
  assert.doesNotMatch(s["build:testnet"]!, /mainnet/);
  assert.doesNotMatch(s["deploy:testnet"]!, /mainnet/);
});
