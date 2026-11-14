// F4 (FUND4 SPEC §4, familiarcow UX-37 / D-FUND4a, SM2 STATES.md M6): the Add money sheet's view model. Pure (no React, no window), so
// every word the sheet, the address step, the live tracker (full, compact and toast) shows is unit-tested here
// (tests/funding/fundSheet.unit.test.ts). The components in src/components/funding/* only render what this returns.
//   - ALWAYS a one-time deposit address (no permanent bridge address), landing as one of the 6 bet tokens (lib/funding/landing).
//   - The state comes from lib/funding/tracker.advance ONLY (SM2 gap F4-2); this file turns a state into words, never decides it.
//   - Amounts: lib/funding/format.displayAmount (received/you get round DOWN, needed/minimums round UP). Strings: lib/funding/copy.
import type { QuoteView, SwapRecord, TokenRef, TrackState, BetSymbol, BalanceMap } from "./funding/types";
import { COPY } from "./funding/copy";
import { displayAmount, etaText } from "./funding/format";
import { NETWORKS } from "./funding/tokens";
import { betSymbolForId, betSymbolOf } from "./funding/landing";
import { msLeft, SOON_MS, refundLands, refundReasonKind } from "./funding/tracker";
import { FundingError } from "./funding/fundingClient";
import { findAsset, toBaseUnits as assetUnits } from "./assets";
import { toBaseUnits } from "./decimal";
import type { Need } from "./intentsBalance";

// ---------------------------------------------------------------- tokens as people read them
export const networkName = (blockchain: string): string => NETWORKS[blockchain]?.[0] ?? blockchain;
export const exchangeNetworkName = (blockchain: string): string | null => NETWORKS[blockchain]?.[1] ?? null;
/** wrap.near is "NEAR" to people (1Click lists it as wNEAR). Every other token keeps 1Click's symbol. */
export const displaySymbol = (t: Pick<TokenRef, "assetId" | "symbol">): string => (betSymbolForId(t.assetId, "mainnet") === "NEAR" ? "NEAR" : t.symbol);
const amt = (units: string | bigint, t: TokenRef, round: "down" | "up" = "down") => displayAmount(units, t.decimals, displaySymbol(t), { round });

// ---------------------------------------------------------------- amount input
export type AmountInput = { ok: true; units: string } | { ok: false; reason: "empty" | "invalid" | "zero" | "too-precise" };
/** What the user typed -> origin base units ("1,5" is read as 1.5). Never rounds: more decimals than the token has is refused. */
export function parseAmountInput(text: string, decimals: number): AmountInput {
  const s = text.trim().replace(",", ".");
  if (!s) return { ok: false, reason: "empty" };
  if (!/^\d*\.?\d*$/.test(s) || s === ".") return { ok: false, reason: "invalid" };
  const frac = s.split(".")[1] ?? "";
  if (frac.length > decimals) return { ok: false, reason: "too-precise" };
  const units = toBaseUnits(s, decimals);
  return BigInt(units) > 0n ? { ok: true, units } : { ok: false, reason: "zero" };
}

/** The shortfall to cover: the hand-off's FULL pay-now (?need) minus the live betting balance; null when covered. An unread
 * balance asks for the full amount (the user can lower it). */
export function needOutUnits(need: Need, balanceUnits: string | null): string | null {
  const full = BigInt(assetUnits(need.symbol, need.amount));
  const short = full - (balanceUnits === null ? 0n : BigInt(balanceUnits));
  return short > 0n ? short.toString() : null;
}

// ---------------------------------------------------------------- the record
/** Built from the REAL quote, and saved BEFORE the address is shown (SPEC §7.4). */
export function recordFromQuote(p: { quote: QuoteView; account: string; origin: TokenRef; destination: TokenRef; now: number; needReturn: string | null }): SwapRecord {
  const q = p.quote;
  if (!q.depositAddress) throw new Error("a real quote has a deposit address");
  if (!q.deadline || !Number.isFinite(Date.parse(q.deadline))) throw new Error("a real quote has a deadline");
  const ref = (t: TokenRef): TokenRef => ({ assetId: t.assetId, symbol: t.symbol, blockchain: t.blockchain, decimals: t.decimals });
  return {
    id: q.depositMemo ? `${q.depositAddress}#${q.depositMemo}` : q.depositAddress, account: p.account, kind: "fund",
    origin: ref(p.origin), destination: ref(p.destination),
    amountIn: q.amountIn, minAmountIn: q.minAmountIn, amountOut: q.amountOut, minAmountOut: q.minAmountOut,
    depositAddress: q.depositAddress, depositMemo: q.depositMemo, recipient: null, deadline: q.deadline,
    createdAt: p.now, updatedAt: p.now, state: "waiting", lastStatus: null, received: null, delivered: null, refunded: null,
    refundReason: null, correlationId: q.correlationId || null, signed: null, needReturn: p.needReturn, checkFailures: 0,
  };
}

// ---------------------------------------------------------------- time
/** "59:01", "0:05", "1:01:01". */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}
export interface TimeOpts { timeZone?: string; locale?: string }
/** "14:32" in the reader's zone (tests pin UTC). */
const clock = (atMs: number, o: TimeOpts = {}) =>
  new Intl.DateTimeFormat(o.locale ?? "en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: o.timeZone }).format(new Date(atMs));

// ---------------------------------------------------------------- step 4: the address
export interface AddressView {
  /** false = the deadline passed: no address, no memo, no QR (SPEC §4.5: never show an address that can't receive). */
  usable: boolean;
  title: string;
  networkBadge: string;
  address: string | null;
  memo: string | null;
  memoWarning: string | null;
  band: string;
  deadline: string | null;
  soon: boolean;
  expired: string | null;
  onlyThis: string;
  exchange: string | null;
}

export function addressView(r: SwapRecord, now: number, o: TimeOpts = {}): AddressView {
  const sym = displaySymbol(r.origin), net = networkName(r.origin.blockchain);
  const left = msLeft(r, now);
  const usable = left === null || left > 0;
  const ex = exchangeNetworkName(r.origin.blockchain);
  return {
    usable,
    title: COPY.add.addressTitle(sym, net),
    networkBadge: COPY.add.networkBadge(net),
    address: usable ? r.depositAddress : null,
    memo: usable ? r.depositMemo : null,
    memoWarning: usable && r.depositMemo ? COPY.add.memo : null,
    band: COPY.add.band(amt(r.minAmountIn, r.origin, "up"), amt(r.amountIn, r.origin, "up")),
    deadline: usable && left !== null && r.deadline ? COPY.add.deadline(clock(Date.parse(r.deadline), o), countdown(left)) : null,
    soon: usable && left !== null && left < SOON_MS,
    expired: usable ? null : COPY.add.expired,
    onlyThis: COPY.add.onlyThis(sym, net),
    exchange: ex ? COPY.add.exchange(ex) : null,
  };
}

// ---------------------------------------------------------------- step 5: the tracker
export const STEP_LABELS = [COPY.track.stepSent, COPY.track.stepConfirming, COPY.track.stepConverting, COPY.track.stepCredited] as const;
export type StepStatus = "done" | "current" | "todo";
export type Tone = "info" | "good" | "warn" | "bad";
export type TrackerCta = "back" | "bet" | "new-address" | "help";
export interface TrackerView {
  state: TrackState;
  tone: Tone;
  message: string;
  /** Refunds: why (one plain sentence). */
  reason: string | null;
  /** The 4-step stepper; empty when the deposit ended without being credited. */
  steps: { label: string; status: StepStatus }[];
  /** The address (and QR) stays visible while it can still take the deposit or a top-up. */
  showAddress: boolean;
  ctas: TrackerCta[];
}

/** Chains whose confirmations take long enough to say so (SPEC §4.6 "Bitcoin confirmations take 10–60 min"). */
const SLOW_CONFIRM: Record<string, string> = { btc: "10–60 min", zec: "10–30 min", bch: "10–60 min", ltc: "5–30 min", doge: "5–30 min" };
/** How far along the 4 steps the last 1Click status is (0 = sent is next). */
const STEP_OF: Record<string, number> = { PENDING_DEPOSIT: 0, KNOWN_DEPOSIT_TX: 1, INCOMPLETE_DEPOSIT: 1, PROCESSING: 2, SUCCESS: 4 };
const STEP_OF_STATE: Partial<Record<TrackState, number>> = { waiting: 0, confirming: 1, short: 1, converting: 2, credited: 4 };

function stepper(at: number): TrackerView["steps"] {
  return STEP_LABELS.map((label, i) => ({ label, status: i < at ? "done" : i === at ? "current" : "todo" }));
}

/** The landing token as a TokenRef the user reads (wNEAR -> NEAR). */
const landing = (r: SwapRecord): TokenRef => ({ ...r.destination, symbol: (betSymbolForId(r.destination.assetId, "mainnet") as BetSymbol | null) ?? r.destination.symbol });
/** Same token on another network (USDT on Ethereum -> USDT): it is moved, not converted. */
const sameToken = (r: SwapRecord) => betSymbolOf({ symbol: displaySymbol(r.origin) }) === landing(r).symbol;

export function trackerView(r: SwapRecord, now: number, o: TimeOpts = {}): TrackerView {
  const sym = displaySymbol(r.origin), net = networkName(r.origin.blockchain), dest = landing(r);
  const left = msLeft(r, now);
  const addressLive = left === null || left > 0;
  const base = { state: r.state, reason: null as string | null };
  switch (r.state) {
    case "waiting":
      if (!addressLive) return { ...base, tone: "warn", message: COPY.add.expired, steps: stepper(0), showAddress: false, ctas: ["new-address", "help"] };
      return { ...base, tone: "info", message: COPY.track.waiting(sym, net, countdown(left ?? 0)), steps: stepper(0), showAddress: true, ctas: [] };
    case "confirming": {
      const slow = SLOW_CONFIRM[r.origin.blockchain];
      const message = slow ? `We see your deposit. ${COPY.track.confirmingSlow(net, slow)}` : COPY.track.confirming(net, "1 min");
      return { ...base, tone: "info", message, steps: stepper(1), showAddress: false, ctas: [] };
    }
    case "converting":
      return {
        ...base, tone: "info", steps: stepper(2), showAddress: false, ctas: [],
        message: sameToken(r) ? COPY.track.moving : COPY.track.converting(amt(r.received ?? r.amountIn, r.origin), net, dest.symbol),
      };
    case "short": {
      const got = BigInt(r.received ?? "0");
      const more = BigInt(r.minAmountIn) - got;
      const time = r.deadline ? clock(Date.parse(r.deadline), o) : "";
      return {
        ...base, tone: "warn", steps: stepper(1), showAddress: addressLive, ctas: addressLive ? [] : ["help"],
        message: COPY.track.short(amt(got, r.origin), amt(r.minAmountIn, r.origin, "up"), amt(more > 0n ? more : 0n, r.origin, "up"), time),
      };
    }
    case "credited":
      return { ...base, tone: "good", message: COPY.track.credited(amt(r.delivered ?? r.amountOut, dest)), steps: stepper(4), showAddress: false, ctas: [r.needReturn ? "back" : "bet"] };
    case "refunded": {
      const back = amt(r.refunded ?? r.received ?? "0", r.origin);
      const k = refundReasonKind(r.refundReason);
      return {
        ...base, tone: "warn", steps: [], showAddress: false, ctas: [],
        message: refundLands(r) === "betting" ? COPY.track.refundedBetting(back) : COPY.track.refundedStray(back, net),
        reason: k === "partial" ? COPY.track.reasonPartial : k === "price" ? COPY.track.reasonPrice : COPY.track.reasonUnknown,
      };
    }
    case "failed":
      return { ...base, tone: "bad", message: COPY.track.failed, steps: [], showAddress: false, ctas: ["help"] };
    case "expired":
      return { ...base, tone: "warn", message: COPY.track.expired, steps: [], showAddress: false, ctas: ["new-address", "help"] };
    case "checking":
      return { ...base, tone: "info", message: COPY.track.checking, steps: stepper(STEP_OF[r.lastStatus ?? "PENDING_DEPOSIT"] ?? 0), showAddress: false, ctas: [] };
  }
}

const STATE_WORD: Record<TrackState, string> = {
  waiting: "Waiting for your deposit", confirming: "Confirming", converting: "Converting", short: "Needs a top-up", credited: "In your balance",
  refunded: "Returned", failed: "Needs help", expired: "Address expired", checking: "Checking",
};

/** One line for the header strip and lists: "Adding 20.00 USDT (Tron) → USDC · Converting". */
export const compactLine = (r: SwapRecord): string =>
  `Adding ${amt(r.amountIn, r.origin)} (${networkName(r.origin.blockchain)}) → ${landing(r).symbol} · ${STATE_WORD[r.state]}`;

/** The step a state sits on (for the compact progress bar). 0..4. */
export const progressOf = (r: SwapRecord): number => STEP_OF_STATE[r.state] ?? STEP_OF[r.lastStatus ?? "PENDING_DEPOSIT"] ?? 0;

/** "Get help" copies these, so support can trace the deposit. */
export const helpText = (r: SwapRecord, now: number): string =>
  COPY.track.helpText({ depositAddress: r.depositAddress, memo: r.depositMemo, correlationId: r.correlationId, time: new Date(now).toISOString() });

// ---------------------------------------------------------------- toast on a live change
const TOAST_STATES: ReadonlySet<TrackState> = new Set(["confirming", "converting", "short", "credited", "refunded", "failed", "expired"]);
/** A toast only when a polled Add money record moves to a new, newsworthy state (never on first load, never "checking"). */
export function toastFor(prev: SwapRecord | undefined, next: SwapRecord, now = Date.now()): { text: string; tone: Tone } | null {
  if (!prev || next.kind !== "fund" || prev.state === next.state || !TOAST_STATES.has(next.state)) return null;
  if (next.state === "confirming") return { text: `We see your ${displaySymbol(next.origin)} deposit (${networkName(next.origin.blockchain)}).`, tone: "info" };
  const v = trackerView(next, now);
  return { text: v.message, tone: v.tone };
}

// ---------------------------------------------------------------- step 3: amount + estimate
export interface QuoteLines { youGet: string; eta: string; fee: string | null; belowBet: string | null }
export function quoteLines(q: QuoteView, _origin: TokenRef, destination: TokenRef): QuoteLines {
  const dest = { ...destination, symbol: displaySymbol(destination) };
  const inUsd = q.amountInUsd === null ? NaN : Number(q.amountInUsd), outUsd = q.amountOutUsd === null ? NaN : Number(q.amountOutUsd);
  let fee: string | null = null;
  if (Number.isFinite(inUsd) && Number.isFinite(outUsd) && outUsd > 0) {
    // ≈ only: the cost in the landing token = amountOut x (in$/out$ - 1). Display figure, never an amount we send.
    const units = BigInt(Math.max(0, Math.ceil(Number(q.amountOut) * (inUsd / outUsd - 1))));
    fee = COPY.add.fee(displayAmount(units, dest.decimals, dest.symbol, { round: "up" }));
  }
  const minStake = findAsset(dest.symbol)?.minStakePerSide;
  const belowBet = minStake && BigInt(q.amountOut) < BigInt(minStake) ? COPY.add.belowBet(displayAmount(minStake, dest.decimals, dest.symbol, { round: "up" })) : null;
  return {
    youGet: COPY.add.youGet(displayAmount(q.amountOut, dest.decimals, dest.symbol, { round: "down" })),
    eta: COPY.add.eta(etaText(q.timeEstimateSec)),
    fee, belowBet,
  };
}

/** A Worker error as one plain sentence (never "failed" for our own outage: "unavailable", balances are safe). */
export function fundErrorText(e: unknown, origin: TokenRef): string {
  if (!(e instanceof FundingError)) return COPY.add.quoteError;
  switch (e.code) {
    case "too_low": return e.minUnits ? COPY.add.tooLow(amt(e.minUnits, origin, "up")) : COPY.add.quoteError;
    case "no_route": return COPY.add.noRoute(displaySymbol(origin), networkName(origin.blockchain));
    case "rate_limited": return COPY.common.rateLimited;
    case "network": case "upstream_down": case "not_configured": return COPY.common.workerDown;
    default: return COPY.add.quoteError;
  }
}

// ---------------------------------------------------------------- "Recent" picks (step 1)
const RECENT_KEY = "praetorial:funding:v1:recent";
interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }
const store = (): StorageLike | null => (typeof localStorage !== "undefined" ? localStorage : null);
export function recentPicks(s: StorageLike | null = store()): string[] {
  try { const v = JSON.parse(s?.getItem(RECENT_KEY) ?? "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 2) : []; } catch { return []; }
}
export function rememberPick(assetId: string, s: StorageLike | null = store()): void {
  try { s?.setItem(RECENT_KEY, JSON.stringify([assetId, ...recentPicks(s).filter((x) => x !== assetId)].slice(0, 2))); } catch { /* private mode */ }
}

// ---------------------------------------------------------------- first login (SM2 gap F4-3)
/** Nothing to bet with: the betting section of F3's balance map read fine and every bet token is 0. An unread section is NOT
 * empty (never send someone to Add money because a read failed). */
export const nothingToBetWith = (map: Pick<BalanceMap, "betting">): boolean =>
  map.betting !== "error" && Object.values(map.betting).every((v) => (v ?? 0n) === 0n);
