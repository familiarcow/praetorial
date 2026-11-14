// Deploy-day check: runs checkMainnetReady on the six wrangler.toml files. Exit 1 listing findings, 0 if none.
// Usage: cd services && node --import tsx workers/scripts/check-mainnet-ready.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkMainnetReady, MAINNET_WORKERS } from "../common/src/mainnetReady.ts";

const WORKERS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const texts = {};
for (const n of MAINNET_WORKERS) {
  const f = path.join(WORKERS, n, "wrangler.toml");
  if (fs.existsSync(f)) texts[n] = fs.readFileSync(f, "utf8");
}
const findings = checkMainnetReady(texts);
for (const f of findings) console.log(`NOT READY  ${f}`);
console.log(findings.length ? `${findings.length} finding(s): mainnet config is NOT deploy-ready` : "mainnet config is deploy-ready (0 findings)");
process.exit(findings.length ? 1 : 0);
