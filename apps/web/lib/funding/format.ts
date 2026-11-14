// F2: amount display for funding screens (familiarcow UX-37 "UIR1 7 amounts: A") and the grey "≈ $X" total ("FUND 11: A").
//
// Amount rule: stablecoins 2 dp; others trimmed to at most 6 significant digits (integer digits are never dropped); NEAR below
// 0.01 (storage, fees) shows "< 0.01 NEAR"; the exact value is `exactAmount` (for Details). Shown-as-received rounds DOWN,
// shown-as-needed rounds UP (FUND3 §4.3), so we never promise more than arrives or ask for less than is needed.
// Works for ANY token (origin tokens, stray tokens), not only the 6, so it takes decimals instead of looking up lib/assets.ts.
// Pure bigint math: no float ever touches an amount. Prices are floats from 1Click, used only for the ≈ $ line.
import { fromBaseUnits } from "../decimal";

const STABLE = new Set(["USDC", "USDT", "USDT0", "USDCX", "DAI", "USDS", "PYUSD", "FDUSD", "USDE"]);
export const isStable = (symbol: string): boolean => STABLE.has(symbol.toUpperCase());
/** Symbols whose sub-0.01 amounts read as "< 0.01" (stables, and NEAR for storage/fees). */
const TINY = (symbol: string) => isStable(symbol) || symbol.toUpperCase() === "NEAR" || symbol.toUpperCase() === "WNEAR";

export type Rounding = "down" | "up";
const toBig = (units: string | bigint): bigint => (typeof units === "bigint" ? units : BigInt(units));
const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** Round `units` (at `decimals`) to `keep` fraction digits; returns base units at `keep` decimals. */
function roundTo(units: bigint, decimals: number, keep: number, mode: Rounding): bigint {
  if (keep >= decimals) return units * pow10(keep - decimals);
  const div = pow10(decimals - keep);
  const q = units / div;
  return mode === "up" && units % div !== 0n ? q + 1n : q;
}

/** Decimal string with exactly/at most `keep` fraction digits. */
function render(scaled: bigint, keep: number, pad: boolean): string {
  let s = fromBaseUnits(scaled.toString(), keep);
  if (pad && keep > 0) {
    const [w, f = ""] = s.split(".");
    s = `${w}.${f.padEnd(keep, "0")}`;
  }
  return s;
}

/** How many fraction digits keep at most 6 significant digits (all integer digits kept, at least the first non-zero). */
function fractionDigitsFor(units: bigint, decimals: number): number {
  const whole = units / pow10(decimals);
  if (whole > 0n) return Math.max(0, 6 - whole.toString().length);
  // < 1: count leading zeros of the fraction, then 6 significant digits.
  const frac = (units % pow10(decimals)).toString().padStart(decimals, "0");
  const lead = frac.search(/[1-9]/);
  return Math.min(decimals, (lead < 0 ? 0 : lead) + 6);
}

/** "12.55 USDC", "0.000985 BTC", "< 0.01 NEAR", "1234567 NEAR" (token amounts are never digit-grouped; only the ≈ $ total is). */
export function displayAmount(units: string | bigint, decimals: number, symbol: string, opts: { round?: Rounding; plain?: boolean } = {}): string {
  const mode = opts.round ?? "down";
  const u = toBig(units);
  const neg = u < 0n;
  const abs = neg ? -u : u;
  const tag = (n: string) => (opts.plain ? n : `${n} ${symbol}`);
  if (abs > 0n && TINY(symbol) && abs < pow10(decimals) / 100n) return opts.plain ? "< 0.01" : `< 0.01 ${symbol}`;
  let text: string;
  if (isStable(symbol)) text = render(roundTo(abs, decimals, 2, mode), 2, true);
  else {
    const keep = fractionDigitsFor(abs, decimals);
    text = render(roundTo(abs, decimals, keep, mode), keep, false);
  }
  return tag(neg && text !== "0" ? `-${text}` : text);
}

/** The exact amount for Details: every digit, trailing zeros trimmed. */
export const exactAmount = (units: string | bigint, decimals: number, symbol: string): string => `${fromBaseUnits(toBig(units).toString(), decimals)} ${symbol}`;

// ---- ≈ $ total ----

export interface PricedHolding { units: bigint; decimals: number; priceUsd: number | null }

/** USD cents (rounded down) for one holding, or null when it has no usable price. Zero units never need a price. */
export function holdingUsdCents(h: PricedHolding): bigint | null {
  if (h.units === 0n) return 0n;
  if (h.priceUsd == null || !Number.isFinite(h.priceUsd) || h.priceUsd < 0) return null;
  // price -> integer micro-micro-dollars (1e-8 $), then units * price / 10^decimals in cents.
  const priceE8 = BigInt(Math.round(h.priceUsd * 1e8));
  return (h.units * priceE8) / pow10(h.decimals + 6);
}

/** "143.20" (no "$", thousands grouped) or null when ANY non-zero holding has no price (familiarcow: hidden if any price is missing). */
export function approxUsdTotal(holdings: PricedHolding[]): string | null {
  let cents = 0n;
  for (const h of holdings) {
    const c = holdingUsdCents(h);
    if (c === null) return null;
    cents += c;
  }
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** "T9yD…uWwb": first 4 and last 4 of an address (cash-out confirmations only; usernames are the identity elsewhere). */
export const shortAddress = (a: string): string => (a.length <= 12 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`);

/** "about 2 min" style ETA from seconds ("10 s", "2 min", "1 h 5 min"). */
export function etaText(sec: number): string {
  const s = Math.max(1, Math.round(sec));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}
