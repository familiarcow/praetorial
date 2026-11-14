// F2: the balance map (SPEC §1, B1-B10): every place the user's money can sit, each section read independently. A section that
// fails is "error" (the screen says "can't read"), never 0 and never hiding the others (FUND1 rule). Reloads take a sequence
// token so an older read never overwrites a newer one (SM1 MON-7).
//   B1 betting: ONE intents.near mt_batch_balance_of over the 6 bet tokens.
//   B2 stray:   mt_tokens_for_owner (paginated) minus the 6, then ONE mt_batch_balance_of; non-zero only; ids 1Click doesn't
//               list are kept as "Unknown token" (token: null). Mainnet only: the testnet intents mock has no mt_tokens_for_owner.
//   B3 / B4-B5 / B6 / B7-B10 come from injected loaders (moveToBetting, the My Bets loader, payout lines, store.syncInFlight).
import type { BalanceMap, BetSymbol, PayoutHolding, StrayHolding, SwapRecord, TokenOption } from "./types";
import { BET_SYMBOLS } from "./types";
import { betTokenId, betSymbolForId } from "./landing";
import { holdingUsdCents, approxUsdTotal } from "./format";
import { viewFunction } from "../rpc";
import { CURRENT_NETWORK, type NetworkId } from "../assets";
import { intentsContractFor } from "../network";
import type { PayoutLine } from "../payoutScreen";

export type View = (contract: string, method: string, args: Record<string, unknown>) => Promise<unknown>;
const defaultView: View = (c, m, a) => viewFunction<unknown>(c, m, a);

export const PAGE = 100;
const MAX_PAGES = 20;
/** Stray holdings worth under this many US cents are "Too small to convert" (only when 1Click has a price for them). */
export const DUST_USD_CENTS = 1n;

function unitsArray(v: unknown, n: number): bigint[] {
  if (!Array.isArray(v) || v.length !== n || !v.every((x) => typeof x === "string" && /^\d+$/.test(x))) throw new Error("malformed mt_batch_balance_of answer");
  return v.map((x) => BigInt(x as string));
}

/** B1: the bet tokens live on `network` (all 6 on mainnet), one batch read. */
export async function readBetting(account: string, view: View = defaultView, network: NetworkId = CURRENT_NETWORK): Promise<Partial<Record<BetSymbol, bigint>>> {
  const symbols = BET_SYMBOLS.filter((s) => betTokenId(s, network));
  const ids = symbols.map((s) => betTokenId(s, network)!);
  const vals = unitsArray(await view(intentsContractFor(network), "mt_batch_balance_of", { account_id: account, token_ids: ids }), ids.length);
  return Object.fromEntries(symbols.map((s, i) => [s, vals[i]]));
}

/** B2: non-bet tokens in the intents account, non-zero only. */
export async function readStray(account: string, view: View = defaultView, tokens: TokenOption[] = [], network: NetworkId = CURRENT_NETWORK): Promise<StrayHolding[]> {
  if (network !== "mainnet") return [];
  const contract = intentsContractFor(network);
  const ids: string[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await view(contract, "mt_tokens_for_owner", { account_id: account, from_index: String(page * PAGE), limit: PAGE });
    if (!Array.isArray(rows)) throw new Error("malformed mt_tokens_for_owner answer");
    for (const r of rows) if (r && typeof (r as any).token_id === "string") ids.push((r as any).token_id);
    if (rows.length < PAGE) break;
  }
  const stray = [...new Set(ids)].filter((id) => betSymbolForId(id, network) === null);
  if (!stray.length) return [];
  const vals = unitsArray(await view(contract, "mt_batch_balance_of", { account_id: account, token_ids: stray }), stray.length);
  const byId = new Map(tokens.map((t) => [t.assetId, t]));
  return stray.flatMap((assetId, i) => {
    if (vals[i] === 0n) return [];
    const t = byId.get(assetId);
    const token = t ? { assetId, symbol: t.symbol, blockchain: t.blockchain, decimals: t.decimals } : null;
    const priceUsd = t?.priceUsd ?? null;
    const cents = token ? holdingUsdCents({ units: vals[i], decimals: token.decimals, priceUsd }) : null;
    return [{ assetId, units: vals[i], token, priceUsd, dust: cents !== null && cents < DUST_USD_CENTS }];
  });
}

/** B6: my unfinished payout lines (receiver = me, not done), per bet. */
export function payoutsFor(lines: PayoutLine[], me: string, network: NetworkId = "mainnet"): PayoutHolding[] {
  return lines
    .filter((l) => l.receiver === me && !l.done)
    .map((l) => ({ betId: l.bet_id, symbol: betSymbolForId(l.token_id, network) ?? betSymbolForId(l.token_id) ?? l.token_id, units: BigInt(l.amount) }));
}

export interface BalanceDeps {
  view?: View;
  network?: NetworkId;
  /** The 1Click token list (names, decimals, prices of stray tokens). */
  tokens?: TokenOption[];
  nearAccount?: () => Promise<Partial<Record<BetSymbol, bigint>>>;
  inBets?: () => Promise<Partial<Record<BetSymbol, { units: bigint; bets: number }>>>;
  payouts?: () => Promise<PayoutHolding[]>;
  inFlight?: () => Promise<SwapRecord[]>;
}

const settle = async <T>(f: (() => Promise<T>) | undefined): Promise<T | "error"> => {
  if (!f) return "error";
  try { return await f(); } catch { return "error"; }
};

/** Every section at once, each failing alone. Sections without a loader are "error" (unread), never 0. */
export async function loadBalanceMap(account: string, d: BalanceDeps = {}): Promise<BalanceMap> {
  const view = d.view ?? defaultView;
  const network = d.network ?? CURRENT_NETWORK;
  const [betting, stray, nearAccount, inBets, payouts, inFlight] = await Promise.all([
    settle(() => readBetting(account, view, network)),
    settle(() => readStray(account, view, d.tokens ?? [], network)),
    settle(d.nearAccount),
    settle(d.inBets),
    settle(d.payouts),
    settle(d.inFlight),
  ]);
  return { betting, stray, nearAccount, inBets, payouts, inFlight: inFlight === "error" ? [] : inFlight };
}

/** MON-7 sequence guard: take a token before a read; drop the result unless it is still current. */
export function createSequence() {
  let n = 0;
  return { next: () => ++n, isCurrent: (t: number) => t === n };
}

/** The grey "≈ $X" under the username (familiarcow FUND 11): the B1 total at 1Click prices, or null (hide the line) when B1 is unread or
 * any non-zero bet token has no price. */
export function bettingTotalUsd(map: Pick<BalanceMap, "betting">, tokens: TokenOption[], network: NetworkId = CURRENT_NETWORK): string | null {
  if (map.betting === "error") return null;
  const byId = new Map(tokens.map((t) => [t.assetId, t]));
  const holdings = (Object.entries(map.betting) as [BetSymbol, bigint][]).map(([symbol, units]) => {
    const t = byId.get(betTokenId(symbol, network) ?? "");
    return { units, decimals: t?.decimals ?? 0, priceUsd: t?.priceUsd ?? null };
  });
  return approxUsdTotal(holdings);
}
