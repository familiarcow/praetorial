// DOM1: the mainnet web is served on https://praetorial.com (custom domain on praetorial-web-mainnet; www.praetorial.com 301s to
// the apex) and every mainnet service URL the bundle carries is a <svc>.praetorial.com host. workers_dev stays on (rollback path).
// Testnet is unchanged (workers.dev).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handle, MAINNET_UPSTREAMS, UPSTREAMS, APEX_ORIGIN } from "../worker/index";
import { NETWORKS } from "../lib/network";
import { MAINNET_REGISTRY_URL, MAINNET_SOURCECHECK_URL } from "../lib/networkSelect";
// @ts-ignore -- plain JS module
import { LIVE_MAINNET_ORIGIN, compareBundles, extractUrls } from "../../../scripts/compare-live-bundle.mjs";
import { runLiveDiff } from "../scripts/mainnetDeployGuard";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const assetsEnv = (hits: string[]) => ({ ASSETS: { fetch: async (r: Request | string) => { hits.push(new URL(typeof r === "string" ? r : r.url).pathname); return new Response("asset"); } } });

test("DOM1: wrangler.mainnet.toml routes praetorial.com and www.praetorial.com as custom domains and keeps workers_dev = true", () => {
  const t = read("../wrangler.mainnet.toml");
  assert.match(t, /^workers_dev = true$/m);
  assert.match(t, /^routes = \[\s*\{ pattern = "praetorial\.com", custom_domain = true \},\s*\{ pattern = "www\.praetorial\.com", custom_domain = true \}\s*\]$/m);
  // www must reach the Worker on every path so it can 301 (assets are otherwise served before the Worker runs).
  assert.match(t, /^run_worker_first = true$/m);
  assert.doesNotMatch(read("../wrangler.testnet.toml"), /^routes\s*=/m);
});

test("DOM1: www.praetorial.com/<path>?<q> 301s to https://praetorial.com/<path>?<q>; the apex serves assets", async () => {
  assert.equal(APEX_ORIGIN, "https://praetorial.com");
  const hits: string[] = [];
  const env = { ...assetsEnv(hits), NETWORK_ID: "mainnet" };
  const r = await handle(new Request("https://www.praetorial.com/bet/7?invite=abc"), env as any);
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "https://praetorial.com/bet/7?invite=abc");
  const p = await handle(new Request("https://www.praetorial.com/_proxy/indexer/offers", { method: "POST" }), env as any);
  assert.equal(p.status, 301, "even /_proxy on www redirects (one origin for Privy and CORS)");
  assert.deepEqual(hits, []);
  const ok = await handle(new Request("https://praetorial.com/bet/7"), env as any);
  assert.equal(await ok.text(), "asset");
  assert.deepEqual(hits, ["/bet/7"]);
});

test("DOM1: workers.dev hosts are not redirected (rollback path) and testnet never redirects", async () => {
  for (const [u, net] of [["https://praetorial-web-mainnet.acct.workers.dev/x", "mainnet"], ["https://praetorial-web-testnet.acct.workers.dev/x", "testnet"]]) {
    const hits: string[] = [];
    const r = await handle(new Request(u), { ...assetsEnv(hits), NETWORK_ID: net } as any);
    assert.equal(r.status, 200, u);
    assert.deepEqual(hits, ["/x"]);
  }
});

test("DOM1: mainnet /_proxy targets and service URLs are the praetorial.com hosts", () => {
  assert.deepEqual({ ...MAINNET_UPSTREAMS }, {
    indexer: "https://indexer.praetorial.com", relayer: "https://relayer.praetorial.com", registry: "https://registry.praetorial.com",
  });
  assert.equal(NETWORKS.mainnet.fundingUrl, "https://funding.praetorial.com");
  assert.equal(NETWORKS.mainnet.registryUrl, "https://registry.praetorial.com");
  assert.equal(MAINNET_REGISTRY_URL, "https://registry.praetorial.com");
  assert.equal(MAINNET_SOURCECHECK_URL, "https://sourcecheck.praetorial.com/sourcecheck");
  const pkg = JSON.parse(read("../package.json"));
  assert.match(pkg.scripts["build:mainnet"], /VITE_SOURCECHECK_URL=https:\/\/sourcecheck\.praetorial\.com\/sourcecheck /);
  for (const u of Object.values(UPSTREAMS)) assert.match(u as string, /-testnet\.[a-z0-9-]+\.workers\.dev$/, "testnet stays on workers.dev");
});

test("DOM1: the live check (check:live:mainnet, deploy guard) reads https://praetorial.com", () => {
  assert.equal(LIVE_MAINNET_ORIGIN, "https://praetorial.com");
});

test("DOM1: extractUrls sees praetorial.com service URLs; a workers.dev service URL moved to <svc>.praetorial.com is not 'missing'", () => {
  const live = `x="https://praetorial-funding-mainnet.acct.workers.dev";y="https://praetorial-sourcecheck-mainnet.acct.workers.dev/sourcecheck";z="/_proxy/indexer"`;
  const dist = `x="https://funding.praetorial.com";y="https://sourcecheck.praetorial.com/sourcecheck";z="/_proxy/indexer"`;
  assert.deepEqual(extractUrls(dist).urls, ["/_proxy/indexer", "https://funding.praetorial.com", "https://sourcecheck.praetorial.com/sourcecheck"]);
  const r = compareBundles(live, dist);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.moved, [
    { from: "https://praetorial-funding-mainnet.acct.workers.dev", to: "https://funding.praetorial.com" },
    { from: "https://praetorial-sourcecheck-mainnet.acct.workers.dev/sourcecheck", to: "https://sourcecheck.praetorial.com/sourcecheck" },
  ]);
  // dropping a service is still refused, moved or not
  assert.deepEqual(compareBundles(live, `y="https://sourcecheck.praetorial.com/sourcecheck";z="/_proxy/indexer"`).missing, ["https://praetorial-funding-mainnet.acct.workers.dev"]);
  // a moved path must match exactly; a testnet Worker never maps to a mainnet host
  assert.deepEqual(compareBundles(`a="https://praetorial-sourcecheck-mainnet.acct.workers.dev/sourcecheck"`, `a="https://sourcecheck.praetorial.com/other"`).missing.length, 1);
  assert.deepEqual(compareBundles(`a="https://praetorial-funding-testnet.acct.workers.dev"`, `a="https://funding.praetorial.com"`).missing.length, 1);
});

test("DOM1: the deploy guard's live diff can read the legacy origin for the cutover deploy (GUARD_LIVE_ORIGIN)", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (u: string) => { seen.push(String(u)); return new Response("", { status: 503 }); }) as unknown as typeof fetch;
  const code = await runLiveDiff("/nonexistent-dist", { log: () => {}, fetchImpl, env: { GUARD_LIVE_ORIGIN: "https://legacy.example" } });
  assert.equal(code, 1);
  assert.equal(seen[0], "https://legacy.example/");
  const seen2: string[] = [];
  await runLiveDiff("/nonexistent-dist", { log: () => {}, fetchImpl: (async (u: string) => { seen2.push(String(u)); return new Response("", { status: 503 }); }) as any, env: {} });
  assert.equal(seen2[0], "https://praetorial.com/");
});
