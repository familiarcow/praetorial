// LIVE1 deploy guard: fail when apps/web/lib/network.ts NETWORKS and the Workers' wrangler.toml disagree on the escrow / intents / registry
// ids or the Worker URLs (testnet = top-level [vars]; mainnet = [env.mainnet.vars] where present). Run before any testnet deploy
// (scripts/deploy-testnet.sh and apps/web `npm run deploy:testnet` both do).
// Usage (any cwd, plain node >= 23, no deps): node services/workers/scripts/check-config-drift.mjs [--repo <repo root>]
// Exit 0 = no drift; 1 = drift (one line per mismatch); 2 = cannot read the inputs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWranglerToml } from "../common/src/stackCheck.ts";
import { checkConfigDrift } from "../common/src/configDrift.ts";

const WORKERS_DEFAULT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let repo = path.resolve(WORKERS_DEFAULT, "../..");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--repo") repo = path.resolve(args[++i]);
  else { console.error(`unknown argument ${args[i]}`); process.exit(2); }
}
const workersDir = path.join(repo, "services/workers");
let networkTs, networkSelectTs, tomls;
try {
  networkTs = fs.readFileSync(path.join(repo, "apps/web/lib/network.ts"), "utf8");
  const sel = path.join(repo, "apps/web/lib/networkSelect.ts");
  networkSelectTs = fs.existsSync(sel) ? fs.readFileSync(sel, "utf8") : "";
  tomls = Object.fromEntries(fs.readdirSync(workersDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(workersDir, d.name, "wrangler.toml")))
    .map((d) => [d.name, fs.readFileSync(path.join(workersDir, d.name, "wrangler.toml"), "utf8")]));
} catch (e) { console.error(`config-drift: cannot read inputs under ${repo}: ${e.message}`); process.exit(2); }
if (Object.keys(tomls).length === 0) { console.error(`config-drift: no services/workers/*/wrangler.toml under ${repo}`); process.exit(2); }

const diffs = checkConfigDrift({ networkTs, networkSelectTs, tomls, parseToml: parseWranglerToml });
if (diffs.length) {
  console.error(`CONFIG DRIFT: apps/web/lib/network.ts vs services/workers/*/wrangler.toml (${diffs.length} mismatch${diffs.length === 1 ? "" : "es"}):`);
  for (const d of diffs) console.error(`  - ${d}`);
  console.error("Fix the stale side before deploying (the web build and every Worker must name the same contracts and Workers).");
  process.exit(1);
}
console.log(`config-drift OK: apps/web NETWORKS matches ${Object.keys(tomls).length} Worker wrangler.toml files (testnet + mainnet)`);
