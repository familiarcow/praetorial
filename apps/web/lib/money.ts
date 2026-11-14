// K0 (UIR1 §2.1, familiarcow UX-37 #7): THE amount rule. Every amount a person reads goes through formatMoney (rendered by src/kit/Amount).
//  - stablecoins (USDC, USDT): always 2 decimals, rounded half-up;
//  - every other token: at most 6 significant digits, trailing zeros trimmed, integer digits never dropped;
//  - a non-zero amount that would read as 0.00 (stables), or a fee/storage line (`minor`) under 0.01: "< 0.01 NEAR";
//  - the exact value (all decimals) is always kept in `exact` for the tooltip / Details;
//  - token units only, never "$" (NAV1 / UX-31: "USDC isnt dollars"). Pure BigInt, never a float.
import { findAsset, symbolForAssetId } from "./assets";
import { fromBaseUnits } from "./decimal";

export interface Money { units: bigint; symbol: string }
export interface MoneyText { text: string; exact: string; tiny: boolean; symbol: string }

const STABLES = new Set(["USDC", "USDT"]);
const SIG = 6;
export const isStable = (symbol: string): boolean => STABLES.has(symbol);

const toBig = (v: bigint | string | number): bigint => { try { return BigInt(typeof v === "number" ? Math.trunc(v) : v); } catch { return 0n; } };

/** Base units + a symbol ("USDC") or a nep141 asset id ("nep141:btc.omft.near"). */
export function money(units: bigint | string | number, assetOrSymbol: string): Money {
  const symbol = findAsset(assetOrSymbol) ? assetOrSymbol : symbolForAssetId(assetOrSymbol);
  return { units: toBig(units), symbol };
}

/** Same-symbol amounts added together, first-seen order (a pot of USDC + BTC stays two amounts). */
export function sumMoney(parts: Money[]): Money[] {
  const by = new Map<string, bigint>();
  for (const p of parts) by.set(p.symbol, (by.get(p.symbol) ?? 0n) + p.units);
  return [...by].map(([symbol, units]) => ({ symbol, units }));
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);
const commas = (whole: string): string => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** units / 10^dec rounded half-up to `keep` decimals, as a decimal string with exactly `keep` decimals. */
function roundTo(units: bigint, dec: number, keep: number): string {
  let q: bigint;
  if (keep >= dec) q = units * pow10(keep - dec);
  else { const d = pow10(dec - keep); q = (units + d / 2n) / d; }
  const s = q.toString().padStart(keep + 1, "0");
  return keep === 0 ? s : `${s.slice(0, -keep)}.${s.slice(-keep)}`;
}

function shortSymbol(symbol: string): string {
  return symbol.length > 14 ? `${symbol.slice(0, 6)}…${symbol.slice(-4)}` : symbol;
}

export function formatMoney(m: Money, opts: { minor?: boolean } = {}): MoneyText {
  const a = findAsset(m.symbol);
  const sym = shortSymbol(m.symbol);
  if (!a) { const t = `${m.units} ${sym}`; return { text: t, exact: `${m.units} ${m.symbol}`, tiny: false, symbol: m.symbol }; }
  const dec = a.decimals;
  const neg = m.units < 0n;
  const u = neg ? -m.units : m.units;
  const exactNum = fromBaseUnits(u.toString(), dec);
  const exact = `${neg ? "-" : ""}${exactNum} ${m.symbol}`;
  const cent = dec >= 2 ? pow10(dec - 2) : 1n; // 0.01 in base units
  const out = (n: string, tiny = false): MoneyText => {
    const [w, f] = n.split(".");
    return { text: `${neg ? "-" : ""}${commas(w!)}${f ? `.${f}` : ""} ${sym}`, exact, tiny, symbol: m.symbol };
  };
  if (u > 0n && u < cent && (isStable(m.symbol) || opts.minor)) return { text: `< 0.01 ${sym}`, exact, tiny: true, symbol: m.symbol };
  if (isStable(m.symbol)) return out(roundTo(u, dec, 2));
  if (u === 0n) return out("0");
  const whole = u / pow10(dec);
  let keep: number;
  if (whole > 0n) keep = Math.max(0, SIG - whole.toString().length);
  else {
    const frac = u.toString().padStart(dec, "0"); // the dec fraction digits
    const firstNonZero = frac.search(/[1-9]/); // 0-based
    keep = firstNonZero + SIG;
  }
  let n = roundTo(u, dec, Math.min(keep, dec));
  if (n.includes(".")) n = n.replace(/0+$/, "").replace(/\.$/, "");
  return out(n);
}

export const moneyText = (m: Money, opts: { minor?: boolean } = {}): string => formatMoney(m, opts).text;
/** Several amounts in one line: "3.50 USDC + 0.000396 BTC". */
export const moneyListText = (ms: Money[], opts: { minor?: boolean } = {}): string => ms.map((m) => moneyText(m, opts)).join(" + ");
