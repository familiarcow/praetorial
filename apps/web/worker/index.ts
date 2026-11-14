// WEBDEP1: static-assets Worker entry. Testnet: assets are served by the platform; only /_proxy/<svc>/* runs this code (run_worker_first).
// Mainnet (DOM1): every request runs this code first (www -> apex redirect below); non-proxy paths go to env.ASSETS.
// Why: the indexer, relayer and registry Workers send no CORS headers for the workers.dev origin, so a browser on workers.dev cannot call them directly.
// Only these three services are proxied (plus TPL2's GET-only NHL schedule reads, handleSports below).
export const UPSTREAMS: Record<string, string> = {
  indexer: "https://praetorial-indexer-testnet.familiarcow.workers.dev",
  relayer: "https://praetorial-relayer-testnet.familiarcow.workers.dev",
  registry: "https://praetorial-registry-testnet.familiarcow.workers.dev",
};
// MAINPREP: mainnet (wrangler.mainnet.toml, [vars] NETWORK_ID="mainnet") is service-binding ONLY. The URL below is just the
// request URL handed to the binding; a missing binding fails closed (502) and never falls back to a URL fetch.
export const MAINNET_UPSTREAMS: Record<string, string> = {
  indexer: "https://indexer.praetorial.com",
  relayer: "https://relayer.praetorial.com",
  registry: "https://registry.praetorial.com",
};
// Worker-to-Worker fetch over workers.dev on one account fails (error 1042), so production uses service bindings (wrangler.*.toml);
// the URL fetch path remains for unit tests / when a binding is absent -- testnet only.
type Fetcher = { fetch: (r: Request | string, init?: RequestInit) => Promise<Response> };
type Env = { ASSETS: Fetcher; INDEXER?: Fetcher; RELAYER?: Fetcher; REGISTRY?: Fetcher; NETWORK_ID?: string };

// TPL2: the game picker's NHL league source (api-web.nhle.com) sends no CORS headers. Only its per-day score/schedule reads are
// proxied: GET-only, no query string, nothing from the browser forwarded, cached 5 minutes. A public third-party read, so a plain URL
// fetch on both networks (the service-binding rule above is for our own Workers). ESPN and MLB statsapi are CORS-open (direct).
export const SPORTS_UPSTREAMS: Record<string, string> = { nhl: "https://api-web.nhle.com" };
export const SPORTS_CACHE_SECS = 300;
const SPORTS_PATH = /^\/_proxy\/sports\/(nhl)(\/v1\/(?:score|schedule)\/\d{4}-\d{2}-\d{2})$/;
export async function handleSports(req: Request, url: URL, doFetch: typeof fetch): Promise<Response> {
  const m = url.pathname.match(SPORTS_PATH);
  if (!m || url.search !== "") return new Response("not found", { status: 404 });
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const fail = () => new Response("schedule unavailable", { status: 502, headers: { "cache-control": "no-store" } });
  try {
    const init = { method: "GET", headers: { accept: "application/json" }, cf: { cacheTtl: SPORTS_CACHE_SECS, cacheEverything: true } };
    const up = await doFetch(`${SPORTS_UPSTREAMS[m[1]]}${m[2]}`, init as RequestInit);
    if (!up.ok) return fail();
    return new Response(up.body, { status: 200, headers: { "content-type": up.headers.get("content-type") ?? "application/json", "cache-control": `public, max-age=${SPORTS_CACHE_SECS}` } });
  } catch {
    return fail();
  }
}

// DOM1: the mainnet web is https://praetorial.com. www.praetorial.com is a second custom domain on this Worker and 301s to the apex
// (path and query kept), so there is one origin for Privy, CORS and share links. wrangler.mainnet.toml sets run_worker_first = true
// so this runs before the asset server on every path. workers.dev hosts are never redirected (rollback path).
export const APEX_ORIGIN = "https://praetorial.com";
const WWW_HOST = "www.praetorial.com";

export async function handle(req: Request, env: Env, doFetch: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url);
  if (url.hostname === WWW_HOST) return Response.redirect(`${APEX_ORIGIN}${url.pathname}${url.search}`, 301);
  if (url.pathname === "/_proxy/sports" || url.pathname.startsWith("/_proxy/sports/")) return handleSports(req, url, doFetch);
  const m = url.pathname.match(/^\/_proxy\/([a-z]+)(\/.*)?$/);
  if (!m) return env.ASSETS.fetch(req);
  if (m[1] === "kraken") return kraken(req, url, m[2] ?? "/", doFetch);
  const net = env.NETWORK_ID || "testnet";
  if (net !== "testnet" && net !== "mainnet") return new Response("unknown network", { status: 502 });
  const base = (net === "mainnet" ? MAINNET_UPSTREAMS : UPSTREAMS)[m[1]];
  if (!base) return new Response("unknown service", { status: 404 });
  if (req.method !== "GET" && req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const bound = env[m[1].toUpperCase() as "INDEXER" | "RELAYER" | "REGISTRY"];
  if (!bound && net === "mainnet") return new Response("service binding missing", { status: 502 });
  const headers = new Headers();
  const ct = req.headers.get("content-type"); if (ct) headers.set("content-type", ct);
  // FUND1b: the relayer's faucet rate-limits per IP; set it from the edge's value (never trust a client-sent x-client-ip).
  if (m[1] === "relayer") headers.set("x-client-ip", req.headers.get("cf-connecting-ip") ?? "unknown");
  // SECREV1 SR-12: the app only reads the indexer; POST /tick etc. are for its cron, never for the public through this proxy.
  // IDX2: the one exception is the post-Open/Take nudge, exactly POST /refresh (no query); the indexer reads the bet from chain itself
  // and rate-limits per client address, which it gets from x-client-ip (set from the edge's cf-connecting-ip, as for the relayer).
  const nudge = m[1] === "indexer" && req.method === "POST" && m[2] === "/refresh" && url.search === "";
  if (m[1] === "indexer" && req.method !== "GET" && !nudge) return new Response("method not allowed", { status: 405 });
  if (nudge) headers.set("x-client-ip", req.headers.get("cf-connecting-ip") ?? "unknown");
  let body: ArrayBuffer | undefined;
  if (req.method === "POST") {
    // SECREV1 SR-10: signed delegates and registry claims are a few KB; never buffer an unbounded body.
    if (Number(req.headers.get("content-length") ?? 0) > MAX_PROXY_BODY) return new Response("request too large", { status: 413 });
    body = await req.arrayBuffer();
    if (body.byteLength > MAX_PROXY_BODY) return new Response("request too large", { status: 413 });
  }
  const send = bound ? bound.fetch.bind(bound) : doFetch;
  const up = await send(`${base}${m[2] ?? "/"}${url.search}`, { method: req.method, headers, body });
  const out = new Headers(up.headers); out.delete("set-cookie");
  // SECREV1 SR-8: our services answer JSON; whatever an upstream sends is never rendered as a document on the app's origin.
  out.set("x-content-type-options", "nosniff");
  if (/html|xml|javascript|svg/i.test(out.get("content-type") ?? "")) out.set("content-type", "text/plain; charset=utf-8");
  return new Response(up.body, { status: up.status, headers: out });
}
export const MAX_PROXY_BODY = 64 * 1024;
// TPL1: the price-bet coin list and live price read Kraken's public market data, which sends no CORS headers. Only two read-only
// public endpoints are forwarded (GET, no headers, no body), on both networks: it is a public exchange API, not one of our services.
export const KRAKEN_UPSTREAM = "https://api.kraken.com";
const KRAKEN_PATHS: Record<string, number> = { "/0/public/AssetPairs": 3600, "/0/public/Ticker": 15 }; // path -> cache seconds
async function kraken(req: Request, url: URL, path: string, doFetch: typeof fetch): Promise<Response> {
  const ttl = KRAKEN_PATHS[path];
  if (ttl === undefined) return new Response("unknown path", { status: 404 });
  if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
  const up = await doFetch(`${KRAKEN_UPSTREAM}${path}${url.search}`, { method: "GET", cf: { cacheTtl: ttl, cacheEverything: true } } as RequestInit);
  const out = new Headers({ "content-type": up.headers.get("content-type") ?? "application/json", "cache-control": `public, max-age=${ttl}` });
  return new Response(up.body, { status: up.status, headers: out });
}
export default { fetch: (req: Request, env: Env) => handle(req, env) };
