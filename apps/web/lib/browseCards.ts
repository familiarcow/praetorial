// BROWSE1: pure logic behind the Browse cards (no React). The indexer may carry rows from an older contract or twice;
// the page keeps only rows for the contract this build points at, and shows nothing it cannot render readably.
// H1: the card itself is the kit BetCard "offer" (lib/homeSections exploreCards); money, people and times come from betView.
import type { IndexerOfferSummary } from "./indexerClient";
import { isUntargetedOffer } from "./indexerClient";

export const BROWSE_EMPTY = "No open bets yet. Make one.";

export const offerKey = (o: Pick<IndexerOfferSummary, "contract_id" | "bet_id">): string => `${o.contract_id}:${o.bet_id}`;

/** Rows for `escrowId` only, untargeted only, one row per contract_id + bet_id. */
export function keepOffers(rows: IndexerOfferSummary[], escrowId: string): IndexerOfferSummary[] {
  const seen = new Set<string>();
  const out: IndexerOfferSummary[] = [];
  for (const r of rows) {
    if (r.contract_id !== escrowId || !isUntargetedOffer(r)) continue;
    const k = offerKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}
