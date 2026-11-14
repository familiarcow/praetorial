// DR4 ground truth: the harness fetches the SAME two pages the bet names (Coinbase candles, Bitstamp OHLC), saves the raw bodies,
// and extracts the max 1-minute candle HIGH inside the window. Independent of the judge; written BEFORE request_resolution.
// Pure decision logic is unit-tested offline.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { SOURCES } from "./scenario.js";
export type Venue = "Coinbase" | "Bitstamp";
export interface Candle { t: number; high: number }
export interface VenueFact { venue: Venue; url: string; candles: number; maxHigh: number | null; breached: boolean; firstBreachT: number | null; rawFile: string; rawSha256: string }
export interface Truth { outcome: "YES" | "NO" | "VOID"; perVenue: VenueFact[]; rule: string }

export function parseCoinbase(raw: string): Candle[] { return (JSON.parse(raw) as number[][]).map((r) => ({ t: r[0], high: r[2] })); }
export function parseBitstamp(raw: string): Candle[] { return (JSON.parse(raw).data.ohlc as { timestamp: string; high: string }[]).map((r) => ({ t: Number(r.timestamp), high: Number(r.high) })); }

/** Window is [startSecs, endSecs): a candle STARTING in it counts. "stays below x" is breached by any high >= x. */
export function venueFact(venue: Venue, candles: Candle[], x: number, startSecs: number, endSecs: number, meta: { url: string; rawFile: string; rawSha256: string }): VenueFact {
  const inWin = candles.filter((c) => c.t >= startSecs && c.t < endSecs).sort((a, b) => a.t - b.t);
  const hit = inWin.find((c) => c.high >= x);
  return { venue, candles: inWin.length, maxHigh: inWin.length ? Math.max(...inWin.map((c) => c.high)) : null, breached: !!hit, firstBreachT: hit ? hit.t : null, ...meta };
}
/** Both sites breached -> NO; neither -> YES; one only (the sources truly disagree) -> VOID. A venue with no candle in the window cannot decide: VOID. */
export function decideStaysBelow(perVenue: VenueFact[], minCandles = 1): Truth {
  const rule = "claim 'stays below x for the whole session' (candle HIGH): YES if no candle high >= x on either site; NO if both sites have one; one site only = the sources disagree = VOID; a site with no candle in the window = VOID";
  if (perVenue.some((v) => v.candles < minCandles)) return { outcome: "VOID", perVenue, rule };
  const n = perVenue.filter((v) => v.breached).length;
  return { outcome: n === 0 ? "YES" : n === perVenue.length ? "NO" : "VOID", perVenue, rule };
}

export async function fetchRaw(url: string): Promise<string> { const r = await fetch(url, { headers: { "user-agent": "praetorial-dr4-harness" } }); if (!r.ok) throw new Error(`${url.replace(/\?.*/, "")} -> HTTP ${r.status}`); return r.text(); }
export async function computeTruth(x: number, startSecs: number, endSecs: number, rawDir: string): Promise<Truth> {
  fs.mkdirSync(rawDir, { recursive: true });
  const facts: VenueFact[] = [];
  for (const [venue, parse] of [["Coinbase", parseCoinbase], ["Bitstamp", parseBitstamp]] as const) {
    const url = SOURCES.find((s) => s.publisher.startsWith(venue))!.url;
    const raw = await fetchRaw(url);
    const rawFile = `raw_${venue.toLowerCase()}.json`;
    fs.writeFileSync(path.join(rawDir, rawFile), raw);
    facts.push(venueFact(venue, parse(raw), x, startSecs, endSecs, { url, rawFile, rawSha256: createHash("sha256").update(raw).digest("hex") }));
  }
  return decideStaysBelow(facts);
}
export async function coinbaseSpot(): Promise<number> { return Number(JSON.parse(await fetchRaw("https://api.exchange.coinbase.com/products/BTC-USD/ticker")).price); }
