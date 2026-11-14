// WKMAIN1b: pure deploy-day check for the six Worker wrangler.toml files ([env.mainnet] sections).
// Returns a list of human-readable findings; empty = ready. Used by scripts/check-mainnet-ready.mjs and unit-tested.
import { parseWranglerToml } from "./stackCheck.js";
export const MAINNET_WORKERS = ["keeper", "relayer", "monitor", "notifier", "indexer", "registry", "sourcecheck", "funding"] as const;
/** F1 (D-FUND4a): the 6 bet tokens (release/mainnet-night/args.mainnet.json asset_limits); funding may only land these. */
export const MAINNET_BET_TOKENS = ["nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "nep141:usdt.tether-token.near", "nep141:wrap.near", "nep141:btc.omft.near", "nep141:eth.omft.near", "nep141:zec.omft.near"] as const;
/** DOM1: the mainnet web is https://praetorial.com (www 301s to it). The workers.dev origin stays allowed until the cutover is confirmed. */
export const LEGACY_MAINNET_WEB_ORIGIN = "https://praetorial-web-mainnet.familiarcow.workers.dev"; // DOM1: TODO-REMOVE after the praetorial.com cutover
/** Browser origins of the mainnet web; every cross-origin Worker (funding, sourcecheck) must allow each one. */
export const MAINNET_WEB_ORIGINS = ["https://praetorial.com", "https://www.praetorial.com", LEGACY_MAINNET_WEB_ORIGIN] as const;
/** DOM1: the mainnet Workers with public HTTP and their custom-domain host. monitor/notifier are private (keeper's /health/<svc>). */
export const MAINNET_PUBLIC_HOSTS = {
  indexer: "indexer.praetorial.com", relayer: "relayer.praetorial.com", registry: "registry.praetorial.com",
  funding: "funding.praetorial.com", sourcecheck: "sourcecheck.praetorial.com", keeper: "keeper.praetorial.com",
} as const;
/** MAINPREP1: accounts whose NEAR balance must be watched (LIVE1: an empty relayer silently broke every relayed action). */
const CREDIT_WATCH_REQUIRED = ["relayer.praetorial.near", "keeper.praetorial.near"];
/** KEYS2 (D-KEYS2): the mainnet escrow contract and fee account. escrow./fee./secrets.praetorial.near are lost (keys never kept). */
export const MAINNET_ESCROW = "bets.praetorial.near";
export const MAINNET_FEE_ACCOUNT = "praetorial.near";
const LOST_ACCOUNTS = /\b(escrow|fee|secrets)\.praetorial\.near\b/;
/** D-RLY1a: mainnet relayer global daily spend cap, 1.4 NEAR. */
export const MAINNET_RELAYER_GLOBAL_DAILY_BUDGET_YOCTO = "1400000000000000000000000";
const host = (u: string): string => { try { return new URL(u).host; } catch { return u; } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isHeader = (l: string) => /^\s*\[/.test(l);
const isMainnetHeader = (l: string) => /^\s*\[\[?env\.mainnet[\].]/.test(l);
export const mainnetSection = (t: string): string => {
  let take = false;
  return t.split("\n").filter((l) => { if (isHeader(l)) take = isMainnetHeader(l); return take; }).join("\n");
};
const uncommented = (t: string) => t.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

export interface MainnetReadyOptions { /** Browser origins the web is served from (default MAINNET_WEB_ORIGINS). */ webOrigins?: readonly string[] }

export function checkMainnetReady(tomlTexts: Record<string, string>, opts: MainnetReadyOptions = {}): string[] {
  const webOrigins = opts.webOrigins ?? MAINNET_WEB_ORIGINS;
  const out: string[] = [];
  for (const n of MAINNET_WORKERS) {
    const t = tomlTexts[n];
    if (t === undefined) { out.push(`${n}: wrangler.toml missing`); continue; }
    if (!/^\[env\.mainnet\]/m.test(t)) { out.push(`${n}: no [env.mainnet] section`); continue; }
    const raw = mainnetSection(t);
    const sec = uncommented(raw);
    for (const ph of new Set(t.match(/DEPLOY_DAY_[A-Z0-9_]+/g) ?? [])) out.push(`${n}: ${ph} placeholder remains`);
    if (/REPLACE_/.test(raw)) out.push(`${n}: REPLACE_ placeholder in [env.mainnet]`);
    if (/testnet/i.test(raw)) out.push(`${n}: [env.mainnet] mentions testnet`);
    const lost = LOST_ACCOUNTS.exec(raw)?.[0];
    if (lost) out.push(`${n}: [env.mainnet] names the lost account ${lost} (D-KEYS2: escrow is ${MAINNET_ESCROW}, fee account ${MAINNET_FEE_ACCOUNT})`);
    if (/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}|\d{8,}:[A-Za-z0-9_-]{30,}/.test(raw)) out.push(`${n}: key or token material in [env.mainnet]`);
    if (n === "indexer" || n === "registry") {
      const id = /^database_id\s*=\s*"([^"]*)"/m.exec(sec)?.[1];
      if (id === undefined) out.push(`${n}: [env.mainnet] has no database_id`);
      else if (!UUID.test(id) && !/^DEPLOY_DAY_/.test(id)) out.push(`${n}: [env.mainnet] database_id is not a uuid`);
    }
    const parsed = parseWranglerToml(t, "mainnet");
    const wantHost = (MAINNET_PUBLIC_HOSTS as Record<string, string>)[n];
    if (wantHost && !(parsed.customDomains.length === 1 && parsed.customDomains[0] === wantHost)) out.push(`${n}: [env.mainnet] needs routes = [{ pattern = "${wantHost}", custom_domain = true }] (DOM1; got ${JSON.stringify(parsed.customDomains)})`);
    if (wantHost && !parsed.workersDev) out.push(`${n}: [env.mainnet] needs workers_dev = true for this release (DOM1 rollback path)`);
    out.push(...nightChecks(n, parsed.vars, webOrigins));
  }
  return out;
}

/** MAINPREP1: per-Worker [env.mainnet.vars] checks for things the code silently defaults to testnet values or leaves unwatched. */
function nightChecks(n: string, v: Record<string, string>, webOrigins: readonly string[]): string[] {
  const out: string[] = [];
  if (v.NEAR_NETWORK_ID !== "mainnet") out.push(`${n}: [env.mainnet.vars] NEAR_NETWORK_ID must be "mainnet" (got ${JSON.stringify(v.NEAR_NETWORK_ID ?? null)})`);
  if (v.ESCROW_CONTRACT_ID !== undefined && v.ESCROW_CONTRACT_ID !== MAINNET_ESCROW) out.push(`${n}: [env.mainnet.vars] ESCROW_CONTRACT_ID must be ${MAINNET_ESCROW} (D-KEYS2; got ${JSON.stringify(v.ESCROW_CONTRACT_ID)})`);
  if (n === "relayer" && v.RELAYER_GLOBAL_DAILY_BUDGET_YOCTO !== MAINNET_RELAYER_GLOBAL_DAILY_BUDGET_YOCTO) out.push(`relayer: [env.mainnet.vars] RELAYER_GLOBAL_DAILY_BUDGET_YOCTO must be ${MAINNET_RELAYER_GLOBAL_DAILY_BUDGET_YOCTO} (1.4 NEAR/day, D-RLY1a; got ${JSON.stringify(v.RELAYER_GLOBAL_DAILY_BUDGET_YOCTO ?? null)})`);
  if (n === "monitor") {
    if (v.FEE_ACCOUNT_ID !== MAINNET_FEE_ACCOUNT) out.push(`monitor: [env.mainnet.vars] FEE_ACCOUNT_ID must be ${MAINNET_FEE_ACCOUNT} (D-KEYS2; got ${JSON.stringify(v.FEE_ACCOUNT_ID ?? null)})`);
    if (!v.USDC_TOKEN_ID?.startsWith("nep141:")) out.push(`monitor: USDC_TOKEN_ID must be the intents id with the nep141: prefix (mt_balance_of on intents.near returns "0" for a bare contract id)`);
    const watched = (v.CREDIT_WATCH ?? "").split(",").map((e) => e.split(":")[0]!.trim()).filter(Boolean);
    const missing = CREDIT_WATCH_REQUIRED.filter((a) => !watched.includes(a));
    if (missing.length) out.push(`monitor: CREDIT_WATCH must watch ${missing.join(", ")} (account:floorYocto)`);
  }
  if (n === "indexer" || n === "notifier") {
    const fb = (v.NEAR_RPC_FALLBACKS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!fb.length) out.push(`${n}: NEAR_RPC_FALLBACKS missing: a second mainnet RPC confirms terminal outcomes (D-DSY1)`);
    else if (host(fb[0]!) === host(v.NEAR_RPC_URL ?? "")) out.push(`${n}: NEAR_RPC_FALLBACKS[0] is the same host as NEAR_RPC_URL; the second RPC must be independent (D-DSY1)`);
  }
  if (n === "notifier" && !/^https:\/\/[^/]+/.test(v.NOTIFIER_BET_LINK_BASE ?? "")) out.push(`notifier: NOTIFIER_BET_LINK_BASE must be an https URL of the mainnet web (code default is a testnet example URL)`);
  if (n === "sourcecheck") {
    const allowed = (v.SOURCECHECK_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim());
    for (const o of webOrigins) if (!allowed.includes(o)) out.push(`sourcecheck: SOURCECHECK_ALLOWED_ORIGINS does not allow the web origin ${o} (the browser calls it cross-origin)`);
  }
  if (n === "funding") {
    const allowed = (v.FUNDING_ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim());
    for (const o of webOrigins) if (!allowed.includes(o)) out.push(`funding: FUNDING_ALLOWED_ORIGINS does not allow the web origin ${o}`);
    if (v.FUNDING_DRY_ONLY !== "0") out.push(`funding: [env.mainnet.vars] FUNDING_DRY_ONLY must be "0" (otherwise Add money / Cash out never get an address)`);
    if (v.ONECLICK_BASE_URL !== "https://1click.chaindefuser.com") out.push(`funding: ONECLICK_BASE_URL must be https://1click.chaindefuser.com (got ${JSON.stringify(v.ONECLICK_BASE_URL ?? null)})`);
    const ids = (v.BETTING_ASSET_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean).sort();
    if (JSON.stringify(ids) !== JSON.stringify([...MAINNET_BET_TOKENS].sort())) out.push(`funding: BETTING_ASSET_IDS must be exactly the 6 bet tokens (D-FUND4a)`);
  }
  return out;
}
