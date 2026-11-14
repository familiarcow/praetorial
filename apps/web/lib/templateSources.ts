// FE3b Q3: the feeds a bet is checked against, read from the same template definition the resolver builds
// (resolver/core/src/template.rs: venue_sources / game_winner sources / nws sources). tests/templateSources.unit.test.ts pins every
// name to a publisher string in template.rs. Never hard-coded per template in a component.
import { templateId } from "./templates";

const BTC_VENUES = ["Coinbase BTC-USD", "Bitstamp btcusd", "Kraken XBT/USD"];
const LEAGUE_FEEDS: Record<string, string[]> = { MLB: ["MLB Stats API", "ESPN"], NHL: ["NHL api-web", "ESPN"], NFL: ["ESPN"], NBA: ["ESPN"] };
const NWS_FEEDS = ["NWS CLI (api.weather.gov)", "IEM CLI (mesonet.agron.iastate.edu)"];

/** Source names for a typed sheet ({template, fields}); [] for a custom sheet or anything unknown. */
export function templateSourceNames(ts: any): string[] {
  const id = templateId(ts).id;
  if (id === "btc_close_at_t" || id === "btc_touch") return [...BTC_VENUES];
  if (id === "game_winner") return [...(LEAGUE_FEEDS[ts?.fields?.league] ?? [])];
  if (id === "nws_daily_high") return [...NWS_FEEDS];
  return [];
}

/** A custom sheet's source hosts (the publisher name when a source has no usable URL), de-duplicated in order. */
export function customSourceHosts(sheet: any): string[] {
  const out: string[] = [];
  for (const s of Array.isArray(sheet?.sources_allowed) ? sheet.sources_allowed : []) {
    let h = "";
    try { h = new URL(String(s?.url ?? "")).hostname; } catch { h = ""; }
    const v = h || String(s?.publisher ?? "").trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}
