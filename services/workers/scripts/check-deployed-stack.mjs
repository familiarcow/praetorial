// STACK1: prove from the LIVE deployment that every Worker points at the frozen build (GET /health on each of the eight Workers, F1 added funding).
// Usage: cd services && node --import tsx workers/scripts/check-deployed-stack.mjs [--network testnet] [--release release/freeze-candidate-2.json]
//        [--subdomain familiarcow] [--url <service>=<url> ...]
// One PASS/FAIL line per Worker; exit 1 on any FAIL (unreachable, wrong escrow id vs the release record, wrong network, git_sha unknown,
// or a cron Worker's last_tick_at older than 3x its cron interval).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkerSpecs, releaseEscrowId, runStackCheck, STACK_WORKERS } from "../common/src/stackCheck.ts";

const WORKERS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(WORKERS, "../..");
const args = process.argv.slice(2);
const opt = { network: "testnet", release: path.join(REPO, "release/freeze-candidate-2.json"), subdomain: process.env.WORKERS_SUBDOMAIN || "familiarcow", urls: {} };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--network") opt.network = args[++i];
  else if (a === "--release") opt.release = path.resolve(args[++i]);
  else if (a === "--subdomain") opt.subdomain = args[++i];
  else if (a === "--url") { const [k, ...v] = String(args[++i]).split("="); opt.urls[k] = v.join("="); }
  else { console.error(`unknown argument ${a}`); process.exit(1); }
}
if (!["testnet", "mainnet"].includes(opt.network)) { console.error(`--network must be testnet or mainnet, got ${opt.network}`); process.exit(1); }

let release;
try { release = JSON.parse(fs.readFileSync(opt.release, "utf8")); } catch (e) { console.error(`cannot read release record ${opt.release}: ${e.message}`); process.exit(1); }
const tomls = Object.fromEntries(STACK_WORKERS.map((n) => [n, fs.readFileSync(path.join(WORKERS, n, "wrangler.toml"), "utf8")]));
const { specs } = buildWorkerSpecs(tomls, opt.network, opt.subdomain, opt.urls);
const expectedEscrow = releaseEscrowId(release, opt.network);
console.log(`deployed-stack check: network=${opt.network} release=${path.relative(REPO, opt.release)} expected escrow=${expectedEscrow ?? "(none in release record)"}`);
const r = await runStackCheck({ network: opt.network, expectedEscrow, specs, fetchImpl: fetch, nowMs: Date.now() });
for (const l of r.lines) console.log(l);
console.log(r.exitCode === 0 ? `deployed stack OK (${r.lines.length}/${r.lines.length} PASS)` : `deployed stack check FAILED (${r.results.filter((l) => !l.ok).length} of ${r.lines.length} FAIL)`);
process.exit(r.exitCode);
