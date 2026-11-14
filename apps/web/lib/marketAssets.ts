// TPL1 (D-PM3 #1): which coins a price bet can be about. The list is every asset with a USD pair on at least 2 of the curated
// exchanges (the resolver's BTC venues: Coinbase, Bitstamp, Kraken), read live from their public product lists, cached, with a
// small built-in fallback so the form never breaks. Coinbase and Bitstamp send CORS headers; Kraken does not, so it goes through
// the web worker's /_proxy/kraken route (worker/index.ts; vite dev proxy in vite.config.ts). Stablecoins and fiat are excluded:
// a bet on USDC's dollar price is not a price bet. This is the bet ASSET (what the price is about), never the stake token.
export type VenueId = "coinbase" | "bitstamp" | "kraken";
export const VENUE_ORDER: VenueId[] = ["coinbase", "bitstamp", "kraken"];
export const VENUE_NAMES: Record<VenueId, string> = { coinbase: "Coinbase", bitstamp: "Bitstamp", kraken: "Kraken" };
/** `api` = the id the exchange's API takes; `label` = the pair as the exchange writes it (the publisher name + ticker pin). */
export interface VenuePair { api: string; label: string }
export interface MarketAsset { symbol: string; name: string; pairs: Partial<Record<VenueId, VenuePair>> }

export const MIN_VENUES = 2;
export const STABLE_OR_FIAT = new Set([
  "USDC", "USDT", "DAI", "PYUSD", "USDG", "USDS", "USDE", "FDUSD", "TUSD", "GUSD", "PAX", "USDP", "BUSD", "USD1", "RLUSD", "LUSD", "FRAX", "EURC", "EURT", "EURQ", "EURR", "USDQ", "USDR", "AUSD", "USTC", "UST",
  "USD", "EUR", "GBP", "CHF", "AUD", "CAD", "JPY", "NZD", "SGD", "HKD",
]);
// Shown first, in this order, when listed; then everything else alphabetically.
const WELL_KNOWN = ["BTC", "ETH", "SOL", "ZEC", "NEAR", "XRP", "DOGE", "LTC", "ADA", "AVAX", "LINK", "DOT", "BCH", "XLM"];
const KNOWN_NAMES: Record<string, string> = {
  BTC: "Bitcoin", ETH: "Ethereum", ZEC: "Zcash", NEAR: "NEAR", SOL: "Solana", XRP: "XRP", DOGE: "Dogecoin", LTC: "Litecoin", ADA: "Cardano",
  AVAX: "Avalanche", LINK: "Chainlink", DOT: "Polkadot", BCH: "Bitcoin Cash", XLM: "Stellar",
};

/** The built-in list (pairs checked against the live product lists on 2026-11-12). */
export const FALLBACK_ASSETS: MarketAsset[] = [
  { symbol: "BTC", name: "Bitcoin", pairs: { coinbase: { api: "BTC-USD", label: "BTC-USD" }, bitstamp: { api: "btcusd", label: "btcusd" }, kraken: { api: "XBTUSD", label: "XBT/USD" } } },
  { symbol: "ETH", name: "Ethereum", pairs: { coinbase: { api: "ETH-USD", label: "ETH-USD" }, bitstamp: { api: "ethusd", label: "ethusd" }, kraken: { api: "ETHUSD", label: "ETH/USD" } } },
  { symbol: "ZEC", name: "Zcash", pairs: { coinbase: { api: "ZEC-USD", label: "ZEC-USD" }, bitstamp: { api: "zecusd", label: "zecusd" }, kraken: { api: "ZECUSD", label: "ZEC/USD" } } },
  { symbol: "NEAR", name: "NEAR", pairs: { coinbase: { api: "NEAR-USD", label: "NEAR-USD" }, bitstamp: { api: "nearusd", label: "nearusd" }, kraken: { api: "NEARUSD", label: "NEAR/USD" } } },
  { symbol: "SOL", name: "Solana", pairs: { coinbase: { api: "SOL-USD", label: "SOL-USD" }, bitstamp: { api: "solusd", label: "solusd" }, kraken: { api: "SOLUSD", label: "SOL/USD" } } },
];

export const MARKET_LIST_URLS: Record<VenueId, string> = {
  coinbase: "https://api.exchange.coinbase.com/products",
  bitstamp: "https://www.bitstamp.net/api/v2/trading-pairs-info/",
  kraken: "/_proxy/kraken/0/public/AssetPairs",
};

type J = any;
const sym = (s: unknown) => (typeof s === "string" ? s.trim().toUpperCase() : "");
const okSym = (s: string) => /^[A-Z0-9]{2,12}$/.test(s);

export function parseCoinbaseProducts(body: J): Map<string, VenuePair> {
  const out = new Map<string, VenuePair>();
  if (!Array.isArray(body)) return out;
  for (const p of body) {
    if (!p || p.quote_currency !== "USD" || p.status !== "online" || p.trading_disabled || typeof p.id !== "string") continue;
    const s = sym(p.base_currency);
    if (okSym(s)) out.set(s, { api: p.id, label: p.id });
  }
  return out;
}

const KRAKEN_ALIAS: Record<string, string> = { XBT: "BTC", XDG: "DOGE" };
export function parseKrakenPairs(body: J): Map<string, VenuePair> {
  const out = new Map<string, VenuePair>();
  const r = body?.result;
  if (!r || typeof r !== "object") return out;
  for (const p of Object.values<J>(r)) {
    if (!p || p.status !== "online" || p.aclass_base !== "currency" || typeof p.wsname !== "string" || typeof p.altname !== "string") continue;
    const [b, q] = p.wsname.split("/");
    if (q !== "USD") continue;
    const s = KRAKEN_ALIAS[b] ?? sym(b);
    if (okSym(s)) out.set(s, { api: p.altname, label: p.wsname });
  }
  return out;
}

export function parseBitstampPairs(body: J): { pairs: Map<string, VenuePair>; names: Map<string, string> } {
  const pairs = new Map<string, VenuePair>(), names = new Map<string, string>();
  if (!Array.isArray(body)) return { pairs, names };
  for (const p of body) {
    if (!p || p.trading !== "Enabled" || typeof p.name !== "string" || typeof p.url_symbol !== "string") continue;
    const [b, q] = p.name.split("/");
    if (q !== "USD") continue;
    const s = sym(b);
    if (!okSym(s)) continue;
    pairs.set(s, { api: p.url_symbol, label: p.url_symbol });
    const n = typeof p.description === "string" ? p.description.split(" / ")[0].trim() : "";
    if (n && n.length <= 40) names.set(s, n);
  }
  return { pairs, names };
}

const rank = (s: string) => { const i = WELL_KNOWN.indexOf(s); return i < 0 ? WELL_KNOWN.length : i; };
export function sortAssets(list: MarketAsset[]): MarketAsset[] {
  return [...list].sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol));
}

/** Assets with a USD pair on at least MIN_VENUES of the curated exchanges; stablecoins and fiat dropped. */
export function mergeAssets(lists: Partial<Record<VenueId, Map<string, VenuePair>>>, names: Map<string, string> = new Map()): MarketAsset[] {
  const by = new Map<string, MarketAsset>();
  for (const v of VENUE_ORDER) for (const [s, pair] of lists[v] ?? []) {
    if (STABLE_OR_FIAT.has(s)) continue;
    const a = by.get(s) ?? { symbol: s, name: KNOWN_NAMES[s] ?? names.get(s) ?? s, pairs: {} };
    a.pairs[v] = pair;
    by.set(s, a);
  }
  return sortAssets([...by.values()].filter((a) => venuesOf(a).length >= MIN_VENUES));
}

/** The curated exchanges that list this asset's USD pair, in the fixed order. */
export function venuesOf(a: MarketAsset): VenueId[] {
  return VENUE_ORDER.filter((v) => !!a.pairs[v]);
}

export function searchAssets(list: MarketAsset[], q: string): MarketAsset[] {
  const t = q.trim().toLowerCase();
  if (!t) return [...list];
  const bySym = list.filter((a) => a.symbol.toLowerCase().startsWith(t));
  const rest = list.filter((a) => !bySym.includes(a) && (a.symbol.toLowerCase().includes(t) || a.name.toLowerCase().includes(t)));
  return [...bySym, ...rest];
}
export function findMarketAsset(list: MarketAsset[], symbol: string): MarketAsset | undefined {
  const s = sym(symbol);
  return list.find((a) => a.symbol === s);
}

export const MARKET_CACHE_KEY = "praetorial.marketAssets.v1";
export const MARKET_CACHE_MS = 60 * 60_000;
type Fetch = (url: string) => Promise<Response>;
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };

async function getJson(f: Fetch, url: string): Promise<J | null> {
  try {
    const r = await f(url);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** The live list (cached for an hour), always including the built-in assets; the built-in list alone if every exchange fails. */
export async function loadMarketAssets(opts: { fetch: Fetch; storage?: Store | null; nowMs: number }): Promise<{ assets: MarketAsset[]; live: boolean }> {
  const st = opts.storage ?? null;
  try {
    const c = st ? JSON.parse(st.getItem(MARKET_CACHE_KEY) ?? "null") : null;
    if (c && typeof c.at === "number" && opts.nowMs - c.at < MARKET_CACHE_MS && Array.isArray(c.assets) && c.assets.length) return { assets: c.assets, live: true };
  } catch { /* unreadable cache: refetch */ }
  const [cb, bs, kr] = await Promise.all([getJson(opts.fetch, MARKET_LIST_URLS.coinbase), getJson(opts.fetch, MARKET_LIST_URLS.bitstamp), getJson(opts.fetch, MARKET_LIST_URLS.kraken)]);
  const b = parseBitstampPairs(bs);
  const lists = { coinbase: parseCoinbaseProducts(cb), bitstamp: b.pairs, kraken: parseKrakenPairs(kr) };
  if (!lists.coinbase.size && !lists.bitstamp.size && !lists.kraken.size) return { assets: FALLBACK_ASSETS, live: false };
  // a venue that did not answer keeps its built-in pairs, so the fallback assets keep all their venues
  for (const v of VENUE_ORDER) if (!lists[v].size) for (const a of FALLBACK_ASSETS) if (a.pairs[v]) lists[v].set(a.symbol, a.pairs[v]!);
  const merged = mergeAssets(lists, b.names);
  for (const a of FALLBACK_ASSETS) if (!merged.some((m) => m.symbol === a.symbol)) merged.push(a);
  const assets = sortAssets(merged);
  try { st?.setItem(MARKET_CACHE_KEY, JSON.stringify({ at: opts.nowMs, assets })); } catch { /* storage full / private mode */ }
  return { assets, live: true };
}

// ---- live price (the per-asset version of lib/tickerVenues.ts)
export function tickerUrl(v: VenueId, p: VenuePair): string {
  if (v === "coinbase") return `https://api.coinbase.com/v2/prices/${encodeURIComponent(p.api)}/spot`;
  if (v === "bitstamp") return `https://www.bitstamp.net/api/v2/ticker/${encodeURIComponent(p.api)}/`;
  return `/_proxy/kraken/0/public/Ticker?pair=${encodeURIComponent(p.api)}`;
}
export function parseTicker(v: VenueId, body: J): number | null {
  let n = NaN;
  try {
    if (v === "coinbase") n = parseFloat(body.data.amount);
    else if (v === "bitstamp") n = parseFloat(body.last);
    else { const r = body.result; n = parseFloat(r[Object.keys(r)[0]].c[0]); }
  } catch { return null; }
  return Number.isFinite(n) && n > 0 ? n : null;
}
/** Median of the prices the listing exchanges answer with now; null when none answers. Never throws. */
export async function fetchAssetPrice(a: MarketAsset, f: Fetch): Promise<number | null> {
  const got = await Promise.all(venuesOf(a).map(async (v) => parseTicker(v, await getJson(f, tickerUrl(v, a.pairs[v]!)))));
  const xs = got.filter((x): x is number => x !== null).sort((x, y) => x - y);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}
/** "$962.08" / "$0.2512" / "$104,250": enough digits for a cheap coin, none wasted on an expensive one. */
export function formatUsdPrice(n: number): string {
  const digits = n >= 100 ? 2 : n >= 1 ? 3 : 6;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: n >= 100 ? 2 : 0 })}`;
}
