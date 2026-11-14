// FE11 (S13): AI ruling card, quotes + sources, VOID wording, challenge offer (bond quote, rounds, no more appeals), finalize, challenge read-back.
// Rules mirror contracts/escrow/src/lib.rs handle_bond (Proposed|Evidence only, positional rounds, no bond on a referee bet, max_rounds).
// No number is hard-coded: the bond comes from required_challenge_bond, the deadline from the bet's own timestamps.
import type { Bet, ChallengeBondQuote } from "./escrowAdapter";
import { appealDeadlineNs, MAX_DISPUTE_ROUNDS } from "./escrowAdapter";
import { findAsset, symbolForAssetId } from "./assets";
import { fromBaseUnits } from "./decimal";
import { formatUtc } from "./offerExpiry";
import { finalizeRefusal, challengeRefusal, type ChallengeRefusalId } from "./betLifecycle";

export interface Evidence { quote: string; sourceId: string; sourceName: string; url: string | null; reason: string | null }

/** Quotes the judge models cited, from the resolver result the contract stored (last_resolution_raw). Replies that don't parse are skipped, never guessed. */
export function parseEvidence(raw: string | null | undefined, terms: string | null | undefined): Evidence[] {
  let root: any;
  try { root = JSON.parse(raw ?? ""); } catch { return []; }
  let sources: any[] = [];
  try { const t = JSON.parse(terms ?? ""); if (Array.isArray(t?.sources_allowed)) sources = t.sources_allowed; } catch { /* terms not kept: show ids only */ }
  const out: Evidence[] = [];
  const seen = new Set<string>();
  for (const d of root?.judge?.run_diagnostics ?? []) {
    let a: any;
    try { a = JSON.parse(d?.content_head ?? ""); } catch { continue; }
    if (typeof a?.quote !== "string" || !a.quote.trim() || typeof a?.source_id !== "string") continue;
    const key = `${a.source_id}|${a.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const s = sources.find((x) => x?.id === a.source_id);
    out.push({ quote: a.quote, sourceId: a.source_id, sourceName: typeof s?.publisher === "string" ? s.publisher : a.source_id, url: typeof s?.url === "string" ? s.url : null, reason: typeof a.reason === "string" ? a.reason : null });
  }
  return out;
}

export type Outcome = "YES" | "NO" | "VOID";
function outcomeOf(o: string | null | undefined): Outcome | null {
  if (o === "YES" || o === "NO") return o;
  if (o === "VOID" || (typeof o === "string" && o.startsWith("VOID:"))) return "VOID";
  return null;
}
const aiBet = (bet: Bet) => !bet.envelope.referee;
const winnerOf = (bet: Bet, o: Outcome): string | null => (o === "VOID" ? null : bet.envelope.maker_side === o ? bet.envelope.maker : bet.taker);

export type RulingCard =
  | { kind: "none" }
  | { kind: "ruling"; outcome: Outcome; headline: string; body: string | null; finalLine: string | null; evidence: Evidence[] };

export const VOID_BODY = "The AI couldn't settle this fairly. You'll both get your money back.";

export function rulingCard(bet: Bet, _me: string | null, nowMs: number): RulingCard {
  const o = outcomeOf(bet.outcome);
  if (!aiBet(bet) || !o) return { kind: "none" };
  const dl = appealDeadlineNs(bet);
  const open = (bet.status === "Proposed" || bet.status === "Evidence") && dl != null && Math.floor(dl / 1e6) > nowMs;
  return {
    kind: "ruling",
    outcome: o,
    headline: `Ruling: ${o}`,
    body: o === "VOID" ? VOID_BODY : null,
    finalLine: open ? `Final unless someone challenges before ${formatUtc(Math.floor(dl! / 1e9 / 60) * 60)}.` : null,
    evidence: parseEvidence(bet.last_resolution_raw, bet.envelope.terms),
  };
}

export function challengeRoundLabel(round: number): string {
  return round <= 1 ? "Round 1: Review" : "Round 2: Final appeal";
}

export function money(q: ChallengeBondQuote): string {
  const sym = symbolForAssetId(q.asset);
  const dec = findAsset(sym)?.decimals ?? 0;
  const n = fromBaseUnits(q.amount, dec);
  return `${n} ${sym}`; // NAV1 (UX-31): token units, never "$"
}

export type ChallengeOffer =
  | { kind: "hidden" }
  | { kind: "already-open"; message: string }
  | { kind: "closed"; message: string; reason: ChallengeRefusalId }
  | { kind: "no-more-appeals"; message: string }
  | { kind: "available"; round: number; roundLabel: string; bondLine: string };

/** Who may challenge and what it costs. YES/NO: the side that lost; VOID: either side (S13). */
export function challengeOffer(bet: Bet, me: string | null, quote: ChallengeBondQuote | null, nowMs: number): ChallengeOffer {
  const o = outcomeOf(bet.outcome);
  if (!me || !aiBet(bet) || !o) return { kind: "hidden" };
  const isMaker = me === bet.envelope.maker;
  if (!isMaker && me !== bet.taker) return { kind: "hidden" };
  if (o !== "VOID" && winnerOf(bet, o) === me) return { kind: "hidden" };
  // LFIX1 (SM1 CON-5): Evidence is a challenged round that hasn't been re-judged yet (exhibits/objections filed). The contract takes a
  // round-2 bond there anyway, which spends max_rounds on one re-judge; the page never offers it.
  if (bet.status === "Challenged" || bet.status === "Rejudge" || bet.status === "Evidence") return { kind: "already-open", message: "A challenge is already open" };
  if (bet.status !== "Proposed") return { kind: "hidden" };
  if (bet.bonds.length >= MAX_DISPUTE_ROUNDS) return { kind: "no-more-appeals", message: "No more appeals." };
  // LFIX1 (SM1 CON-1): window, paid runs left, time before resolve_deadline, a live judge before it -- the bond buys a re-judge only then.
  const refusal = challengeRefusal(bet, nowMs);
  if (refusal) return { kind: "closed", message: refusal.message, reason: refusal.id };
  if (!quote) return { kind: "no-more-appeals", message: "No more appeals." }; // the contract's own end-of-rounds signal
  const round = bet.bonds.length + 1;
  // LFIX1 (SM1 LIFE-8): BetPage passes an empty placeholder while the quote loads; never print "a bond of 0".
  const bondLine = quote.asset === "" ? "Checking the bond amount…" : `Challenging costs a bond of ${money(quote)}. You get it back if you win the challenge.`;
  return { kind: "available", round, roundLabel: challengeRoundLabel(round), bondLine };
}

/** Refuse before signing when the Intents balance can't cover the quoted bond. An unknown balance does not block (the contract refunds a bad bond). */
export function bondBalanceRefusal(quote: ChallengeBondQuote, balanceUnits: string | null): string | null {
  if (balanceUnits == null) return null;
  return BigInt(balanceUnits) >= BigInt(quote.amount) ? null : `Not enough balance for the bond (${money(quote)})`;
}

/** LIFE1 (SM1 LIFE-3): shown only when the contract's finalize would accept it now (betLifecycle.finalizeRefusal mirrors every
 * require: bonded 24h cap, window_extension_ns, and "challenge round pending a ruling" while a re-judge is still possible). */
export function finalizeOffer(bet: Bet, nowMs: number): { show: boolean } {
  return { show: bet.outcome != null && finalizeRefusal(bet, nowMs) === null };
}

export function finalizedLine(bet: Bet): string {
  const o = outcomeOf(bet.outcome);
  if (!o) return "The bet is settled.";
  if (o === "VOID") return "The bet is settled. Both sides are being refunded.";
  return `The bet is settled. ${winnerOf(bet, o)} is being paid.`;
}

/** LFIX1 (SM1 CON-1/CON-5, the take modal's CRT-5 lesson): the challenge modal re-reads the bet just before the bond is signed. The
 * page's copy is the 15 s poll; if the bet moved on (someone bonded, evidence filed, finalized, re-ruled) or the bond can no longer buy
 * a re-judge, nothing is sent. */
export function challengeGuard(shown: Bet, fresh: Bet | null, nowMs: number): { ok: true } | { ok: false; message: string } {
  if (!fresh) return { ok: false, message: "We couldn't re-read the bet before challenging. Nothing was sent. Try again." };
  // status + bond count + outcome: any new ruling after the modal opened went through a bond (bonds.length grows), so these suffice.
  const changed = fresh.status !== shown.status || fresh.bonds.length !== shown.bonds.length || fresh.outcome !== shown.outcome;
  if (changed) return { ok: false, message: "The bet changed since you opened this. Nothing was sent. Check the page and try again." };
  const r = challengeRefusal(fresh, nowMs);
  return r ? { ok: false, message: `${r.message}${/\.$/.test(r.message) ? "" : "."} Nothing was sent.` } : { ok: true };
}

export type ChallengeConfirm = { kind: "challenged"; message: string } | { kind: "refused"; message: string } | { kind: "pending"; message: string };

/** The relayer only says "sent"; the contract decides. Success needs get_bet to show one more bond round. */
export async function confirmChallenge(a: {
  betId: number; bondsBefore: number;
  deps: { getBet: (id: number) => Promise<Bet | null>; sleep: (ms: number) => Promise<void> };
  attempts?: number; delayMs?: number;
}): Promise<ChallengeConfirm> {
  const attempts = Math.max(1, a.attempts ?? 8);
  let last: Bet | null = null;
  for (let i = 0; i < attempts; i++) {
    try { last = await a.deps.getBet(a.betId); } catch { last = null; }
    if (last) {
      if (last.bonds.length > a.bondsBefore) return { kind: "challenged", message: "Your challenge is in. The AI will look at it again." };
      if (!["Proposed", "Evidence", "Challenged", "Rejudge", "Taken", "Resolving"].includes(last.status)) return { kind: "refused", message: "The challenge didn't go through: the bet is already decided. Your bond was returned." };
    }
    if (i < attempts - 1) await a.deps.sleep(a.delayMs ?? 2000);
  }
  return { kind: "pending", message: "We sent your challenge but can't see it on the bet yet. Check again in a moment before trying again." };
}
