// FE2b / S7+S8+S11: before signing a deposit, compare the exact "You pay now" amount (base units) with the user's balance
// inside Intents. A shortfall sends the user to /add-money with the need; the hand-off carries the FULL pay-now amount
// and the add-money screen derives the remaining shortfall from the live balance (FE2).
import { INTENTS_CONTRACT_ID } from "./config";
import { viewFunction } from "./rpc";
import { assetId, symbolForAssetId } from "./assets";
import { displayAmount } from "./funding/format";
import { fromBaseUnits } from "./decimal";
import { findAsset } from "./assets";
import { needQuery, parseNeed, formatMoney, type Need } from "./intentsBalance";

type View = (contract: string, method: string, args: Record<string, unknown>) => Promise<string>;

/** null = the balance covers it. Pure, bigint only. */
export function needFor(symbol: string, payNowUnits: bigint, balanceUnits: string): Need | null {
  if (BigInt(balanceUnits) >= payNowUnits) return null;
  const a = findAsset(symbol);
  if (!a) throw new Error(`unknown asset ${symbol}`);
  let amount = fromBaseUnits(payNowUnits.toString(), a.decimals);
  if (amount.includes(".")) amount = amount.replace(/0+$/, "").replace(/\.$/, "");
  return { symbol, amount };
}

export const addMoneyPath = (n: Need, returnTo?: string) => `/add-money${needQuery(n.symbol, n.amount)}${returnTo && safeReturn(returnTo) ? `&return=${encodeURIComponent(returnTo)}` : ""}`;

/** F4: every in-app hand-off to Add money is an `/add-money?...` path. The app opens the Add money sheet OVER the current page for
 * it (create / take / bet page: the draft stays), instead of navigating away. */
export const isAddMoneyPath = (p: string): boolean => /^\/add-money(\?|$)/.test(p);
export function parseAddMoneyPath(p: string): { need: Need | null; returnTo: string | null } {
  const q = p.includes("?") ? p.slice(p.indexOf("?")) : "";
  return { need: parseNeed(q), returnTo: parseReturn(q) };
}

/** Only in-app /new and /bet/:id paths are accepted as a "back to my bet" target. */
export function safeReturn(p: string | null | undefined): string | null {
  return p && (p === "/new" || /^\/bet\/\d+$/.test(p)) ? p : null;
}
export function parseReturn(search: string): string | null {
  return safeReturn(new URLSearchParams(search).get("return"));
}

/** Reads only the deposit asset's balance. A failed read returns null (don't block: the contract refunds a bad deposit anyway). */
export async function fundingNeed(a: { account: string; symbol: string; payNowUnits: bigint; view?: View }): Promise<Need | null> {
  const view: View = a.view ?? ((c, m, x) => viewFunction<string>(c, m, x));
  const id = assetId(a.symbol);
  if (!id) return null;
  try {
    const bal = await view(INTENTS_CONTRACT_ID, "mt_balance_of", { account_id: a.account, token_id: id });
    return needFor(a.symbol, a.payNowUnits, String(bal ?? "0"));
  } catch { return null; }
}

export interface FundingShort { need: Need; missingText: string; sentence: string; path: string }
/** FUND1b: the in-modal "Add money" notice. Missing = pay-now minus the live balance (exact); null when covered or the read failed. */
export async function fundingShort(a: { account: string; symbol: string; payNowUnits: bigint; returnTo?: string; view?: View }): Promise<FundingShort | null> {
  const id = assetId(a.symbol);
  if (!id) return null;
  return (await fundingCheck({ account: a.account, tokenId: id, payNowUnits: a.payNowUnits, returnTo: a.returnTo, view: a.view })).short;
}

/** M1 (SM2 gap M1-2): ONE balance read before a pay-in gives both the shortfall (null = covered / unknown asset) and the balance
 *  (the refund check's "before"). A failed read never blocks: { short: null, balanceUnits: null }. */
export async function fundingCheck(a: { account: string; tokenId: string; payNowUnits: bigint; returnTo?: string; view?: View }): Promise<{ short: FundingShort | null; balanceUnits: bigint | null }> {
  const view: View = a.view ?? ((c, m, x) => viewFunction<string>(c, m, x));
  let bal: string;
  try { bal = String((await view(INTENTS_CONTRACT_ID, "mt_balance_of", { account_id: a.account, token_id: a.tokenId })) ?? "0"); BigInt(bal); } catch { return { short: null, balanceUnits: null }; }
  const balanceUnits = BigInt(bal);
  const symbol = symbolForAssetId(a.tokenId);
  if (!findAsset(symbol)) return { short: null, balanceUnits };
  const need = needFor(symbol, a.payNowUnits, bal);
  if (!need) return { short: null, balanceUnits };
  // A NEEDED amount rounds up (F3 rule): a 1-unit shortfall is "0.01 USDC", never "0.00 USDC".
  const missingText = displayAmount(a.payNowUnits - balanceUnits, findAsset(symbol)!.decimals, symbol, { round: "up" });
  return { short: { need, missingText, sentence: `You need ${missingText} more in your betting balance to do this.`, path: addMoneyPath(need, a.returnTo) }, balanceUnits };
}
