// DR4 scenario: ONE messy custom any-page bet typed into the S3 custom builder, two distinct sites (D-TPL1).
// Wording is taken verbatim from the L1 messy-phrasing set (live-L1/examples.json range_breakout_no, "BTC stays below $76123 for
// the whole session": a custom-kind case the builder ACCEPTS, unlike flips_100k_messy / pct_up_day / friday_custom, which the builder
// refuses). Only the level is re-chosen from the live price so the real market decides; the phrasing is never cleaned up.
// Shared by the live spec and the offline unit test so the test proves exactly what the spec types.
export interface Win { start: string; end: string; cutoff: string } // datetime-local values (UTC minutes, "YYYY-MM-DDTHH:MM")
export interface DrForm {
  claim: string; element: string; rule: "ALL" | "ANY";
  sources: { publisher: string; url: string; tier: "primary" | "data"; ticker: string }[];
  win: Win; fallback: string; early: string; leading: string[];
}
export const SOURCES: DrForm["sources"] = [
  { publisher: "Coinbase BTC-USD", url: "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60", tier: "primary", ticker: "BTC-USD" },
  { publisher: "Bitstamp btcusd", url: "https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&limit=100", tier: "primary", ticker: "btcusd" },
];
export const usdText = (x: number) => `$${x.toLocaleString("en-US")}`;
/** L1 messy wording, level substituted: "BTC stays below $76123 for the whole session" (L1 writes the level without a comma; kept that way). */
export const claimFor = (x: number) => `BTC stays below $${x} for the whole session`;
export const elementFor = (x: number) => `Does BTC stay below $${x} for the whole session?`;
/** Level ~bps above spot, rounded UP to $10 (a 10-minute window: roughly a coin flip, so the real price decides). */
export function chooseLevel(spot: number, bps = 12): number { return Math.ceil((spot * (1 + bps / 10_000)) / 10) * 10; }
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16);
/** Shortest window the builder allows: start a few minutes after the form is filled, 10 minutes long, evidence cutoff 2 min later. */
export function windowFrom(nowMs: number, leadMin = 4, lenMin = 10, cutoffMin = 2): Win {
  const start = Math.ceil(nowMs / 60_000) * 60_000 + leadMin * 60_000;
  return { start: iso(start), end: iso(start + lenMin * 60_000), cutoff: iso(start + (lenMin + cutoffMin) * 60_000) };
}
export function formFor(x: number, win: Win): DrForm {
  return {
    claim: claimFor(x), element: elementFor(x), rule: "ALL", sources: SOURCES, win,
    leading: ["Only candle data from the two listed venues counts; a 1-minute candle HIGH (the wick) is what is read, not the close."],
    fallback: "Fallback: if one named venue is unavailable the other must confirm; if fewer than two can be checked the outcome is VOID.",
    early: "No early settlement: the outcome is decided at the window end.",
  };
}
