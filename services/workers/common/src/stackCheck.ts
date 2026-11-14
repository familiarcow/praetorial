// STACK1: core of scripts/check-deployed-stack.mjs. Proves from the LIVE deployment (each Worker's GET /health) that every Worker points at the
// frozen build: same network, the escrow id in the release record, a real git sha, and (cron-driven Workers) a recent scheduled() run.
// Pure + host-neutral: all I/O (fetch, file reads, clock) is injected.
export const STACK_WORKERS = ["indexer", "keeper", "monitor", "notifier", "relayer", "registry", "sourcecheck", "funding"] as const;
/** Workers whose /health carries last_tick_at (driven by the keeper's single cron through the shared dispatcher). */
const TICK_WORKERS = new Set(["keeper", "monitor", "indexer"]);
/** The tick must be at most this many cron intervals old. */
export const STALE_FACTOR = 3;
/** Clock skew tolerated for a last_tick_at slightly in the future. */
const FUTURE_SKEW_MS = 60_000;

export type Probe = { status: number; body: unknown } | { error: string };
export interface WorkerSpec { service: string; name: string; url: string; cronMinutes?: number; expectedRegistryId?: string }
export interface Line { service: string; name: string; ok: boolean; detail: string }

/** Minimal wrangler.toml reader: the top-level (testnet) or [env.mainnet] name, workers_dev and vars (strings only), the cron triggers and
 *  (DOM1) the custom-domain route hosts (`routes = [{ pattern = "x.praetorial.com", custom_domain = true }]`, one line). workers_dev
 *  defaults like wrangler: on when the env has no routes, off once it has any. */
export function parseWranglerToml(text: string, network: string): { name: string; workersDev: boolean; vars: Record<string, string>; crons: string[]; customDomains: string[] } {
  const prefix = network === "mainnet" ? "env.mainnet." : "";
  let section = ""; const top: Record<string, string> = {}; const vars: Record<string, string> = {}; let crons: string[] = []; let workersDev: boolean | null = null;
  const customDomains: string[] = []; let hasRoutes = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = line.match(/^\[{1,2}([^\]]+)\]{1,2}$/);
    if (sec) { section = sec[1]!.trim(); continue; }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1]!, val = kv[2]!.replace(/\s+#.*$/, "").trim();
    const s = val.match(/^"(.*)"$/)?.[1];
    if (prefix ? section === prefix.slice(0, -1) : section === "") {
      if (s !== undefined) top[key] = s;
      if (key === "workers_dev") workersDev = val === "true";
      if (key === "routes") {
        hasRoutes = true;
        for (const [obj] of val.matchAll(/\{[^{}]*\}/g)) {
          const pattern = obj.match(/\bpattern\s*=\s*"([^"]+)"/)?.[1];
          if (pattern && /\bcustom_domain\s*=\s*true\b/.test(obj)) customDomains.push(pattern);
        }
      }
    } else if (section === `${prefix}vars` && s !== undefined) vars[key] = s;
    else if (section === `${prefix}triggers` && key === "crons") crons = [...val.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  }
  return { name: top.name ?? "", workersDev: workersDev ?? !hasRoutes, vars, crons, customDomains };
}

/** "* * * * *" -> 1, "*\/N * * * *" -> N; anything else is not a minute-granular cron this check understands. */
export function cronMinutes(cron: string): number | null {
  const m = cron.trim().match(/^(?:\*|\*\/(\d+)) \* \* \* \*$/);
  return m ? (m[1] ? Number(m[1]) : 1) : null;
}

export function buildWorkerSpecs(tomls: Record<string, string>, network: string, subdomain: string, overrides: Record<string, string> = {}): { specs: WorkerSpec[] } {
  const cfg = Object.fromEntries(STACK_WORKERS.map((s) => [s, parseWranglerToml(tomls[s] ?? "", network)]));
  const host = (name: string) => `https://${name}.${subdomain}.workers.dev`;
  // DOM1: a Worker with a custom domain (mainnet: <svc>.praetorial.com) is probed there, the public host people use; else workers.dev.
  const base = (c: { name: string; customDomains: string[] }) => (c.customDomains[0] ? `https://${c.customDomains[0]}` : host(c.name));
  const keeperBase = base(cfg.keeper!);
  const keeperMinutes = Math.min(...cfg.keeper!.crons.map(cronMinutes).filter((n): n is number => n !== null), Infinity);
  const specs = STACK_WORKERS.map((service): WorkerSpec => {
    const c = cfg[service]!;
    // Private Workers (workers_dev=false) are only reachable over a service binding; the keeper exposes their /health read-only.
    const url = overrides[service] ?? (c.customDomains[0] || c.workersDev ? `${base(c)}/health` : `${keeperBase}/health/${service}`);
    const spec: WorkerSpec = { service, name: c.name, url };
    if (TICK_WORKERS.has(service) && Number.isFinite(keeperMinutes)) spec.cronMinutes = keeperMinutes; // all three run off the keeper's one cron trigger
    if (service === "registry" && c.vars.REGISTRY_ID) spec.expectedRegistryId = c.vars.REGISTRY_ID;
    return spec;
  });
  return { specs };
}

/** The escrow account the release record names for `network`, or null if it names none. */
export function releaseEscrowId(release: any, network: string): string | null {
  const key = network === "mainnet" ? "mainnet_escrow" : "testnet_escrow";
  const v = release?.[key]?.account;
  return typeof v === "string" && v ? v : null;
}

export function evaluateStack(o: { network: string; expectedEscrow: string | null; specs: WorkerSpec[]; probes: Record<string, Probe>; nowMs: number }): Line[] {
  return o.specs.map((spec): Line => {
    const fail = (detail: string): Line => ({ service: spec.service, name: spec.name, ok: false, detail });
    const probe = o.probes[spec.service];
    if (!probe) return fail("unreachable: no response recorded");
    if ("error" in probe) return fail(`unreachable: ${probe.error}`);
    if (probe.status !== 200) return fail(`HTTP ${probe.status}`);
    const b: any = probe.body;
    if (!b || typeof b !== "object") return fail("body is not a JSON object");
    const problems: string[] = [];
    if (b.service !== spec.service) problems.push(`service is ${JSON.stringify(b.service)}, expected ${spec.service}`);
    if (b.network !== o.network) problems.push(`network is ${JSON.stringify(b.network)}, expected ${o.network}`);
    if (spec.service === "registry") {
      if (!spec.expectedRegistryId) problems.push("no REGISTRY_ID in wrangler.toml to compare registry_id against");
      else if (b.registry_id !== spec.expectedRegistryId) problems.push(`registry_id is ${JSON.stringify(b.registry_id)}, expected ${spec.expectedRegistryId}`);
    } else if (!o.expectedEscrow) problems.push(`release record names no ${o.network} escrow id`);
    else if (b.escrow_contract_id !== o.expectedEscrow) problems.push(`escrow_contract_id is ${JSON.stringify(b.escrow_contract_id)}, release record says ${o.expectedEscrow}`);
    if (typeof b.git_sha !== "string" || b.git_sha === "" || b.git_sha === "unknown") problems.push(`git_sha is ${JSON.stringify(b.git_sha ?? null)} (unknown)`);
    let age = "";
    if (spec.cronMinutes !== undefined) {
      const t = typeof b.last_tick_at === "string" ? Date.parse(b.last_tick_at) : NaN;
      const maxMs = STALE_FACTOR * spec.cronMinutes * 60_000;
      if (!Number.isFinite(t)) problems.push(`last_tick_at is ${JSON.stringify(b.last_tick_at ?? null)} (no tick recorded)`);
      else {
        const ageMs = o.nowMs - t; age = ` tick_age=${Math.round(ageMs / 1000)}s`;
        if (ageMs > maxMs) problems.push(`last_tick_at ${b.last_tick_at} is ${Math.round(ageMs / 1000)}s old, older than ${STALE_FACTOR}x the ${spec.cronMinutes} min cron interval (${maxMs / 1000}s)`);
        else if (ageMs < -FUTURE_SKEW_MS) problems.push(`last_tick_at ${b.last_tick_at} is in the future`);
      }
    }
    if (problems.length) return fail(problems.join("; "));
    const esc = spec.service === "registry" ? `registry_id=${b.registry_id}` : `escrow=${b.escrow_contract_id}`;
    return { service: spec.service, name: spec.name, ok: true, detail: `network=${b.network} ${esc} git_sha=${b.git_sha}${age}` };
  });
}

export const formatLine = (l: Line): string => `${l.ok ? "PASS" : "FAIL"} ${l.service.padEnd(11)} ${l.name}  ${l.detail}`;

export async function runStackCheck(o: { network: string; expectedEscrow: string | null; specs: WorkerSpec[]; fetchImpl: (url: string, init?: any) => Promise<Response>; nowMs: number; timeoutMs?: number }): Promise<{ lines: string[]; exitCode: number; results: Line[] }> {
  const probes: Record<string, Probe> = {};
  await Promise.all(o.specs.map(async (s) => {
    try {
      const r = await o.fetchImpl(s.url, { signal: AbortSignal.timeout(o.timeoutMs ?? 15_000), headers: { accept: "application/json" } });
      const text = await r.text();
      let body: unknown = text; try { body = JSON.parse(text); } catch { /* keep text */ }
      probes[s.service] = { status: r.status, body };
    } catch (e: any) { probes[s.service] = { error: String(e?.cause?.code ?? e?.message ?? e) }; }
  }));
  const results = evaluateStack({ network: o.network, expectedEscrow: o.expectedEscrow, specs: o.specs, probes, nowMs: o.nowMs });
  return { lines: results.map(formatLine), exitCode: results.every((l) => l.ok) ? 0 : 1, results };
}
