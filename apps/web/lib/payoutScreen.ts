// FE13 (S15): the payout / refund screen for every ending, and the payout progress + retry for pending payouts.
// Every amount is derived from the bet's own contract fields the way contracts/escrow/src/lib.rs schedules the payout lines (finalize, referee_rule,
// concede, void_after_deadline, emergency_refund, cancel/expire): side_fee with the bet's OWN fee floor copies (PA1), the tip carved from each side's
// own stake (RF2; paid on referee_rule / concede / deadline VOID, never on emergency or cancel/expire), storage to the fee account on a decided bet.
// D-UX21 #1: tips are shown exactly as the contract pays them. Nothing is hard-coded: no fee, floor, tip or storage figure lives here.
import type { Bet } from "./escrowAdapter";
import { findAsset, symbolForAssetId } from "./assets";
import { fromBaseUnits } from "./decimal";
import { formatUtc } from "./offerExpiry";

export const DRAIN_METHOD = "drain_payouts";
/** The contract clamps `limit` to its own MAX_DRAIN_BATCH (a test pins this number to lib.rs). */
export const DRAIN_LIMIT = 10;
export const drainPayoutsArgs = (betId: number): { bet_id: number; limit: number } => ({ bet_id: betId, limit: DRAIN_LIMIT });

/** Mirrors PendingPayout in lib.rs. */
export interface PayoutLine { id: number; bet_id: number; token_id: string; receiver: string; amount: string; reason: string; attempts: number; done: boolean; in_flight: boolean }

export type Ending = "won" | "lost" | "void-ai" | "void-referee" | "deadline" | "conceded-by-me" | "conceded-by-other" | "conceded" | "cancelled" | "expired" | "emergency";
export interface ExpectedLine { role: "maker" | "taker" | "winner" | "referee" | "fee"; asset: string; amount: bigint; reason: string }
export interface Progress { state: "paid" | "paying" | "slow" | "unknown"; message: string; lines: string[]; canRetry: boolean }
export interface PayoutScreen { ending: Ending; headline: string; lines: string[]; progress: Progress }

const big = (v: unknown): bigint => { try { return BigInt(String(v ?? "0")); } catch { return 0n; } };
const utc = (ns: number) => formatUtc(Math.floor(ns / 1e9));

function money(units: bigint, asset: string): string {
  const sym = symbolForAssetId(asset) ?? asset;
  const dollars = sym === "USDC" || sym === "USDT";
  let n = fromBaseUnits(units.toString(), findAsset(sym)?.decimals ?? 0);
  if (dollars) { const [w, f = ""] = n.split("."); n = `${w}.${f.padEnd(2, "0")}`; }
  return `${n} ${sym}`; // NAV1 (UX-31): token units, never "$"
}
function sum(parts: { asset: string; units: bigint }[]): string {
  const by = new Map<string, bigint>();
  for (const p of parts) by.set(p.asset, (by.get(p.asset) ?? 0n) + p.units);
  return [...by].filter(([, u]) => u > 0n || by.size === 1).map(([a, u]) => money(u, a)).join(" + ");
}

/** lib.rs side_fee: min(stake, max(stake * fee_bps / 10000, the bet's own min fee)). */
function sideFee(stake: bigint, feeBps: number, min: bigint): bigint {
  const pct = (stake * BigInt(feeBps)) / 10_000n;
  const f = pct > min ? pct : min;
  return f < stake ? f : stake;
}

interface Side { who: string | null; asset: string; stake: bigint; fee: bigint; tip: bigint; storage: bigint }
function sides(bet: Bet): [Side, Side] {
  const b = bet as any; const e = bet.envelope as any;
  const hasRef = !!e.referee;
  const mk = (who: string | null, asset: string, stake: unknown, min: unknown, tip: unknown, storage: unknown): Side => {
    const st = big(stake);
    return { who, asset, stake: st, fee: sideFee(st, e.fee_bps ?? 0, big(min)), tip: hasRef ? big(tip) : 0n, storage: big(storage) };
  };
  return [mk(e.maker, e.maker_asset, e.stake_maker, b.fee_min_maker, b.tip_maker, b.storage_maker), mk(bet.taker, e.taker_asset, e.stake_taker, b.fee_min_taker, b.tip_taker, b.storage_taker)];
}

type Kind =
  | { k: "cancelled" | "expired" | "emergency" | "deadline" | "void-ai" | "void-referee" }
  | { k: "decided"; winner: 0 | 1; conceded: boolean };

function classify(bet: Bet): Kind | null {
  const e = bet.envelope as any;
  switch (bet.status) {
    case "Cancelled": return { k: "cancelled" };
    case "Expired": return { k: "expired" };
    case "Voided": return bet.outcome === "VOID" ? { k: "deadline" } : { k: "emergency" };
    case "Finalized": case "Settled": {
      if (bet.outcome == null) return null;
      if (bet.outcome === "VOID") return { k: e.referee ? "void-referee" : "void-ai" };
      // concede never sets proposed_at; AI submit_outcome and referee_rule always do.
      return { k: "decided", winner: bet.outcome === e.maker_side ? 0 : 1, conceded: bet.proposed_at == null };
    }
    default: return null;
  }
}

/** The ledger lines the contract schedules for this ending (receivers by role). Null when the bet has no ending yet. */
export function expectedPayouts(bet: Bet): ExpectedLine[] | null {
  const c = classify(bet);
  if (!c) return null;
  const [m, t] = sides(bet);
  const taken = bet.taker != null;
  const out: ExpectedLine[] = [];
  const push = (role: ExpectedLine["role"], asset: string, amount: bigint, reason: string) => { if (amount > 0n) out.push({ role, asset, amount, reason }); };
  const keep = !!(bet.envelope as any).keep_terms;
  const tips = () => { push("referee", m.asset, m.tip, "referee_tip"); push("referee", t.asset, t.tip, "referee_tip"); };
  switch (c.k) {
    case "cancelled": case "expired": push("maker", m.asset, m.stake + m.storage, "cancel_expire_refund"); break;
    case "emergency":
      push("maker", m.asset, m.stake + m.storage, "emergency_refund_maker");
      if (taken) push("taker", t.asset, t.stake + t.storage, "emergency_refund_taker");
      break;
    case "void-ai": case "void-referee": case "deadline": {
      const r = c.k === "deadline" ? "void_deadline" : "void_refund";
      if (c.k !== "void-ai") tips();
      push("maker", m.asset, m.stake - m.tip, `${r}_maker`); push("taker", t.asset, t.stake - t.tip, `${r}_taker`);
      if (keep) { push("fee", m.asset, m.storage, "void_storage_keep_terms"); push("fee", t.asset, t.storage, "void_storage_keep_terms"); }
      else { push("maker", m.asset, m.storage, "void_storage_refund_maker"); push("taker", t.asset, t.storage, "void_storage_refund_taker"); }
      break;
    }
    case "decided":
      tips();
      push("winner", m.asset, m.stake - m.fee - m.tip, "payout_winner"); push("winner", t.asset, t.stake - t.fee - t.tip, "payout_winner");
      push("fee", m.asset, m.fee + m.storage, "fee_and_storage"); push("fee", t.asset, t.fee + t.storage, "fee_and_storage");
      break;
  }
  return out;
}

function progress(bet: Bet, pending: PayoutLine[] | null): Progress {
  if (pending == null) return { state: "unknown", message: "Checking the payout…", lines: [], canRetry: false };
  const open = pending.filter((l) => !l.done);
  if (open.length === 0) {
    // A Finalized bet is only promoted to Settled by a drain, so an empty list on Finalized is not "Paid" yet.
    if (bet.status === "Finalized") return { state: "paying", message: "Payout in progress…", lines: [], canRetry: true };
    return { state: "paid", message: "Paid.", lines: [], canRetry: false };
  }
  const slow = open.some((l) => l.attempts > 0 && !l.in_flight);
  return {
    state: slow ? "slow" : "paying",
    message: slow ? "Payout is taking longer than usual. Your money is safe in escrow. Retry." : "Payout in progress…",
    lines: open.map((l) => `Sending ${money(big(l.amount), l.token_id)} to ${l.receiver}`),
    canRetry: open.some((l) => !l.in_flight),
  };
}

function refundLine(s: Side, keep: boolean, tipped: boolean): string {
  const refund = s.stake - (tipped ? s.tip : 0n);
  const stakeTxt = `${money(refund, s.asset)} stake${tipped && s.tip > 0n ? ` after your ${money(s.tip, s.asset)} tip` : ""}`;
  if (s.storage === 0n) return `Refunded: ${stakeTxt}.`;
  if (keep) return `Refunded: ${stakeTxt}. The ${money(s.storage, s.asset)} storage charge was kept because the terms were stored.`;
  return `Refunded: ${stakeTxt} + ${money(s.storage, s.asset)} storage charge = ${money(refund + s.storage, s.asset)}.`;
}

export function payoutScreen(bet: Bet, me: string | null, pending: PayoutLine[] | null): PayoutScreen | null {
  const c = classify(bet);
  if (!c) return null;
  const e = bet.envelope as any;
  const [m, t] = sides(bet);
  const ref: string | null = e.referee?.account ?? null;
  const keep = !!e.keep_terms;
  const mySide = me && me === e.maker ? 0 : me && me === bet.taker ? 1 : null;
  const my = mySide === 0 ? m : mySide === 1 ? t : null;
  const done = (ending: Ending, headline: string, lines: string[]): PayoutScreen => ({ ending, headline, lines, progress: progress(bet, pending) });
  const tipLine = (s: Side) => (ref && s.tip > 0n ? [`Your tip of ${money(s.tip, s.asset)} was paid to ${ref}.`] : []);

  switch (c.k) {
    case "cancelled": case "expired": {
      const ending = c.k;
      if (my) return done(ending, "Nobody took this bet. You were refunded in full.", [refundLine(m, false, false)]);
      return done(ending, "Nobody took this bet. The maker was refunded in full.", [`${e.maker} got back ${money(m.stake + m.storage, m.asset)}.`]);
    }
    case "emergency": {
      const lines = ["No fee was charged.", ...(my ? [refundLine(my, false, false)] : [m, t].filter((s) => s.who).map((s) => `${s.who} got back ${money(s.stake + s.storage, s.asset)}.`))];
      return done("emergency", my ? "The app was shut down. You got your own deposits back." : "The app was shut down. Both sides got their own deposits back.", lines);
    }
    case "deadline": {
      const when = utc(e.resolve_deadline);
      const who = ref ?? "Nobody";
      const verb = ref ? `${who} didn't rule by ${when}.` : `Nobody ruled by ${when}.`;
      if (!my) return done("deadline", `${verb} Both bettors were refunded.`, [m, t].map((s) => `${s.who} got back ${money(s.stake - s.tip + s.storage, s.asset)}.`));
      return done("deadline", `${verb} You were both refunded.`, [refundLine(my, keep, true), ...tipLine(my)]);
    }
    case "void-ai": {
      const lines = ["No fee was charged.", ...(my ? [refundLine(my, keep, false)] : [m, t].map((s) => `${s.who} got back ${money(s.stake + (keep ? 0n : s.storage), s.asset)}.`))];
      if (bet.challenged_by) lines.push("A challenge was filed on this bet. If it won a round, the judge's run cost was taken from the other side's refund, so the refund above can be lower for them.");
      return done("void-ai", my ? "This bet was voided. You got your stake back." : "This bet was voided. Both sides got their stake back.", lines);
    }
    case "void-referee": {
      const lines = ["No platform fee was charged.", ...(my ? [refundLine(my, keep, true), ...tipLine(my)] : [m, t].map((s) => `${s.who} got back ${money(s.stake - s.tip + (keep ? 0n : s.storage), s.asset)}.`))];
      return done("void-referee", `${ref} voided this bet.`, lines);
    }
    case "decided": {
      const w = c.winner === 0 ? m : t;
      const l = c.winner === 0 ? t : m;
      const winnerName = w.who ?? "The winner";
      const loserName = l.who ?? "The other side";
      const pot = sum([m, t].map((s) => ({ asset: s.asset, units: s.stake })));
      const fees = sum([m, t].map((s) => ({ asset: s.asset, units: s.fee })));
      const tips = [m, t].filter((s) => s.tip > 0n);
      const net = sum([m, t].map((s) => ({ asset: s.asset, units: s.stake - s.fee - s.tip })));
      const storage = sum([m, t].map((s) => ({ asset: s.asset, units: s.storage })));
      const potLine = `Pot ${pot} − fee ${fees}${tips.length ? ` − tip ${sum(tips.map((s) => ({ asset: s.asset, units: s.tip })))}` : ""} = ${net}`;
      const storageLine = [m, t].some((s) => s.storage > 0n) ? [`The network storage charge (${storage}) went with the fee.`] : [];
      const iWon = my === w;
      if (c.conceded) {
        if (my && !iWon) return done("conceded-by-me", `You conceded. ${winnerName} was paid.`, [`Same fee as a normal ending: ${potLine.replace(/^Pot/, "pot")} paid.`, ...storageLine]);
        if (iWon) return done("conceded-by-other", `${loserName} conceded. You won ${net}.`, [potLine, ...storageLine]);
        return done("conceded", `${loserName} conceded. ${winnerName} was paid ${net}.`, [potLine, ...storageLine]);
      }
      if (iWon) return done("won", `You won ${net}.`, [potLine, ...storageLine]);
      if (my) {
        const lines = [`${winnerName} was paid.`];
        if (ref && my.tip > 0n) lines.push(`Your tip of ${money(my.tip, my.asset)} to ${ref} came out of your stake.`);
        return done("lost", `You lost ${money(my.stake, my.asset)}.`, lines);
      }
      return done("won", `${winnerName} won ${net}.`, [potLine, ...storageLine]);
    }
  }
}

export type DrainConfirm = { kind: "paid" | "pending"; message: string };

/** The relayer only says "sent"; the contract decides. Success needs an empty pending list on a bet that is no longer Finalized. */
export async function confirmDrain(a: {
  betId: number;
  deps: { getBet: (id: number) => Promise<Bet | null>; pending: (id: number) => Promise<PayoutLine[] | null>; sleep: (ms: number) => Promise<void> };
  attempts?: number; delayMs?: number;
}): Promise<DrainConfirm & { bet: Bet | null; pending: PayoutLine[] | null }> {
  const attempts = Math.max(1, a.attempts ?? 8);
  let bet: Bet | null = null; let pending: PayoutLine[] | null = null;
  for (let i = 0; i < attempts; i++) {
    try { [bet, pending] = await Promise.all([a.deps.getBet(a.betId), a.deps.pending(a.betId)]); } catch { /* keep trying */ }
    if (bet && pending && pending.filter((l) => !l.done).length === 0 && bet.status !== "Finalized") return { kind: "paid", message: "Paid.", bet, pending };
    if (i < attempts - 1) await a.deps.sleep(a.delayMs ?? 2000);
  }
  return { kind: "pending", message: "We sent it but can't see the payout finish yet. Check again in a moment.", bet, pending };
}
