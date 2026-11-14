// MAINPREP (4): the mainnet deploy guard (scripts/mainnetDeployGuard.ts) runs after build:mainnet and before wrangler deploy.
// It refuses when (a) lib/assetLimits.generated.ts is not current with the deploy-night args (release/mainnet-night/args.mainnet.json,
// else release/draft-args.mainnet.json with a loud WARNING), or (b) the built bundle (dist/assets/*.js) names a testnet account
// id (".testnet") or "praetorial-dev-1101", or lacks the mainnet escrow / intents ids.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { limitsArgsSource, checkLimits, scanBundle, runGuard, requiredMainnetUrls } from "../scripts/mainnetDeployGuard";
import { render, resolveArgs, DRAFT_LABEL } from "../scripts/genAssetLimits";

const here = dirname(fileURLToPath(import.meta.url));
const draftArgs = readFileSync(join(here, "../../../release/draft-args.mainnet.json"), "utf8");

// DEPLOYFIX: a clean mainnet bundle also carries every required mainnet service URL (funding Worker, sourcecheck, registry, proxies).
const URLS = requiredMainnetUrls().map((u) => `"${u.url}"`).join(";");
// A throwaway repo layout: <repo>/release/..., <repo>/apps/web/{lib,dist/assets}
function fakeRepo(opts: { night?: string; generated?: string; bundle?: Record<string, string> }) {
  const repo = mkdtempSync(join(tmpdir(), "mpguard-"));
  const web = join(repo, "apps/web");
  mkdirSync(join(repo, "release"), { recursive: true });
  mkdirSync(join(web, "lib"), { recursive: true });
  mkdirSync(join(web, "dist/assets"), { recursive: true });
  writeFileSync(join(repo, "release/draft-args.mainnet.json"), draftArgs);
  if (opts.night !== undefined) { mkdirSync(join(repo, "release/mainnet-night"), { recursive: true }); writeFileSync(join(repo, "release/mainnet-night/args.mainnet.json"), opts.night); }
  writeFileSync(join(web, "lib/assetLimits.generated.ts"), opts.generated ?? render(draftArgs));
  for (const [f, s] of Object.entries(opts.bundle ?? { "index-abc.js": `const a="bets.praetorial.near",b="intents.near";${URLS}` })) writeFileSync(join(web, "dist/assets", f), s);
  return { repo, web };
}
const nightArgs = () => { const a = JSON.parse(draftArgs); a.asset_limits[0][1].min_per_side = "20000000"; return JSON.stringify(a); };

test("limits source: night args when present, else draft with draft=true", () => {
  assert.deepEqual({ ...limitsArgsSource(fakeRepo({}).repo), path: undefined }, { path: undefined, label: "release/draft-args.mainnet.json", draft: true });
  const s = limitsArgsSource(fakeRepo({ night: nightArgs() }).repo);
  assert.equal(s.label, "release/mainnet-night/args.mainnet.json"); assert.equal(s.draft, false);
});

test("checkLimits: current file passes; stale vs night args refuses", () => {
  const ok = fakeRepo({});
  assert.equal(checkLimits(limitsArgsSource(ok.repo), join(ok.web, "lib/assetLimits.generated.ts")), null);
  const stale = fakeRepo({ night: nightArgs() });
  assert.match(String(checkLimits(limitsArgsSource(stale.repo), join(stale.web, "lib/assetLimits.generated.ts"))), /out of date.*mainnet-night/s);
  const fresh = fakeRepo({ night: nightArgs(), generated: render(nightArgs(), "release/mainnet-night/args.mainnet.json") });
  assert.equal(checkLimits(limitsArgsSource(fresh.repo), join(fresh.web, "lib/assetLimits.generated.ts")), null);
});

test("scanBundle: flags .testnet account ids and praetorial-dev-1101, file by file; requires the mainnet ids", () => {
  const { web } = fakeRepo({ bundle: {
    "index-1.js": 'x="bets.praetorial.near";y="intents.near";z="fee.praetorial-dev-1101.testnet";',
    "vendor-2.js": 'w="nep141:usdc.testnet";h="https://praetorial-indexer-testnet.familiarcow.workers.dev";n="https://testnet.nearblocks.io"',
  } });
  const r = scanBundle(join(web, "dist"));
  assert.deepEqual(r.hits.map((h) => `${h.file}:${h.match}`).sort(), ["index-1.js:fee.praetorial-dev-1101.testnet", "index-1.js:praetorial-dev-1101", "vendor-2.js:nep141:usdc.testnet"]);
  assert.deepEqual(r.missing, []);
  const bare = fakeRepo({ bundle: { "index.js": 'a="x.near"' } });
  assert.deepEqual(scanBundle(join(bare.web, "dist")).missing, ["bets.praetorial.near", "intents.near"]);
});

test("runGuard: clean draft repo passes with a loud DRAFT warning; testnet strings, stale limits or no bundle refuse", () => {
  const logs: string[] = []; const log = (s: string) => logs.push(s);
  assert.equal(runGuard(fakeRepo({}).repo, log), 0);
  assert.ok(logs.some((l) => /WARNING/.test(l) && /DRAFT/.test(l)), logs.join("\n"));
  assert.equal(runGuard(fakeRepo({ bundle: { "i.js": `"bets.praetorial.near";"intents.near";"alice.testnet";${URLS}` } }).repo, () => {}), 1);
  assert.equal(runGuard(fakeRepo({ night: nightArgs() }).repo, () => {}), 1);
  assert.equal(runGuard(fakeRepo({ bundle: {} }).repo, () => {}), 1);
  const nightLogs: string[] = [];
  assert.equal(runGuard(fakeRepo({ night: nightArgs(), generated: render(nightArgs(), "release/mainnet-night/args.mainnet.json") }).repo, (s) => nightLogs.push(s)), 0);
  assert.ok(!nightLogs.some((l) => /DRAFT/.test(l)));
});

test("gen:limits: default source is the draft args (unchanged); --args <file> / GEN_LIMITS_ARGS select another file", () => {
  assert.equal(DRAFT_LABEL, "release/draft-args.mainnet.json");
  assert.match(resolveArgs([], {}).path, /release\/draft-args\.mainnet\.json$/);
  assert.equal(resolveArgs([], {}).label, DRAFT_LABEL);
  const { repo } = fakeRepo({ night: nightArgs() });
  const p = join(repo, "release/mainnet-night/args.mainnet.json");
  assert.equal(resolveArgs(["--args", p], {}).path, p);
  assert.equal(resolveArgs([], { GEN_LIMITS_ARGS: p }).path, p);
  assert.equal(resolveArgs(["--args", p], {}).label, "release/mainnet-night/args.mainnet.json");
  assert.match(render(nightArgs(), "release/mainnet-night/args.mainnet.json"), /from release\/mainnet-night\/args\.mainnet\.json/);
  assert.match(render(nightArgs(), "release/mainnet-night/args.mainnet.json"), /minStakePerSide: "20000000"/);
  assert.throws(() => resolveArgs(["--args"], {}), /--args needs a file/);
});

test("scanBundle: minified property access (r.testnet, a.funding.chain.testnet) and testnet URL hosts are not account ids", () => {
  const { web } = fakeRepo({ bundle: {
    "v.js": '"bets.praetorial.near";"intents.near";x=r.testnet;y=l.funding.chain.testnet?1:0;u="https://explore.testnet.tempo.xyz";h="https://testnet.nearblocks.io"',
    "w.js": 'p="taker.testnet (optional)";q=`newref.testnet`;s=\'nep141:wrap.testnet\'',
  } });
  assert.deepEqual(scanBundle(join(web, "dist")).hits.map((h) => `${h.file}:${h.match}`), ["w.js:nep141:wrap.testnet", "w.js:newref.testnet", "w.js:taker.testnet"]);
});
