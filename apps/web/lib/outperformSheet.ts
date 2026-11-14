// TPL1 (PM NOTE, familiarcow approved): "Which outperforms?" -- two coins, a start and an end UTC minute, a margin in percentage points.
// The resolver has no typed template for it (pinned wasm), so it is a CUSTOM sheet decided by the AI judge, in the same shape as
// lib/assetPriceSheet (claim, one narrow question, the median-close rule, only these pairs, CLAUSES_V1, 7-day evidence tail).
// YES when A's change beats B's by at least the margin, NO when B's beats A's by at least the margin, VOID (refund) in between.
// The claim says "percentage points" / "price change", never "%" or "percent": the resolver lint (lint_hints.rs PERCENT, mirrored in
// builderGate AMBIGUOUS_PERCENT_MOVE) refuses those words in a claim because they usually mean a move with no fixed reference;
// here both references (the start and end candles on named venues) are fixed in the sheet.
// Sources: for each coin, the venues that list BOTH coins (>= 2): Bitstamp and Kraken name the candle time (one URL at the start,
// one at the end); Coinbase answers 400 for a future start time, so it is its latest-candles URL (as in assetPriceSheet).
import { lintTemplate, buildTypedSheet, parseIso } from "./templates";
import { toUtcMinute, openUtcNow, type GuidedForm } from "./guidedFields";
import { builderGate } from "./builderGate";
import { MIN_VENUES, VENUE_NAMES, VENUE_ORDER, type MarketAsset, type VenueId } from "./marketAssets";

const EVIDENCE_TAIL_SECS = 7 * 86400; // template.rs EVIDENCE_TAIL_SECS
const CLAUSES_V1 = ["UTC_V1", "BEFORE_INCLUSIVE_V1", "NUMERIC_EXACT_V1", "ROUNDING_PRECISION_V1", "NO_DATA_FALLBACK_V1"];
const FALLBACK = "Fallback: if one named source is unavailable the remaining sources must confirm; if too few can be checked the outcome is VOID with full refunds after the recovery window.";
export const DEFAULT_MARGIN_PTS = "0.5";
const iso = (secs: number) => new Date(secs * 1000).toISOString().replace(/\.\d+Z$/, "Z");
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The venues that list both coins, in the curated order. */
export function sharedVenues(a: MarketAsset, b: MarketAsset): VenueId[] {
  return VENUE_ORDER.filter((v) => a.pairs[v] && b.pairs[v]);
}

/** The margin as typed (blank = the default 0.5) in canonical form, or null when it is not a number of points in (0, 100] with
 *  at most 2 decimals. */
export function marginPts(v: string | undefined): string | null {
  const t = (v ?? "").trim() || DEFAULT_MARGIN_PTS;
  if (!/^\d+(\.\d{1,2})?$/.test(t) || !(Number(t) > 0) || Number(t) > 100) return null;
  return t.replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

const ids: Record<VenueId, string> = { coinbase: "CB", bitstamp: "BS", kraken: "KR" };
function sources(x: MarketAsset, tag: "A" | "B", venues: VenueId[], start: number, end: number) {
  const out: { id: string; publisher: string; url: string; pair: string }[] = [];
  for (const v of venues) {
    const p = x.pairs[v]!;
    const publisher = `${VENUE_NAMES[v]} ${p.label}`;
    if (v === "coinbase") { out.push({ id: `S_${ids[v]}_${tag}`, publisher, url: `https://api.exchange.coinbase.com/products/${p.api}/candles?granularity=60`, pair: p.label }); continue; }
    for (const [when, t] of [["START", start], ["END", end]] as const) {
      const url = v === "bitstamp" ? `https://www.bitstamp.net/api/v2/ohlc/${p.api}/?step=60&limit=5&start=${t - 60}`
        : `https://api.kraken.com/0/public/OHLC?pair=${p.api}&interval=1&since=${t - 120}`;
      out.push({ id: `S_${ids[v]}_${tag}_${when}`, publisher, url, pair: p.label });
    }
  }
  return out;
}

/** The custom sheet for "did A's price change beat B's by at least m percentage points from start to end?". */
export function outperformSheet(a: MarketAsset, b: MarketAsset, g: GuidedForm): Record<string, unknown> {
  const sIso = toUtcMinute(g.start_utc ?? ""), eIso = toUtcMinute(g.end_utc ?? "");
  const s = parseIso(sIso) ?? 0, e = parseIso(eIso) ?? 0;
  const m = marginPts(g.margin_pts) ?? (g.margin_pts ?? "").trim();
  const pa = `${a.symbol}-USD`, pb = `${b.symbol}-USD`;
  const venues = sharedVenues(a, b);
  const names = andList(venues.map((v) => VENUE_NAMES[v]));
  const src = [...sources(a, "A", venues, s, e), ...sources(b, "B", venues, s, e)];
  const pubs = [...new Set(src.map((x) => x.publisher))];
  const cutoff = iso(e + EVIDENCE_TAIL_SECS);
  return {
    claim: `From ${sIso} to ${eIso}, the ${pa} price change beats the ${pb} price change by at least ${m} percentage points, using the median close of the 1-minute candles on ${names}.`,
    elements: [{ id: "e1", q: `From ${sIso} to ${eIso}, did the ${pa} price change beat the ${pb} price change by at least ${m} percentage points (median 1-minute close on ${names})?` }],
    rule: "ALL",
    clauses: [...CLAUSES_V1],
    time: { window_start: iso(s - 60), window_end: iso(e), evidence_cutoff: cutoff },
    sources_allowed: src.map(({ id, publisher, url }) => ({ id, publisher, url })),
    source_classes: Object.fromEntries(pubs.map((p) => [p, "primary"])),
    ticker_pins: Object.fromEntries(src.map((x) => [x.publisher, x.pair])),
    custom_definitions: [
      FALLBACK,
      `Each coin's price at a time is the median CLOSE of its 1-minute USD candle ending at that time on ${names} (with two readable venues, their mean). The CLOSE is what is checked, never the high or low (wick).`,
      `Each coin's price change is (price at ${eIso} minus price at ${sIso}) divided by price at ${sIso}, times 100, in percentage points.`,
      `YES if the ${pa} change minus the ${pb} change is at least ${m} percentage points. NO if the ${pb} change minus the ${pa} change is at least ${m} percentage points. Otherwise the gap is under the ${m}-point margin and the outcome is VOID with full refunds.`,
      `Early resolution: never before the 1-minute candle ending ${eIso} has closed; the settle request is ${eIso} plus 5 minutes.`,
      `Only the ${pa} pair and the ${pb} pair on the named venues are eligible; no aggregators or other assets.`,
    ],
    window_close: cutoff,
    sources: true,
  };
}

/** Problems with the "Which outperforms?" form: the typed lint's own time errors for the start and the end (checked on a
 *  Bitcoin-shaped copy, like assetPriceProblems), the end after the start, two different coins, the margin, >= 2 shared exchanges,
 *  then the builder gate on the sheet. */
export function outperformProblems(a: MarketAsset | undefined, b: MarketAsset | undefined, g: GuidedForm, nowMs: number): string[] {
  const p: string[] = [];
  const open = openUtcNow(nowMs);
  for (const k of ["start_utc", "end_utc"] as const) {
    const t = toUtcMinute(g[k] ?? "");
    const shape = Object.fromEntries(Object.entries({ t_utc: t, op: ">=", x_usd: 1, open_utc: open }).filter(([, v]) => v !== ""));
    for (const x of lintTemplate(buildTypedSheet("btc_close_at_t", shape))) if (!p.includes(x)) p.push(x);
  }
  const s = parseIso(toUtcMinute(g.start_utc ?? "")), e = parseIso(toUtcMinute(g.end_utc ?? ""));
  // A start already past would let the maker bet on a move partly known; the typed lint does not check it (the review checks the end).
  if (s != null && s <= Math.floor(nowMs / 1000)) p.push(`OUTPERFORM_START_PASSED: the start (${g.start_utc} UTC) has already passed; pick a start in the future`);
  if (s != null && e != null && !(e > s)) p.push(`OUTPERFORM_END_NOT_AFTER_START: the end (${g.end_utc}) must be after the start (${g.start_utc})`);
  if (!a || !b) p.push("OUTPERFORM_NEED_TWO_COINS: pick two coins to compare");
  else if (a.symbol === b.symbol) p.push(`OUTPERFORM_SAME_COIN: both coins are ${a.symbol}; pick two different coins`);
  if (!marginPts(g.margin_pts)) p.push(`OUTPERFORM_MARGIN: the margin must be a number of percentage points above 0 and at most 100, like 0.5 (got ${JSON.stringify(g.margin_pts ?? "")})`);
  if (a && b && a.symbol !== b.symbol) {
    const n = sharedVenues(a, b).length;
    if (n < MIN_VENUES) p.push(`PRICE_TOO_FEW_VENUES: ${a.symbol}-USD and ${b.symbol}-USD are both listed on ${n} of the curated exchanges; this bet needs at least ${MIN_VENUES} that list both`);
  }
  if (p.length) return p;
  return builderGate(outperformSheet(a!, b!, g)).problems;
}

/** "Checked on Coinbase and Kraken (they list both coins)". */
export function outperformVenuesText(a: MarketAsset, b: MarketAsset): string {
  const v = sharedVenues(a, b);
  return v.length ? `Checked on ${andList(v.map((x) => VENUE_NAMES[x]))} (the exchanges that list both coins)` : "No exchange we check lists both coins.";
}
