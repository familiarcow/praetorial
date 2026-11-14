// DEPLOYFIX: scripts/compare-live-bundle.mjs (dist vs the live mainnet bundle), the guard's required mainnet URLs + live diff
// (scripts/mainnetDeployGuard.ts) and the post-deploy check (scripts/postDeployCheck.ts). Fixtures (tests/fixtures/deployfix):
//   live/         verbatim excerpts of the live mainnet bundle of 2026-11-12 (index-Cxt3Yv_k.js; it HAS VITE_FUNDING_URL)
//   dist-prefix/  what build:mainnet produced before DEPLOYFIX (no funding URL)       -> must be refused
//   dist-fixed/   what it produces now (funding URL from the network table, not env)  -> must pass
// No network: every fetch is a stub serving the fixture files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore -- plain JS module (no types), run by tsx
import { extractUrls, compareBundles, readBundleDir, fetchLiveBundle, main, parseArgs, LIVE_MAINNET_ORIGIN } from "../../../scripts/compare-live-bundle.mjs";
import { requiredMainnetUrls, scanBundle, runGuard, runLiveDiff } from "../scripts/mainnetDeployGuard";
import { postDeployCheck } from "../scripts/postDeployCheck";
import { render } from "../scripts/genAssetLimits";

const FX = new URL("./fixtures/deployfix/", import.meta.url).pathname;
const FUNDING = "https://funding.praetorial.com";
const LIVE_URLS = [
  "/_proxy/indexer", "/_proxy/kraken/0/public/AssetPairs", "/_proxy/registry", "/_proxy/relayer", FUNDING,
  "https://praetorial-sourcecheck-testnet.familiarcow.workers.dev/sourcecheck",
  "https://registry.praetorial.com",
  "https://sourcecheck.praetorial.com/sourcecheck",
];
const text = (dir: string) => readBundleDir(join(FX, dir)).text as string;

/** A fetch stub that serves a directory as a website (GET only); `drop` paths return 404. */
function siteFetch(dir: string, drop: string[] = []) {
  const calls: Array<{ url: string; method: string }> = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    const path = new URL(url).pathname.replace(/^\/$/, "/index.html");
    if (drop.includes(path)) return new Response("nope", { status: 404 });
    try { return new Response(readFileSync(join(dir, path)), { status: 200 }); } catch { return new Response("nope", { status: 404 }); }
  };
  return { fetch: f as unknown as typeof fetch, calls };
}

test("extractUrls: the live bundle's env object and every service URL (third-party vendor URLs ignored)", () => {
  const r = extractUrls(text("live"));
  assert.deepEqual(r.env, {
    VITE_FUNDING_URL: FUNDING, VITE_INDEXER_URL: "/_proxy/indexer", VITE_REGISTRY_URL: "/_proxy/registry", VITE_RELAYER_URL: "/_proxy/relayer",
    VITE_SOURCECHECK_URL: "https://sourcecheck.praetorial.com/sourcecheck",
  });
  assert.deepEqual(r.urls, LIVE_URLS);
  assert.ok(!r.urls.some((u: string) => /fastnear|linea/.test(u)), "chain RPCs in vendor code are not ours");
});

test("compare: the pre-DEPLOYFIX build lacks exactly the funding URL; the fixed build has every live URL (funding moved env -> table)", () => {
  const pre = compareBundles(text("live"), text("dist-prefix"));
  assert.deepEqual(pre.missing, [FUNDING]);
  const fixed = compareBundles(text("live"), text("dist-fixed"));
  assert.deepEqual(fixed.missing, []);
  assert.deepEqual(fixed.extra, []);
  assert.deepEqual(fixed.envMoved, ["VITE_FUNDING_URL"]);
});

test("compare-live-bundle CLI (--live-dir, offline): exit 1 + MISSING for the pre-fix dist, exit 0 for the fixed dist, exit 2 on bad input", async () => {
  const logs: string[] = [];
  assert.equal(await main(["--live-dir", join(FX, "live"), "--dist", join(FX, "dist-prefix")], { log: (s: string) => logs.push(s) }), 1);
  assert.match(logs.join("\n"), new RegExp(`MISSING ${FUNDING}`));
  assert.match(logs.join("\n"), /REFUSED: dist lacks 1 URL/);
  const ok: string[] = [];
  assert.equal(await main(["--live-dir", join(FX, "live"), "--dist", join(FX, "dist-fixed")], { log: (s: string) => ok.push(s) }), 0);
  assert.match(ok.join("\n"), /OK: dist has every service URL the live bundle has/);
  assert.equal(await main(["--dist", join(FX, "nope")], { log: () => {}, fetchImpl: siteFetch(join(FX, "live")).fetch }), 2);
  assert.equal(await main(["--bogus"], { log: () => {} }), 2);
  assert.throws(() => parseArgs(["--dist"]), /needs a value/);
  assert.equal(parseArgs([]).origin, LIVE_MAINNET_ORIGIN);
  assert.equal(LIVE_MAINNET_ORIGIN, "https://praetorial.com");
});

test("fetchLiveBundle: GETs only, crawls index.html -> entry -> lazy chunks; any non-200 throws (fail closed)", async () => {
  const s = siteFetch(join(FX, "live"));
  const live = await fetchLiveBundle("https://w.example/", s.fetch);
  assert.equal(live.entry, "index-Cxt3Yv_k.js");
  assert.deepEqual(live.files, ["MarketList-Bq1x.js", "index-Cxt3Yv_k.js"]);
  assert.deepEqual(s.calls.map((c) => c.url), ["https://w.example/", "https://w.example/assets/index-Cxt3Yv_k.js", "https://w.example/assets/MarketList-Bq1x.js"]);
  assert.ok(s.calls.every((c) => c.method === "GET"));
  assert.deepEqual(extractUrls(live.text).urls, LIVE_URLS);
  await assert.rejects(fetchLiveBundle("https://w.example", siteFetch(join(FX, "live"), ["/assets/MarketList-Bq1x.js"]).fetch), /HTTP 404/);
  await assert.rejects(fetchLiveBundle("https://w.example", siteFetch(join(FX, "dist-fixed")).fetch), /HTTP 404/);
  // CLI over the network stub: same verdicts as offline.
  assert.equal(await main(["--origin", "https://w.example", "--dist", join(FX, "dist-prefix")], { log: () => {}, fetchImpl: s.fetch }), 1);
  assert.equal(await main(["--origin", "https://w.example", "--dist", join(FX, "dist-fixed")], { log: () => {}, fetchImpl: s.fetch }), 0);
});

test("guard: requiredMainnetUrls is exactly the live bundle's mainnet service URLs, each non-empty; funding first", () => {
  const req = requiredMainnetUrls();
  assert.deepEqual(req.map((u) => u.url), [
    FUNDING, "https://sourcecheck.praetorial.com/sourcecheck", "https://registry.praetorial.com",
    "/_proxy/indexer", "/_proxy/relayer", "/_proxy/registry",
  ]);
  const live = extractUrls(text("live")).urls;
  for (const u of req) assert.ok(u.url && live.includes(u.url), `${u.name} ${u.url} is in the live bundle`);
});

test("guard scanBundle: refuses the pre-fix dist (funding missing), passes the fixed dist; an EMPTY required URL is a refusal", () => {
  assert.deepEqual(scanBundle(join(FX, "dist-prefix")).missingUrls.map((u) => u.url), [FUNDING]);
  assert.deepEqual(scanBundle(join(FX, "dist-fixed")).missingUrls, []);
  assert.deepEqual(scanBundle(join(FX, "dist-fixed"), [{ name: "funding", url: "" }]).missingUrls, [{ name: "funding", url: "" }]);
  const empty = mkdtempSync(join(tmpdir(), "dfx-empty-"));
  assert.equal(scanBundle(empty).missingUrls.length, requiredMainnetUrls().length, "no bundle = every URL missing");
});

const draftArgs = readFileSync(new URL("../../../release/draft-args.mainnet.json", import.meta.url), "utf8");
function repoWithDist(distFixture: string) {
  const repo = mkdtempSync(join(tmpdir(), "dfx-guard-"));
  mkdirSync(join(repo, "release"), { recursive: true });
  mkdirSync(join(repo, "apps/web/lib"), { recursive: true });
  writeFileSync(join(repo, "release/draft-args.mainnet.json"), draftArgs);
  writeFileSync(join(repo, "apps/web/lib/assetLimits.generated.ts"), render(draftArgs));
  cpSync(join(FX, distFixture), join(repo, "apps/web/dist"), { recursive: true });
  return repo;
}

test("guard runGuard: the pre-fix dist is REFUSED naming the funding Worker; the fixed dist passes", () => {
  const logs: string[] = [];
  assert.equal(runGuard(repoWithDist("dist-prefix"), (s) => logs.push(s)), 1);
  assert.ok(logs.some((l) => /REFUSED: mainnet service URL missing from bundle \(funding Worker/.test(l) && l.includes(FUNDING)), logs.join("\n"));
  const ok: string[] = [];
  assert.equal(runGuard(repoWithDist("dist-fixed"), (s) => ok.push(s)), 0, ok.join("\n"));
  assert.ok(ok.some((l) => /urls: all 6 mainnet service URLs present/.test(l)), ok.join("\n"));
});

test("guard runLiveDiff: refuses a dist missing a live URL, passes the fixed dist, fails closed when live is unreadable; GUARD_SKIP_LIVE=1 warns", async () => {
  const site = siteFetch(join(FX, "live")).fetch;
  const o = { fetchImpl: site, env: {}, origin: "https://w.example" };
  const pre: string[] = [];
  assert.equal(await runLiveDiff(join(FX, "dist-prefix"), { ...o, log: (s) => pre.push(s) }), 1);
  assert.match(pre.join("\n"), new RegExp(`MISSING ${FUNDING}`));
  assert.equal(await runLiveDiff(join(FX, "dist-fixed"), { ...o, log: () => {} }), 0);
  const down: string[] = [];
  assert.equal(await runLiveDiff(join(FX, "dist-fixed"), { ...o, fetchImpl: siteFetch(join(FX, "nope")).fetch, log: (s) => down.push(s) }), 1);
  assert.match(down.join("\n"), /REFUSED: cannot read the live mainnet bundle/);
  const skip: string[] = [];
  let fetched = false;
  assert.equal(await runLiveDiff(join(FX, "dist-prefix"), { ...o, env: { GUARD_SKIP_LIVE: "1" }, fetchImpl: (async () => { fetched = true; return new Response(""); }) as unknown as typeof fetch, log: (s) => skip.push(s) }), 0);
  assert.equal(fetched, false);
  assert.match(skip.join("\n"), /WARNING: GUARD_SKIP_LIVE=1/);
});

test("post-deploy check: live bundle with funding passes; a live bundle without it FAILS (exit 1); unreadable site exit 2", async () => {
  const ok: string[] = [];
  assert.equal(await postDeployCheck({ origin: "https://w.example", fetchImpl: siteFetch(join(FX, "live")).fetch, log: (s) => ok.push(s) }), 0, ok.join("\n"));
  assert.match(ok.join("\n"), new RegExp(`PASS funding Worker .*${FUNDING}`));
  // A site serving the pre-fix build (what `deploy:mainnet` used to ship).
  const site = mkdtempSync(join(tmpdir(), "dfx-site-"));
  cpSync(join(FX, "dist-prefix"), site, { recursive: true });
  writeFileSync(join(site, "index.html"), `<script type="module" src="/assets/${readdirSync(join(site, "assets"))[0]}"></script>`);
  const bad: string[] = [];
  assert.equal(await postDeployCheck({ origin: "https://w.example", fetchImpl: siteFetch(site).fetch, log: (s) => bad.push(s) }), 1);
  assert.match(bad.join("\n"), /FAIL funding Worker/);
  assert.match(bad.join("\n"), /LIVE CHECK FAILED/);
  assert.equal(await postDeployCheck({ origin: "https://w.example", fetchImpl: siteFetch(join(FX, "nope")).fetch, log: () => {} }), 2);
});

test("package.json: check:live:mainnet runs the post-deploy check; deploy:mainnet still runs the guard (which now includes the live diff)", () => {
  const s = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> }).scripts;
  assert.equal(s["check:live:mainnet"], "tsx scripts/postDeployCheck.ts");
  assert.match(s["deploy:mainnet"]!, / && tsx scripts\/mainnetDeployGuard\.ts && wrangler deploy/);
  const guard = readFileSync(new URL("../scripts/mainnetDeployGuard.ts", import.meta.url), "utf8");
  assert.match(guard, /runLiveDiff\(join\(repo, "apps\/web\/dist"\)\)/, "the CLI entry runs the live diff");
});
