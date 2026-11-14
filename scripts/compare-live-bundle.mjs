#!/usr/bin/env node
// DEPLOYFIX: read-only diff of the service URLs in a built web bundle (apps/web/dist) vs the LIVE mainnet web bundle.
// Exit 1 when the live bundle has a URL the local dist lacks (a redeploy would drop that service, e.g. 1Click funding).
// Exit 2 on usage / fetch errors (fail closed: an unreachable live site is not a pass). GETs only; no keys, no writes.
//
//   node scripts/compare-live-bundle.mjs [--dist apps/web/dist] [--origin https://praetorial.com]
//   node scripts/compare-live-bundle.mjs --live-dir <dir-of-saved-live-js> --dist <dist>     # offline (fixtures / saved copy)
//
// "Service URLs" (extractUrls): the values of the inlined `import.meta.env` object (VITE_*_URL etc.: Vite inlines it as one
// object literal starting {BASE_URL:"/",...}), plus every quoted *.workers.dev URL and every quoted same-origin "/_proxy/..." path.
// Third-party URLs inside vendor code (chain RPCs, docs links) are not ours and are ignored.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LIVE_MAINNET_ORIGIN = "https://praetorial.com";

const ENV_OBJECT = /\{BASE_URL:"[^"]*",[^{}]*\}/g;
const ENV_PAIR = /([A-Za-z_][A-Za-z0-9_]*):"((?:[^"\\]|\\.)*)"/g;
const WORKER_URL = /["'`](https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev(?:\/[A-Za-z0-9._~/-]*)?)["'`]/g;
// DOM1: the mainnet service hosts are <svc>.praetorial.com (custom domains); quoted ones are service URLs too.
const PRAETORIAL_URL = /["'`](https:\/\/[a-z0-9-]+\.praetorial\.com(?:\/[A-Za-z0-9._~/-]*)?)["'`]/g;
// DOM1: a live mainnet Worker URL on workers.dev ("https://praetorial-<svc>-mainnet.<account>.workers.dev<path>") is satisfied by the
// same path on its custom domain "https://<svc>.praetorial.com<path>" (the cutover), never by any other host or path.
const MAINNET_WORKERS_DEV = /^https:\/\/praetorial-([a-z]+)-mainnet\.[a-z0-9-]+\.workers\.dev(\/.*)?$/;
export function customDomainOf(url) {
  const m = url.match(MAINNET_WORKERS_DEV);
  return m ? `https://${m[1]}.praetorial.com${m[2] ?? ""}` : null;
}
const PROXY_PATH = /["'`](\/_proxy\/[A-Za-z0-9._~/?=&-]*)["'`]/g;
const isUrlish = (v) => /^https?:\/\//.test(v) || v.startsWith("/_proxy/");

/** { env: {VITE_X: value} (URL-ish values only, from every inlined env object), urls: sorted unique service URLs } */
export function extractUrls(text) {
  const env = {};
  const urls = new Set();
  for (const obj of text.match(ENV_OBJECT) ?? []) {
    for (const [, k, v] of obj.matchAll(ENV_PAIR)) if (k.startsWith("VITE_") && isUrlish(v)) { env[k] = v; urls.add(v); }
  }
  for (const re of [WORKER_URL, PRAETORIAL_URL, PROXY_PATH]) for (const [, u] of text.matchAll(re)) urls.add(u);
  return { env, urls: [...urls].sort() };
}

/** missing: in live, not in dist (refuse). extra: in dist only (info). envMoved: live env keys whose URL dist has, but not via env
 *  (e.g. VITE_FUNDING_URL now comes from the network table): info only, the URL is still shipped. moved (DOM1): live workers.dev
 *  mainnet Worker URLs that dist ships on their praetorial.com custom domain instead: info only, the service is still there. */
export function compareBundles(liveText, distText) {
  const live = extractUrls(liveText);
  const dist = extractUrls(distText);
  const has = new Set(dist.urls);
  const moved = [];
  const missing = live.urls.filter((u) => {
    if (has.has(u)) return false;
    const to = customDomainOf(u);
    if (to && has.has(to)) { moved.push({ from: u, to }); return false; }
    return true;
  });
  const movedTo = new Set(moved.map((m) => m.to));
  const extra = dist.urls.filter((u) => !live.urls.includes(u) && !movedTo.has(u));
  const envMoved = Object.keys(live.env).filter((k) => !(k in dist.env) && (has.has(live.env[k]) || has.has(customDomainOf(live.env[k]) ?? ""))).sort();
  return { live, dist, missing, extra, envMoved, moved };
}

/** Every .js under <dir>/assets (or <dir> itself if it has no assets/), plus index.html when present, concatenated. */
export function readBundleDir(dir) {
  const assets = existsSync(join(dir, "assets")) && statSync(join(dir, "assets")).isDirectory() ? join(dir, "assets") : dir;
  const files = existsSync(assets) ? readdirSync(assets).filter((f) => f.endsWith(".js")).sort() : [];
  if (!files.length) throw new Error(`no bundle: ${assets}/*.js is empty`);
  const html = existsSync(join(dir, "index.html")) ? readFileSync(join(dir, "index.html"), "utf8") : "";
  return { files, text: html + "\n" + files.map((f) => readFileSync(join(assets, f), "utf8")).join("\n") };
}

/** GET <origin>/, then every /assets/*.js it references, then every assets/*.js those reference (Vite's lazy-chunk lists), BFS.
 *  Read-only. Throws on any non-200 so the caller fails closed. */
export async function fetchLiveBundle(origin = LIVE_MAINNET_ORIGIN, fetchImpl = globalThis.fetch, maxFiles = 2000) {
  const get = async (url) => {
    const r = await fetchImpl(url, { headers: { "cache-control": "no-cache" } });
    if (!r.ok) throw new Error(`GET ${url}: HTTP ${r.status}`);
    return r.text();
  };
  const base = origin.replace(/\/+$/, "");
  const html = await get(`${base}/`);
  const ref = /(?:^|[^A-Za-z0-9_.-])\/?(assets\/[A-Za-z0-9_.-]+\.js)/g;
  const queue = [...new Set([...html.matchAll(ref)].map((m) => m[1]))];
  if (!queue.length) throw new Error(`GET ${base}/: no assets/*.js referenced (not the web app?)`);
  const seen = new Set(queue);
  const parts = [html];
  const files = [];
  while (queue.length) {
    const batch = queue.splice(0, 8); // 8 GETs at a time
    if (files.length + batch.length > maxFiles) throw new Error(`more than ${maxFiles} js files referenced; refusing`);
    const texts = await Promise.all(batch.map((p) => get(`${base}/${p}`)));
    batch.forEach((p, i) => {
      files.push(p.slice("assets/".length));
      parts.push(texts[i]);
      for (const m of texts[i].matchAll(ref)) if (!seen.has(m[1])) { seen.add(m[1]); queue.push(m[1]); }
    });
  }
  const entry = (html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/) ?? [])[1] ?? null;
  return { files: files.sort(), entry, text: parts.join("\n") };
}

export function formatReport(r, labels = { live: "live", dist: "dist" }) {
  const out = [];
  out.push(`${labels.live}: ${r.live.urls.length} service URL(s); ${labels.dist}: ${r.dist.urls.length}`);
  for (const [k, v] of Object.entries(r.live.env).sort()) out.push(`  ${labels.live} env ${k}=${v}`);
  const movedFrom = new Map((r.moved ?? []).map((m) => [m.from, m.to]));
  for (const u of r.live.urls) out.push(`  ${r.missing.includes(u) ? "MISSING" : movedFrom.has(u) ? "moved  " : "ok     "} ${u}${movedFrom.has(u) ? ` -> ${movedFrom.get(u)}` : ""}`);
  for (const u of r.extra) out.push(`  extra   ${u}   (in ${labels.dist} only)`);
  for (const k of r.envMoved) out.push(`  note    ${k} is not in ${labels.dist}'s env object, but its URL ${r.live.env[k]} is in ${labels.dist} (network table)`);
  out.push(r.missing.length ? `REFUSED: ${labels.dist} lacks ${r.missing.length} URL(s) the ${labels.live} bundle has: ${r.missing.join(" ")}`
    : `OK: ${labels.dist} has every service URL the ${labels.live} bundle has`);
  return out.join("\n");
}

export function parseArgs(argv) {
  const o = { dist: null, origin: LIVE_MAINNET_ORIGIN, liveDir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { const v = argv[++i]; if (!v) throw new Error(`${a} needs a value`); return v; };
    if (a === "--dist") o.dist = val();
    else if (a === "--origin") o.origin = val();
    else if (a === "--live-dir") o.liveDir = val();
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** Returns the exit code. */
export async function main(argv, { log = console.log, fetchImpl = globalThis.fetch, cwd = process.cwd() } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) { log(`usage error: ${e.message}`); return 2; }
  const here = fileURLToPath(new URL(".", import.meta.url));
  const distDir = o.dist ? resolve(cwd, o.dist) : join(here, "../apps/web/dist");
  let live, dist;
  try {
    dist = readBundleDir(distDir);
    if (o.liveDir) { const l = readBundleDir(resolve(cwd, o.liveDir)); live = { ...l, entry: null }; }
    else live = await fetchLiveBundle(o.origin, fetchImpl);
  } catch (e) { log(`ERROR: ${e.message}`); return 2; }
  log(`live: ${o.liveDir ?? o.origin} (${live.files.length} js${live.entry ? `, entry ${live.entry}` : ""}); dist: ${distDir} (${dist.files.length} js)`);
  const r = compareBundles(live.text, dist.text);
  log(formatReport(r));
  return r.missing.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
