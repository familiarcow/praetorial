// FE10 (S12): the live bet page's logic. Status chips in plain English, concede (D-CONCEDE1/UX-10) refusal table pinned to
// contracts/escrow/src/lib.rs, the "referee frozen while a ruling is in progress" rule mirrored from amend_referee, the concede
// read-back, and the pending referee-change display. No numbers are written into copy here.
import type { Bet } from "./escrowAdapter";
import { challengedSentence } from "./betLifecycle";

export const ALL_STATUSES = ["Open", "Taken", "Resolving", "Proposed", "Challenged", "Evidence", "Rejudge", "Finalized", "Settled", "Voided", "Cancelled", "Expired"];

export interface Chip { id: "open" | "live" | "ruling" | "dispute" | "paying" | "done" | "refunded" | "cancelled" | "expired"; label: string; sentence: string }

function who(bet: Bet): string {
  const r = bet.envelope.referee;
  return r ? r.account : "the AI";
}

/** One plain chip + one sentence per contract status. `me` is only used to say "you". */
export function statusChip(bet: Bet, me: string | null): Chip {
  const w = who(bet);
  const decider = bet.envelope.referee ? `${w} decides this bet.` : "The AI decides this bet.";
  switch (bet.status) {
    case "Open": return { id: "open", label: "Open", sentence: "Waiting for someone to take this bet. Nothing is locked until they do." };
    case "Taken": return { id: "live", label: "Live", sentence: `Both sides are in. ${decider}` };
    case "Resolving": return { id: "ruling", label: "Ruling in progress", sentence: `${bet.envelope.referee ? `${w} is` : "The AI is"} working out who won.` };
    case "Proposed": return { id: "ruling", label: "Ruling made", sentence: `${bet.envelope.referee ? w : "The AI"} has given a ruling. It becomes final unless someone challenges it in time.` };
    // LIFE1 (SM1 LIFE-1): say when the re-judge is asked for (the keeper does it when the evidence window ends; anyone can from then on).
    case "Challenged": return { id: "dispute", label: "Challenged", sentence: challengedSentence(bet) ?? "The ruling was challenged. The AI will look at it again." };
    case "Evidence": return { id: "dispute", label: "Collecting evidence", sentence: challengedSentence(bet) ?? "The ruling was challenged. Both sides can add evidence before the next ruling." };
    case "Rejudge": return { id: "dispute", label: "Second look", sentence: "The bet is being looked at again after a challenge." };
    case "Finalized": return { id: "paying", label: "Paying out", sentence: "The result is final. Winnings are being sent." };
    case "Settled": return { id: "done", label: "Done", sentence: bet.outcome ? "The bet is over and everyone has been paid." : "The bet is over." };
    case "Voided": return { id: "refunded", label: "Refunded", sentence: "No result was reached, so both sides were refunded." };
    case "Cancelled": return { id: "cancelled", label: "Cancelled", sentence: "The maker cancelled this bet before anyone took it." };
    case "Expired": return { id: "expired", label: "Expired", sentence: "Nobody took this offer in time. The maker's money is back." };
  }
  return { id: "live", label: "Unknown", sentence: "We can't tell this bet's state right now." };
}

/** Mirrors amend_referee: changeable only while Open, or Taken with no challenge bond posted. Terminal statuses are also closed. */
export function refereeChangeFrozen(bet: Pick<Bet, "status" | "bonds">): boolean {
  return !(bet.status === "Open" || (bet.status === "Taken" && bet.bonds.length === 0));
}

export const FROZEN_MESSAGE = "The referee can't be changed now: a ruling is in progress or has been made.";

export interface ConcedeRefusalRow { id: string; source: string; message: string }
// concede panics (no refund path): every require()/panic text in lib.rs's concede, plus bet_mut's unknown-bet text.
export const CONCEDE_REFUSALS: ConcedeRefusalRow[] = [
  { id: "shutdown", source: "contract is shut down", message: "This app has been shut down. Use the emergency refund instead" },
  { id: "status", source: "bet not concedable in its current status", message: "This bet can't be conceded right now: it either hasn't been taken yet or it is already over" },
  { id: "no-taker", source: "bet has no taker", message: "Nobody has taken this bet yet, so there is nothing to concede" },
  { id: "party", source: "only maker or taker may concede", message: "Only the two people in this bet can concede it" },
  { id: "no-counter", source: "no counterparty outcome", message: "This bet has no other side to concede to" },
  { id: "unknown", source: "unknown bet_id", message: "We can't find this bet" },
];

export function plainConcedeRefusal(reason: string): { known: boolean; message: string } {
  const row = CONCEDE_REFUSALS.find((r) => reason.includes(r.source));
  return row ? { known: true, message: row.message } : { known: false, message: "The concede didn't go through. Nothing changed" };
}

/** The outcome the contract awards when `me` concedes: the other side's. Null when `me` is not a party. */
export function concedeWinnerOutcome(bet: Pick<Bet, "taker" | "envelope">, me: string | null): string | null {
  if (!me) return null;
  const e = bet.envelope as any;
  if (me === e.maker) return (e.outcomes as string[]).find((o) => o !== e.maker_side) ?? null;
  if (me === bet.taker) return e.maker_side;
  return null;
}

export function concedeSentence(bet: Pick<Bet, "taker" | "envelope">, me: string | null): string {
  const other = me === bet.envelope.maker ? bet.taker : bet.envelope.maker;
  return `Concede this bet? Your side loses and ${other ?? "the other side"} is paid right away. This cannot be undone.`;
}

export type ConcedeOutcome = { kind: "conceded"; message: string } | { kind: "ruled"; message: string } | { kind: "pending"; message: string };

/** Success only when get_bet shows the bet decided for the other side. The relayer only says "sent". */
export async function confirmConcede(a: {
  betId: number; me: string;
  deps: { getBet: (id: number) => Promise<Bet | null>; sleep: (ms: number) => Promise<void> };
  attempts?: number; delayMs?: number;
}): Promise<ConcedeOutcome> {
  let last: Bet | null = null;
  const attempts = a.attempts ?? 8;
  const delayMs = a.delayMs ?? 2000;
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try { last = await a.deps.getBet(a.betId); } catch { last = null; }
    if (last) {
      const decided = ["Finalized", "Settled"].includes(last.status);
      if (decided && last.outcome != null) {
        if (last.outcome === concedeWinnerOutcome(last, a.me)) return { kind: "conceded", message: "You conceded. The other side is being paid." };
        return { kind: "ruled", message: "The bet was decided before your concede landed. Nothing was conceded." };
      }
      if (["Voided", "Cancelled", "Expired"].includes(last.status)) return { kind: "ruled", message: "The bet ended before your concede landed. Nothing was conceded." };
    }
    if (i < attempts - 1) await a.deps.sleep(delayMs);
  }
  return { kind: "pending", message: "We sent your concede but can't see it on the bet yet. Check again in a moment before trying again." };
}

/** REVIEW1 (SM1 LIFE-11): the concede modal re-reads the bet right before signing. Anything that changes who gets paid or whether a
 *  concede still makes sense (status, ruling, challenge rounds, parties, stakes, deadlines) since the modal opened stops it. */
export function concedeGuard(shown: Bet, now: Bet | null): { ok: true } | { ok: false; message: string } {
  if (!now) return { ok: false, message: "We couldn't find this bet any more. Nothing was sent." };
  const a: any = shown, b: any = now;
  const what: string[] = [];
  if (a.status !== b.status) what.push(`it is now ${b.status}, not ${a.status}`);
  if ((a.outcome ?? null) !== (b.outcome ?? null)) what.push(b.outcome ? `a ruling came in (${b.outcome})` : "the ruling changed");
  if ((a.proposed_at ?? null) !== (b.proposed_at ?? null) && (a.outcome ?? null) === (b.outcome ?? null)) what.push("the ruling changed");
  if ((a.bonds?.length ?? 0) !== (b.bonds?.length ?? 0)) what.push("someone challenged the ruling");
  if ((a.taker ?? null) !== (b.taker ?? null) || a.envelope.maker !== b.envelope.maker) what.push("the people on the bet changed");
  if (JSON.stringify(a.envelope.referee ?? null) !== JSON.stringify(b.envelope.referee ?? null)) what.push("the referee changed");
  if (a.envelope.stake_maker !== b.envelope.stake_maker || a.envelope.stake_taker !== b.envelope.stake_taker) what.push("the stakes changed");
  if (a.envelope.resolve_deadline !== b.envelope.resolve_deadline || (a.window_extension_ns ?? 0) !== (b.window_extension_ns ?? 0)) what.push("the deadlines changed");
  if (what.length === 0) return { ok: true };
  return { ok: false, message: `This bet changed since you opened this: ${Array.from(new Set(what)).join("; ")}. Nothing was conceded and nothing was sent. Close this and look at the bet again.` };
}

export interface PendingReferee { maker: string | null; taker: string | null; makerSet: boolean; takerSet: boolean }

function proposedName(v: string | null | undefined): string | null | undefined {
  if (v == null) return undefined;
  try { const p = JSON.parse(v); return p == null ? "the AI" : String(p.account ?? ""); } catch { return undefined; }
}

/** The two-sided referee change in flight (referee_proposal), or null when neither side has proposed. */
export function pendingRefereeProposal(bet: Bet): PendingReferee | null {
  const p = (bet as any).referee_proposal as { maker_value: string | null; taker_value: string | null } | undefined;
  if (!p) return null;
  const m = proposedName(p.maker_value);
  const t = proposedName(p.taker_value);
  if (m === undefined && t === undefined) return null;
  return { maker: m ?? null, taker: t ?? null, makerSet: m !== undefined, takerSet: t !== undefined };
}

/** The JSON amend_referee takes: Option<Referee>. */
export function refereeJson(account: string | null): string {
  return account ? JSON.stringify({ account, mode: "Human" }) : "null";
}
