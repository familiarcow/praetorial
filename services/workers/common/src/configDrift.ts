// LIVE1 config-drift guard: core of scripts/check-config-drift.mjs. The web site was once built from an apps/web/lib/network.ts that named an
// old escrow while every Worker's wrangler.toml named the new one. This compares, per network, the web's NETWORKS table with each Worker's
// wrangler vars (testnet = top-level [vars], mainnet = [env.mainnet.vars]) and returns one message per mismatch.
// Pure + import-free (loadable by plain `node` via type stripping): the caller reads the files and parses wrangler.toml
// (stackCheck.ts parseWranglerToml) and passes the results in.

export type Net = "testnet" | "mainnet";
export const NETS: readonly Net[] = ["testnet", "mainnet"];

export interface WebNetwork { escrow?: string; intents?: string; registryId?: string; relayerUrl?: string; indexerUrl?: string; registryUrl?: string }
/** What parseWranglerToml returns (only the fields used here). name "" = the toml has no section for that network. */
export interface WorkerCfg { name: string; workersDev: boolean; vars: Record<string, string>; customDomains?: string[] }

/** web NETWORKS field -> Worker wrangler var it must equal (compared only where the Worker declares the var). */
export const VAR_FIELDS: ReadonlyArray<[keyof WebNetwork, string]> = [
  ["escrow", "ESCROW_CONTRACT_ID"],
  ["intents", "INTENTS_CONTRACT_ID"],
  ["registryId", "REGISTRY_ID"],
];
/** web URL field -> Worker whose workers.dev host it must name. */
export const URL_FIELDS: ReadonlyArray<[keyof WebNetwork, string]> = [
  ["relayerUrl", "relayer"],
  ["indexerUrl", "indexer"],
  ["registryUrl", "registry"],
];
const FIELDS: ReadonlyArray<keyof WebNetwork> = ["escrow", "intents", "registryId", "relayerUrl", "indexerUrl", "registryUrl"];
const REQUIRED: ReadonlyArray<keyof WebNetwork> = ["escrow", "intents", "registryId"];

/** `export const NAME = "value"` string constants of a TS module (e.g. lib/networkSelect.ts TESTNET_REGISTRY_URL). */
export function parseStringConsts(ts: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of ts.matchAll(/^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*"([^"]*)"\s*;/gm)) out[m[1]!] = m[2]!;
  return out;
}

/**
 * Reads NETWORKS.testnet / NETWORKS.mainnet out of apps/web/lib/network.ts source text. A field is a string literal or an identifier
 * resolved through `consts` (string constants imported from networkSelect.ts or declared in network.ts). Throws when the table or a
 * required field (escrow, intents, registryId) cannot be read: an unreadable table must fail the guard, never pass it.
 */
export function parseWebNetworks(networkTs: string, consts: Record<string, string> = {}): Record<Net, WebNetwork> {
  const start = networkTs.search(/export\s+const\s+NETWORKS\b/);
  if (start < 0) throw new Error("network.ts: export const NETWORKS not found");
  const table = networkTs.slice(start);
  const allConsts = { ...parseStringConsts(networkTs), ...consts };
  const out = {} as Record<Net, WebNetwork>;
  for (const net of NETS) {
    const open = table.search(new RegExp(`\\n\\s*${net}\\s*:\\s*\\{`));
    if (open < 0) throw new Error(`network.ts: NETWORKS.${net} not found`);
    // the network's object literal: from its "{" to the matching "}"
    let i = table.indexOf("{", open), depth = 0, end = -1;
    for (; i < table.length; i++) {
      if (table[i] === "{") depth++;
      else if (table[i] === "}" && --depth === 0) { end = i; break; }
    }
    if (end < 0) throw new Error(`network.ts: NETWORKS.${net} is not closed`);
    const body = table.slice(table.indexOf("{", open) + 1, end);
    const w: WebNetwork = {};
    for (const f of FIELDS) {
      const m = body.match(new RegExp(`(?:^|[\\s,{])${f}\\s*:\\s*(?:"([^"]*)"|([A-Za-z_$][\\w$]*))\\s*,?`));
      if (!m) continue;
      if (m[1] !== undefined) w[f] = m[1];
      else if (m[2]! in allConsts) w[f] = allConsts[m[2]!];
      else throw new Error(`network.ts: NETWORKS.${net}.${f} = ${m[2]} is not a string constant this check can resolve`);
    }
    for (const f of REQUIRED) if (w[f] === undefined) throw new Error(`network.ts: NETWORKS.${net}.${f} not found`);
    out[net] = w;
  }
  return out;
}

/** The workers.dev Worker name a URL addresses ("https://<name>.<subdomain>.workers.dev/..."), or null for any other URL. */
export function workersDevName(url: string): string | null {
  try {
    const u = new URL(url);
    const labels = u.hostname.split(".");
    return u.hostname.endsWith(".workers.dev") && labels.length === 4 ? labels[0]! : null;
  } catch { return null; }
}

/**
 * Every mismatch between the web table and the Workers' wrangler configs. `workers[service][net]` is the parsed wrangler.toml for that
 * network (testnet = top level, mainnet = [env.mainnet]); a Worker without an [env.mainnet] (name "") is skipped for mainnet, and only vars
 * the Worker declares are compared. Empty result = no drift.
 */
export function compareConfig(web: Record<Net, WebNetwork>, workers: Record<string, Record<Net, WorkerCfg>>): string[] {
  const diffs: string[] = [];
  for (const net of NETS) {
    const wn = web[net];
    if (!wn) { diffs.push(`${net}: apps/web NETWORKS.${net} missing`); continue; }
    for (const [svc, byNet] of Object.entries(workers).sort(([a], [b]) => a.localeCompare(b))) {
      const c = byNet[net];
      if (!c || !c.name) continue;
      const where = net === "mainnet" ? "[env.mainnet.vars]" : "[vars]";
      for (const [field, v] of VAR_FIELDS) {
        if (!(v in c.vars)) continue;
        if (c.vars[v] !== wn[field]) {
          diffs.push(`${net}: apps/web NETWORKS.${net}.${field} = "${wn[field] ?? "(missing)"}" but services/workers/${svc}/wrangler.toml ${where} ${v} = "${c.vars[v]}"`);
        }
      }
    }
    for (const [field, svc] of URL_FIELDS) {
      const url = wn[field];
      if (!url) continue; // empty = service not configured for this network (web fails closed at call time)
      const c = workers[svc]?.[net];
      if (!c || !c.name) { diffs.push(`${net}: apps/web NETWORKS.${net}.${field} = "${url}" but services/workers/${svc}/wrangler.toml has no ${net} Worker`); continue; }
      const host = workersDevName(url);
      if (host === null) {
        // DOM1: an https URL that is not workers.dev must be one of the Worker's custom_domain routes (e.g. registry.praetorial.com).
        let h: string | null = null;
        try { const u = new URL(url); h = u.protocol === "https:" ? u.hostname : null; } catch { /* proxy path: nothing comparable */ }
        const doms = c.customDomains ?? [];
        if (h !== null && !doms.includes(h)) diffs.push(`${net}: apps/web NETWORKS.${net}.${field} = "${url}" is not a custom domain of services/workers/${svc}/wrangler.toml (routes: ${doms.join(", ") || "none"})`);
        continue;
      }
      if (host !== c.name) diffs.push(`${net}: apps/web NETWORKS.${net}.${field} = "${url}" addresses Worker "${host}" but services/workers/${svc}/wrangler.toml name = "${c.name}"`);
      else if (!c.workersDev) diffs.push(`${net}: apps/web NETWORKS.${net}.${field} = "${url}" but services/workers/${svc}/wrangler.toml has workers_dev = false`);
    }
  }
  return diffs;
}

/** Text-in convenience used by the script and the tests. */
export function checkConfigDrift(o: {
  networkTs: string; networkSelectTs?: string; tomls: Record<string, string>;
  parseToml: (text: string, network: string) => WorkerCfg;
}): string[] {
  let web: Record<Net, WebNetwork>;
  try { web = parseWebNetworks(o.networkTs, o.networkSelectTs ? parseStringConsts(o.networkSelectTs) : {}); } catch (e) { return [(e as Error).message]; }
  const workers = Object.fromEntries(Object.entries(o.tomls).map(([svc, text]) => [svc, { testnet: o.parseToml(text, "testnet"), mainnet: o.parseToml(text, "mainnet") }]));
  return compareConfig(web, workers);
}
