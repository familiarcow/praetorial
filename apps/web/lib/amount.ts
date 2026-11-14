// MODAL1b: the one place money text is produced (no React, no cycle with stakeDeadlines).
import { findAsset } from "./assets";
import { fromBaseUnits } from "./decimal";

const DOLLAR_ASSETS = new Set(["USDC", "USDT"]);

export interface AmountOpts { /** pad dollar coins to two places ("1.00 USDC") */ cents?: boolean; /** number only, no symbol */ plain?: boolean }

/** Base units -> text at the asset's own decimals: "10 USDC" / "0.50 USDC" (cents), "10 NEAR". Never goes through a float.
 * NAV1 (UX-31, familiarcow: "USDC isnt dollars"): every amount is in token units with its symbol; USDC/USDT are never written with "$". */
export function formatAmount(symbol: string, units: bigint | string, opts: AmountOpts = {}): string {
  const a = findAsset(symbol);
  if (!a) throw new Error(`unknown asset ${symbol}`);
  const raw = typeof units === "bigint" ? units.toString() : units;
  let n = fromBaseUnits(raw, a.decimals);
  const dollars = DOLLAR_ASSETS.has(symbol);
  if (dollars && opts.cents) { const [w, f = ""] = n.split("."); n = `${w}.${f.padEnd(2, "0")}`; }
  if (opts.plain) return n;
  return `${n} ${symbol}`;
}

