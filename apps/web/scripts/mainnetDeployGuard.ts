// MAINPREP (4): mainnet deploy guard. `deploy:mainnet` = build:mainnet && this && wrangler deploy, so it runs on the BUILT bundle.
// Refuses (exit 1) when:
//  - lib/assetLimits.generated.ts is not current with the deploy-night args release/mainnet-night/args.mainnet.json
//    (if that file is missing it checks release/draft-args.mainnet.json and prints a loud WARNING: limits come from DRAFT args);
//  - dist/assets/*.js names a testnet account id ("<x>.testnet") or "praetorial-dev-1101";
//  - dist/assets/*.js lacks the mainnet escrow / intents ids, or there is no bundle at all;
//  - NAV1: dist/assets/*.js still names a mocked-e2e window seam (REFUSED_SEAMS; lib/testHooks.ts compiles them out of a mainnet
//    production build, so a hit means VITE_E2E_HOOKS=1 or a seam read that bypasses TEST_HOOKS_ENABLED);
//  - K0: dist/assets/*.js contains the /kit playground (KIT_MARKERS; only VITE_KIT=1 builds have it, lib/kitBuild.ts);
//  - DEPLOYFIX: dist/assets/*.js lacks a mainnet service URL (requiredMainnetUrls: funding Worker, sourcecheck Worker, registry Worker,
//    /_proxy/{indexer,relayer,registry}), or one of them is "" in the table (a redeploy would turn that service off);
//  - DEPLOYFIX (CLI only, runLiveDiff): the LIVE mainnet bundle has a service URL dist lacks (scripts/compare-live-bundle.mjs, GETs only).
//    Fails closed if the live site cannot be read; GUARD_SKIP_LIVE=1 skips it with a loud WARNING (first deploy / offline only).
//    DOM1: GUARD_LIVE_ORIGIN=<origin> compares against another live origin (the praetorial.com cutover deploy reads the workers.dev one).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { render, DRAFT_LABEL } from "./genAssetLimits";
import { NETWORKS } from "../lib/network";
import { MAINNET_SOURCECHECK_URL } from "../lib/networkSelect";
// @ts-ignore -- plain JS module (no types), run by tsx
import { compareBundles, fetchLiveBundle, formatReport, LIVE_MAINNET_ORIGIN } from "../../../scripts/compare-live-bundle.mjs";

const NIGHT_LABEL = "release/mainnet-night/args.mainnet.json";
export const REQUIRED_MAINNET_IDS = ["bets.praetorial.near", "intents.near"];
// A NEAR account id ending in .testnet (optionally nep141:-prefixed) that starts a string literal (so minified property access like
// `r.testnet` and URL hosts like "https://explore.testnet.x" are not flagged), and the testnet dev account anywhere.
const TESTNET_ID = /(?<=["'`])(?:nep141:)?[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.testnet(?![a-z0-9_.-])/g;
const DEV_ACCOUNT = /praetorial-dev-1101/g;
/** The window seams that let a page fake a signed-in wallet or bend services (lib/testHooks.ts E2E seams). */
export const REFUSED_SEAMS = ["__e2eTestWallet", "__e2eRegistryUrl", "__e2eDepositApi", "__e2eSourceCheckTimeoutMs", "__e2eConfirm", "e2e-wallet-changed", "__e2eSignSeam", "__e2eRenderCrash"];
const SEAM = new RegExp(REFUSED_SEAMS.join("|"), "g");
/** K0: the /kit playground (fixture bets, mocked network) must never ship in a mainnet bundle (src/kit/Playground.tsx KIT_MARKER). */
export const KIT_MARKERS = ["praetorial-kit-playground", "__kitNetworkMocked"];
const KIT = new RegExp(KIT_MARKERS.join("|"), "g");

/** DEPLOYFIX: every service URL the live mainnet bundle (2026-11-12, index-Cxt3Yv_k.js) carries, from the one source each has
 *  (network table / networkSelect / build:mainnet's proxy paths). Each must appear as a quoted literal in dist/assets/*.js. */
export function requiredMainnetUrls(): Array<{ name: string; url: string }> {
  const m = NETWORKS.mainnet;
  return [
    { name: "funding Worker (1Click Add money / Cash out / Convert)", url: m.fundingUrl },
    { name: "sourcecheck Worker", url: MAINNET_SOURCECHECK_URL },
    { name: "registry Worker", url: m.registryUrl },
    { name: "indexer proxy", url: "/_proxy/indexer" },
    { name: "relayer proxy", url: "/_proxy/relayer" },
    { name: "registry proxy", url: "/_proxy/registry" },
  ];
}

export interface ArgsSource { path: string; label: string; draft: boolean }

export function limitsArgsSource(repo: string): ArgsSource {
  const night = join(repo, NIGHT_LABEL);
  return existsSync(night) ? { path: night, label: NIGHT_LABEL, draft: false } : { path: join(repo, DRAFT_LABEL), label: DRAFT_LABEL, draft: true };
}

/** null when the generated limits file equals what gen:limits would write from `src`; otherwise the refusal reason. */
export function checkLimits(src: ArgsSource, generatedPath: string): string | null {
  const want = render(readFileSync(src.path, "utf8"), src.label);
  const have = existsSync(generatedPath) ? readFileSync(generatedPath, "utf8") : "";
  return have === want ? null
    : `lib/assetLimits.generated.ts is out of date vs ${src.label}: run \`npm run gen:limits -- --args ${src.path}\``;
}

export interface ScanResult { files: string[]; hits: Array<{ file: string; match: string }>; missing: string[]; seams: Array<{ file: string; match: string }>; kit: Array<{ file: string; match: string }>; missingUrls: Array<{ name: string; url: string }> }

export function scanBundle(distDir: string, urls: Array<{ name: string; url: string }> = requiredMainnetUrls()): ScanResult {
  const dir = join(distDir, "assets");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".js")).sort() : [];
  const hits: ScanResult["hits"] = [];
  const seams: ScanResult["seams"] = [];
  const kit: ScanResult["kit"] = [];
  let all = "";
  for (const f of files) {
    const s = readFileSync(join(dir, f), "utf8");
    all += s;
    const seen = new Set<string>();
    for (const re of [TESTNET_ID, DEV_ACCOUNT]) for (const m of s.matchAll(re)) seen.add(m[0]);
    for (const match of [...seen].sort()) hits.push({ file: f, match });
    for (const match of [...new Set([...s.matchAll(SEAM)].map((m) => m[0]))].sort()) seams.push({ file: f, match });
    for (const match of [...new Set([...s.matchAll(KIT)].map((m) => m[0]))].sort()) kit.push({ file: f, match });
  }
  // An empty required URL is itself a refusal (the table lost it), never a vacuous `includes('""')` pass.
  const missingUrls = urls.filter((u) => !u.url || !files.length || !all.includes(`"${u.url}"`));
  return { files, hits, seams, kit, missingUrls, missing: files.length ? REQUIRED_MAINNET_IDS.filter((id) => !all.includes(`"${id}"`)) : [...REQUIRED_MAINNET_IDS] };
}

/** Returns the process exit code. `repo` is the repository root (apps/web lives at <repo>/apps/web). */
export function runGuard(repo: string, log: (s: string) => void = console.log): number {
  const web = join(repo, "apps/web");
  const errs: string[] = [];
  const src = limitsArgsSource(repo);
  if (src.draft) {
    log("!".repeat(78));
    log(`WARNING: ${NIGHT_LABEL} not found -- asset limits are checked against DRAFT args (${DRAFT_LABEL}).`);
    log("WARNING: the web's per-asset limits come from DRAFT args, not the args the mainnet escrow was deployed with.");
    log("!".repeat(78));
  }
  const lim = checkLimits(src, join(web, "lib/assetLimits.generated.ts"));
  if (lim) errs.push(lim); else log(`limits: lib/assetLimits.generated.ts is current with ${src.label}`);
  const scan = scanBundle(join(web, "dist"));
  if (!scan.files.length) errs.push("no bundle: dist/assets/*.js is empty -- run `npm run build:mainnet` first");
  for (const h of scan.hits) errs.push(`testnet id in bundle: dist/assets/${h.file}: ${h.match}`);
  for (const h of scan.seams) errs.push(`test-only seam in bundle (fake wallet / mocked services): dist/assets/${h.file}: ${h.match}`);
  for (const h of scan.kit) errs.push(`/kit playground in bundle (VITE_KIT=1 build): dist/assets/${h.file}: ${h.match}`);
  for (const m of scan.missing) if (scan.files.length) errs.push(`mainnet id missing from bundle: "${m}"`);
  for (const u of scan.missingUrls) if (scan.files.length) errs.push(u.url ? `mainnet service URL missing from bundle (${u.name}): "${u.url}"` : `mainnet service URL is EMPTY in the network table (${u.name})`);
  if (scan.files.length && !scan.hits.length && !scan.seams.length && !scan.kit.length && !scan.missing.length) log(`bundle: ${scan.files.length} js file(s), no testnet ids, no test seams, mainnet ids present`);
  if (scan.files.length && !scan.missingUrls.length) log(`urls: all ${requiredMainnetUrls().length} mainnet service URLs present (${requiredMainnetUrls().map((u) => u.url).join(" ")})`);
  for (const e of errs) log(`REFUSED: ${e}`);
  return errs.length ? 1 : 0;
}

/** DEPLOYFIX: dist vs the LIVE mainnet bundle (read-only GETs). 0 = dist has every service URL live has; 1 = refuse. An unreadable
 *  live site refuses too, unless env.GUARD_SKIP_LIVE === "1" (loud WARNING; for the very first deploy or an offline dry run). */
export async function runLiveDiff(distDir: string, o: { log?: (s: string) => void; fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; origin?: string } = {}): Promise<number> {
  const log = o.log ?? console.log;
  const env = o.env ?? process.env;
  if (env.GUARD_SKIP_LIVE === "1") {
    log("!".repeat(78));
    log("WARNING: GUARD_SKIP_LIVE=1 -- dist was NOT compared with the live mainnet bundle (scripts/compare-live-bundle.mjs).");
    log("!".repeat(78));
    return 0;
  }
  // DOM1: GUARD_LIVE_ORIGIN reads another live origin (the cutover deploy: the legacy workers.dev origin, before praetorial.com serves the app).
  const origin = o.origin ?? (env.GUARD_LIVE_ORIGIN || LIVE_MAINNET_ORIGIN);
  let live: { text: string; files: string[]; entry: string | null };
  try { live = await fetchLiveBundle(origin, o.fetchImpl ?? fetch); } catch (e) {
    log(`REFUSED: cannot read the live mainnet bundle at ${origin} (${(e as Error).message}); set GUARD_SKIP_LIVE=1 only if there is no live site yet`);
    return 1;
  }
  const dir = join(distDir, "assets");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".js")).sort() : [];
  const html = existsSync(join(distDir, "index.html")) ? readFileSync(join(distDir, "index.html"), "utf8") : "";
  const r = compareBundles(live.text, html + "\n" + files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n"));
  log(`live diff: ${origin} (${live.files.length} js, entry ${live.entry}) vs dist (${files.length} js)`);
  log(formatReport(r, { live: "live", dist: "dist" }));
  return r.missing.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  const offline = runGuard(repo);
  // The live diff runs even when the offline checks refused, so the operator sees every problem at once.
  runLiveDiff(join(repo, "apps/web/dist")).then((liveCode) => { process.exitCode = offline || liveCode; });
}
