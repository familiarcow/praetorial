// PXF1: deploy-day price fetcher. Fetches USD spot prices for BTC/ETH/NEAR/ZEC from two DIFFERENT public
// providers and merges them into a release input for gen. Fail closed: any problem refuses, no partial output.
// gen-new-args still enforces its own 30-min staleness and 2% checks; nothing here bypasses them.
import { ReleaseError, PRICE_MAX_DIFF_PCT, type ReleaseInput } from "./gen.js";

export const PXF1_ASSETS = ["BTC", "ETH", "NEAR", "ZEC"] as const;
export type PriceAsset = (typeof PXF1_ASSETS)[number];
export interface HttpResp { status: number; body: string; date: string | null }
export type Http = (url: string) => Promise<HttpResp>;
export interface Quote { provider: string; pair: string; price: string; ts_ms: number }
export interface Adapter { name: string; fetch(http: Http, asset: string): Promise<Quote> }
export interface PriceRow { asset: string; a: Quote; b: Quote; diff_pct: number }

const refuse = (m: string): never => { throw new ReleaseError(m); };

/** Plain positive decimal only (no exponent, NaN, sign, zero). */
function plainDecimal(v: unknown, who: string, asset: string): string {
  let s: unknown = v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return refuse(`${who} ${asset}: price is not finite`);
    s = /e/i.test(String(v)) ? v.toFixed(18).replace(/0+$/, "") : String(v);
  }
  if (typeof s !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(s)) return refuse(`${who} ${asset}: price is not a plain positive decimal: ${JSON.stringify(v)}`);
  if (!/[1-9]/.test(s)) return refuse(`${who} ${asset}: price is zero`);
  return s;
}
function json(r: HttpResp, who: string, asset: string): any {
  if (r.status < 200 || r.status > 299) return refuse(`${who} ${asset}: HTTP ${r.status}`);
  try { return JSON.parse(r.body); } catch { return refuse(`${who} ${asset}: response is not JSON`); }
}
function dateTs(r: HttpResp, who: string, asset: string): number {
  const t = r.date ? Date.parse(r.date) : NaN;
  return Number.isFinite(t) ? t : refuse(`${who} ${asset}: no usable timestamp (Date header ${JSON.stringify(r.date)})`);
}

export const coinbase: Adapter = {
  name: "coinbase",
  async fetch(http, asset) {
    const pair = `${asset}-USD`;
    const r = await http(`https://api.coinbase.com/v2/prices/${pair}/spot`);
    const d = json(r, "coinbase", asset)?.data;
    if (!d || typeof d !== "object") return refuse(`coinbase ${asset}: missing data`);
    if (d.currency !== "USD") return refuse(`coinbase ${asset}: non-USD quote (${JSON.stringify(d.currency)})`);
    if (d.base !== asset) return refuse(`coinbase ${asset}: wrong base asset ${JSON.stringify(d.base)}`);
    return { provider: "coinbase", pair, price: plainDecimal(d.amount, "coinbase", asset), ts_ms: dateTs(r, "coinbase", asset) };
  },
};

const KRAKEN_PAIR: Record<string, string> = { BTC: "XBTUSD", ETH: "ETHUSD", NEAR: "NEARUSD", ZEC: "ZECUSD" };
export const kraken: Adapter = {
  name: "kraken",
  async fetch(http, asset) {
    const pair = KRAKEN_PAIR[asset] ?? refuse(`kraken ${asset}: no pair mapping`);
    const r = await http(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
    const j = json(r, "kraken", asset);
    if (Array.isArray(j?.error) && j.error.length) return refuse(`kraken ${asset}: API error ${JSON.stringify(j.error)}`);
    const keys = Object.keys(j?.result ?? {});
    if (keys.length !== 1) return refuse(`kraken ${asset}: expected one result pair, got ${keys.length}`);
    if (!/USD$/.test(keys[0])) return refuse(`kraken ${asset}: non-USD pair ${keys[0]}`);
    const price = plainDecimal(j.result[keys[0]]?.c?.[0], "kraken", asset); // last trade close
    return { provider: "kraken", pair, price, ts_ms: dateTs(r, "kraken", asset) };
  },
};

const CG_ID: Record<string, string> = { BTC: "bitcoin", ETH: "ethereum", NEAR: "near", ZEC: "zcash" };
export const coingecko: Adapter = {
  name: "coingecko",
  async fetch(http, asset) {
    const id = CG_ID[asset] ?? refuse(`coingecko ${asset}: no id mapping`);
    const r = await http(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_last_updated_at=true&precision=full`);
    const e = json(r, "coingecko", asset)?.[id];
    if (!e || typeof e !== "object" || !("usd" in e)) return refuse(`coingecko ${asset}: no usd quote for ${id}`);
    const luat = e.last_updated_at;
    if (typeof luat !== "number" || !Number.isFinite(luat) || luat <= 0) return refuse(`coingecko ${asset}: no usable timestamp (last_updated_at)`);
    return { provider: "coingecko", pair: `${id}/usd`, price: plainDecimal(e.usd, "coingecko", asset), ts_ms: luat * 1000 };
  },
};

export const ADAPTERS: Record<string, Adapter> = { coinbase, kraken, coingecko };

/** relative difference of b vs a in percent (exact BigInt, 6 dp) */
function diffPct(a: string, b: string): { pct: number; over: boolean } {
  const sc = (s: string) => { const [i, f = ""] = s.split("."); return { n: BigInt(i + f), d: 10n ** BigInt(f.length) }; };
  const x = sc(a), y = sc(b);
  const absNum = x.n * y.d > y.n * x.d ? x.n * y.d - y.n * x.d : y.n * x.d - x.n * y.d; // |a-b| over (x.d*y.d)
  const den = x.n * y.d; // a over (x.d*y.d)
  return { pct: Number((absNum * 100_000_000n) / den) / 1_000_000, over: absNum * 100n > BigInt(PRICE_MAX_DIFF_PCT) * den };
}

export async function fetchPrices(o: { http: Http; providers: Adapter[]; now_ms: number; assets?: readonly string[] }): Promise<PriceRow[]> {
  if (o.providers.length !== 2 || o.providers[0].name === o.providers[1].name) return refuse("prices: need exactly two different providers (the same provider twice is refused)");
  const [A, B] = o.providers;
  const rows: PriceRow[] = [];
  for (const asset of o.assets ?? PXF1_ASSETS) {
    const a = await A.fetch(o.http, asset);
    const b = await B.fetch(o.http, asset);
    const d = diffPct(a.price, b.price);
    if (d.over) return refuse(`${asset}: ${A.name} ${a.price} vs ${B.name} ${b.price} differ by ${d.pct}% (> ${PRICE_MAX_DIFF_PCT}%); refused`);
    rows.push({ asset, a, b, diff_pct: d.pct });
  }
  return rows;
}

const TOKEN_ASSET: Record<string, string> = { "nep141:btc.omft.near": "BTC", "nep141:eth.omft.near": "ETH", "nep141:wrap.near": "NEAR", "nep141:zec.omft.near": "ZEC" };
const PRICE_KEYS = ["price_usd", "price_ts_ms", "second_price_usd", "second_price_ts_ms", "price_source", "second_price_source"];

/** Returns a copy of `input` with prices filled in for every volatile asset and near_price. Stables get no price fields. */
export function mergePrices(input: ReleaseInput, rows: PriceRow[]): ReleaseInput {
  const by = new Map(rows.map((r) => [r.asset, r]));
  const fields = (r: PriceRow) => ({
    price_usd: r.a.price, price_ts_ms: r.a.ts_ms, price_source: `${r.a.provider} ${r.a.pair}`,
    second_price_usd: r.b.price, second_price_ts_ms: r.b.ts_ms, second_price_source: `${r.b.provider} ${r.b.pair}`,
  });
  const out: ReleaseInput = JSON.parse(JSON.stringify(input));
  out.assets = out.assets.map((a) => {
    const c: any = { ...a };
    for (const k of PRICE_KEYS) delete c[k];
    if (a.kind === "stable") return c;
    const sym = TOKEN_ASSET[a.token_id] ?? refuse(`${a.token_id}: no price mapping (supported: ${Object.keys(TOKEN_ASSET).join(", ")})`);
    const r = by.get(sym) ?? refuse(`${a.token_id}: no ${sym} price fetched`);
    return { ...c, ...fields(r) };
  });
  const n = by.get("NEAR") ?? refuse("no NEAR price fetched (needed for near_price)");
  const f = fields(n);
  out.near_price = { price_usd: f.price_usd, price_ts_ms: f.price_ts_ms, second_price_usd: f.second_price_usd, second_price_ts_ms: f.second_price_ts_ms };
  return out;
}

export function renderPriceTable(rows: PriceRow[]): string {
  const l = ["| Asset | Provider A | Price A (USD) | Provider B | Price B (USD) | Diff % | ts (UTC) |", "|---|---|---|---|---|---|---|"];
  for (const r of rows) l.push(`| ${r.asset} | ${r.a.provider} ${r.a.pair} | ${r.a.price} | ${r.b.provider} ${r.b.pair} | ${r.b.price} | ${r.diff_pct} | ${new Date(Math.min(r.a.ts_ms, r.b.ts_ms)).toISOString()} |`);
  return l.join("\n");
}

/** Real network http (15 s timeout). Not used by tests. */
export const realHttp: Http = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json", "user-agent": "praetorial-pxf1" } });
  return { status: res.status, body: await res.text(), date: res.headers.get("date") };
};
