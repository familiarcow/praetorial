// C1 (UIR1 §3.4 + §2.2 ReviewSummary, familiarcow UX-37 #5 #6 #7, PEOPLE RULE 2026-11-11): the create / take review model.
//  - summary: FIVE lines -- the bet, the deadline, both stakes, who decides (the referee as @username), when the offer closes.
//  - terms:   everything else, shown under a collapsed "Full terms": sources, exact times (local + UTC), the challenge window or the
//             referee's rule-by date, the money with exact values, the fee rule, who can take it, refunds, worst case.
// Every line is built from structured offer fields; the only free text is the claim sentence and the sources list. Amounts go
// through lib/money.ts (stables 2 dp, others <= 6 significant, tiny storage "< 0.01", exact value next to it in Full terms); dates
// through lib/dates.ts (relative in the summary, exact in Full terms). No status word, hash, asset id or account id is ever shown.
// (FE7's first model -- pay table, deadlines block, refund rules -- is folded into `terms`.)
import type { StructuredOffer } from "../src/components/ReviewCard";
import { findAsset, toBaseUnits } from "./assets";
import { FEE_BPS, feeForSideUnits } from "./escrowAdapter";
import { refereeAccount, refereeCostLine } from "./referee";
import { formatMoney, type Money } from "./money";
import { exactTime, timeLeft } from "./dates";
import { person, personLabel, type Names } from "./betView";

export interface ReviewStorage { maker: string; taker: string; makerUnits?: string; takerUnits?: string }

export type SummaryId = "claim" | "deadline" | "stakes" | "decider" | "closes";
/** One of the five lines. `at` (ms) + `future`: the screen renders it as a live relative time with the exact time on tap. */
export interface SummaryRow { id: SummaryId; label: string; text: string; at?: number; future?: string }
export interface TermRow { id: string; label: string; value: string }

export interface ReviewModel {
  summary: SummaryRow[];
  terms: TermRow[];
  /** "You pay now" (stake + your storage charge) for the Open button; null while the storage quote is loading. */
  payNow: string | null;
  table: { stake: string; storage: string | null; tip: string | null; payNow: string | null };
  fee: { maker: string; taker: string; floor: string; line: string };
}

export interface ReviewOpts { nowMs?: number; names?: Names; storageUnavailable?: boolean }

/** Base units of a typed amount for DISPLAY. A float with noise past the asset's decimals (0.1 + 0.2) is rounded to them, never shown as 0. */
export function amountUnits(symbol: string, amount: number | string): bigint {
  try { return BigInt(toBaseUnits(symbol, amount)); } catch { /* too many decimals: round below */ }
  const dec = findAsset(symbol)?.decimals;
  const n = Number(amount);
  if (dec === undefined || !Number.isFinite(n)) return 0n;
  try { return BigInt(toBaseUnits(symbol, n.toFixed(Math.min(dec, 20)))); } catch { return 0n; }
}
const unitsOf = amountUnits;
const m = (units: bigint, symbol: string): Money => ({ units, symbol });
const text = (x: Money, minor = false) => formatMoney(x, { minor }).text;
/** "< 0.01 USDC (exactly 0.000004 USDC)": the exact value only when the rounded one hides digits. */
function withExact(x: Money, minor = false): string {
  const f = formatMoney(x, { minor });
  const norm = (s: string) => { const n = s.replace(/[^\d.]/g, ""); return n.includes(".") ? n.replace(/0+$/, "").replace(/\.$/, "") : n; };
  return f.tiny || norm(f.text) !== norm(f.exact) ? `${f.text} (exactly ${f.exact})` : f.text;
}
const exact = (ms: number) => { const e = exactTime(ms); return `${e.local} (your time) · ${e.utc}`; };
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

export function buildReviewModel(offer: StructuredOffer, storage?: ReviewStorage | null, opts: ReviewOpts = {}): ReviewModel {
  const nowMs = opts.nowMs ?? Date.now();
  const human = offer.referee.mode === "human";
  const taker = offer.side === "taker";
  const sym = offer.makerAssetSymbol;
  const asset = findAsset(sym);
  const theirAsset = findAsset(offer.takerAssetSymbol);
  const myStake = m(unitsOf(sym, offer.makerAmount), sym);
  const theirStake = m(unitsOf(offer.takerAssetSymbol, offer.takerAmount), offer.takerAssetSymbol);

  // fees (the contract's side_fee: max(1%, the asset's minimum per side), never more than the stake)
  const minFee = BigInt(asset?.minFeePerSide ?? "0");
  const feeMine = offer.viewerFee !== undefined ? m(unitsOf(sym, offer.viewerFee), sym) : m(feeForSideUnits(myStake.units, minFee), sym);
  const feeTheirs = m(feeForSideUnits(theirStake.units, BigInt(theirAsset?.minFeePerSide ?? "0")), offer.takerAssetSymbol);
  const floor = text(m(minFee, sym));
  const feeRule = `${FEE_BPS / 100}% of the stake, at least ${floor} per person, taken from the pot when the bet ends.`;

  // storage + pay now
  const myStorage = storage?.makerUnits !== undefined ? m(BigInt(storage.makerUnits), sym) : null;
  const theirStorage = storage?.takerUnits !== undefined ? m(BigInt(storage.takerUnits), offer.takerAssetSymbol) : null;
  const payNowMoney = myStorage ? m(myStake.units + myStorage.units, sym) : null;
  const pending = opts.storageUnavailable ? storagePlaceholder(true) : "Loading…";

  // people: the referee and a named taker are @usernames (lib/betView personLabel), never account ids
  const refAcct = refereeAccount(offer.referee);
  const ref = refAcct ? personLabel({ account: refAcct, username: offer.refereeUsername ?? null, isMe: false }) : null;
  const tip = human
    ? refereeCostLine({ tipOn: !!offer.tipMaker, stake: text(myStake).replace(` ${sym}`, ""), tip: text(feeMine).replace(` ${sym}`, ""), symbol: sym })
    : null;

  // times
  const eventAt = offer.eventAtSecs ? offer.eventAtSecs * 1000 : null;
  const closesAt = offer.offerClosesAtSecs ? offer.offerClosesAtSecs * 1000 : null;
  const resolveAt = offer.resolveSecs ? offer.resolveSecs * 1000 : null;
  const rel = (at: number, future: string) => timeLeft({ at, now: nowMs, future }).text;

  const summary: SummaryRow[] = [
    { id: "claim", label: "Bet", text: offer.claimText },
    eventAt ? { id: "deadline", label: "Deadline", text: rel(eventAt, "Ends"), at: eventAt, future: "Ends" } : { id: "deadline", label: "Deadline", text: offer.deadlineLabel ? `Ends ${offer.deadlineLabel}` : "Not set" },
    { id: "stakes", label: "Stakes", text: `You put in ${text(myStake)} · they put in ${text(theirStake)}` },
    { id: "decider", label: "Who decides", text: human ? `${ref ?? personLabel({ account: "", username: null, isMe: false })}, a person (no AI)` : offer.deciderText ? offer.deciderText : `The AI judge${offer.sources.length ? `, from ${andList(offer.sources)}` : ""}` },
    closesAt ? { id: "closes", label: "Offer", text: rel(closesAt, "Closes"), at: closesAt, future: "Closes" } : { id: "closes", label: "Offer", text: offer.offerClosesLabel ?? "Open until the event starts" },
  ];

  const terms: TermRow[] = [];
  const add = (id: string, label: string, value: string | null | undefined) => { if (value) terms.push({ id, label, value }); };
  add("sources", "Sources", offer.sources.length ? offer.sources.join(", ") : human ? "None (a person decides)" : "None");
  add("offer-closes", "Offer closes", closesAt ? `${exact(closesAt)}${offer.offerClosesClamped ? " (the event starts then, so that is as long as it can stay open)" : ""}` : offer.offerClosesLabel ?? null);
  add("event", "Event", eventAt ? exact(eventAt) : offer.deadlineLabel || null);
  add("window", reviewHasSettlementLine(human) ? "Challenges" : "Referee", human
    ? `${ref ?? "The referee"} can rule any time until ${resolveAt ? exact(resolveAt) : offer.resolveByLabel ?? "the deadline"}. If they don't, you're both refunded.`
    : `${offer.settlementPeriodLabel} to challenge a ruling, 2 rounds.`);
  add("stake", "Your stake", text(myStake));
  add("their-stake", "Their stake", text(theirStake));
  add("storage", "Your storage charge", myStorage ? withExact(myStorage, true) : pending);
  if (!taker) add("their-storage", "Their storage charge", theirStorage ? withExact(theirStorage, true) : pending);
  add("tip", "Tip", tip);
  if (taker && human) add("agreement", "Referee", `Taking this bet means you agree to ${ref ?? "the referee"} deciding it.`);
  add("pay-now", "You pay now", payNowMoney ? withExact(payNowMoney) : pending);
  add("fee", "Fee", feeRule);
  if (!taker) {
    const who = offer.takerAccount ? personLabel(person(offer.takerAccount, null, opts.names ?? {})) : null;
    add("takers", "Who can take it", who ? `Only ${who} can take it.` : offer.inviteByLink ? "Only people you send a personal invite link to can take it." : "Anyone with the link can take it.");
  }
  add("refunds", "Refunds", [
    "Nobody takes it: full refund.",
    human ? `The referee never rules: you're both refunded${resolveAt ? ` on ${exactTime(resolveAt).utc}` : offer.resolveByLabel ? ` on ${offer.resolveByLabel}` : ""}.` : "The AI can't decide (VOID): you both get your stakes back and no fee is charged.",
    "If the app is shut down, anyone can trigger a full refund.",
  ].join(" "));
  add("worst-case", "Worst case", `If you lose, you lose your ${text(myStake)} stake. You can't lose more than what you pay now.`);
  if ((offer.typedSheet as { fields?: { open_utc?: unknown } } | null | undefined)?.fields?.open_utc) {
    add("restamp", "Start time", "Set when you open the bet. If you wait more than a few minutes, it is refreshed and you are asked to confirm again.");
  }
  add("safety", "Safety", "Money can only go to you or the other party.");

  const payNow = payNowMoney ? text(payNowMoney) : null;
  return {
    summary,
    terms,
    payNow,
    table: { stake: text(myStake), storage: myStorage ? withExact(myStorage, true) : null, tip, payNow },
    fee: { maker: text(feeMine), taker: text(feeTheirs), floor, line: feeRule },
  };
}

/** FE5b: a human referee has no challenge window; the review shows the referee's rule-by date instead. */
export const reviewHasSettlementLine = (human: boolean): boolean => !human;

/** Storage-line text while the quote is missing: "loading" only until the read settles with no rate. */
export function storagePlaceholder(unavailable: boolean): string {
  return unavailable ? "not available (this asset is not enabled on the contract for this network)" : "loading from the contract...";
}
