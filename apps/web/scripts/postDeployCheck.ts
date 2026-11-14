// DEPLOYFIX: post-deploy check (read-only; the PM runs it right after `npm run deploy:mainnet`):
//   cd apps/web && npm run check:live:mainnet            # [--origin <url>]
// GETs the LIVE mainnet web (index.html + every assets/*.js it references, scripts/compare-live-bundle.mjs fetchLiveBundle) and
// exits 1 unless the bundle carries every mainnet service URL the deploy guard requires (requiredMainnetUrls: the funding Worker
// first, so 1Click Add money / Cash out / Convert is on), plus the escrow/intents ids. Exit 2 if the site cannot be read.
import { fileURLToPath } from "node:url";
import { requiredMainnetUrls, REQUIRED_MAINNET_IDS } from "./mainnetDeployGuard";
// @ts-ignore -- plain JS module (no types), run by tsx
import { fetchLiveBundle, extractUrls, LIVE_MAINNET_ORIGIN } from "../../../scripts/compare-live-bundle.mjs";

export async function postDeployCheck(o: { origin?: string; fetchImpl?: typeof fetch; log?: (s: string) => void } = {}): Promise<number> {
  const log = o.log ?? console.log;
  const origin = o.origin ?? LIVE_MAINNET_ORIGIN;
  let live: { text: string; files: string[]; entry: string | null };
  try { live = await fetchLiveBundle(origin, o.fetchImpl ?? fetch); } catch (e) {
    log(`FAIL: cannot read the live bundle at ${origin}: ${(e as Error).message}`);
    return 2;
  }
  log(`live: ${origin} entry ${live.entry} (${live.files.length} js)`);
  const env = extractUrls(live.text).env as Record<string, string>;
  for (const [k, v] of Object.entries(env).sort()) log(`  env ${k}=${v}`);
  const fails: string[] = [];
  for (const u of requiredMainnetUrls()) {
    const ok = !!u.url && live.text.includes(`"${u.url}"`);
    log(`  ${ok ? "PASS" : "FAIL"} ${u.name}: ${u.url || "(empty in the network table)"}`);
    if (!ok) fails.push(u.name);
  }
  for (const id of REQUIRED_MAINNET_IDS) {
    const ok = live.text.includes(`"${id}"`);
    log(`  ${ok ? "PASS" : "FAIL"} mainnet id ${id}`);
    if (!ok) fails.push(id);
  }
  log(fails.length ? `LIVE CHECK FAILED: ${fails.join(", ")} missing from the live mainnet bundle -- redeploy from a build that passes guard:mainnet`
    : `live check OK: funding + every mainnet service URL present`);
  return fails.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf("--origin");
  postDeployCheck({ origin: i > 0 ? process.argv[i + 1] : undefined }).then((c) => { process.exitCode = c; });
}
