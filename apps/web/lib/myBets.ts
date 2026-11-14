// FE14 (S16) + H1: the ids behind My Bets. No contract view lists bets by account or by referee (lib.rs has get_bet / open_offers /
// pending_payouts_view only), so loading goes through the indexer: /history?account= (mine), /offers (offers made to me by name) and
// /history?referee= (exact; on failure the unfiltered /history scan, flagged incomplete). Each id is then read with get_bet (the truth)
// and grouped by lib/homeSections.ts myHome (betView); the old row/chip/needs model here is gone (SM2 H1-1: one status vocabulary).

export const EMPTY = {
  all: "You haven't made a bet yet.",
  referee: "Nobody has asked you to decide a bet yet.",
  error: "We can't load your bets. Retry.",
  refereeError: "We can't load the bets you decide. Retry.",
};

export const REFEREE_SCAN_LIMIT = 50;

/** Indexer offers addressed to my account by name (taker_allow travels as a JSON string; invite links cannot be found by account). */
export function targetedAtMe(offers: { bet_id: number; taker_allow: string }[], me: string | null): number[] {
  if (!me) return [];
  return offers.filter((o) => { try { const a = JSON.parse(o.taker_allow); return !!a && typeof a === "object" && a.Account === me; } catch { return false; } }).map((o) => o.bet_id);
}

/**
 * No contract view and no indexer route lists bets by referee. The leanest honest source: the indexer's unfiltered /history, keep bets that
 * were taken (a referee can only rule on those), not mine, newest first, capped; the caller get_bet's each and homeSections.myHome keeps those that name me.
 */
export function refereeCandidates(history: { bet_id: number; maker: string; taker: string | null; status: string }[], me: string | null, limit: number = REFEREE_SCAN_LIMIT): number[] {
  return history
    .filter((h) => h.taker !== null && !["Open", "Cancelled", "Expired"].includes(h.status) && h.maker !== me && h.taker !== me)
    .map((h) => h.bet_id)
    .sort((a, b) => b - a)
    .slice(0, limit);
}

type HistoryRow = { bet_id: number; maker: string; taker: string | null; status: string };

/** FE14b (D-FE14a): the indexer's /history?referee=<me> already lists exactly the bets that name me today; keep every id (no cap), newest first. */
export function refereeIdsExact(history: HistoryRow[]): number[] {
  return [...new Set(history.map((h) => h.bet_id))].sort((a, b) => b - a);
}

export const INCOMPLETE_NOTE = "This list may be incomplete. We couldn't get your full list just now, so we only checked the most recent bets. Retry in a moment.";

/** Exact list first; if that call fails, the FE14 scan (refereeCandidates) with incomplete=true so the screen says so. Rejects only if both fail. */
export async function refereeIds(me: string | null, src: { exact: (me: string) => Promise<HistoryRow[]>; scan: () => Promise<HistoryRow[]> }): Promise<{ ids: number[]; incomplete: boolean }> {
  if (me) { try { return { ids: refereeIdsExact(await src.exact(me)), incomplete: false }; } catch { /* fall back below */ } }
  return { ids: refereeCandidates(await src.scan(), me), incomplete: true };
}
