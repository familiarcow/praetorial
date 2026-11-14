// DOM1: mainnet moves to praetorial.com. Every public mainnet Worker has a custom-domain route <svc>.praetorial.com (workers_dev kept on
// as the rollback path), CORS allows the apex + www origins, the notifier links to the apex, and check-deployed-stack / the release
// record point at the praetorial.com hosts. Testnet stays on workers.dev.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkerSpecs, parseWranglerToml, STACK_WORKERS } from "../src/stackCheck.js";
import { checkMainnetReady, MAINNET_PUBLIC_HOSTS, MAINNET_WEB_ORIGINS, MAINNET_WORKERS } from "../src/mainnetReady.js";

const WORKERS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = path.resolve(WORKERS, "../..");
const toml = (n: string) => fs.readFileSync(path.join(WORKERS, n, "wrangler.toml"), "utf8");
const tomls = Object.fromEntries(STACK_WORKERS.map((n) => [n, toml(n)]));
const PUBLIC = ["indexer", "relayer", "registry", "funding", "sourcecheck", "keeper"];

test("DOM1: the public mainnet hosts are exactly <svc>.praetorial.com for the six Workers with public HTTP", () => {
  assert.deepEqual({ ...MAINNET_PUBLIC_HOSTS }, Object.fromEntries(PUBLIC.map((s) => [s, `${s}.praetorial.com`])));
});

test("DOM1: every public mainnet Worker has a custom-domain route on <svc>.praetorial.com and keeps workers_dev = true", () => {
  for (const s of PUBLIC) {
    const c = parseWranglerToml(tomls[s]!, "mainnet");
    assert.deepEqual(c.customDomains, [`${s}.praetorial.com`], s);
    assert.equal(c.workersDev, true, `${s}: workers_dev stays on for this release (rollback path)`);
  }
});

test("DOM1: private Workers (monitor, notifier) get no route; testnet sections get no route", () => {
  for (const s of ["monitor", "notifier"]) assert.deepEqual(parseWranglerToml(tomls[s]!, "mainnet").customDomains, [], s);
  for (const s of STACK_WORKERS) assert.deepEqual(parseWranglerToml(tomls[s]!, "testnet").customDomains, [], `${s} testnet`);
});

test("DOM1: parseWranglerToml reads only custom_domain routes of the selected env", () => {
  const t = [
    'name = "w-testnet"', "", "[env.mainnet]", 'name = "w-mainnet"',
    'routes = [{ pattern = "w.praetorial.com", custom_domain = true }, { pattern = "praetorial.com/x/*", zone_name = "praetorial.com" }]',
  ].join("\n");
  assert.deepEqual(parseWranglerToml(t, "mainnet").customDomains, ["w.praetorial.com"]);
  assert.deepEqual(parseWranglerToml(t, "testnet").customDomains, []);
  assert.equal(parseWranglerToml(t, "mainnet").workersDev, false, "wrangler: routes and no workers_dev => workers.dev off");
  assert.equal(parseWranglerToml(t, "testnet").workersDev, true);
});

test("DOM1: CORS allow-lists (funding, sourcecheck, registry) allow https://praetorial.com and https://www.praetorial.com", () => {
  const keys: Record<string, string> = { funding: "FUNDING_ALLOWED_ORIGINS", sourcecheck: "SOURCECHECK_ALLOWED_ORIGINS", registry: "REGISTRY_CORS_ORIGINS" };
  for (const [s, k] of Object.entries(keys)) {
    const allowed = (parseWranglerToml(tomls[s]!, "mainnet").vars[k] ?? "").split(",").map((o) => o.trim());
    for (const o of ["https://praetorial.com", "https://www.praetorial.com"]) assert.ok(allowed.includes(o), `${s} ${k} lacks ${o}`);
  }
  assert.ok(MAINNET_WEB_ORIGINS.includes("https://praetorial.com" as any));
  assert.ok(MAINNET_WEB_ORIGINS.includes("https://www.praetorial.com" as any));
});

test("DOM1: the notifier's Telegram bet links point at https://praetorial.com/bet", () => {
  assert.equal(parseWranglerToml(tomls.notifier!, "mainnet").vars.NOTIFIER_BET_LINK_BASE, "https://praetorial.com/bet");
});

test("DOM1: check-deployed-stack probes the praetorial.com hosts on mainnet (private Workers through keeper.praetorial.com)", () => {
  const { specs } = buildWorkerSpecs(tomls, "mainnet", "unused-subdomain");
  const url = Object.fromEntries(specs.map((s) => [s.service, s.url]));
  for (const s of PUBLIC) assert.equal(url[s], `https://${s}.praetorial.com/health`, s);
  assert.equal(url.monitor, "https://keeper.praetorial.com/health/monitor");
  assert.equal(url.notifier, "https://keeper.praetorial.com/health/notifier");
});

test("DOM1: check-deployed-stack keeps workers.dev for testnet (no routes there)", () => {
  const { specs } = buildWorkerSpecs(tomls, "testnet", "sub");
  assert.equal(specs.find((s) => s.service === "indexer")!.url, "https://praetorial-indexer-testnet.sub.workers.dev/health");
});

test("DOM1: release/mainnet-night/release-mainnet.json names the praetorial.com web origin and the same service hosts as wrangler", () => {
  const rel = JSON.parse(fs.readFileSync(path.join(REPO, "release/mainnet-night/release-mainnet.json"), "utf8"));
  assert.equal(rel.web?.origin, "https://praetorial.com");
  assert.equal(rel.web?.www_redirect, "https://www.praetorial.com");
  const want = Object.fromEntries(PUBLIC.map((s) => [s, `https://${s}.praetorial.com`]));
  assert.deepEqual(rel.service_hosts, want);
  for (const s of PUBLIC) assert.deepEqual(parseWranglerToml(tomls[s]!, "mainnet").customDomains, [new URL(rel.service_hosts[s]).host]);
});

test("DOM1: check-mainnet-ready refuses a public mainnet Worker without its praetorial.com custom-domain route", () => {
  const texts = Object.fromEntries(MAINNET_WORKERS.map((n) => [n, toml(n)]));
  assert.deepEqual(checkMainnetReady(texts).filter((f) => /praetorial\.com/.test(f)), []);
  const stripped = { ...texts, relayer: texts.relayer!.replace(/^routes\s*=.*$/m, "") };
  assert.ok(checkMainnetReady(stripped).some((f) => f.startsWith("relayer:") && f.includes("relayer.praetorial.com")));
  const wrongHost = { ...texts, funding: texts.funding!.replace('pattern = "funding.praetorial.com"', 'pattern = "funds.praetorial.com"') };
  assert.ok(checkMainnetReady(wrongHost).some((f) => f.startsWith("funding:") && f.includes("funding.praetorial.com")));
});
