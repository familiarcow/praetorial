// WEBDEP1 (D-WEBDEP1): the deployed preview is testnet-only. The deploy config and build script must force testnet,
// serve dist as static assets with SPA fallback, and carry no routes / custom domains / mainnet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const toml = () => read("../wrangler.testnet.toml");
const pkg = () => JSON.parse(read("../package.json")) as { scripts: Record<string, string> };

test("deploy config: Worker praetorial-web-testnet, dist assets, SPA fallback, workers.dev only", () => {
  const t = toml();
  assert.match(t, /^name\s*=\s*"praetorial-web-testnet"\s*$/m);
  assert.match(t, /^directory\s*=\s*"\.\/dist"\s*$/m);
  assert.match(t, /^not_found_handling\s*=\s*"single-page-application"\s*$/m);
  assert.match(t, /^workers_dev\s*=\s*true\s*$/m);
  const live = t.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(live, /^\s*routes?\s*=/m, "no routes");
  assert.doesNotMatch(live, /custom_domain|\[\[routes\]\]|zone_name|pattern\s*=/, "no custom domains");
});

test("deploy config never selects or names mainnet", () => {
  const live = toml().split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(live, /mainnet|\.near\b|praetorial\.com/i);
});

test("build:testnet forces NETWORK_ID=testnet (and VITE_NETWORK_ID) and deploy:testnet builds that way with the testnet config only", () => {
  const s = pkg().scripts;
  assert.ok(s["build:testnet"], "build:testnet script");
  assert.match(s["build:testnet"], /NETWORK_ID=testnet/);
  assert.match(s["build:testnet"], /VITE_NETWORK_ID=testnet/);
  assert.doesNotMatch(s["build:testnet"], /mainnet/);
  assert.ok(s["deploy:testnet"], "deploy:testnet script");
  assert.match(s["deploy:testnet"], /build:testnet/);
  assert.match(s["deploy:testnet"], /wrangler deploy --config wrangler\.testnet\.toml/);
});

test("LIVE1: deploy:testnet runs the config-drift guard first (web NETWORKS vs Worker wrangler.toml) and stops on failure", () => {
  const d = pkg().scripts["deploy:testnet"]!;
  assert.match(d, /^node \.\.\/\.\.\/services\/workers\/scripts\/check-config-drift\.mjs && /, "guard is the first step, chained with &&");
  assert.ok(d.indexOf("check-config-drift") < d.indexOf("build:testnet"), "guard before build");
  assert.ok(d.indexOf("build:testnet") < d.indexOf("wrangler deploy"), "build before deploy");
});
