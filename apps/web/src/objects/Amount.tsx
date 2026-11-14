import React from "react";
import { formatAmount, type AmountOpts } from "../../lib/uiObjects";

/** Money text from base units at the asset's own decimals (BigInt, never a float). */
export function Amount({ symbol, units, cents, plain, ...rest }: { symbol: string; units: bigint | string; [k: `data-${string}`]: unknown } & AmountOpts) {
  return <span {...(rest as object)} data-asset={symbol}>{formatAmount(symbol, units, { cents, plain })}</span>;
}
