// K0 (UIR1 §2.0): THE bet view model. betView(bet, me, now) turns a contract Bet into everything a screen shows: the question,
// who is who (usernames first), the one pill wording (PILL_WORDS is the only status-wording table), the sentence, the next
// deadline, the one primary action, More actions, the ruling, the payout, Details and the Activity history.
// The state comes ONLY from lib/betLifecycle.ts phaseOf, and every gate reuses the existing contract mirrors (finalizeRefusal,
// showRequestResultNow, canConcede, refereeChangeFrozen, rejudgeDueMs, expectedPayouts, payoutScreen), so cards cannot drift
// from the contract. Amounts are Money (rendered by src/kit/Amount through lib/money.ts); people are Person (src/kit/UserChip);
// times are ms numbers (src/kit/TimeLeft through lib/dates.ts). Strings here never contain a raw account id except in Details.
import type { Bet } from "./escrowAdapter";
import { canConcede, MAX_DISPUTE_ROUNDS, ROUND_WINDOW_NS, termsClaimText, TERMS_NOT_AVAILABLE } from "./escrowAdapter";
import { challengeRefusal, finalizeNotBeforeNs, finalizeRefusal, phaseOf, rejudgeDueMs, type PhaseId } from "./betLifecycle";
import { showRequestResultNow } from "./requestResult";
import { refereeChangeFrozen } from "./liveBet";
import { parseEvidence, type Evidence } from "./ruling";
import { expectedPayouts, payoutScreen, type Ending, type PayoutLine } from "./payoutScreen";
import { formatMoney, money, moneyListText, moneyText, sumMoney, type Money } from "./money";
import { utcFromNs } from "./dates";
import { questionText } from "./betDetail";
import { identityOf } from "./appState";

// ---------------------------------------------------------------- people
/** `loading`: the @username lookup is still in flight (C1: shown as NAME_LOADING, never as "Unnamed account" for a named user). */
export interface Person { account: string; username: string | null; isMe: boolean; loading?: boolean }
/** account -> username. A key present with value undefined = lookup in flight (loading); null = no username; absent = never asked. */
export type Names = Record<string, string | null | undefined>;
/** The label of a person whose @username is still loading. */
export const NAME_LOADING = "…";

export function person(account: string, me: string | null, names: Names = {}): Person {
  const isMe = me != null && account === me;
  const loading = !isMe && account in names && names[account] === undefined;
  return { account, username: names[account] ?? null, isMe, ...(loading ? { loading } : {}) };
}
/** Long ids (implicit 64-hex, long named accounts) as "a1b2…f9e0"; short named accounts stay whole. */
export const shortId = (id: string): string => (id.length > 20 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id);
/** "You" / "@alice" / "Unnamed account". Usernames are the identity (familiarcow UX-37 + PEOPLE RULE 2026-11-11): a raw id is never a
 *  label (SM2: lib/appState identityOf is the one rule; raw ids only in Account details / Verify / Add money / Cash out). */
export const personLabel = (p: Person): string => p.loading && !p.isMe ? NAME_LOADING : identityOf({ account: p.account, username: p.username, me: p.isMe ? p.account : null }).label;
/** The same, mid-sentence ("you"). */
const nameIn = (p: Person): string => (p.isMe ? "you" : personLabel(p));

// ---------------------------------------------------------------- the one wording table
export type Tone = "neutral" | "info" | "warn" | "good" | "bad";
export type PillId =
  | "open" | "closed" | "live" | "waiting-result" | "you-decide" | "waiting-referee" | "refund-due" | "no-result" | "judging" | "stuck"
  | "ruling" | "final" | "rechecking" | "paying" | "payout-delayed" | "won" | "lost" | "conceded" | "settled" | "refunded" | "cancelled"
  | "expired" | "shutdown" | "unknown";
export interface Pill { id: PillId; label: string; tone: Tone }

/** Every status word the app shows for a bet. Nothing else may invent one. */
export const PILL_WORDS: Record<PillId, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "info" },
  closed: { label: "Closed", tone: "neutral" },
  live: { label: "Live", tone: "info" },
  "waiting-result": { label: "Waiting for result", tone: "info" },
  "you-decide": { label: "You decide", tone: "warn" },
  "waiting-referee": { label: "Waiting for referee", tone: "info" },
  "refund-due": { label: "Refund due", tone: "warn" },
  "no-result": { label: "No result", tone: "warn" },
  judging: { label: "AI is deciding", tone: "info" },
  stuck: { label: "Stuck", tone: "bad" },
  ruling: { label: "Ruling made", tone: "info" },
  final: { label: "Final", tone: "good" },
  rechecking: { label: "Being re-checked", tone: "warn" },
  paying: { label: "Paying out", tone: "good" },
  "payout-delayed": { label: "Payout delayed", tone: "warn" },
  won: { label: "Won", tone: "good" },
  lost: { label: "Lost", tone: "bad" },
  conceded: { label: "Conceded", tone: "neutral" },
  settled: { label: "Settled", tone: "neutral" },
  refunded: { label: "Refunded", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
  shutdown: { label: "Refund available", tone: "warn" },
  unknown: { label: "Unknown", tone: "neutral" },
};
const pill = (id: PillId): Pill => ({ id, ...PILL_WORDS[id] });

// ---------------------------------------------------------------- actions
export type ActionId =
  | "share" | "take" | "cancel" | "change-referee" | "duplicate" | "new-bet" | "request-result" | "challenge" | "concede"
  | "finalize" | "retry-payout" | "rule" | "refund-all" | "add-evidence";
export interface Action { id: ActionId; label: string; kind: "primary" | "danger" | "neutral"; hint?: string }
const ACTION_LABELS: Record<ActionId, { label: string; kind: Action["kind"]; hint?: string }> = {
  share: { label: "Share link", kind: "primary" },
  take: { label: "Take this bet", kind: "primary" },
  cancel: { label: "Cancel and refund", kind: "danger" },
  "change-referee": { label: "Change who decides", kind: "neutral" },
  duplicate: { label: "Duplicate", kind: "neutral" },
  "new-bet": { label: "Start a new bet", kind: "neutral" },
  "request-result": { label: "Ask for the result", kind: "primary", hint: "The AI checks now instead of waiting for its next round." },
  challenge: { label: "Challenge the ruling", kind: "primary", hint: "You post a bond. You get it back if you win." },
  concede: { label: "Concede", kind: "danger" },
  finalize: { label: "Finalize now", kind: "primary", hint: "The ruling stands. This pays everyone now." },
  "retry-payout": { label: "Retry payout", kind: "primary", hint: "Your money is safe in escrow." },
  rule: { label: "Decide", kind: "primary", hint: "YES, NO or Void" },
  "refund-all": { label: "Refund everyone", kind: "primary", hint: "Anyone can return the deposits." },
  "add-evidence": { label: "Add evidence", kind: "neutral" },
};
const action = (id: ActionId, hint?: string): Action => ({ id, ...ACTION_LABELS[id], ...(hint ? { hint } : {}) });

// ---------------------------------------------------------------- the view
export type Role = "maker" | "taker" | "referee" | "viewer";
export interface Side { who: Person | null; side: string | null; stake: Money }
export type Decider = { kind: "ai" } | { kind: "person"; who: Person };
export interface NextAt { label: string; past: string; at: number }
export interface DetailRow { id: string; label: string; value: string }
export interface ActivityEntry { id: string; at: number | null; text: string }
export type RulingView =
  | { kind: "ai"; outcome: "YES" | "NO" | "VOID"; evidence: Evidence[]; finalAt: number | null }
  | { kind: "person"; outcome: "YES" | "NO" | "VOID"; who: Person };
export interface PayoutRow { label: string; value: Money[]; minor?: boolean; emphasis?: boolean; toMe?: boolean }
export interface PayoutView { ending: Ending; headline: string; rows: PayoutRow[]; state: "paid" | "paying" | "slow" | "unknown"; message: string; canRetry: boolean }

export interface BetView {
  id: number;
  question: string;
  role: Role;
  phase: PhaseId;
  /** The bet's fee rate (basis points per side, charged only when someone wins). */
  feeBps: number;
  maker: Side;
  taker: Side;
  me: { side: string | null; stake: Money | null };
  them: { who: Person | null; side: string | null; stake: Money };
  decider: Decider;
  pill: Pill;
  /** The result line, when there is one ("You won 39.00 USDC."). */
  headline: string | null;
  sentence: string;
  next: NextAt | null;
  primary: Action | null;
  secondary: Action[];
  ruling: RulingView | null;
  payout: PayoutView | null;
  details: DetailRow[];
  activity: ActivityEntry[];
}

export interface BetViewCtx {
  names?: Names;
  /** PayoutLine[] from pending_payouts (null = not loaded yet). */
  pending?: PayoutLine[] | null;
  /** The contract is shut down (emergency refund governs). */
  shutdown?: boolean;
  /** Escrow contract id (phaseOf / resolvingState check the stored result is for this contract). */
  contractId?: string;
  /** required_challenge_bond: undefined = not asked, null = no more rounds. */
  bond?: Money | null;
}

const NS_PER_MS = 1e6;
const msOf = (ns: number | string | null | undefined): number | null => (ns == null ? null : Math.floor(Number(ns) / NS_PER_MS));
const outcomeOf = (o: string | null | undefined): "YES" | "NO" | "VOID" | null =>
  o === "YES" || o === "NO" ? o : typeof o === "string" && o.startsWith("VOID") ? "VOID" : null;
const TERMINAL: PhaseId[] = ["settled", "refunded", "cancelled", "expired"];

export function betView(bet: Bet, me: string | null, nowMs: number, ctx: BetViewCtx = {}): BetView {
  const e = bet.envelope;
  const names = ctx.names ?? {};
  const contractId = ctx.contractId ?? "";
  const phase = phaseOf(bet, nowMs * NS_PER_MS, contractId);
  const P = (a: string) => person(a, me, names);
  const takerSide = e.outcomes.find((o) => o !== e.maker_side) ?? null;
  const maker: Side = { who: P(e.maker), side: e.maker_side, stake: money(e.stake_maker, e.maker_asset) };
  const taker: Side = { who: bet.taker ? P(bet.taker) : null, side: takerSide, stake: money(e.stake_taker, e.taker_asset) };
  const refAcct = e.referee?.account ?? null;
  const decider: Decider = refAcct ? { kind: "person", who: P(refAcct) } : { kind: "ai" };
  const role: Role = me && me === e.maker ? "maker" : me && me === bet.taker ? "taker" : me && me === refAcct ? "referee" : "viewer";
  const bettor = role === "maker" || role === "taker";
  const mine = role === "maker" ? maker : role === "taker" ? taker : null;
  const other = role === "taker" ? maker : role === "maker" ? taker : maker;
  const outcome = outcomeOf(bet.outcome);
  const winnerSide = outcome === "YES" || outcome === "NO" ? outcome : null;
  const iWinRuling = mine != null && winnerSide != null && mine.side === winnerSide;
  const question = questionText(e.terms) ?? termsClaimText(e) ?? TERMS_NOT_AVAILABLE; // B1: real sheets carry `claim` or a template
  const shutdown = !!ctx.shutdown && !TERMINAL.includes(phase);

  // ---- payout (endings) and ruling
  const payout = payoutView(bet, me, ctx.pending ?? null, maker, taker, role, P);
  const windowEnd = bet.proposed_at == null ? null
    : msOf(Number(bet.proposed_at) + Math.min(Number(e.settlement_period), ROUND_WINDOW_NS) + Number(bet.window_extension_ns ?? 0));
  // SM2 B1-6: with no challenge, finalize waits the FULL settlement_period, which can end after the 24 h challenge window.
  // Until then the ruling can't be challenged but isn't final yet: no "Final" pill, say when it becomes final.
  const finalAtNs = finalizeNotBeforeNs(bet);
  const notFinalYet = phase === "ruling-final" && finalAtNs != null && nowMs * NS_PER_MS < finalAtNs;
  let ruling: RulingView | null = null;
  if (outcome && bet.proposed_at != null) {
    ruling = refAcct ? { kind: "person", outcome, who: P(refAcct) }
      : { kind: "ai", outcome, evidence: parseEvidence(bet.last_resolution_raw, e.terms), finalAt: phase === "ruling" ? windowEnd : null };
  }

  // ---- pill
  let pillId: PillId;
  switch (phase) {
    case "open": pillId = "open"; break;
    case "open-lapsed": pillId = "closed"; break;
    case "live": pillId = "live"; break;
    case "awaiting-result": pillId = "waiting-result"; break;
    case "awaiting-referee": pillId = role === "referee" ? "you-decide" : "waiting-referee"; break;
    case "refund-due": pillId = "refund-due"; break;
    case "no-result": pillId = "no-result"; break;
    case "judging": pillId = "judging"; break;
    case "stuck": pillId = "stuck"; break;
    case "ruling": pillId = "ruling"; break;
    case "ruling-final": pillId = notFinalYet ? "ruling" : "final"; break;
    case "challenged": pillId = "rechecking"; break;
    case "paying": pillId = payout?.state === "slow" ? "payout-delayed" : "paying"; break;
    case "settled":
      pillId = payout?.ending === "conceded-by-me" ? "conceded" : mine ? (iWinRuling ? "won" : "lost") : "settled"; break;
    case "refunded": pillId = "refunded"; break;
    case "cancelled": pillId = "cancelled"; break;
    case "expired": pillId = "expired"; break;
    default: pillId = "unknown";
  }
  if (shutdown) pillId = "shutdown";

  // ---- sentence + next
  const deciderName = decider.kind === "ai" ? "The AI" : personLabel(decider.who);
  const tipOn = BigInt((bet as any).tip_maker ?? "0") > 0n || BigInt((bet as any).tip_taker ?? "0") > 0n;
  let sentence: string;
  let next: NextAt | null = null;
  const fundMs = msOf(e.funding_deadline)!;
  const resolveMs = msOf(e.resolve_deadline)!;
  switch (phase) {
    case "open":
      sentence = role === "maker" ? "Waiting for someone to take it."
        : role === "referee" ? "You'll decide this bet if someone takes it."
        : `You put in ${moneyText(taker.stake)} to win ${moneyText(maker.stake)}.`;
      next = { label: "Closes", past: "Closed", at: fundMs };
      break;
    case "open-lapsed":
      sentence = role === "maker" ? "Nobody took it in time. Your stake comes back to you." : "Nobody took it in time.";
      next = { label: "Closes", past: "Closed", at: fundMs };
      break;
    case "live":
      sentence = decider.kind === "ai" ? "The AI decides after the event." : `${decider.who.isMe ? "You decide" : `${deciderName} decides`} after the event.`;
      next = { label: "Event", past: "Event", at: fundMs };
      break;
    case "awaiting-result":
      sentence = showRequestResultNow(bet, nowMs) ? "Result not in yet? You can ask the AI now." : "The AI checks the result soon.";
      break;
    case "awaiting-referee":
      sentence = role === "referee" ? `Rule YES, NO or Void.${tipOn ? " You get the tip whatever you decide." : ""}`
        : `Waiting for ${deciderName} to decide.`;
      next = { label: "Deadline", past: "Deadline passed", at: resolveMs };
      break;
    case "refund-due": sentence = "Nobody decided in time. Both sides get their stake back."; break;
    case "no-result":
      sentence = "The AI used all its checks without a result. Both stakes come back after the deadline.";
      next = { label: "Refund", past: "Refund", at: resolveMs };
      break;
    case "judging": sentence = "The AI is working out who won. Usually a few minutes."; break;
    case "stuck": sentence = bettor ? "This bet can't finish on its own. You can concede, or contact us." : "This bet can't finish on its own."; break;
    case "ruling": {
      // LFIX1 (SM1 CON-1): inside the window but the bond could not buy a re-judge (runs used up / deadline near / no judge): say so.
      const blocked = decider.kind === "ai" ? challengeRefusal(bet, nowMs) : null;
      const cantChallenge = blocked && ["no-runs-left", "deadline-near", "no-live-judge"].includes(blocked.id) ? blocked.message : null;
      sentence = outcome === "VOID" ? (cantChallenge ? `The AI couldn't settle this. Both stakes come back. ${cantChallenge}` : "The AI couldn't settle this. Both stakes come back unless someone challenges.")
        : !mine ? `${deciderName} ruled ${outcome}.`
        : iWinRuling ? `${deciderName} ruled ${outcome}. You're winning.`
        : cantChallenge ? `${deciderName} ruled ${outcome}. ${cantChallenge}` : `${deciderName} ruled ${outcome}. You can challenge it.`;
      if (windowEnd != null) next = { label: "Final", past: "Final", at: windowEnd };
      break;
    }
    case "ruling-final":
      if (notFinalYet) {
        sentence = `${deciderName} ruled ${outcome}. It can't be challenged any more and becomes final when the settlement period ends.`;
        next = { label: "Final", past: "Final", at: Math.floor(finalAtNs! / NS_PER_MS) };
      } else sentence = "The ruling stands. Paying out shortly.";
      break;
    case "challenged": {
      // the latest challenge's poster; round 2 is the last one (MAX_DISPUTE_ROUNDS), so say there is no appeal after it
      const last = bet.bonds.at(-1);
      const by = last ? personLabel(P(last.holder)) : bet.challenged_by ? personLabel(P(bet.challenged_by)) : "someone";
      const who = by === "You" ? "you" : by;
      sentence = bet.bonds.length >= MAX_DISPUTE_ROUNDS
        ? `Challenged again by ${who}. The AI looks one last time; there is no appeal after this.`
        : `Challenged by ${who}. The AI looks again.`;
      const due = rejudgeDueMs(bet);
      if (due != null) next = { label: "Second look", past: "Second look due", at: due };
      break;
    }
    case "paying":
      sentence = payout?.state === "slow" ? "Your money is safe in escrow. The payout is retrying." : "The result is final. Sending the money now.";
      break;
    case "settled": case "refunded": case "cancelled": case "expired":
      sentence = payout?.headline ?? "This bet is over.";
      break;
    default: sentence = "We can't tell this bet's state right now.";
  }
  if (shutdown) { sentence = "The app was shut down. Anyone can return the deposits."; next = null; }

  // ---- actions
  let primary: Action | null = null;
  const secondary: Action[] = [];
  const concedeOk = bettor && canConcede(bet, me, !!ctx.shutdown);
  const refChangeOk = bettor && !refereeChangeFrozen(bet) && (phase !== "open" || role === "maker");
  if (shutdown) primary = action("refund-all");
  else switch (phase) {
    case "open":
      if (role === "maker") { primary = action("share"); secondary.push(action("cancel")); if (refChangeOk) secondary.push(action("change-referee")); secondary.push(action("duplicate")); }
      else if (role === "viewer") primary = action("take");
      break;
    case "live": case "awaiting-referee":
      if (role === "referee" && phase === "awaiting-referee") primary = action("rule");
      if (concedeOk) secondary.push(action("concede"));
      if (refChangeOk) secondary.push(action("change-referee"));
      break;
    case "awaiting-result":
      if (bettor && showRequestResultNow(bet, nowMs)) primary = action("request-result");
      if (concedeOk) secondary.push(action("concede"));
      break;
    case "no-result": case "judging": case "stuck": // the contract accepts concede while Resolving (LIFE1 concede path)
      // LFIX1 (SM1 LIFE-11): not to the side a standing ruling favours while its re-judge runs (conceding hands the pot over). Stuck
      // keeps it for both: concede is the only per-bet exit there (RUNBOOK-stuck-resolving.md), and the notice explains who should.
      if (concedeOk && !(iWinRuling && phase !== "stuck")) secondary.push(action("concede"));
      break;
    case "ruling": {
      const canChallenge = bettor && decider.kind === "ai" && (outcome === "VOID" || !iWinRuling)
        && bet.status === "Proposed" && bet.bonds.length < MAX_DISPUTE_ROUNDS && ctx.bond !== null
        && challengeRefusal(bet, nowMs) === null; // LFIX1: CON-5 (never from Evidence) + CON-1 (only while the re-judge can run)
      if (canChallenge) primary = action("challenge", ctx.bond ? `${moneyText(ctx.bond)} bond. You get it back if you win.` : undefined);
      if (concedeOk && !iWinRuling) secondary.push(action("concede"));
      break;
    }
    case "ruling-final":
      if (outcome != null && finalizeRefusal(bet, nowMs) === null) primary = action("finalize");
      break;
    case "challenged":
      if (bettor && showRequestResultNow(bet, nowMs)) primary = action("request-result");
      if (bettor && (bet.status === "Challenged" || bet.status === "Evidence") && bet.bonds.length === 1) secondary.push(action("add-evidence"));
      if (concedeOk && !iWinRuling) secondary.push(action("concede")); // LFIX1 (SM1 LIFE-11): not to the standing ruling's winner
      break;
    case "paying":
      if (payout?.canRetry && payout.state !== "unknown") primary = action("retry-payout");
      break;
    case "settled":
      if (bettor) secondary.push(action("duplicate"), action("new-bet"));
      break;
    case "refunded": case "cancelled": case "expired":
      // LFIX1 (SM1 LIFE-6): Voided/Cancelled/Expired never become Settled; their refund lines can sit unsent or failed (CON-4).
      if (payout?.canRetry && (payout.state === "paying" || payout.state === "slow")) primary = action("retry-payout");
      if (bettor) secondary.push(action("duplicate"));
      break;
  }

  const view: BetView = {
    id: e.bet_id, question, role, phase, feeBps: e.fee_bps, maker, taker,
    me: { side: mine?.side ?? null, stake: mine?.stake ?? null },
    them: { who: other.who, side: other.side, stake: other.stake },
    decider, pill: pill(pillId),
    headline: TERMINAL.includes(phase) || phase === "paying" ? payout?.headline ?? null : null,
    sentence, next, primary, secondary, ruling, payout,
    details: [], activity: [],
  };
  view.details = detailRows(bet, view, windowEnd, nowMs);
  view.activity = activity(bet, view, P);
  return view;
}

// ---------------------------------------------------------------- payout (endings)
function payoutView(bet: Bet, me: string | null, pending: PayoutLine[] | null, maker: Side, taker: Side, role: Role, P: (a: string) => Person): PayoutView | null {
  const ps = payoutScreen(bet, me, pending);
  const lines = expectedPayouts(bet);
  if (!ps || !lines) return null;
  const pick = (role: string) => lines.filter((l) => l.role === role).map((l) => money(l.amount, l.asset));
  const net = sumMoney(pick("winner"));
  const fee = sumMoney(pick("fee"));
  const tips = sumMoney(pick("referee"));
  const e = bet.envelope;
  const winnerSide = bet.outcome === e.maker_side ? maker : taker;
  const loserSide = winnerSide === maker ? taker : maker;
  const W = winnerSide.who ? personLabel(winnerSide.who) : "The winner";
  const L = loserSide.who ? personLabel(loserSide.who) : "The other side";
  const R = e.referee ? personLabel(P(e.referee.account)) : null;
  const mine = role === "maker" ? maker : role === "taker" ? taker : null;
  const nets = moneyListText(net);
  const myRefund = sumMoney(lines.filter((l) => (l.role === "maker" && role === "maker") || (l.role === "taker" && role === "taker")).map((l) => money(l.amount, l.asset)));
  let headline: string;
  let rows: PayoutRow[];
  // LFIX1 (SM1 LIFE-6): a refund ending is "on its way" until every ledger line is done (refund_open / emergency_refund don't drain).
  const sending = ps.progress.state === "paying" || ps.progress.state === "slow";
  switch (ps.ending) {
    case "won": headline = mine ? `You won${nets ? ` ${nets}` : ""}.` : `${W} won${nets ? ` ${nets}` : ""}.`; break;
    case "lost": headline = `You lost ${moneyText(mine!.stake)}.`; break;
    case "conceded-by-me": headline = `You conceded. ${W} was paid.`; break;
    case "conceded-by-other": headline = `${L} conceded. You won${nets ? ` ${nets}` : ""}.`; break;
    case "conceded": headline = `${L} conceded. ${W} was paid${nets ? ` ${nets}` : ""}.`; break;
    case "void-ai": headline = sending ? (mine ? "This bet was voided. Your stake is on its way back." : "This bet was voided. Both stakes are on their way back.")
      : mine ? "This bet was voided. You got your stake back." : "This bet was voided. Both sides got their stake back."; break;
    case "void-referee": headline = `${R} voided this bet.`; break; // the refund lines say what came back (a tip is not returned)
    case "deadline": headline = `${R ? `${R} didn't decide in time.` : "Nobody decided in time."} ${sending ? "Both stakes are on their way back." : "Both sides were refunded."}`; break;
    case "cancelled": headline = role === "maker" ? `You cancelled this bet. ${sending ? "Your stake is on its way back." : "Your stake was refunded."}` : "The maker cancelled this bet."; break;
    case "expired": headline = role === "maker" ? `Nobody took this bet. ${sending ? "Your stake is on its way back." : "You were refunded in full."}`
      : `Nobody took this bet. ${sending ? "The maker's stake is on its way back." : "The maker was refunded."}`; break;
    case "emergency": headline = sending ? (mine ? "The app was shut down. Your deposits are on their way back." : "The app was shut down. Everyone's deposits are on their way back.")
      : mine ? "The app was shut down. You got your own deposits back." : "The app was shut down. Both sides got their own deposits back."; break;
  }
  if (ps.ending === "won" || ps.ending === "lost" || ps.ending.startsWith("conceded")) {
    rows = [
      { label: "Pot", value: sumMoney([maker.stake, taker.stake]) },
      { label: "Fee", value: fee, minor: true },
      ...(tips.length ? [{ label: `Tip to ${R}`, value: tips }] : []),
      { label: winnerSide.who?.isMe ? "Paid to you" : `Paid to ${W}`, value: net, emphasis: true, toMe: !!winnerSide.who?.isMe },
    ];
  } else if (mine) {
    rows = [{ label: "Back to you", value: myRefund, emphasis: true, toMe: true }, ...(tips.length ? [{ label: `Tip to ${R}`, value: tips }] : [])];
  } else {
    rows = [{ label: "Returned", value: sumMoney(lines.filter((l) => l.role === "maker" || l.role === "taker").map((l) => money(l.amount, l.asset))), emphasis: true }];
  }
  return { ending: ps.ending, headline, rows, state: ps.progress.state, message: ps.progress.message, canRetry: ps.progress.canRetry };
}

// ---------------------------------------------------------------- Details (collapsed; exact values, raw ids allowed here)
function detailRows(bet: Bet, v: BetView, windowEnd: number | null, now: number): DetailRow[] {
  const e = bet.envelope;
  const rows: DetailRow[] = [{ id: "bet", label: "Bet", value: `#${e.bet_id}` }, { id: "question", label: "Question", value: v.question }];
  try {
    const t = JSON.parse(e.terms ?? "");
    const src = Array.isArray(t?.sources_allowed) ? t.sources_allowed.map((s: any) => s?.publisher ?? s?.id).filter(Boolean) : [];
    if (src.length) rows.push({ id: "sources", label: "Sources", value: src.join(", ") });
  } catch { /* terms not kept */ }
  rows.push({ id: "decider", label: "Decided by", value: v.decider.kind === "ai" ? "The AI" : personLabel(v.decider.who) });
  const stake = (s: Side) => formatMoney(s.stake).exact;
  rows.push({ id: "maker-stake", label: `${v.maker.who ? personLabel(v.maker.who) : "Maker"} (${v.maker.side})`, value: stake(v.maker) });
  rows.push({ id: "taker-stake", label: `${v.taker.who ? personLabel(v.taker.who) : "Taker"} (${v.taker.side})`, value: stake(v.taker) });
  rows.push({ id: "closes", label: bet.taker ? "Event time" : "Offer closes", value: utcFromNs(e.funding_deadline) });
  // CS1 (bet 53): a referee's final ruling or a concession pays out before the window runs out; the window never applied.
  const endedEarly = ["Settled", "Voided"].includes(bet.status) && windowEnd != null && windowEnd > now;
  if (windowEnd != null && !endedEarly) rows.push({ id: "challenge-window", label: "Challenge window ends", value: utcFromNs(windowEnd * NS_PER_MS) });
  rows.push({ id: "deadline", label: "Last day to decide", value: `${utcFromNs(e.resolve_deadline)}. If nobody decides by then, both stakes are returned.` });
  rows.push({ id: "fee", label: "Fee", value: `${e.fee_bps / 100}% of each stake (with a small minimum), only when someone wins. No fee on a refund.` });
  const b: any = bet;
  if (b.storage_maker && b.storage_maker !== "0") rows.push({ id: "storage", label: "Network storage", value: formatMoney(money(b.storage_maker, e.maker_asset), { minor: true }).exact });
  if (bet.exhibits.length) rows.push({ id: "exhibits", label: "Evidence filed", value: bet.exhibits.map((x) => `${x.hash.slice(0, 8)}…`).join(", ") });
  rows.push({ id: "accounts", label: "Account details", value: [`maker ${e.maker}`, bet.taker ? `taker ${bet.taker}` : null, e.referee ? `referee ${e.referee.account}` : null].filter(Boolean).join(" · ") });
  return rows;
}

// ---------------------------------------------------------------- Activity (full history, collapsed by default; familiarcow UX-37 #9)
function activity(bet: Bet, v: BetView, P: (a: string) => Person): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  const add = (id: string, at: number | null, text: string) => out.push({ id, at, text });
  const e = bet.envelope;
  const M = v.maker.who!;
  add("made", msOf(bet.created_at) || null, `${personLabel(M)} made this bet on ${v.maker.side} with ${moneyText(v.maker.stake)}.`);
  if (v.taker.who) add("taken", msOf(bet.taken_at), `${personLabel(v.taker.who)} took it on ${v.taker.side} with ${moneyText(v.taker.stake)}.`);
  const req = (bet as any).pending_resolution_request;
  if (req?.requested_at != null && bet.proposed_at == null) add("requested", msOf(req.requested_at), "The result was requested from the AI.");
  // CS1 (testnet bet 49): finalize mem::takes bet.bonds, so after the payout only challenged_by (the last challenger) and
  // all_results (every accepted ruling, in order; a RETRY is never stored) still tell the challenge and the second look.
  const rulings = ((bet as any).all_results ?? []) as { outcome: string }[];
  const rounds = Math.max(bet.bonds.length, rulings.length - 1, bet.challenged_by ? 1 : 0);
  const who = e.referee ? personLabel(P(e.referee.account)) : "The AI";
  if (bet.proposed_at != null && bet.outcome != null) {
    const first = outcomeOf(bet.bonds[0]?.pre_challenge_outcome ?? rulings[0]?.outcome ?? bet.outcome);
    // proposed_at is the latest ruling's time: only the first ruling's when nobody has looked again.
    add("ruled", rulings.length > 1 ? null : msOf(bet.proposed_at), `${who} ruled ${first}.`);
  }
  for (let r = 1; r <= rounds; r++) {
    const b = bet.bonds.find((x) => x.round === r);
    const by = b ? P(b.holder) : r === rounds && bet.challenged_by ? P(bet.challenged_by) : null;
    add(`bond-${r}`, null, by ? `${personLabel(by)} challenged the ruling${b ? ` (round ${r})` : ""}.` : "The ruling was challenged.");
    const again = rulings[r];
    if (again) {
      const before = outcomeOf(rulings[r - 1].outcome), now = outcomeOf(again.outcome);
      const isLast = r === rulings.length - 1;
      add(`rejudged-${r}`, isLast ? msOf(bet.proposed_at) : null,
        now === before ? `${who} looked again and ruled ${now} again.` : `${who} looked again and changed the ruling to ${now}.`);
    }
  }
  bet.exhibits.forEach((x, i) => add(`exhibit-${i}`, msOf(x.submitted_at), `${personLabel(P(x.submitted_by))} added evidence.`));
  const outcome = outcomeOf(bet.outcome);
  switch (bet.status) {
    case "Finalized": add("final", null, "The result is final."); break;
    case "Settled":
      if (outcome !== "VOID" && bet.proposed_at == null) {
        const loser = outcome === e.maker_side ? v.taker.who : v.maker.who;
        add("conceded", null, `${loser ? personLabel(loser) : "One side"} conceded.`);
      } else if (outcome === "VOID") add("voided", null, "Voided. Both stakes were returned.");
      else add("final", null, "The result is final.");
      add("paid", null, "Paid out.");
      break;
    case "Voided": add("voided", null, outcome === "VOID" ? "Nobody decided in time. Both stakes were returned." : "The app was shut down. Deposits were returned."); break;
    case "Cancelled": add("cancelled", null, `${personLabel(M)} cancelled it. The stake went back to ${nameIn(M)}.`); break;
    case "Expired": add("expired", null, `Nobody took it. The stake went back to ${nameIn(M)}.`); break;
  }
  return out;
}

/** The toast text when a bet the reader is looking at changes state (replaces the Notifications panel). Null = nothing to say. */
export function changeToast(prev: BetView | null, next: BetView): string | null {
  if (!prev || prev.id !== next.id) return null;
  if (prev.pill.label !== next.pill.label) return `Update: ${next.pill.label}.`;
  if (next.activity.length > prev.activity.length) return `Update: ${next.activity.at(-1)!.text}`;
  return null;
}

/** Five-line summary for create/take review (UIR1 §3.4 / UX-37 #5). Full terms go in a Disclosure (view.details). */
export function reviewRows(v: BetView): DetailRow[] {
  const mySide = v.role === "maker" ? v.maker : v.taker;
  const theirSide = v.role === "maker" ? v.taker : v.maker;
  return [
    { id: "question", label: "Bet", value: v.question },
    { id: "stake", label: "You put in", value: `${moneyText(mySide.stake)} on ${mySide.side}` },
    { id: "win", label: "You win", value: `${moneyText(theirSide.stake)} if ${mySide.side}` },
    { id: "decider", label: "Decided by", value: v.decider.kind === "ai" ? "The AI" : personLabel(v.decider.who) },
    { id: "fee", label: "Fee", value: `${v.feeBps / 100}% of your stake, only if someone wins` },
  ];
}
