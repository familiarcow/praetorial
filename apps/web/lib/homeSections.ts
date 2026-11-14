// H1 (UIR1 §3.2/§3.3; familiarcow UX-37 #2 In progress = others' bets only, #3 Settled = one collapsed summary row, #4 no Duplicate on
// Home cards; PEOPLE RULE; SM2 H1-1/H1-2). The Home model. Every card is a BetView (lib/betView.ts betView, built on
// betLifecycle.phaseOf), so the pill, the sentence and the action are the bet page's own; nothing here invents a status word or reads
// a raw bet status to decide what to show. Pure: HomePage / MyBets / BrowsePage / InProgressBets load and render what these return.
//  - My Bets: "Needs you" (the bet page asks something of me now) first, then Open offers, In progress, Bets you decide; Settled is
//    kept apart for the one collapsed summary row. Only a "Needs you" card keeps its button.
//  - Explore: other people's open offers I can take ("offer" cards, Take).
//  - In progress: other people's accepted, unfinished bets ("public" cards, read-only); mine are under My Bets.
import type { Bet } from "./escrowAdapter";
import { betView, personLabel, type Action, type BetView, type Names, type PillId } from "./betView";
import { phaseOf, type PhaseId } from "./betLifecycle";
import { pendingRefereeProposal, refereeChangeFrozen } from "./liveBet";
import { accountsOnBet } from "./betNames";
import { listEnabledAssets } from "./assets";
import { TERMS_NOT_AVAILABLE } from "./escrowAdapter";
import type { PayoutLine } from "./payoutScreen";
import type { Money } from "./money";

/** One loaded bet. `pending` = pending_payouts (only read while paying), `bond` = required_challenge_bond (undefined = not read,
 *  null = no more rounds). */
export interface HomeBet { id: number; bet: Bet; pending?: PayoutLine[] | null; bond?: Money | null }
export interface HomeCtx { names?: Names; contractId?: string; shutdown?: boolean }
/** Mirrors src/kit BetCardVariant (lib does not import the kit). */
export type CardVariant = "mine" | "offer" | "public" | "decide" | "compact";
export interface HomeCard { view: BetView; variant: CardVariant }
export type MyGroupId = "needs" | "open" | "progress" | "decide";
export interface MyGroup { id: MyGroupId; title: string; cards: HomeCard[] }
export interface SettledRow { title: string; summary: string; cards: HomeCard[] }
export interface MyHome { groups: MyGroup[]; settled: SettledRow | null; empty: boolean }

const TITLES: Record<MyGroupId, string> = { needs: "Needs you", open: "Open offers", progress: "In progress", decide: "Bets you decide" };
const ORDER: MyGroupId[] = ["needs", "open", "progress", "decide"];
const TERMINAL: PhaseId[] = ["settled", "refunded", "cancelled", "expired"];
const OPEN: PhaseId[] = ["open", "open-lapsed"];
/** The bet page's primary actions that are the user's to do (not the keeper's, not optional): these make a bet "need" me. */
const NEEDS: Action["id"][] = ["take", "challenge", "retry-payout", "rule", "refund-all"];
const ANSWER_REFEREE: Action = { id: "change-referee", label: "Answer the referee change", kind: "primary" };

const viewOf = (b: HomeBet, me: string | null, nowMs: number, ctx: HomeCtx): BetView =>
  betView(b.bet, me, nowMs, { names: ctx.names, contractId: ctx.contractId, shutdown: ctx.shutdown, pending: b.pending ?? null, ...(b.bond !== undefined ? { bond: b.bond } : {}) });
const newestFirst = (a: HomeCard, b: HomeCard) => b.view.id - a.view.id;
const readable = (v: BetView) => v.question !== TERMS_NOT_AVAILABLE;

/** The account an offer is made to by name (taker_allow { Account }), else null. */
function offeredTo(bet: Bet): string | null {
  const a = bet.envelope.taker_allow as unknown;
  return a && typeof a === "object" && typeof (a as { Account?: unknown }).Account === "string" ? (a as { Account: string }).Account : null;
}

/** What the bet page asks of me right now, or null. betView's primary when it is mine to do, else a referee change waiting for my
 *  answer (the bet page's Change-referee section). */
export function needsMe(view: BetView, bet: Bet, me: string | null = null): Action | null {
  if (view.primary?.id === "take") return me && offeredTo(bet) === me ? view.primary : null; // anyone may take an open offer; it needs me only if it names me
  if (view.primary && NEEDS.includes(view.primary.id)) return view.primary;
  if ((view.role === "maker" || view.role === "taker") && !TERMINAL.includes(view.phase) && !refereeChangeFrozen(bet)) {
    const p = pendingRefereeProposal(bet);
    if (p && (view.role === "maker" ? !p.makerSet : !p.takerSet)) return ANSWER_REFEREE;
  }
  return null;
}

/** Which extra contract reads a card needs (phaseOf, never a raw status): pending payouts while paying (Retry payout), the challenge
 *  bond for a bettor inside the challenge window (Challenge). */
export function extraReads(bet: Bet, me: string | null, nowMs: number, contractId: string): { pending: boolean; bond: boolean } {
  const phase = phaseOf(bet, nowMs * 1e6, contractId);
  const bettor = !!me && (bet.envelope.maker === me || bet.taker === me);
  // LFIX1 (SM1 LIFE-6): refund endings too (Voided/Cancelled/Expired can owe a refund forever; only Settled means every line is done).
  const refundEnding = (phase === "refunded" || phase === "cancelled" || phase === "expired") && bet.status !== "Settled";
  return { pending: phase === "paying" || refundEnding, bond: phase === "ruling" && bettor };
}

/** My Bets. Bets I make, take or referee, plus offers made to me by name (they show only while I can take them). */
export function myHome(items: HomeBet[], me: string | null, nowMs: number, ctx: HomeCtx = {}): MyHome {
  const by: Record<MyGroupId, HomeCard[]> = { needs: [], open: [], progress: [], decide: [] };
  const settled: HomeCard[] = [];
  const seen = new Set<number>();
  for (const b of items) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    const v = viewOf(b, me, nowMs, ctx);
    const need = needsMe(v, b.bet, me);
    const party = v.role === "maker" || v.role === "taker" || v.role === "referee";
    if (!party && !need) continue; // someone else's bet (or an offer to me I can no longer take)
    if (need) { by.needs.push({ view: { ...v, primary: need }, variant: v.role === "referee" ? "decide" : "mine" }); continue; }
    const card = { ...v, primary: null };
    if (TERMINAL.includes(v.phase)) settled.push({ view: card, variant: "compact" });
    else if (v.role === "referee") by.decide.push({ view: card, variant: "decide" });
    else if (OPEN.includes(v.phase)) by.open.push({ view: card, variant: "mine" });
    else by.progress.push({ view: card, variant: "mine" });
  }
  const groups = ORDER.filter((id) => by[id].length).map((id) => ({ id, title: TITLES[id], cards: by[id].sort(newestFirst) }));
  const s = settled.sort(newestFirst);
  return {
    groups,
    settled: s.length ? { title: `Settled (${s.length})`, summary: settledSummary(s.map((c) => c.view)), cards: s } : null,
    empty: groups.length === 0 && s.length === 0,
  };
}

const SUMMARY_ORDER: PillId[] = ["won", "lost", "conceded", "settled", "refunded", "cancelled", "expired"];
/** "won 2 · lost 1 · refunded 3": the pill words (lower case), fixed order, zero counts left out. */
export function settledSummary(views: BetView[]): string {
  const n = new Map<PillId, { label: string; count: number }>();
  for (const v of views) n.set(v.pill.id, { label: v.pill.label, count: (n.get(v.pill.id)?.count ?? 0) + 1 });
  const ids = [...SUMMARY_ORDER, ...[...n.keys()].filter((k) => !SUMMARY_ORDER.includes(k))];
  return ids.filter((id) => n.has(id)).map((id) => `${n.get(id)!.label.toLowerCase()} ${n.get(id)!.count}`).join(" · ");
}

/** Explore: other people's offers I can take now (betView offers me Take), readable, optionally one token. Newest first. */
export function exploreCards(items: HomeBet[], me: string | null, nowMs: number, ctx: HomeCtx = {}, token: string = "all"): HomeCard[] {
  return items.map((b) => viewOf(b, me, nowMs, ctx))
    .filter((v) => v.phase === "open" && v.role === "viewer" && v.primary?.id === "take" && readable(v))
    .filter((v) => token === "all" || v.maker.stake.symbol === token || v.taker.stake.symbol === token)
    .map((view) => ({ view, variant: "offer" as const }))
    .sort(newestFirst);
}

/** IDX2: the maker's own just-opened bets on Explore. `indexed` = the indexer's /offers rows for this escrow (null: unreadable);
 * `fresh` = get_bet of the listed ones. Listed + read -> the indexed row; otherwise the optimistic row from the Open result. */
export type NewOfferSource = "optimistic" | "indexed";
export interface NewOfferItem extends HomeBet { source: NewOfferSource }
export function myNewOffers(entries: { id: number; bet: Bet }[], indexed: { bet_id: number }[] | null, fresh: ReadonlyMap<number, Bet | null>): NewOfferItem[] {
  const listed = new Set((indexed ?? []).map((o) => o.bet_id));
  return entries.map((e) => {
    const f = listed.has(e.id) ? fresh.get(e.id) : null;
    return f ? { id: e.id, bet: f, source: "indexed" as const } : { id: e.id, bet: e.bet, source: "optimistic" as const };
  });
}
/** IDX2: their cards: "mine" cards of bets that are still open and mine (taken / cancelled ones drop off Explore), newest first. */
export function myNewCards(items: NewOfferItem[], me: string | null, nowMs: number, ctx: HomeCtx = {}): (HomeCard & { source: NewOfferSource })[] {
  if (!me) return [];
  // the optimistic bet comes from session storage: one that cannot be rendered is dropped, never allowed to break the Home page
  const views = items.flatMap((b) => { try { return [{ view: viewOf(b, me, nowMs, ctx), source: b.source }]; } catch { return []; } });
  return views
    .filter(({ view: v }) => v.phase === "open" && v.role === "maker" && readable(v))
    .map(({ view, source }) => ({ view, variant: "mine" as const, source }))
    .sort(newestFirst);
}

/** The Explore filter: "all" + the bet tokens, in launch order. */
export const filterChips = (): string[] => ["all", ...listEnabledAssets().map((a) => a.symbol)];

/** In progress: other people's accepted, unfinished bets; read-only. Mine (and the ones I referee) are under My Bets. */
export function inProgressCards(items: HomeBet[], me: string | null, nowMs: number, ctx: HomeCtx = {}): HomeCard[] {
  return items.map((b) => viewOf(b, me, nowMs, ctx))
    .filter((v) => v.role === "viewer" && !OPEN.includes(v.phase) && !TERMINAL.includes(v.phase) && v.phase !== "unknown" && readable(v))
    .map((v) => ({ view: { ...v, primary: null }, variant: "public" as const }))
    .sort(newestFirst);
}

/** Indexer statuses of accepted, unfinished bets (the candidate list for In progress; each one is then read with get_bet). */
export const IN_PROGRESS_STATUSES = ["Taken", "Resolving", "Proposed", "Challenged", "Evidence", "Rejudge", "Finalized"] as const;
export const IN_PROGRESS_LIMIT = 20;

export function inProgressCandidates(history: { bet_id: number; status: string }[], limit: number = IN_PROGRESS_LIMIT, hidden: ReadonlySet<number> = new Set()): number[] {
  const ids = history.filter((h) => (IN_PROGRESS_STATUSES as readonly string[]).includes(h.status) && !hidden.has(h.bet_id)).map((h) => h.bet_id);
  return [...new Set(ids)].sort((a, b) => b - a).slice(0, limit);
}

/** Explore Bets: everyone else's open offers, minus `hidden` (CS1: lib/exploreHidden, testnet plumbing). Indexer rows, before get_bet. */
export function exploreOffers<T extends { maker: string; bet_id?: number }>(offers: T[], me: string | null, hidden: ReadonlySet<number> = new Set()): T[] {
  return offers.filter((o) => (!me || o.maker !== me) && !(o.bet_id !== undefined && hidden.has(o.bet_id)));
}

/** Everyone a Home card can name, once (for the one names lookup, lib/homeNames.ts). */
export function homeAccounts(items: HomeBet[]): string[] {
  return [...new Set(items.flatMap((b) => accountsOnBet(b.bet)))];
}

// ---------------------------------------------------------------- SET1: Settled (public)
// SET1 (PM, 2026-11-14: "I cant see the bets that have already finished ... I want all users to be able to see them"): everyone's
// finished, accepted bets, mine included (unlike In progress), as read-only "public" cards. Never-taken bets (Cancelled / Expired)
// are not shown: nobody bet against anybody.

/** Indexer statuses of finished bets (the candidate list for Settled; each one is then read with get_bet). The indexer's
 *  "settling, confirming" (an unconfirmed terminal state) is not one: it shows up once confirmed. */
export const SETTLED_STATUSES = ["Settled", "Voided"] as const;
/** One page of the Settled section ("Show more" loads the next). */
export const SETTLED_LIMIT = 20;

/** Every finished candidate, newest first, deduped, minus `hidden` (the section loads them a page at a time). */
export function settledCandidates(history: { bet_id: number; status: string }[], hidden: ReadonlySet<number> = new Set()): number[] {
  const ids = history.filter((h) => (SETTLED_STATUSES as readonly string[]).includes(h.status) && !hidden.has(h.bet_id)).map((h) => h.bet_id);
  return [...new Set(ids)].sort((a, b) => b - a);
}

/** The Settled card's line: the ruling (YES / NO / VOID) and how the bet ended (the AI judge, the referee, a concession, nobody in
 *  time), then the payout headline betView already wrote. Null when the bet has not ended (or was never taken). */
export function settledEnding(view: BetView, bet: Bet): string | null {
  const p = view.payout;
  if ((view.phase !== "settled" && view.phase !== "refunded") || !p || !bet.taker) return null;
  const outcome = bet.outcome === "YES" || bet.outcome === "NO" ? bet.outcome : "VOID";
  const by = view.decider.kind === "person" ? personLabel(view.decider.who) : "The AI judge";
  const sending = p.state === "paying" || p.state === "slow";
  switch (p.ending) {
    case "won": case "lost": return `${by} ruled ${outcome}. ${p.headline}`;
    case "conceded": case "conceded-by-me": case "conceded-by-other": return `Ended ${outcome} by concession. ${p.headline}`;
    case "void-ai": return `The AI judge ruled VOID. ${sending ? "Both stakes are on their way back." : "Both sides got their stake back."}`;
    case "void-referee": return `${by} ruled VOID. ${sending ? "Both stakes are on their way back." : "Both sides were refunded."}`;
    case "deadline": return `Ended VOID: nobody decided in time. ${sending ? "Both stakes are on their way back." : "Both sides were refunded."}`;
    case "emergency": return `Ended VOID: the app was shut down. ${sending ? "Both stakes are on their way back." : "Both sides got their deposits back."}`;
    default: return null;
  }
}

/** Settled: everyone's finished, accepted bets (mine too), readable, newest first; "public" cards whose line is settledEnding. */
export function settledCards(items: HomeBet[], me: string | null, nowMs: number, ctx: HomeCtx = {}): HomeCard[] {
  const seen = new Set<number>();
  const out: HomeCard[] = [];
  for (const b of items) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    const v = viewOf(b, me, nowMs, ctx);
    const line = readable(v) ? settledEnding(v, b.bet) : null;
    if (line) out.push({ view: { ...v, sentence: line, primary: null, secondary: [] }, variant: "public" });
  }
  return out.sort(newestFirst);
}
