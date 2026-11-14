// TPL1 (D-PM3 #1): a price bet on a coin other than Bitcoin. The resolver's typed price templates are BTC-only (pinned wasm), so
// any other asset becomes a CUSTOM sheet decided by the AI judge, written in the same shape the resolver materializes for BTC
// (resolver/core/src/template.rs `materialize` btc_close_at_t / btc_touch: claim, one narrow question, the median-close or
// wick-touch rule, "only this pair, no aggregators", CLAUSES_V1, a 7-day evidence tail) with the exchanges that list the pair.
//
// Source URLs: the venues' public 1-minute candle endpoints, the same hosts and paths as template.rs venue_sources. Coinbase
// answers 400 for a start time in the future ("Start cannot be in the future"), so it is asked for its latest candles (the last
// 5 hours); Bitstamp and Kraken take the candle time and answer 200 before it exists (checked live 2026-11-12), so the open-time
// "Check the sources" reaches every URL. Touch bets read the latest candles (the keeper archives them every 6 hours while live).
import { lintTemplate, buildTypedSheet, parseIso, templateId } from "./templates";
import { toUtcMinute, openUtcNow, type GuidedForm } from "./guidedFields";
import { builderGate } from "./builderGate";
import { MIN_VENUES, VENUE_NAMES, venuesOf, type MarketAsset, type VenueId } from "./marketAssets";

export type PriceKind = "btc_close_at_t" | "btc_touch";
export const isBitcoin = (a: MarketAsset | null | undefined): boolean => !a || a.symbol === "BTC";

const EVIDENCE_TAIL_SECS = 7 * 86400; // template.rs EVIDENCE_TAIL_SECS
const CLAUSES_V1 = ["UTC_V1", "BEFORE_INCLUSIVE_V1", "NUMERIC_EXACT_V1", "ROUNDING_PRECISION_V1", "NO_DATA_FALLBACK_V1"];
const FALLBACK = "Fallback: if one named source is unavailable the remaining sources must confirm; if too few can be checked the outcome is VOID with full refunds after the recovery window.";
export const ASSET_PRICE_RULE_ONLY_PAIR = (pair: string) => `Only the ${pair} pair on the named venues is eligible; no aggregators or other assets.`;
const OP_WORDS: Record<string, string> = { ">": "above (>)", ">=": "at least (>=)", "<": "below (<)", "<=": "at most (<=)" };
const iso = (secs: number) => new Date(secs * 1000).toISOString().replace(/\.\d+Z$/, "Z");
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** A plain positive dollar amount ("950", "0.25", up to 8 decimals) in canonical form, or null. */
export function priceLevel(v: string | undefined): string | null {
  const t = (v ?? "").trim();
  if (!/^\d+(\.\d{1,8})?$/.test(t) || !(Number(t) > 0)) return null;
  return t.replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function sources(a: MarketAsset, win: { closeAt?: number }): { id: string; publisher: string; url: string; pair: string }[] {
  const id: Record<VenueId, string> = { coinbase: "S_CB", bitstamp: "S_BS", kraken: "S_KR" };
  return venuesOf(a).map((v) => {
    const p = a.pairs[v]!;
    const t = win.closeAt;
    const url = v === "coinbase" ? `https://api.exchange.coinbase.com/products/${p.api}/candles?granularity=60`
      : v === "bitstamp" ? `https://www.bitstamp.net/api/v2/ohlc/${p.api}/?step=60&${t === undefined ? "limit=1000" : `limit=5&start=${t - 60}`}`
      : `https://api.kraken.com/0/public/OHLC?pair=${p.api}&interval=1${t === undefined ? "" : `&since=${t - 120}`}`;
    return { id: id[v], publisher: `${VENUE_NAMES[v]} ${p.label}`, url, pair: p.label };
  });
}

/** The custom sheet for a price bet on `a` (any asset; the app only uses it for non-Bitcoin ones). Fields as the guided form holds them. */
export function assetPriceSheet(kind: PriceKind, a: MarketAsset, g: GuidedForm, nowMs: number): Record<string, unknown> {
  const pair = `${a.symbol}-USD`;
  const names = venuesOf(a).map((v) => VENUE_NAMES[v]);
  const x = priceLevel(g.x_usd) ?? (g.x_usd ?? "").trim();
  let claim: string, q: string, ws: number, we: number, defs: string[], src: ReturnType<typeof sources>;
  if (kind === "btc_close_at_t") {
    const tIso = toUtcMinute(g.t_utc ?? "");
    const t = parseIso(tIso) ?? 0;
    const opw = OP_WORDS[g.op] ?? g.op;
    claim = `The median of the CLOSE of the 1-minute ${pair} candle ending ${tIso} on ${andList(names)} is ${opw} ${x} USD.`;
    q = `Is the median close of the 1-minute ${pair} candle ending ${tIso} on ${andList(names)} ${opw} ${x} USD?`;
    ws = t - 60; we = t;
    src = sources(a, { closeAt: t });
    defs = [
      names.length >= 3
        ? "The CLOSE of the 1-minute candle is what is checked, never the high (wick). With three venues the median close decides; with two the mean, and VOID if they straddle the level; fewer than two is VOID."
        : "The CLOSE of the 1-minute candle is what is checked, never the high (wick). With the two venues the mean close decides, and VOID if they straddle the level; fewer than two is VOID.",
      "Early resolution: never before the candle has closed; the settle request is T + 5 minutes.",
    ];
  } else {
    const dIso = toUtcMinute(g.deadline_utc ?? "");
    const oIso = openUtcNow(nowMs);
    const above = g.direction !== "at_or_below";
    const [side, cmp, ext] = above ? ["at or above", ">=", "HIGH"] : ["at or below", "<=", "LOW"];
    const where = names.length >= 3 ? `at least two of ${names.join(", ")}` : `both ${andList(names)}`;
    claim = `${pair} 1-minute candle ${above ? "high" : "low"} is ${side} ${x} USD on ${where} between ${oIso} and ${dIso}.`;
    q = `Is a 1-minute ${pair} candle ${above ? "high" : "low"} ${cmp} ${x} on ${names.length >= 3 ? `at least two of ${andList(names)}` : `both ${andList(names)}`} between ${oIso} and ${dIso}?`;
    ws = parseIso(oIso) ?? 0; we = parseIso(dIso) ?? 0;
    src = sources(a, {});
    defs = [
      `A 1-minute candle ${ext} (the wick), not the close, crossing the stated USD level counts as a touch; the touch requires confirmation on ${names.length >= 3 ? "at least two of the three" : "both of the two"} named venues.`,
      "Early YES resolution is allowed at the first qualifying confirmed candle, never before; if no touch occurred in the window the outcome is NO.",
    ];
  }
  const cutoff = iso(we + EVIDENCE_TAIL_SECS);
  return {
    claim,
    elements: [{ id: "e1", q }],
    rule: "ALL",
    clauses: [...CLAUSES_V1],
    time: { window_start: iso(ws), window_end: iso(we), evidence_cutoff: cutoff },
    sources_allowed: src.map(({ id, publisher, url }) => ({ id, publisher, url })),
    source_classes: Object.fromEntries(src.map((s) => [s.publisher, "primary"])),
    ticker_pins: Object.fromEntries(src.map((s) => [s.publisher, s.pair])),
    custom_definitions: [FALLBACK, ...defs, ASSET_PRICE_RULE_ONLY_PAIR(pair)],
    window_close: cutoff,
    sources: true,
  };
}

/** Problems with the form for a non-Bitcoin price bet: the typed lint's own named errors for the time / comparison (checked on a
 *  Bitcoin-shaped copy), the price (any positive dollar amount; cents allowed), >= 2 listing exchanges, then the builder gate. */
export function assetPriceProblems(kind: PriceKind, a: MarketAsset, g: GuidedForm, nowMs: number): string[] {
  const shape = kind === "btc_close_at_t"
    ? { t_utc: toUtcMinute(g.t_utc ?? ""), op: g.op, x_usd: 1, open_utc: openUtcNow(nowMs) }
    : { direction: g.direction, x_usd: 1, deadline_utc: toUtcMinute(g.deadline_utc ?? ""), open_utc: openUtcNow(nowMs) };
  const clean = Object.fromEntries(Object.entries(shape).filter(([, v]) => v !== undefined && v !== ""));
  const p = lintTemplate(buildTypedSheet(kind, clean));
  if (!priceLevel(g.x_usd)) p.push(`PRICE_LEVEL_NOT_POSITIVE: enter the price as a positive number of US dollars, like 950 or 0.25 (got ${JSON.stringify(g.x_usd ?? "")})`);
  const n = venuesOf(a).length;
  if (n < MIN_VENUES) p.push(`PRICE_TOO_FEW_VENUES: ${a.symbol}-USD is listed on ${n} of the curated exchanges; a price bet needs at least ${MIN_VENUES} to check it`);
  if (p.length) return p;
  return builderGate(assetPriceSheet(kind, a, g, nowMs)).problems;
}

/** The review card's "who decides" line for a price bet; null for every other bet (the card keeps its own line). */
export function deciderLine(sheet: unknown): string | null {
  const s = sheet as Record<string, any> | null;
  const id = templateId(s).id;
  if (id === "btc_close_at_t" || id === "btc_touch") return "Decided by code from Coinbase, Bitstamp and Kraken 1-minute prices";
  if (id !== "custom" || !s?.ticker_pins || !Array.isArray(s.sources_allowed)) return null;
  const pubs = [...new Set<string>(s.sources_allowed.map((x: any) => String(x?.publisher ?? "")).filter((x: string) => x in s.ticker_pins))]; // "Which outperforms?" names a venue twice (start, end)
  if (!pubs.length || !/1-minute/.test(String(s.claim ?? ""))) return null;
  return `Decided by the AI judge reading ${andList(pubs)}`;
}

/** The "who decides" line for a coin, before any sheet exists (the fill step): the same words deciderLine gives its sheet. */
export function assetDeciderText(a: MarketAsset | null | undefined): string {
  if (isBitcoin(a)) return "Decided by code from Coinbase, Bitstamp and Kraken 1-minute prices";
  return `Decided by the AI judge reading ${andList(venuesOf(a!).map((v) => `${VENUE_NAMES[v]} ${a!.pairs[v]!.label}`))}`;
}
/** "Checked on Coinbase ZEC-USD, Bitstamp zecusd and Kraken ZEC/USD": only the exchanges that list the pair. */
export function assetVenuesText(a: MarketAsset): string {
  return `Checked on ${andList(venuesOf(a).map((v) => `${VENUE_NAMES[v]} ${a.pairs[v]!.label}`))}`;
}
