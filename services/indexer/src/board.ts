// Pure board-building logic: turns a set of Bet views into the
// open-offers board + per-account history shape the HTTP API serves.
// Read-only everywhere — the indexer holds no signing key at all (it is
// explicitly the one service with zero onchain write capability).
import type { Bet } from "@praetorial/common/types.js";
import type { TaggedBet } from "@praetorial/common/discovery.js";
import { CONFIRMING_DISPLAY } from "@praetorial/common/terminalConfirmCore.js";

export interface OfferSummary {
  bet_id: number;
  contract_id: string;
  contract_version: string;
  maker: string;
  maker_side: string;
  stake_maker: string;
  stake_taker: string;
  funding_deadline: number;
  taker_allow: string;
}

export interface BetHistoryEntry {
  bet_id: number;
  contract_id: string;
  contract_version: string;
  maker: string;
  taker: string | null;
  status: string;
  outcome: string | null;
  // D-DSY1 (additive): equals status except "settling, confirming" for a
  // terminal bet the second RPC has not confirmed (status/outcome are then
  // masked too, so no winner leaks through legacy fields).
  display_status: string;
}

export function buildOpenOffersBoard(bets: Map<number, Bet>): OfferSummary[] {
  const out: OfferSummary[] = [];
  for (const [id, bet] of bets) {
    if (bet.status !== "Open") continue;
    out.push({
      bet_id: id,
      contract_id: "",
      contract_version: "",
      maker: bet.envelope.maker,
      maker_side: bet.envelope.maker_side,
      stake_maker: bet.envelope.stake_maker,
      stake_taker: bet.envelope.stake_taker,
      funding_deadline: bet.envelope.funding_deadline,
      taker_allow: JSON.stringify(bet.envelope.taker_allow),
    });
  }
  return out.sort((a, b) => a.bet_id - b.bet_id);
}

export function buildHistory(bets: Map<number, Bet>, accountId?: string): BetHistoryEntry[] {
  const out: BetHistoryEntry[] = [];
  for (const [id, bet] of bets) {
    if (accountId && bet.envelope.maker !== accountId && bet.taker !== accountId) continue;
    out.push({
      bet_id: id,
      contract_id: "",
      contract_version: "",
      maker: bet.envelope.maker,
      taker: bet.taker,
      status: bet.status,
      outcome: bet.outcome,
      display_status: bet.status,
    });
  }
  return out.sort((a, b) => a.bet_id - b.bet_id);
}

// D-UPGRADE1: multi-contract board/history built straight off a
// TaggedBet map (keyed "<contractId>:<betId>" by discoverAllBetsMulti)
// -- every entry carries which contract version it came from, and
// bet_id alone is no longer assumed unique across the whole board
// (only within one contract).
export function buildOpenOffersBoardMulti(bets: Map<string, TaggedBet>): OfferSummary[] {
  const out: OfferSummary[] = [];
  for (const [, tb] of bets) {
    if (tb.bet.status !== "Open") continue;
    out.push({
      bet_id: tb.betId,
      contract_id: tb.contractId,
      contract_version: tb.version,
      maker: tb.bet.envelope.maker,
      maker_side: tb.bet.envelope.maker_side,
      stake_maker: tb.bet.envelope.stake_maker,
      stake_taker: tb.bet.envelope.stake_taker,
      funding_deadline: tb.bet.envelope.funding_deadline,
      taker_allow: JSON.stringify(tb.bet.envelope.taker_allow),
    });
  }
  return out.sort((a, b) => a.contract_id.localeCompare(b.contract_id) || a.bet_id - b.bet_id);
}

/** IDXREF1 (D-FE14a): `refereeId` keeps exactly the bets whose CURRENT referee account (envelope.referee.account, which
 * amend_referee rewrites) equals it; AI-mode bets (no/null referee) never match. Orthogonal to `accountId` (the HTTP layer
 * rejects both together). */
export function buildHistoryMulti(bets: Map<string, TaggedBet>, accountId?: string, refereeId?: string): BetHistoryEntry[] {
  const out: BetHistoryEntry[] = [];
  for (const [, tb] of bets) {
    if (accountId && tb.bet.envelope.maker !== accountId && tb.bet.taker !== accountId) continue;
    if (refereeId !== undefined && tb.bet.envelope.referee?.account !== refereeId) continue;
    const shown = redactUnconfirmed(tb);
    out.push({
      bet_id: tb.betId,
      contract_id: tb.contractId,
      contract_version: tb.version,
      maker: tb.bet.envelope.maker,
      taker: tb.bet.taker,
      status: shown.bet.status,
      outcome: shown.bet.outcome,
      display_status: shown.display_status,
    });
  }
  return out.sort((a, b) => a.contract_id.localeCompare(b.contract_id) || a.bet_id - b.bet_id);
}

/** D-DSY1: a Settled/Voided bet whose terminal state the second RPC has not
 * confirmed (confirmed === false) is shown as "settling, confirming" with no
 * outcome. refreshBets sets `confirmed` explicitly on every Settled/Voided
 * bet it produces; a TaggedBet that never went through it (undefined) is
 * shown as-is (pure-builder callers/tests). */
export function redactUnconfirmed(tb: TaggedBet): TaggedBet & { display_status: string } {
  if (tb.confirmed !== false) return { ...tb, display_status: tb.bet.status };
  return {
    ...tb,
    bet: { ...tb.bet, status: CONFIRMING_DISPLAY as unknown as TaggedBet["bet"]["status"], outcome: null },
    display_status: CONFIRMING_DISPLAY,
  };
}

/** NEAR account id rules: 2-64 chars, dot-separated parts of [a-z0-9] with single - or _ separators between alphanumerics. */
export function isValidNearAccountId(a: string): boolean {
  return a.length >= 2 && a.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(a);
}

/** IDXREF1: the single /history handler both hosts (node server.ts, Worker index.ts) call, so they cannot drift.
 * `?account=` behaviour is unchanged (not validated); `?referee=` must be a valid NEAR account id; both together -> 400. */
export function historyHttp(bets: Map<string, TaggedBet>, params: URLSearchParams): { status: number; body: unknown } {
  const account = params.get("account") ?? undefined;
  const referee = params.get("referee");
  if (referee !== null && params.has("account")) return { status: 400, body: { error: "account and referee are mutually exclusive" } };
  if (referee !== null && !isValidNearAccountId(referee)) return { status: 400, body: { error: "invalid referee account id" } };
  return { status: 200, body: buildHistoryMulti(bets, account, referee ?? undefined) };
}
