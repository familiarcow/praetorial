// FE2 / S1c: the user's balances inside Intents (mt_balance_of on the intents contract, one read per enabled asset), the
// shortfall vs the bet being created, and the money formatting. No hard-coded amounts.
import { INTENTS_CONTRACT_ID } from "./config";
import { viewFunction } from "./rpc";
import { listEnabledAssets, assetId, findAsset, toBaseUnits } from "./assets";
import { fromBaseUnits } from "./decimal";

type View = (contract: string, method: string, args: Record<string, unknown>) => Promise<any>;

/** symbol -> base units (string). Throws if the reads fail (the screen shows "We can't read your balance").
 * F2 (FUND4 SPEC §1 B1): ONE `mt_batch_balance_of` for every enabled asset instead of one `mt_balance_of` each. If the batch read
 * fails or answers in an unexpected shape, it falls back to the per-token reads (the previous behaviour), so a balance is never
 * shown from a half-understood answer and an RPC without the batch method still works. */
export async function fetchIntentsBalances(account: string, view: View = (c, m, a) => viewFunction<any>(c, m, a)): Promise<Record<string, string>> {
  const assets = listEnabledAssets();
  const ids = assets.map((a) => assetId(a.symbol)!);
  const out: Record<string, string> = {};
  let vals: string[] | null = null;
  try {
    const r: unknown = await view(INTENTS_CONTRACT_ID, "mt_batch_balance_of", { account_id: account, token_ids: ids });
    if (Array.isArray(r) && r.length === ids.length && r.every((x) => typeof x === "string" && /^\d+$/.test(x))) vals = r as string[];
  } catch { /* fall back below */ }
  if (!vals) vals = (await Promise.all(ids.map((id) => view(INTENTS_CONTRACT_ID, "mt_balance_of", { account_id: account, token_id: id })))).map((v) => String(v ?? "0"));
  assets.forEach((a, i) => { out[a.symbol] = vals![i]; });
  return out;
}

export function shortfallUnits(balance: string, needed: string): bigint {
  const d = BigInt(needed) - BigInt(balance);
  return d > 0n ? d : 0n;
}

export function formatMoney(symbol: string, units: string): string {
  const a = findAsset(symbol);
  if (!a) throw new Error(`unknown asset ${symbol}`);
  let h = fromBaseUnits(units, a.decimals);
  // NAV1 (UX-31): token units, never "$". Dollar coins show two places ("12.50 USDC", rounded down).
  if (symbol === "USDC" || symbol === "USDT") {
    const [w, f = ""] = h.split(".");
    return `${w}.${(f + "00").slice(0, 2)} ${symbol}`;
  }
  if (h.includes(".")) h = h.replace(/0+$/, "").replace(/\.$/, "");
  return `${h} ${symbol}`;
}

export interface Need { symbol: string; amount: string }
export function parseNeed(search: string): Need | null {
  const q = new URLSearchParams(search);
  const symbol = q.get("asset"), amount = q.get("need");
  if (!symbol || !amount || !findAsset(symbol) || !/^\d+(\.\d+)?$/.test(amount)) return null;
  try { toBaseUnits(symbol, amount); } catch { return null; }
  return { symbol, amount };
}
export const needQuery = (symbol: string, amount: string) => `?asset=${encodeURIComponent(symbol)}&need=${encodeURIComponent(amount)}`;

/** The S1c headline for one asset (USDC by default). */
export function balanceHeadline(symbol: string, balanceUnits: string, need: Need | null): string {
  const bal = `Your balance: ${formatMoney(symbol, balanceUnits)}.`;
  if (need) {
    const short = shortfallUnits(balanceUnits, toBaseUnits(need.symbol, need.amount));
    if (short === 0n) return `${bal} You have enough for this bet.`;
    return `${bal} You need ${formatMoney(need.symbol, short.toString())} more.`;
  }
  return BigInt(balanceUnits) === 0n ? `${bal} Add ${symbol} to place a bet.` : bal;
}
