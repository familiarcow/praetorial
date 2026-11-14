// F5 (FUND4 SPEC §5, familiarcow UX-37 / D-FUND4a, SM2 STATES.md M7): the Cash out and Convert sheets' view model. Pure (no React, no
// window), so every word the sheets show is unit-tested (tests/funding/cashOut.unit.test.ts); src/components/funding/WithdrawSheet,
// ConvertSheet and AddressInput only render what this returns.
//   - Cash out: anything the user holds in their account (the 6 bet tokens and "Not usable for bets yet" tokens) -> any token on
//     any network the conversion service delivers, to the user's own address. Convert: only into the 6 (lib/funding/landing).
//   - Both are signed by the user (lib/cashOutSign.ts); the record is written BEFORE signing (signed: false) so a reload or a
//     cancelled wallet prompt is never lost: "You didn't confirm this cash out. [Confirm] [Cancel]" while the quote is valid.
//   - The state comes from lib/funding/tracker.advance only (SM2 M6/M7); this file turns it into words. Unknown is "checking".
//   - The destination address is the one raw address the user sees here (SM2 §2.2: raw ids only in Add money / Cash out).
// Amounts: lib/funding/format.displayAmount (received rounds DOWN, needed/minimums round UP). Shared strings: lib/funding/copy.
import type { BalanceMap, BetSymbol, QuoteView, StrayHolding, SwapRecord, TokenOption, TokenRef, TrackState } from "./funding/types";
import { BET_SYMBOLS } from "./funding/types";
import { COPY } from "./funding/copy";
import { displayAmount, etaText, shortAddress } from "./funding/format";
import { betSymbolForId, betTokenId, convertTargets } from "./funding/landing";
import { searchTokens } from "./funding/tokens";
import { needsConfirm } from "./funding/tracker";
import { validateRecipient, isMemoChain } from "./funding/chainAddress";
import { FundingError } from "./funding/fundingClient";
import { parseAmountInput, displaySymbol, networkName } from "./fundSheet";
import { findAsset } from "./assets";
import { fromBaseUnits } from "./decimal";

/** F5's own words (the shared ones are in lib/funding/copy COPY.cashOut / COPY.convert). Same wording rules: no "intents",
 * "1Click", "bridge", "quote", "withdraw" in user copy (unit-tested). */
export const CASH_OUT_COPY = {
  fromBalance: "From your betting balance",
  fromOther: "Not usable for bets yet",
  nothing: "There's nothing to cash out yet.",
  amountLabel: (symbol: string) => `How much ${symbol}?`,
  enterAmount: "Enter an amount.",
  invalidNumber: "Enter a number, like 10.5.",
  tooPrecise: (symbol: string) => `That amount has too many decimals for ${symbol}.`,
  moreThanYouHave: (have: string) => `That's more than you have (${have}).`,
  sendAsCurrent: (symbol: string, network: string) => `Send as ${symbol} on ${network}`,
  change: "Change",
  next: "Next",
  back: "Back",
  review: "Review",
  ownAccount: (network: string) => `That's your account ID here, not an address on ${network}.`,
  tooSmallNoMin: (network: string) => `Too small to send to ${network}.`,
  tooSmallConvert: (min: string) => `Too small to convert. Minimum is ${min}.`,
  noRoute: (symbol: string, network: string) => `${symbol} on ${network} isn't available right now. Pick another network or try later.`,
  gettingPrice: "Getting the price…",
  fullAddress: "Full address",
  priceMoved: "The price moved. Check the new amounts, then confirm again.",
  refusedSubmit: "We couldn't send it. Nothing left your balance. Try again in a moment.",
  stepConfirmed: "Confirmed",
  stepSending: "Sending",
  stepSent: "Sent",
  stepConverting: "Converting",
  stepCredited: "In your balance",
  checking: "We can't check this right now. It's still being processed. Retrying…",
  expiredSigned: "This didn't go through, so nothing left your balance. If your balance looks wrong, get help.",
  expiredUnsigned: "You didn't confirm this cash out in time. Nothing was sent.",
  expiredUnsignedConvert: "You didn't confirm this conversion in time. Nothing was converted.",
  unsignedConvert: "You didn't confirm this conversion.",
  backInAccount: (amount: string) => `We couldn't send it. ${amount} is back in your account.`,
  convertBackBetting: (amount: string) => `We couldn't convert it. ${amount} is back in your betting balance.`,
  convertBackAccount: (amount: string) => `We couldn't convert it. ${amount} is back in your account.`,
  converting: (from: string, to: string) => `Converting ${from} to ${to}…`,
  convertTitleBet: (amount: string) => `Convert ${amount}`,
  convertTo: "Convert to",
  convertCta: "Convert",
  doneCta: "Done",
  leaveWarning: "Your cash out is being confirmed. Leaving now may leave it unconfirmed.",
} as const;

// ---------------------------------------------------------------- what can be cashed out
export interface CashOutHolding {
  assetId: string;
  /** The token as the conversion service names it (origin of the cash out / convert). */
  token: TokenRef;
  /** "USDC" for a bet token; "USDC (Ethereum)" for a token that isn't usable for bets. */
  label: string;
  /** Display symbol (wNEAR -> NEAR). */
  symbol: string;
  units: bigint;
  amountText: string;
  kind: "betting" | "stray";
}

/** A bet token as a TokenRef (mainnet ids: the conversion service is mainnet-only). */
export function betRef(symbol: BetSymbol): TokenRef {
  return { assetId: betTokenId(symbol, "mainnet")!, symbol, blockchain: "near", decimals: findAsset(symbol)!.decimals };
}
const amt = (units: string | bigint, t: TokenRef, round: "down" | "up" = "down") => displayAmount(units, t.decimals, displaySymbol(t), { round });

export function holdingFor(symbol: BetSymbol, units: bigint): CashOutHolding | null {
  if (!betTokenId(symbol, "mainnet")) return null;
  const token = betRef(symbol);
  return { assetId: token.assetId, token, label: symbol, symbol, units, amountText: amt(units, token), kind: "betting" };
}
/** A non-bet token in the account; null when it is unknown to the conversion service (it can't be priced or routed: support). */
export function holdingFromStray(s: StrayHolding): CashOutHolding | null {
  if (!s.token || s.units <= 0n) return null;
  const symbol = displaySymbol(s.token);
  return { assetId: s.assetId, token: s.token, label: `${symbol} (${networkName(s.token.blockchain)})`, symbol, units: s.units, amountText: amt(s.units, s.token), kind: "stray" };
}

/** Step 1: every non-zero bet token (D-ASSET1 order), then every known non-zero non-bet token. An unread section adds nothing. */
export function cashOutHoldings(map: Pick<BalanceMap, "betting" | "stray">): CashOutHolding[] {
  const out: CashOutHolding[] = [];
  if (map.betting !== "error") for (const s of BET_SYMBOLS) {
    const u = map.betting[s] ?? 0n;
    const h = u > 0n ? holdingFor(s, u) : null;
    if (h) out.push(h);
  }
  if (map.stray !== "error") for (const s of map.stray) { const h = holdingFromStray(s); if (h) out.push(h); }
  return out;
}

// ---------------------------------------------------------------- amount
export type CashOutAmount = { ok: true; units: string } | { ok: false; message: string };
export function parseCashOutAmount(text: string, h: CashOutHolding): CashOutAmount {
  const p = parseAmountInput(text, h.token.decimals);
  if (!p.ok) {
    if (p.reason === "too-precise") return { ok: false, message: CASH_OUT_COPY.tooPrecise(h.symbol) };
    if (p.reason === "invalid") return { ok: false, message: CASH_OUT_COPY.invalidNumber };
    return { ok: false, message: CASH_OUT_COPY.enterAmount };
  }
  if (BigInt(p.units) > h.units) return { ok: false, message: CASH_OUT_COPY.moreThanYouHave(h.amountText) };
  return { ok: true, units: p.units };
}
/** Max: the whole balance, every digit (the field holds plain digits, never a rounded display amount). */
export const maxAmountText = (h: CashOutHolding): string => fromBaseUnits(h.units.toString(), h.token.decimals);

/** "10.00 USDC is in open bets and can't be cashed out." (money in bets sits in the escrow, not in the balance). */
export function lockedLine(inBets: BalanceMap["inBets"], symbol: string): string | null {
  if (inBets === "error") return null;
  const l = (inBets as Record<string, { units: bigint } | undefined>)[symbol];
  const asset = findAsset(symbol);
  if (!l || l.units <= 0n || !asset) return null;
  return COPY.cashOut.locked(displayAmount(l.units, asset.decimals, symbol));
}

// ---------------------------------------------------------------- send as
const NATIVE: Partial<Record<string, BetSymbol>> = { BTC: "BTC", ETH: "ETH", ZEC: "ZEC", NEAR: "NEAR" };
/** SPEC §5.1 step 2: BTC/ETH/ZEC/NEAR -> their own network; USDC/USDT -> the network the user last added that symbol from (their
 * Add money records); a non-bet token -> its own network. Otherwise null: the user picks ("Popular for USDC" first). */
export function defaultSendAs(h: CashOutHolding, tokens: TokenOption[], records: SwapRecord[]): TokenOption | null {
  const by = (id: string | null) => (id ? tokens.find((t) => t.assetId === id) ?? null : null);
  if (h.kind === "stray") return by(h.assetId);
  const native = NATIVE[h.symbol];
  if (native) return by(betTokenId(native, "mainnet"));
  const last = records.filter((r) => r.kind === "fund" && displaySymbol(r.origin) === h.symbol).sort((a, b) => b.createdAt - a.createdAt)[0];
  return last ? by(last.origin.assetId) : null;
}
/** Every token the user can receive, the same symbol on every network first. Cross-symbol is allowed (the review shows it). */
export const sendAsList = (tokens: TokenOption[], h: CashOutHolding, query = ""): TokenOption[] => searchTokens(tokens, query, h.symbol);

// ---------------------------------------------------------------- address
export type AddressVerdict = { state: "empty" } | { state: "ok" } | { state: "bad"; message: string };
/** The user's address on the destination chain, checked with the funding Worker's own rules (lib/funding/chainAddress.ts). The
 * text is trimmed first (pasted addresses often carry a newline); the trimmed text is what is sent. */
export function checkAddress(dest: Pick<TokenOption, "blockchain" | "networkName">, text: string, ctx: { account: string; ownDeposits: readonly string[] }): AddressVerdict {
  const a = text.trim();
  if (!a) return { state: "empty" };
  const r = validateRecipient(dest.blockchain, a, { account: ctx.account, refused: ctx.ownDeposits });
  if (r.ok) return { state: "ok" };
  if (r.reason === "empty") return { state: "empty" };
  if (r.reason === "refused") {
    if (/deposit address/.test(r.detail)) return { state: "bad", message: COPY.cashOut.ownDeposit };
    if (/NEAR account id/.test(r.detail)) return { state: "bad", message: CASH_OUT_COPY.ownAccount(dest.networkName) };
    return { state: "bad", message: COPY.cashOut.contract };
  }
  return { state: "bad", message: COPY.cashOut.invalid(dest.networkName) };
}
/** XRP / Stellar / TON: exchanges there need a tag/memo, which a cash out can't add (SPEC §5.1 step 3): ask, and block "Yes". */
export const memoChain = (dest: Pick<TokenOption, "blockchain">): boolean => isMemoChain(dest.blockchain);

// ---------------------------------------------------------------- review
export interface ReviewView { rows: { id: string; label: string; value: string }[]; fullAddress: string }
export function reviewView(q: QuoteView, h: CashOutHolding, dest: TokenOption, recipient: string): ReviewView {
  const d = { ...dest, symbol: displaySymbol(dest) };
  const net = networkName(dest.blockchain);
  const send = amt(q.amountIn, h.token) + (h.kind === "stray" ? ` (${networkName(h.token.blockchain)})` : "");
  return {
    fullAddress: recipient,
    rows: [
      { id: "send", label: COPY.cashOut.reviewSend, value: send },
      { id: "receive", label: COPY.cashOut.reviewReceive, value: `${amt(q.amountOut, d)} on ${net}` },
      { id: "at-least", label: COPY.cashOut.reviewAtLeast, value: amt(q.minAmountOut, d) },
      { id: "to", label: COPY.cashOut.reviewTo, value: `${shortAddress(recipient)} (${net})` },
      { id: "fee", label: COPY.cashOut.reviewFee, value: `${amt(q.withdrawFee, d, "up")} · about ${etaText(q.timeEstimateSec)}` },
    ],
  };
}

/** A Worker error as one plain sentence. Our own outage is "unavailable, your balances are safe", never "failed". */
export function cashOutErrorText(e: unknown, h: CashOutHolding, dest: Pick<TokenRef, "blockchain" | "symbol" | "assetId">, kind: "withdraw" | "convert" = "withdraw"): string {
  if (!(e instanceof FundingError)) return COPY.add.quoteError;
  const net = networkName(dest.blockchain);
  switch (e.code) {
    case "too_low": {
      const min = e.minUnits ? amt(e.minUnits, h.token, "up") : null;
      if (kind === "convert") return min ? CASH_OUT_COPY.tooSmallConvert(min) : COPY.account.strayDust;
      return min ? COPY.cashOut.tooSmall(net, min) : CASH_OUT_COPY.tooSmallNoMin(net);
    }
    case "bad_recipient": return COPY.cashOut.invalid(net);
    case "no_route": return CASH_OUT_COPY.noRoute(displaySymbol(dest), net);
    case "rate_limited": return COPY.common.rateLimited;
    case "network": case "upstream_down": case "not_configured": return COPY.common.workerDown;
    default: return COPY.add.quoteError;
  }
}

// ---------------------------------------------------------------- the record (written BEFORE signing)
export function cashOutRecord(p: { quote: QuoteView; account: string; kind: "withdraw" | "convert"; origin: TokenRef; destination: TokenRef; recipient: string | null; now: number }): SwapRecord {
  const q = p.quote;
  if (!q.depositAddress) throw new Error("a real cash-out price has a deposit address");
  if (!q.deadline || !Number.isFinite(Date.parse(q.deadline))) throw new Error("a real cash-out price has a deadline");
  const ref = (t: TokenRef): TokenRef => ({ assetId: t.assetId, symbol: t.symbol, blockchain: t.blockchain, decimals: t.decimals });
  return {
    id: q.depositMemo ? `${q.depositAddress}#${q.depositMemo}` : q.depositAddress, account: p.account, kind: p.kind,
    origin: ref(p.origin), destination: ref(p.destination),
    amountIn: q.amountIn, minAmountIn: q.minAmountIn, amountOut: q.amountOut, minAmountOut: q.minAmountOut,
    depositAddress: q.depositAddress, depositMemo: q.depositMemo, recipient: p.kind === "withdraw" ? p.recipient : null, deadline: q.deadline,
    createdAt: p.now, updatedAt: p.now, state: "waiting", lastStatus: null, received: null, delivered: null, refunded: null,
    refundReason: null, correlationId: q.correlationId || null, signed: false, needReturn: null, checkFailures: 0, createdHere: true,
  };
}
/** The real price must not be below the "At least" the user reviewed; if it is, show the new amounts and ask again. */
export const priceDropped = (reviewed: QuoteView, real: QuoteView): boolean => BigInt(real.amountOut) < BigInt(reviewed.minAmountOut);

// ---------------------------------------------------------------- tracker
export type CashOutCta = "confirm" | "cancel" | "done" | "help";
export interface CashOutView {
  state: TrackState;
  tone: "info" | "good" | "warn" | "bad";
  message: string;
  steps: { label: string; status: "done" | "current" | "todo" }[];
  ctas: CashOutCta[];
  /** Written before signing and not signed (yet). */
  unsigned: boolean;
}
const IN_PROGRESS: ReadonlySet<TrackState> = new Set(["waiting", "confirming", "converting", "short"]);
const stepper = (labels: string[], at: number) => labels.map((label, i) => ({ label, status: (i < at ? "done" : i === at ? "current" : "todo") as "done" | "current" | "todo" }));
/** "20.00 USDC" for a bet token, "1.00 USDC (Ethereum)" for anything else. */
const originText = (r: SwapRecord, units: string) =>
  amt(units, r.origin) + (betSymbolForId(r.origin.assetId, "mainnet") ? "" : ` (${networkName(r.origin.blockchain)})`);
const destRef = (r: SwapRecord): TokenRef => ({ ...r.destination, symbol: displaySymbol(r.destination) });
/** Not signed: only while the record still waits (a status beyond "waiting" means the transfer did happen). */
const isUnsigned = (r: SwapRecord) => r.signed === false && (r.state === "waiting" || r.state === "expired" || r.state === "checking");
/** SECREV1 SR-1: only a record this browser wrote before signing can be confirmed (the Worker cannot prove who asked for a quote). */
const confirmable = (r: SwapRecord, now: number) => r.createdHere === true && needsConfirm(r, now);

export function cashOutTrackerView(r: SwapRecord, now: number): CashOutView {
  if (r.kind === "convert") return convertTrackerView(r, now);
  const labels = [CASH_OUT_COPY.stepConfirmed, CASH_OUT_COPY.stepSending, CASH_OUT_COPY.stepSent];
  const to = r.recipient ? shortAddress(r.recipient) : "";
  const dest = destRef(r);
  const base = { state: r.state, unsigned: false };
  if (isUnsigned(r)) {
    return confirmable(r, now)
      ? { ...base, unsigned: true, tone: "warn", message: COPY.cashOut.unsigned, steps: [], ctas: ["confirm", "cancel"] }
      : { ...base, unsigned: true, tone: "info", message: CASH_OUT_COPY.expiredUnsigned, steps: [], ctas: ["done"] };
  }
  if (IN_PROGRESS.has(r.state)) return { ...base, tone: "info", message: COPY.cashOut.sending(amt(r.amountOut, dest), to), steps: stepper(labels, 1), ctas: [] };
  switch (r.state) {
    case "credited": return { ...base, tone: "good", message: COPY.cashOut.sent(amt(r.delivered ?? r.amountOut, dest), to), steps: stepper(labels, 3), ctas: ["done"] };
    case "refunded": {
      const back = originText(r, r.refunded ?? r.amountIn);
      return { ...base, tone: "warn", message: betSymbolForId(r.origin.assetId, "mainnet") ? COPY.cashOut.refunded(back) : CASH_OUT_COPY.backInAccount(back), steps: [], ctas: ["done"] };
    }
    case "failed": return { ...base, tone: "bad", message: COPY.track.failed, steps: [], ctas: ["help"] };
    case "expired": return { ...base, tone: "info", message: CASH_OUT_COPY.expiredSigned, steps: [], ctas: ["done", "help"] };
    default: return { ...base, tone: "info", message: CASH_OUT_COPY.checking, steps: stepper(labels, 1), ctas: [] };
  }
}

export function convertTrackerView(r: SwapRecord, now: number): CashOutView {
  const labels = [CASH_OUT_COPY.stepConfirmed, CASH_OUT_COPY.stepConverting, CASH_OUT_COPY.stepCredited];
  const dest = destRef(r);
  const base = { state: r.state, unsigned: false };
  if (isUnsigned(r)) {
    return confirmable(r, now)
      ? { ...base, unsigned: true, tone: "warn", message: CASH_OUT_COPY.unsignedConvert, steps: [], ctas: ["confirm", "cancel"] }
      : { ...base, unsigned: true, tone: "info", message: CASH_OUT_COPY.expiredUnsignedConvert, steps: [], ctas: ["done"] };
  }
  if (IN_PROGRESS.has(r.state)) return { ...base, tone: "info", message: CASH_OUT_COPY.converting(originText(r, r.amountIn), dest.symbol), steps: stepper(labels, 1), ctas: [] };
  switch (r.state) {
    case "credited": return { ...base, tone: "good", message: COPY.convert.done(amt(r.delivered ?? r.amountOut, dest)), steps: stepper(labels, 3), ctas: ["done"] };
    case "refunded": {
      const back = originText(r, r.refunded ?? r.amountIn);
      return { ...base, tone: "warn", message: betSymbolForId(r.origin.assetId, "mainnet") ? CASH_OUT_COPY.convertBackBetting(back) : CASH_OUT_COPY.convertBackAccount(back), steps: [], ctas: ["done"] };
    }
    case "failed": return { ...base, tone: "bad", message: COPY.track.failed, steps: [], ctas: ["help"] };
    case "expired": return { ...base, tone: "info", message: CASH_OUT_COPY.expiredSigned, steps: [], ctas: ["done", "help"] };
    default: return { ...base, tone: "info", message: CASH_OUT_COPY.checking, steps: stepper(labels, 1), ctas: [] };
  }
}

// ---------------------------------------------------------------- in-flight list
const DISMISSED_KEY = (account: string) => `praetorial:funding:v1:dismissed:${account}`;
interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }
const store = (): StorageLike | null => (typeof localStorage !== "undefined" ? localStorage : null);
export function dismissedIds(account: string, s: StorageLike | null = store()): string[] {
  try { const v = JSON.parse(s?.getItem(DISMISSED_KEY(account)) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; }
}
/** [Cancel] on an unsigned cash out: it stops showing as "in progress" (it was never sent; its price simply runs out). */
export function dismiss(account: string, id: string, s: StorageLike | null = store()): void {
  try { s?.setItem(DISMISSED_KEY(account), JSON.stringify([id, ...dismissedIds(account, s).filter((x) => x !== id)].slice(0, 50))); } catch { /* private mode */ }
}
/** An unsigned cash out / convert the user cancelled, or whose price ran out, is not "in progress": nothing was sent. */
export function visibleInFlight(r: SwapRecord, now: number, dismissed: readonly string[]): boolean {
  if (r.kind === "fund" || !isUnsigned(r)) return true;
  return !dismissed.includes(r.id) && confirmable(r, now);
}

// ---------------------------------------------------------------- convert
/** Convert lands only in the 6 (minus the token itself). Default: the same token (USDC on Ethereum -> USDC), else USDC. */
export const convertChoices = (h: CashOutHolding): { choices: BetSymbol[]; default: BetSymbol } =>
  convertTargets({ assetId: h.assetId, symbol: h.symbol }, "mainnet");

export interface ConvertView { title: string; youGet: string | null }
export function convertView(h: CashOutHolding, q: QuoteView | null, to: BetSymbol): ConvertView {
  const title = h.kind === "stray" ? COPY.convert.title(amt(h.units, h.token), networkName(h.token.blockchain)) : CASH_OUT_COPY.convertTitleBet(h.amountText);
  return { title, youGet: q ? COPY.convert.youGet(amt(q.amountOut, betRef(to)), etaText(q.timeEstimateSec)) : null };
}
