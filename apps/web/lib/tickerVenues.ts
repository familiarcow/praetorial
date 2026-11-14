// Shared venue->upstream-URL map and price parser, used by the vite dev
// proxy (vite.config.ts, dev only) and the production Cloudflare Pages
// Function equivalent (functions/api/ticker.ts). One copy so the two
// never drift. Venues here must stay a superset of lib/venues.ts's
// curated per-asset lists -- adding a venue to the curated list without
// adding its ticker URL here would let the UI "allow" a venue the
// backend can't actually price.
export const TICKER_URLS: Record<string, string> = {
  coinbase: "https://api.coinbase.com/v2/prices/BTC-USD/spot",
  binance: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
  bitstamp: "https://www.bitstamp.net/api/v2/ticker/btcusd/",
  kraken: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
  gemini: "https://api.gemini.com/v1/pubticker/btcusd",
  okx: "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT",
  bybit: "https://api.bybit.com/v5/market/tickers?category=spot&symbol=BTCUSDT",
};

// Binance's public api.binance.com is geo-blocked from US IPs. Fall back
// in order to api.binance.us, then the read-only data-api.binance.vision
// mirror; if all three fail, say so in the UI rather than silently
// showing a stale/wrong price.
export const BINANCE_FALLBACK_URLS: string[] = [
  "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT",
  "https://api.binance.us/api/v3/ticker/price?symbol=BTCUSDT",
  "https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT",
];

export function parseTickerPrice(venue: string, body: any): number | null {
  try {
    if (venue === "coinbase") return parseFloat(body.data.amount);
    if (venue === "binance") return parseFloat(body.price);
    if (venue === "bitstamp") return parseFloat(body.last);
    if (venue === "kraken") {
      const result = body.result;
      const key = Object.keys(result)[0];
      return parseFloat(result[key].c[0]);
    }
    if (venue === "gemini") return parseFloat(body.last);
    if (venue === "okx") return parseFloat(body.data[0].last);
    if (venue === "bybit") return parseFloat(body.result.list[0].lastPrice);
  } catch {
    return null;
  }
  return null;
}

export interface VenueFetchResult {
  price: number | null;
  error?: string;
  /** Which upstream URL actually answered (useful for Binance's fallback chain). */
  source?: string;
}

/**
 * Fetches one venue's price. Binance tries binance.com, then binance.us,
 * then data-api.binance.vision in order (geo-block fallback, D-VENUE1);
 * every other venue hits its single known endpoint. Never throws --
 * failures come back as { price: null, error }.
 */
export async function fetchVenuePrice(venue: string): Promise<VenueFetchResult> {
  if (venue === "binance") {
    const attempts: string[] = [];
    for (const url of BINANCE_FALLBACK_URLS) {
      try {
        const r = await fetch(url);
        if (!r.ok) {
          attempts.push(`${url} -> HTTP ${r.status}`);
          continue;
        }
        const body = await r.json();
        const price = parseTickerPrice("binance", body);
        if (price && price > 0) return { price, source: url };
        attempts.push(`${url} -> unparseable response`);
      } catch (e: any) {
        attempts.push(`${url} -> ${String(e?.message ?? e)}`);
      }
    }
    return {
      price: null,
      error:
        "Binance unavailable from all endpoints (binance.com, binance.us, data-api.binance.vision) -- possibly geo-blocked. " +
        attempts.join("; "),
    };
  }
  const upstream = TICKER_URLS[venue];
  if (!upstream) return { price: null, error: "unknown venue" };
  try {
    const r = await fetch(upstream);
    if (!r.ok) return { price: null, error: `HTTP ${r.status}` };
    const body = await r.json();
    const price = parseTickerPrice(venue, body);
    return { price, source: upstream };
  } catch (e: any) {
    return { price: null, error: String(e?.message ?? e) };
  }
}
