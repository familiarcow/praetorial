// bigint/decimal-string helpers for nep141 base-unit amounts. v0.2's
// quoteExactAmount computed base units as `Math.round(units * 10 **
// decimals)`, which silently loses precision past Number.MAX_SAFE_INTEGER
// (2^53) -- routine for 24-decimal wNEAR amounts. These helpers do the
// scaling as decimal-string arithmetic through BigInt instead of float
// multiplication, so no amount at any of the six v1 assets' decimals
// (6, 8, 18, 24) ever loses precision in the conversion itself.

/** Decimal string/number -> integer base-unit string (e.g. "1.5", 6 -> "1500000"). */
export function toBaseUnits(amount: number | string, decimals: number): string {
  const s = typeof amount === "number" ? amount.toString() : amount.trim();
  if (s === "" || s === "-" ) return "0";
  const neg = s.startsWith("-");
  const abs = neg ? s.slice(1) : s;
  const [wholeRaw, fracRaw = ""] = abs.split(".");
  const whole = wholeRaw === "" ? "0" : wholeRaw;
  if (fracRaw.length > decimals) {
    // Round at the decimals boundary rather than silently truncating.
    const keep = fracRaw.slice(0, decimals);
    const nextDigit = fracRaw.charCodeAt(decimals) - 48;
    let combined = BigInt(whole + keep.padEnd(decimals, "0") || "0");
    if (nextDigit >= 5) combined += 1n;
    return (neg ? -combined : combined).toString();
  }
  const fracPadded = fracRaw.padEnd(decimals, "0");
  const combinedStr = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, "");
  const value = BigInt(combinedStr === "" ? "0" : combinedStr);
  return (neg ? -value : value).toString();
}

/** Integer base-unit string -> decimal string (e.g. "1500000", 6 -> "1.5"). */
export function fromBaseUnits(amount: string, decimals: number): string {
  const neg = amount.startsWith("-");
  const abs = neg ? amount.slice(1) : amount;
  const padded = abs.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals) || "0";
  const frac = decimals > 0 ? padded.slice(padded.length - decimals) : "";
  const fracTrimmed = frac.replace(/0+$/, "");
  const out = fracTrimmed ? `${whole}.${fracTrimmed}` : whole;
  return neg && out !== "0" ? `-${out}` : out;
}
