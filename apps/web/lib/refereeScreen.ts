// FE12 (S14): the human referee's screen + the bettors' waiting view. Mirrors contracts/escrow/src/lib.rs referee_rule:
// only the named referee, status Taken, no outcome yet, funding_deadline <= now <= resolve_deadline; pays out in the same call (no challenge).
// D-UX21 #2: the UI follows the contract's time rule and adds none of its own. Every number comes from the bet's own fields.
import type { Bet } from "./escrowAdapter";
import { findAsset, symbolForAssetId } from "./assets";
import { fromBaseUnits } from "./decimal";
import { formatUtc } from "./offerExpiry";

export const REFEREE_RULE_METHOD = "referee_rule";
export type RuleOutcome = "YES" | "NO" | "VOID";
export interface RuleButton { outcome: RuleOutcome; label: string }

const utc = (ns: number) => formatUtc(Math.floor(ns / 1e9));
const refereeOf = (bet: Bet) => bet.envelope.referee?.account ?? null;

export function money(units: bigint, asset: string): string {
  const sym = symbolForAssetId(asset) ?? asset;
  const n = fromBaseUnits(units.toString(), findAsset(sym)?.decimals ?? 0);
  return `${n} ${sym}`; // NAV1 (UX-31): token units, never "$"
}
const big = (v: unknown): bigint => { try { return BigInt(String(v ?? "0")); } catch { return 0n; } };
/** side_fee: max(stake * fee_bps / 10000, the bet's own min fee), capped at the stake. */
function sideFee(stake: bigint, feeBps: number, min: bigint): bigint {
  const pct = (stake * BigInt(feeBps)) / 10_000n;
  const f = pct > min ? pct : min;
  return f < stake ? f : stake;
}
export function sides(bet: Bet) {
  const b = bet as any;
  const e = bet.envelope;
  return [
    { stake: big(e.stake_maker), asset: e.maker_asset, fee: sideFee(big(e.stake_maker), e.fee_bps ?? 0, big(b.fee_min_maker)), tip: big(b.tip_maker) },
    { stake: big(e.stake_taker), asset: e.taker_asset, fee: sideFee(big(e.stake_taker), e.fee_bps ?? 0, big(b.fee_min_taker)), tip: big(b.tip_taker) },
  ];
}
export function sum(parts: { asset: string; units: bigint }[]): string {
  const byAsset = new Map<string, bigint>();
  for (const p of parts) byAsset.set(p.asset, (byAsset.get(p.asset) ?? 0n) + p.units);
  return [...byAsset].map(([a, u]) => money(u, a)).join(" + ");
}

export type RefereeScreen =
  | { kind: "none" }
  | { kind: "wait"; line: string }
  | { kind: "referee"; state: "ready" | "early" | "closed" | "ruled" | "ended"; message: string | null; deadlineLine: string; tipLine: string | null; buttons: RuleButton[] };

const BUTTONS: RuleButton[] = [{ outcome: "YES", label: "YES" }, { outcome: "NO", label: "NO" }, { outcome: "VOID", label: "VOID — refund both" }];

export function refereeScreen(bet: Bet, me: string | null, nowMs: number): RefereeScreen {
  const ref = refereeOf(bet);
  if (!ref || !me) return { kind: "none" };
  const e = bet.envelope;
  const deadline = utc(e.resolve_deadline);
  const isBettor = me === e.maker || me === bet.taker;
  if (me !== ref) {
    // LFIX1 (SM1 LIFE-5): past resolve_deadline nobody can rule any more (referee_rule: now <= resolve_deadline); the page says refund due.
    if (isBettor && bet.status === "Taken" && bet.outcome == null && nowMs * 1e6 <= Number(e.resolve_deadline)) return { kind: "wait", line: `Waiting for ${ref} to rule · they have until ${deadline}` };
    return { kind: "none" };
  }
  const tips = sides(bet).filter((s) => s.tip > 0n).map((s) => ({ asset: s.asset, units: s.tip }));
  const tipLine = tips.length ? `You'll receive ${sum(tips)} whatever you decide.` : null;
  const deadlineLine = `You can rule any time until ${deadline}. If you don't, both are refunded.`;
  const base = { deadlineLine, tipLine, buttons: [] as RuleButton[] };
  if (bet.outcome != null || bet.status === "Finalized" || bet.status === "Settled") return { kind: "referee", state: "ruled", message: "A ruling has already been made.", ...base };
  if (bet.status !== "Taken") return { kind: "referee", state: "ended", message: "This bet has ended. There is nothing left to rule on.", ...base };
  if (nowMs * 1e6 < e.funding_deadline) return { kind: "referee", state: "early", message: `You can rule from ${utc(e.funding_deadline)}.`, ...base };
  if (nowMs * 1e6 > e.resolve_deadline) return { kind: "referee", state: "closed", message: "The ruling window closed with no ruling. Both bettors get their stakes back; the refund is sent automatically.", ...base };
  return { kind: "referee", state: "ready", message: null, ...base, buttons: BUTTONS };
}

const TAIL = "This pays out immediately and can't be changed or challenged.";

/** The confirm step: who gets paid and how much (what the contract schedules: stake - side fee - tip, per side). */
export function ruleConfirmSentence(bet: Bet, outcome: RuleOutcome): string {
  const s = sides(bet);
  if (outcome === "VOID") return `You're ruling VOID: both bettors get their stake back, no fee. ${TAIL}`;
  const winner = bet.envelope.maker_side === outcome ? bet.envelope.maker : bet.taker;
  const amount = sum(s.map((x) => ({ asset: x.asset, units: x.stake - x.fee - x.tip })));
  return `You're ruling ${outcome}: ${winner} wins ${amount}. ${TAIL}`;
}

export function refereeRuleArgs(betId: number, outcome: RuleOutcome): { bet_id: number; outcome: RuleOutcome } {
  if (outcome !== "YES" && outcome !== "NO" && outcome !== "VOID") throw new Error("outcome must be YES, NO or VOID");
  return { bet_id: betId, outcome };
}

export type RuleConfirm = { kind: "ruled" | "refused" | "pending"; message: string };

function tipSuffix(bet: Bet): string {
  const tips = sides(bet).filter((s) => s.tip > 0n).map((s) => ({ asset: s.asset, units: s.tip }));
  return tips.length ? ` Your tip of ${sum(tips)} is on its way.` : "";
}

/** The relayer only says "sent"; the contract decides. Success needs get_bet to show the ruling. */
export async function confirmRule(a: {
  betId: number; outcome: RuleOutcome;
  deps: { getBet: (id: number) => Promise<Bet | null>; sleep: (ms: number) => Promise<void> };
  attempts?: number; delayMs?: number;
  /** M1 (PEOPLE RULE): how to name the paid side ("@mia"); the modal passes personLabel over the bet's names. */
  name?: (account: string) => string;
}): Promise<RuleConfirm> {
  const attempts = Math.max(1, a.attempts ?? 8);
  for (let i = 0; i < attempts; i++) {
    let last: Bet | null = null;
    try { last = await a.deps.getBet(a.betId); } catch { last = null; }
    if (last) {
      if (last.outcome != null && ["Finalized", "Settled"].includes(last.status)) {
        if (last.outcome === "VOID") return { kind: "ruled", message: "Done. Both bettors are being refunded." + tipSuffix(last) };
        const winner = last.envelope.maker_side === last.outcome ? last.envelope.maker : last.taker;
        return { kind: "ruled", message: `Done. ${winner && a.name ? a.name(winner) : winner} has been paid.` + tipSuffix(last) };
      }
      if (["Voided", "Cancelled", "Expired"].includes(last.status)) return { kind: "refused", message: "The ruling didn't go through: the bet has already ended. Nothing was changed." };
    }
    if (i < attempts - 1) await a.deps.sleep(a.delayMs ?? 2000);
  }
  return { kind: "pending", message: "We sent your ruling but can't see it on the bet yet. Check again in a moment before trying again." };
}
