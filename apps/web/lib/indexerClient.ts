// Thin client over services/indexer's read-only HTTP API (board.ts /
// server.ts): the browse page's fast path for the open-offers board and
// per-account history. The indexer holds no signing key and is purely a
// cache in front of the same escrow view methods (open_offers/get_bet)
// escrowAdapter.ts calls directly -- if this fetch fails, callers should
// fall back to escrowAdapter.openOffers, never block the UI on it.
import { INDEXER_URL } from "./config";
import { requireService } from "./network";

// Mirrors services/indexer/src/board.ts's OfferSummary exactly.
export interface IndexerOfferSummary {
  /** IDX1: the escrow contract this row was indexed from (older contracts can still appear; the web filters them). */
  contract_id?: string;
  contract_version?: number;
  bet_id: number;
  maker: string;
  maker_side: string;
  stake_maker: string;
  stake_taker: string;
  funding_deadline: number;
  taker_allow: string; // JSON-stringified TakerAllow ("Any" | {"Account":...} | {"InvitePubkey":...})
}

// Mirrors services/indexer/src/board.ts's BetHistoryEntry exactly.
export interface IndexerHistoryEntry {
  bet_id: number;
  maker: string;
  taker: string | null;
  status: string;
  outcome: string | null;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${requireService("indexer", INDEXER_URL)}${path}`);
  if (!res.ok) throw new Error(`indexer ${path} -> HTTP ${res.status}`);
  return res.json();
}

export async function fetchOpenOffers(): Promise<IndexerOfferSummary[]> {
  return getJson<IndexerOfferSummary[]>("/offers");
}

export async function fetchHistory(accountId?: string): Promise<IndexerHistoryEntry[]> {
  const qs = accountId ? `?account=${encodeURIComponent(accountId)}` : "";
  return getJson<IndexerHistoryEntry[]>(`/history${qs}`);
}

// IDXREF1: exactly the bets whose current referee account is `refereeId` (services/indexer board.ts historyHttp).
export async function fetchRefereeHistory(refereeId: string): Promise<IndexerHistoryEntry[]> {
  return getJson<IndexerHistoryEntry[]>(`/history?referee=${encodeURIComponent(refereeId)}`);
}

// taker_allow travels as a JSON string (see OfferSummary above); only
// "Any" offers are takeable by anyone -- a direct-challenge
// ({"Account":...}) or invite-gated ({"InvitePubkey":...}) offer is
// deliberately excluded from the generic "open offers" browse list
// (the task brief's "un-targeted, takeable" filter).
export function isUntargetedOffer(offer: IndexerOfferSummary): boolean {
  return offer.taker_allow === "Any" || offer.taker_allow === '"Any"';
}
