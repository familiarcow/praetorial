// FE5 (S5): stake limits, live fee, settlement window, resolve deadline, named taker. Pure helpers; every number is read from the
// contract's asset_limit / protocol_fee_bps views (D-PARAMS1: they can change with 24h notice), with the release-args table only
// as the fallback while a view is loading. The fee formula is the contract's side_fee (incl. the minimum-fee floor, D-FEEMIN1/2).
import { findAsset, LAUNCH_MAX_PER_SIDE } from "./assets";
import { FEE_BPS } from "./escrowAdapter";
import { isUsableAccount } from "./referee";

export interface SettlementOption { id: string; secs: number }
/** D-UX21/S5: a window of 1 hour to 24 hours (the 7-day choice is dropped). */
export const SETTLEMENT_OPTIONS: SettlementOption[] = [{ id: "1h", secs: 3600 }, { id: "6h", secs: 6 * 3600 }, { id: "24h", secs: 86400 }];
export { OFFER_EXPIRY_OPTIONS } from "./offerExpiry";

const DAY = 86400;
export const MAX_RESOLVE_SECS = 1461 * DAY; // D-HORIZON1a
export const HUMAN_DEFAULT_SECS = 365 * DAY; // D-REFUI3b / UX-11

export interface AssetLimitView { min_per_side?: string; max_per_side?: string; min_fee_per_side?: string; storage_per_kib?: string }
export interface StakeLimits { symbol: string; decimals: number; minPerSide: bigint; maxPerSide: bigint; minFeePerSide: bigint; feeBps: number }

export function limitsFor(symbol: string, view: AssetLimitView | null | undefined, feeBps: number | null | undefined): StakeLimits {
  const a = findAsset(symbol);
  if (!a) throw new Error(`unknown asset ${symbol}`);
  const pick = (live: string | undefined, table: string | undefined, dflt: string) => BigInt(live ?? table ?? dflt);
  return {
    symbol,
    decimals: a.decimals,
    minPerSide: pick(view?.min_per_side, a.minStakePerSide, "0"),
    maxPerSide: pick(view?.max_per_side, a.maxStakePerSide, LAUNCH_MAX_PER_SIDE),
    minFeePerSide: pick(view?.min_fee_per_side, a.minFeePerSide, "0"),
    feeBps: feeBps ?? FEE_BPS,
  };
}

/** Mirrors contracts/escrow side_fee: min(stake, max(stake*bps/10000, min_fee_per_side)). */
export function sideFee(stake: bigint, feeBps: number, minFeePerSide: bigint): bigint {
  const pct = (stake * BigInt(feeBps)) / 10_000n;
  const fee = pct > minFeePerSide ? pct : minFeePerSide;
  return fee < stake ? fee : stake;
}

export function formatUnits(units: bigint, decimals: number): string {
  if (decimals === 0) return units.toString();
  const s = units.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

const DOLLAR_ASSETS = new Set(["USDC", "USDT"]);
/** Token units, never "$" (UX-31/UX-33: USDC is not dollars): "10 USDC", "10 NEAR". `cents` pads dollar coins to two places ("1.00 USDC"). */
function money(symbol: string, units: bigint, decimals: number, cents = false): string {
  let t = formatUnits(units, decimals);
  if (DOLLAR_ASSETS.has(symbol) && cents) { const [w, f = ""] = t.split("."); t = `${w}.${f.padEnd(2, "0")}`; }
  return `${t} ${symbol}`;
}
export const moneyText = (l: StakeLimits, units: bigint, cents = false) => money(l.symbol, units, l.decimals, cents);

export function feeInfo(symbol: string, stakeUnits: bigint, l: StakeLimits): { units: bigint; each: string; exact: string; line: string } {
  const units = sideFee(stakeUnits, l.feeBps, l.minFeePerSide);
  // The stake from which the percentage overtakes the minimum: min * 10000 / bps (rounded up).
  const from = l.feeBps > 0 ? (l.minFeePerSide * 10_000n + BigInt(l.feeBps) - 1n) / BigInt(l.feeBps) : 0n;
  const pct = `${l.feeBps % 100 === 0 ? l.feeBps / 100 : l.feeBps / 100}%`;
  return {
    units,
    each: money(symbol, units, l.decimals, true),
    exact: formatUnits(units, l.decimals),
    line: `Fee: ${money(symbol, units, l.decimals, true)} each (${money(symbol, l.minFeePerSide, l.decimals, true)} minimum per person, ${pct} from ${money(symbol, from, l.decimals)}).`,
  };
}

function parseStake(symbol: string, text: string, l: StakeLimits): { units: bigint } | { error: string } {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return { error: "Enter your stake." };
  const frac = t.split(".")[1] ?? "";
  // FE5b: the asset's own decimals (6 for USDC/USDT); amounts are DISPLAYED to cents (money(.., cents)). No UX ruling asks for 2.
  const places = l.decimals;
  if (frac.length > places) return { error: `Use at most ${places} decimal places.` };
  const [w, f = ""] = t.split(".");
  return { units: BigInt(w) * 10n ** BigInt(l.decimals) + BigInt(f.padEnd(l.decimals, "0") || "0") };
}

/** One bettor's stake against the live limits; null when fine. */
export function stakeProblem(symbol: string, text: string, l: StakeLimits): string | null {
  const p = parseStake(symbol, text, l);
  if ("error" in p) return p.error;
  if (p.units < l.minPerSide || p.units === 0n) return `Minimum stake is ${moneyText(l, l.minPerSide)}`;
  if (l.maxPerSide < BigInt(LAUNCH_MAX_PER_SIDE) && p.units > l.maxPerSide) return `Maximum stake is ${moneyText(l, l.maxPerSide)}`;
  const fee = sideFee(p.units, l.feeBps, l.minFeePerSide);
  if (fee >= p.units) return `The stake has to be more than the fee (${money(symbol, fee, l.decimals, true)}).`;
  return null;
}

/** Event time -> the person's default deadline: event + 1 year, held to 4 years from now (UX-11 / D-HORIZON1a). */
export function defaultResolveSecs(eventSecs: number, nowSecs?: number): number {
  const d = eventSecs + HUMAN_DEFAULT_SECS;
  return nowSecs === undefined ? d : Math.min(d, nowSecs + MAX_RESOLVE_SECS);
}
export function resolveProblem(a: { resolveSecs: number; eventSecs: number; nowSecs: number }): string | null {
  if (a.resolveSecs <= a.eventSecs) return "The deadline has to be after the event.";
  if (a.resolveSecs - a.nowSecs > MAX_RESOLVE_SECS) return "That date is more than 4 years away.";
  return null;
}
export function expiryProblem(a: { expirySecs: number; resolveSecs: number }): string | null {
  return a.expirySecs >= a.resolveSecs ? "The offer has to expire before the resolve deadline." : null;
}
export function takerProblem(taker: string, ctx: { maker: string | null; referee: string | null }): string | null {
  const t = taker.trim();
  if (!t) return null;
  if (ctx.maker && t === ctx.maker) return "You can't name yourself.";
  if (!isUsableAccount(t)) return "That doesn't look like a valid account.";
  if (ctx.referee && t === ctx.referee) return "The person who takes the bet can't also be the referee.";
  return null;
}
