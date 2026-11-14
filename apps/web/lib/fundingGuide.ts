// FUND1: the plain "what's missing and what to do" guide for the Add money screen (and anywhere a bet lacks balance).
// Pure, bigint only. Says exactly how much is missing, whether moving what the user already holds covers it, and (testnet only)
// when to offer a free test-NEAR top-up.
import { findAsset, toBaseUnits, type NetworkId } from "./assets";
import { formatMoney, shortfallUnits, balanceHeadline, type Need } from "./intentsBalance";
import { NEAR_SPENDABLE_RESERVE_YOCTO, type MovableReport } from "./moveToBetting";

export interface FundingGuide {
  headline: string;
  /** Exact amount still missing from the betting balance (null = enough). */
  missingText: string | null;
  /** What would still be missing after moving everything movable (null = nothing, or not applicable). */
  afterMoveMissingText: string | null;
  coveredByMoving: boolean;
  showFaucet: boolean;
  notes: string[];
}

export function fundingGuide(a: { need: Need | null; symbol?: string; balanceUnits: string; report: MovableReport; network: NetworkId }): FundingGuide {
  const symbol = a.need?.symbol ?? a.symbol ?? "USDC";
  const headline = balanceHeadline(symbol, a.balanceUnits, a.need);
  const notes: string[] = [];
  const nearText = (y: bigint | string) => formatMoney("NEAR", y.toString());
  const r = a.report;

  if (r.native.state === "too-small") notes.push(`You have ${nearText(r.native.yocto)} in your NEAR account, but ${nearText(NEAR_SPENDABLE_RESERVE_YOCTO)} stays in your NEAR account to pay for storage, so there's nothing left to move.`);
  if (r.native.state === "unreadable" || r.readFailed.length) notes.push(`We couldn't read your ${r.readFailed.join(" / ")} balance${r.readFailed.length > 1 ? "s" : ""} just now. Try again in a moment.`);

  const short = a.need ? shortfallUnits(a.balanceUnits, toBaseUnits(a.need.symbol, a.need.amount)) : 0n;
  if (!a.need || short === 0n) return { headline, missingText: null, afterMoveMissingText: null, coveredByMoving: true, showFaucet: false, notes };

  const movable = r.holdings.filter((h) => h.symbol === symbol).reduce((s, h) => s + BigInt(h.amountUnits), 0n);
  const covered = movable >= short;
  if (symbol !== "NEAR" && r.holdings.some((h) => h.symbol === "NEAR")) notes.push(`NEAR can't be used for a ${symbol} bet. This bet is in ${symbol}.`);
  const after = short - movable;
  const testnetNear = a.network === "testnet" && symbol === "NEAR";
  return {
    headline,
    missingText: formatMoney(symbol, short.toString()),
    afterMoveMissingText: !covered && movable > 0n ? formatMoney(symbol, after.toString()) : null,
    coveredByMoving: covered,
    showFaucet: testnetNear && !covered && !!findAsset("NEAR"),
    notes,
  };
}
