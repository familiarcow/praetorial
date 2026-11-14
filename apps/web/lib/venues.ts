// Curated venue list and the bettor's-choice source model (D-VENUE1).
//
// Sources are the bettor's choice: a curated list has built-in fetchers
// (Coinbase, Binance, Bitstamp, Kraken, Gemini, OKX, Bybit); a bettor may
// also name a custom venue, which is allowed but flagged on the review
// card as "checked from evidence/archive only, not a built-in fetcher"
// rather than refused outright.
export const CURATED_VENUES: Record<string, string[]> = {
  "BTC-USD": ["Coinbase", "Binance", "Bitstamp", "Kraken", "Gemini", "OKX", "Bybit"],
};

// Maps a free-text pair string (as typed into a source row, e.g.
// "btcusd", "XBT/USD", "BTC-USD") to the curated-list key it falls
// under. Only BTC-USD is modeled today; anything else maps to its own
// uppercased pair (so it has an empty curated list, meaning any venue
// named against it is a custom/non-built-in venue).
export function assetKeyForPair(pair: string): string {
  const normalized = pair.toLowerCase().replace(/[^a-z]/g, "");
  if (normalized.includes("btc") || normalized === "xbtusd") return "BTC-USD";
  return pair.trim().toUpperCase();
}

export function curatedVenuesFor(pair: string): string[] {
  return CURATED_VENUES[assetKeyForPair(pair)] ?? [];
}

/** True if this venue is on the built-in curated list for this pair (has a real fetcher). */
export function isCuratedVenue(pair: string, venue: string): boolean {
  if (!venue.trim()) return false;
  const list = curatedVenuesFor(pair);
  return list.some((v) => v.toLowerCase() === venue.trim().toLowerCase());
}

/**
 * Bettors may always name a custom venue (P-1: freedom stays with the
 * user over which sources). It is never refused outright -- instead it
 * is flagged, both in the create form and on the review card, so the
 * counterparty and the resolver know it has no built-in price fetcher
 * and will be checked from evidence/archive only.
 */
export function customVenueFlagMessage(venue: string, pair: string): string {
  return `Source "${venue} ${pair}" is a custom venue: checked from evidence/archive only, not a built-in fetcher.`;
}
