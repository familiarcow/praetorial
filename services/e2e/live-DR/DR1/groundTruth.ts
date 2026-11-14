// DR1 ground truth: BTC-USD 1-minute candle highs/lows from Kraken, Coinbase (and Bitstamp as the third venue of the template)
// fetched by the HARNESS from public APIs, independent of the judge. Pure decision logic (decideTouch) is unit-tested offline.
export type Venue = "Coinbase" | "Kraken" | "Bitstamp";
export interface Candle { t: number; high: number; low: number } // t = candle start, unix seconds
export type Direction = "at_or_above" | "at_or_below";
export interface VenueVerdict { venue: Venue; candles: number; touched: boolean; extreme: number | null; firstTouchT: number | null }
export interface Truth { outcome: "YES" | "NO"; confirming: Venue[]; perVenue: VenueVerdict[]; rule: string }

export function venueVerdict(venue: Venue, candles: Candle[], dir: Direction, x: number, openSecs: number, deadlineSecs: number): VenueVerdict {
  const inWin = candles.filter((c) => c.t >= openSecs && c.t < deadlineSecs).sort((a, b) => a.t - b.t);
  const hit = inWin.find((c) => (dir === "at_or_above" ? c.high >= x : c.low <= x));
  const ext = inWin.length ? (dir === "at_or_above" ? Math.max(...inWin.map((c) => c.high)) : Math.min(...inWin.map((c) => c.low))) : null;
  return { venue, candles: inWin.length, touched: !!hit, extreme: ext, firstTouchT: hit ? hit.t : null };
}
/** Template rule (resolver template.rs btc_touch): a wick crossing the level on at least TWO of the three named venues is YES, else NO. */
export function decideTouch(perVenue: VenueVerdict[]): Truth {
  const confirming = perVenue.filter((v) => v.touched).map((v) => v.venue);
  return { outcome: confirming.length >= 2 ? "YES" : "NO", confirming, perVenue, rule: "wick (1-minute high for at_or_above / low for at_or_below) crossing the level on >= 2 of Coinbase, Bitstamp, Kraken within [open_utc, deadline_utc)" };
}

const j = async (u: string): Promise<any> => { const r = await fetch(u); if (!r.ok) throw new Error(`${u.replace(/\?.*/, "")} -> HTTP ${r.status}`); return r.json(); };
export async function fetchKraken(fromSecs: number): Promise<Candle[]> {
  const out: Candle[] = []; let since = fromSecs - 1;
  for (let i = 0; i < 10; i++) {
    const r = await j(`https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1&since=${since}`);
    const key = Object.keys(r.result).find((k) => k !== "last")!; const rows: any[][] = r.result[key];
    for (const x of rows) out.push({ t: Number(x[0]), high: Number(x[2]), low: Number(x[3]) });
    if (rows.length < 700 || Number(r.result.last) <= since) break; since = Number(r.result.last);
  }
  return out;
}
export async function fetchCoinbase(fromSecs: number, toSecs: number): Promise<Candle[]> {
  const out: Candle[] = [];
  for (let s = fromSecs; s < toSecs; s += 300 * 60) {
    const e = Math.min(s + 300 * 60, toSecs);
    const rows: number[][] = await j(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${new Date(s * 1000).toISOString()}&end=${new Date(e * 1000).toISOString()}`);
    for (const x of rows) out.push({ t: x[0], low: x[1], high: x[2] });
  }
  return out;
}
export async function fetchBitstamp(fromSecs: number, toSecs: number): Promise<Candle[]> {
  const r = await j(`https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&limit=1000&start=${fromSecs}&end=${toSecs}`);
  return (r.data.ohlc as { timestamp: string; high: string; low: string }[]).map((x) => ({ t: Number(x.timestamp), high: Number(x.high), low: Number(x.low) }));
}
export async function computeTruth(dir: Direction, x: number, openSecs: number, deadlineSecs: number): Promise<Truth> {
  const [k, c, b] = await Promise.all([fetchKraken(openSecs), fetchCoinbase(openSecs, deadlineSecs), fetchBitstamp(openSecs, deadlineSecs)]);
  return decideTouch([venueVerdict("Coinbase", c, dir, x, openSecs, deadlineSecs), venueVerdict("Kraken", k, dir, x, openSecs, deadlineSecs), venueVerdict("Bitstamp", b, dir, x, openSecs, deadlineSecs)]);
}
/** Threshold that the real price decides: ~0.8% above (or below) the live Coinbase price, rounded to $100. */
export async function chooseThreshold(dir: Direction): Promise<{ x: number; spot: number }> {
  const spot = Number((await j("https://api.exchange.coinbase.com/products/BTC-USD/ticker")).price);
  const raw = dir === "at_or_above" ? spot * 1.008 : spot * 0.992;
  return { x: (dir === "at_or_above" ? Math.ceil(raw / 100) : Math.floor(raw / 100)) * 100, spot };
}
