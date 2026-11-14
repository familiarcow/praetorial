// GUEST1 §5: what a guest's browser may send. Every request recorded in guest mode goes through this; any answer but null fails the spec.
// Allowed: GET reads (indexer, registry lookups, the public token list) and the NEAR RPC's read-only JSON-RPC calls (views are POSTs
// by the JSON-RPC protocol). Never: any other non-GET, any relayer / signer / funding / faucet / activation / registry-write /
// source-check URL (whatever the method), any RPC broadcast.
export interface GuestPolicyConfig { rpcUrl: string; relayerUrl: string; registryUrl: string; sourceCheckUrl: string }
export interface SeenRequest { method: string; url: string; body?: string | null }

const RPC_READ_METHODS = new Set(["query", "block", "status", "chunk", "gas_price", "validators", "tx", "EXPERIMENTAL_tx_status", "EXPERIMENTAL_protocol_config", "network_info"]);
const QUERY_READS = new Set(["call_function", "view_account", "view_state", "view_access_key", "view_access_key_list", "view_code"]);
// Funding / money-movement hosts and paths: deposit addresses (bridge), swaps/quotes (1click; only its public token list is a read).
const FUNDING_HOSTS = new Set(["bridge.chaindefuser.com", "solver-relay-v2.chaindefuser.com"]);
const WRITE_PATHS = [/\/claim\b/, /\/activate\b/, /\/faucet\b/, /\/relay\b/, /\/sign\b/, /\/withdraw\b/, /\/deposit\b/];

const norm = (u: string) => u.replace(/\/+$/, "");
const under = (url: string, base: string) => !!base && (norm(url) === norm(base) || url.startsWith(norm(base) + "/") || url.startsWith(norm(base) + "?"));

/** null = fine; otherwise why this request must never come from a guest. */
export function guestRequestViolation(r: SeenRequest, c: GuestPolicyConfig): string | null {
  let u: URL;
  try { u = new URL(r.url); } catch { return "unparseable URL"; }
  const method = r.method.toUpperCase();
  if (under(r.url, c.relayerUrl)) return "relayer";
  if (under(r.url, c.sourceCheckUrl)) return "source check (paid AI call)";
  if (FUNDING_HOSTS.has(u.hostname)) return "funding";
  if (u.hostname === "1click.chaindefuser.com" && !(method === "GET" && u.pathname === "/v0/tokens")) return "funding (1click)";
  if (WRITE_PATHS.some((p) => p.test(u.pathname))) return "write endpoint";
  if (method === "GET" || method === "HEAD") return null;
  // The Privy SDK's own start-up ping (PrivyProvider mounts for every visitor, before any guest code runs): event "sdk_initialize" only.
  // Any other Privy POST (send a code, log in, make a wallet, sign) is a violation.
  if (u.hostname === "auth.privy.io" && u.pathname === "/api/v1/analytics_events") {
    try { if (JSON.parse(r.body ?? "").event_name === "sdk_initialize") return null; } catch { /* fall through */ }
    return "Privy event other than sdk_initialize";
  }
  if (under(r.url, c.rpcUrl) && method === "POST") {
    let body: { method?: unknown; params?: { request_type?: unknown } } | null = null;
    try { body = JSON.parse(r.body ?? ""); } catch { return "RPC POST with an unreadable body"; }
    const m = String(body?.method ?? "");
    if (!RPC_READ_METHODS.has(m)) return `RPC ${m || "?"} (not a read)`;
    if (m === "query" && !QUERY_READS.has(String(body?.params?.request_type ?? ""))) return "RPC query that is not a view";
    return null;
  }
  return `${method} (not a read)`;
}
