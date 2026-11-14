// MODAL1c2: pure helpers for the Take bet FlowModal (no React, runs under `tsx --test`).
// M1 (UX-37 #5, UIR1 §3.6): Take is ONE confirm step: the 5-line review (kit ReviewSummary, referee included) + a pay box + one button.
import type { FlowStep } from "./flowModal";
import type { FlowResult } from "../src/modal/FlowModal";
import { takeChoices, takeTipOffer } from "./takeScreen";
import { symbolForAssetId } from "./assets";
import { feeBreakdown, formatAmount } from "./uiObjects";
import { money, moneyText } from "./money";
import { TAKEN_BY_ME, TAKE_PENDING } from "./takeView";

export type TakeStepId = "confirm";
export const TAKE_STEPS: FlowStep[] = [{ id: "confirm", title: "Take this bet" }];
export const TAKE_DRAFT_KEY = (betId: number) => `take-bet-${betId}`;

export interface TakeTerms {
  symbol: string; asset: string; minFeeUnits: bigint;
  stakeUnits: bigint; feeUnits: bigint; tipUnits: bigint; storageUnits: bigint; payNowUnits: bigint;
  texts: { stake: string; fee: string; tip: string | null; storage: string; payNow: string };
  /** What the taker can lose, in plain words with the exact amount. */
  loseText: string;
}

/** Exact amounts for one take, from the contract's own numbers (BigInt end to end). The tip comes out of the stake, never on top. */
export function takeTerms(bet: any, o: { tip: boolean; asset?: string }): TakeTerms {
  const choices = takeChoices(bet);
  const c = choices.find((x) => x.asset === o.asset) ?? choices[0];
  const symbol = symbolForAssetId(c.asset) ?? c.asset;
  const idx = (bet.envelope.taker_options ?? []).findIndex((t: { asset: string }) => t.asset === c.asset);
  const minFeeUnits = BigInt((c.isPrimary ? bet.fee_min_taker : bet.fee_min_taker_options?.[idx]) ?? "0");
  const offer = takeTipOffer(bet, c.asset);
  const tipUnits = o.tip && offer.visible ? c.tipUnits : 0n;
  const fb = feeBreakdown({ symbol, stakeUnits: c.stake, feeBps: bet.envelope.fee_bps, minFeePerSide: minFeeUnits, tipUnits });
  const storageUnits = c.deposit - c.stake;
  const t = (u: bigint) => formatAmount(symbol, u, { cents: true });
  const stake = t(c.stake);
  const loseText = `What you can lose: your whole stake of ${stake}. Nothing beyond that is ever taken from you.` + (tipUnits > 0n ? ` The ${t(tipUnits)} referee tip comes out of that stake, not on top.` : "");
  return {
    symbol, asset: c.asset, minFeeUnits, stakeUnits: c.stake, feeUnits: fb.feeUnits, tipUnits, storageUnits, payNowUnits: c.deposit,
    texts: { stake, fee: t(fb.feeUnits), tip: tipUnits > 0n ? t(tipUnits) : null, storage: t(storageUnits), payNow: t(c.deposit) },
    loseText,
  };
}

/** The take's outcome (any kind confirmTake / the page logic can end in) as the FlowModal result. Only "taken" is a success. */
export function takeFlowResult(o: { kind: string; message: string }, txHash: string | null): FlowResult {
  if (o.kind === "taken") return { kind: "success", txHash, message: o.message };
  if (o.kind === "pending") return { kind: "pending", txHash, message: o.message };
  return { kind: "failure", reason: o.message };
}

export interface PayRow { id: "pay-now" | "fee" | "tip"; label: string; value: string }
/** M1: the take sheet's pay box (what leaves the balance now, the exact fee and when it applies, the tip). lib/money wording. */
export function takePayRows(t: TakeTerms): PayRow[] {
  const m = (u: bigint) => moneyText(money(u, t.asset));
  const rows: PayRow[] = [
    { id: "pay-now", label: "You pay now", value: `${m(t.stakeUnits)} (+ ${m(t.storageUnits)} storage)` },
    { id: "fee", label: "Fee", value: `${m(t.feeUnits)}, taken from your stake only if someone wins` },
  ];
  if (t.tipUnits > 0n) rows.push({ id: "tip", label: "Referee tip", value: `${m(t.tipUnits)}, out of your stake` });
  return rows;
}

/** SM2 gap M1-1: the result line's words come from takeView, never restated in the modal. */
export function takeResultText(phase: "success" | "pending" | "failure", reason: string | null): string {
  return phase === "success" ? TAKEN_BY_ME : phase === "pending" ? TAKE_PENDING : reason ?? "";
}
