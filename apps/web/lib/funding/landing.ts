// F2: the landing-token rule (familiarcow UX-37 FUND 12, D-FUND4a). Whatever the user sends, it lands in their betting balance as ONE
// of the 6 bet tokens. Default: the same token when the origin IS a bet token by symbol (USDC on any network -> USDC, BTC -> BTC,
// wNEAR/NEAR -> NEAR, ...), otherwise USDC. The "Bet with" picker offers only the 6; a bet hand-off (?need) locks it to the bet's
// token. Convert (stray or refunded tokens) also lands only in the 6.
// There is no rail choice any more: every Add money uses a one-time 1Click address (no permanent bridge addresses, UX-37 FUND 13).
import { BET_SYMBOLS, type BetSymbol, type TokenRef } from "./types";
import { findAsset, CURRENT_NETWORK, type NetworkId } from "../assets";

export const DEFAULT_BET_WITH: BetSymbol = "USDC";

/** Strip 1Click decorations ("USDC(DEPRECATED)") and fold case. */
const bareSymbol = (s: string): string => s.replace(/\(.*\)$/, "").trim().toUpperCase();
/** 1Click lists wrap.near as "wNEAR"; users know it as NEAR. Every other bet token matches by exact symbol. */
const ALIASES: Record<string, BetSymbol> = { USDC: "USDC", USDT: "USDT", NEAR: "NEAR", WNEAR: "NEAR", BTC: "BTC", ETH: "ETH", ZEC: "ZEC" };

/** The bet token this token IS (same token, any network), or null. Wrapped/bridged look-alikes (WETH, WBTC, cbBTC, USDT0) are
 * different tokens and are NOT matched: they convert to USDC by default and the user can pick another of the 6. */
export function betSymbolOf(token: Pick<TokenRef, "symbol">): BetSymbol | null {
  return ALIASES[bareSymbol(token.symbol)] ?? null;
}

/** The intents token id a bet token lands as on `network` (null when the token is not live there, e.g. BTC on testnet). */
export function betTokenId(symbol: BetSymbol, network: NetworkId = CURRENT_NETWORK): string | null {
  const a = findAsset(symbol);
  if (!a || a.disabledReason?.[network]) return null;
  return a.ids[network] ?? null;
}

/** The bet tokens selectable on `network`, in D-ASSET1 order. */
export const betWithChoices = (network: NetworkId = CURRENT_NETWORK, locked: BetSymbol | null = null): BetSymbol[] =>
  BET_SYMBOLS.filter((s) => betTokenId(s, network) !== null && (locked === null || s === locked));

/** The token id -> bet symbol, or null when the id is not one of the 6 (on `network`). */
export function betSymbolForId(assetId: string, network: NetworkId = CURRENT_NETWORK): BetSymbol | null {
  return BET_SYMBOLS.find((s) => betTokenId(s, network) === assetId) ?? null;
}
export const isBetTokenId = (assetId: string, network: NetworkId = CURRENT_NETWORK): boolean => betSymbolForId(assetId, network) !== null;

/** Default "Bet with" for an origin token. */
export function defaultBetWith(origin: Pick<TokenRef, "symbol">, network: NetworkId = CURRENT_NETWORK): BetSymbol {
  const same = betSymbolOf(origin);
  return same && betTokenId(same, network) ? same : DEFAULT_BET_WITH;
}

export type BetWithChoice =
  | { ok: true; symbol: BetSymbol; destinationAsset: string; locked: boolean; sameToken: boolean }
  | { ok: false; reason: "not_a_bet_token" | "locked_to_other" | "not_on_network" };

/** The landing token for an Add money: the user's pick (must be one of the 6), else the bet's token when locked, else the default.
 * `destinationAsset` is what the Worker request carries as `betWith`. */
export function resolveBetWith(p: { origin: Pick<TokenRef, "symbol">; picked?: string | null; locked?: BetSymbol | null; network?: NetworkId }): BetWithChoice {
  const network = p.network ?? CURRENT_NETWORK;
  const locked = p.locked ?? null;
  let symbol: BetSymbol;
  if (p.picked != null) {
    if (!(BET_SYMBOLS as readonly string[]).includes(p.picked)) return { ok: false, reason: "not_a_bet_token" };
    symbol = p.picked as BetSymbol;
    if (locked && symbol !== locked) return { ok: false, reason: "locked_to_other" };
  } else symbol = locked ?? defaultBetWith(p.origin, network);
  const destinationAsset = betTokenId(symbol, network);
  if (!destinationAsset) return { ok: false, reason: "not_on_network" };
  return { ok: true, symbol, destinationAsset, locked: locked !== null, sameToken: betSymbolOf(p.origin) === symbol };
}

/** Convert targets for a holding in the intents account: the 6, minus the token itself. Default = its own bet symbol (a bridged
 * USDC (Ethereum) converts to USDC), else USDC. */
export function convertTargets(holding: { assetId: string; symbol: string }, network: NetworkId = CURRENT_NETWORK): { choices: BetSymbol[]; default: BetSymbol } {
  const choices = betWithChoices(network).filter((s) => betTokenId(s, network) !== holding.assetId);
  const same = betSymbolOf(holding);
  const def = same && choices.includes(same) ? same : choices.includes(DEFAULT_BET_WITH) ? DEFAULT_BET_WITH : choices[0];
  return { choices, default: def };
}
