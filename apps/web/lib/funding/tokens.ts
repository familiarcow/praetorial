// F2: the "What do you have?" token list (SPEC §4.1): 1Click /v0/tokens (public, CORS *) fetched from the browser, cached 5 min in
// memory and 24 h in localStorage as a fallback, mapped to TokenOption with network names, exchange network names, popular
// ranking, search with aliases (trc20, erc20, bep20, ...), and the landing-token tag (betSymbol).
// Fail closed: a `blockchain` we have no name for, 1cs_v1:* pseudo-assets and "(DEPRECATED)" rows are hidden (never guessed).
import type { TokenOption } from "./types";
import { betSymbolOf, betTokenId } from "./landing";
import { ONECLICK_TOKENS_URL } from "../config";

export interface RawToken { assetId: string; decimals: number; blockchain: string; symbol: string; price?: number | null; contractAddress?: string }

/** 1Click `blockchain` code -> [network name, exchange network name or null, search aliases]. 39 chains (FUND3 §4, 2026-11-11). */
export const NETWORKS: Record<string, [string, string | null, string[]]> = {
  abs: ["Abstract", null, []],
  adi: ["ADI", null, []],
  aleo: ["Aleo", null, []],
  aptos: ["Aptos", null, []],
  arb: ["Arbitrum", "Arbitrum One", ["arbitrum", "arb"]],
  avax: ["Avalanche", "Avalanche C-Chain", ["avalanche", "avax", "c-chain"]],
  base: ["Base", "Base", []],
  bch: ["Bitcoin Cash", null, ["bch"]],
  bera: ["Berachain", null, ["bera"]],
  bsc: ["BNB Chain", "BNB Smart Chain (BEP-20)", ["bnb", "bsc", "bep20", "bep-20", "binance"]],
  btc: ["Bitcoin", "Bitcoin", ["bitcoin"]],
  cardano: ["Cardano", null, ["ada"]],
  dash: ["Dash", null, []],
  doge: ["Dogecoin", null, ["doge"]],
  eth: ["Ethereum", "Ethereum (ERC-20)", ["ethereum", "erc20", "erc-20", "mainnet"]],
  fogo: ["Fogo", null, []],
  gnosis: ["Gnosis", "Gnosis Chain", ["xdai"]],
  hood: ["Robinhood Chain", null, ["robinhood"]],
  hypercore: ["Hyperliquid", null, ["hyperliquid", "hypercore", "hyperevm"]],
  ltc: ["Litecoin", null, ["ltc"]],
  miden: ["Miden", null, []],
  monad: ["Monad", null, []],
  movement: ["Movement", null, []],
  near: ["NEAR", "NEAR Protocol", ["near"]],
  op: ["Optimism", "Optimism", ["optimism", "op"]],
  plasma: ["Plasma", null, []],
  pol: ["Polygon", "Polygon PoS", ["polygon", "matic", "pol"]],
  prl: ["PRL", null, []],
  qtc: ["QTC", null, []],
  scroll: ["Scroll", null, []],
  sol: ["Solana", "Solana (SPL)", ["solana", "spl"]],
  starknet: ["Starknet", null, ["stark"]],
  stellar: ["Stellar", "Stellar", ["xlm"]],
  sui: ["Sui", null, []],
  ton: ["TON", "TON", ["toncoin"]],
  tron: ["Tron", "Tron (TRC-20)", ["tron", "trc20", "trc-20", "trx"]],
  xlayer: ["X Layer", null, ["okx"]],
  xrp: ["XRP Ledger", "XRP", ["ripple", "xrpl"]],
  zec: ["Zcash", "Zcash", ["zcash"]],
};

/** Chains whose exchange deposits often need a memo/tag (SPEC §5.1). */
export const MEMO_CHAINS = new Set(["xrp", "stellar", "ton"]);

/** SPEC §4.1 popular list, in order: `${symbol}@${blockchain}`. */
export const POPULAR = [
  "USDT@tron", "USDC@eth", "USDC@base", "USDC@sol", "USDT@eth", "BTC@btc", "ETH@eth", "ETH@base", "SOL@sol", "wNEAR@near", "USDC@near", "ZEC@zec",
];

export function toTokenOption(raw: RawToken): TokenOption | null {
  if (!raw || typeof raw.assetId !== "string" || raw.assetId.startsWith("1cs_v1:")) return null;
  if (/\(DEPRECATED\)/i.test(raw.symbol)) return null;
  const net = NETWORKS[raw.blockchain];
  if (!net || !Number.isInteger(raw.decimals) || raw.decimals < 0) return null;
  const rank = POPULAR.indexOf(`${raw.symbol}@${raw.blockchain}`);
  const price = typeof raw.price === "number" && Number.isFinite(raw.price) && raw.price > 0 ? raw.price : null;
  // Users know wrap.near as NEAR: show it so in the picker (the asset id stays wrap.near).
  const symbol = raw.assetId === betTokenId("NEAR", "mainnet") ? "NEAR" : raw.symbol;
  return {
    assetId: raw.assetId, symbol, blockchain: raw.blockchain, decimals: raw.decimals, networkName: net[0], exchangeNetworkName: net[1],
    priceUsd: price, popularRank: rank >= 0 ? rank + 1 : null, logo: "", chainLogo: "", memoChain: MEMO_CHAINS.has(raw.blockchain),
    betSymbol: betSymbolOf({ symbol }),
  };
}

/** Popular first (by rank), then alphabetical by symbol, then network. */
export function sortTokens(list: TokenOption[]): TokenOption[] {
  return [...list].sort((a, b) =>
    (a.popularRank ?? 1e9) - (b.popularRank ?? 1e9) || a.symbol.localeCompare(b.symbol) || a.networkName.localeCompare(b.networkName));
}

export function mapTokens(raw: unknown): TokenOption[] {
  if (!Array.isArray(raw)) throw new Error("token list is not an array");
  const seen = new Set<string>();
  const out: TokenOption[] = [];
  for (const r of raw) {
    const t = toTokenOption(r as RawToken);
    if (t && !seen.has(t.assetId)) { seen.add(t.assetId); out.push(t); }
  }
  return sortTokens(out);
}

/** Search symbol, network name and aliases. Tokens of the `prefer` symbol (a ?need hand-off) come first. Empty query = all. */
export function searchTokens(list: TokenOption[], query: string, prefer: string | null = null): TokenOption[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hay = (t: TokenOption) => [t.symbol, t.networkName, t.exchangeNetworkName ?? "", t.blockchain, ...(NETWORKS[t.blockchain]?.[2] ?? [])].join(" ").toLowerCase();
  const hits = words.length ? list.filter((t) => { const h = hay(t); return words.every((w) => h.includes(w)); }) : [...list];
  if (!prefer) return hits;
  const p = prefer.toUpperCase();
  return [...hits.filter((t) => t.symbol.toUpperCase() === p || t.betSymbol === p), ...hits.filter((t) => !(t.symbol.toUpperCase() === p || t.betSymbol === p))];
}

export const popularTokens = (list: TokenOption[]): TokenOption[] => list.filter((t) => t.popularRank !== null).sort((a, b) => a.popularRank! - b.popularRank!);

// ---- loading with caches ----
export const TOKENS_MEMORY_TTL_MS = 5 * 60_000;
export const TOKENS_STORAGE_TTL_MS = 24 * 3_600_000;
export const TOKENS_STORAGE_KEY = "praetorial:funding:v1:tokens";

interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }
type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
let memory: { at: number; list: TokenOption[] } | null = null;
export const resetTokenCache = () => { memory = null; };

/** The token list: memory (5 min) -> network -> localStorage (24 h) when the network fails. Throws when nothing is usable. */
export async function loadTokens(deps: { fetch?: FetchLike; storage?: StorageLike | null; now?: () => number; url?: string } = {}): Promise<{ list: TokenOption[]; stale: boolean }> {
  const now = (deps.now ?? Date.now)();
  if (memory && now - memory.at < TOKENS_MEMORY_TTL_MS) return { list: memory.list, stale: false };
  const storage = deps.storage === undefined ? (typeof localStorage !== "undefined" ? localStorage : null) : deps.storage;
  const doFetch: FetchLike = deps.fetch ?? ((u) => fetch(u));
  try {
    const res = await doFetch(deps.url ?? ONECLICK_TOKENS_URL);
    if (!res.ok) throw new Error(`tokens HTTP ${res.status}`);
    const raw = await res.json();
    const list = mapTokens(raw);
    if (!list.length) throw new Error("empty token list");
    memory = { at: now, list };
    try { storage?.setItem(TOKENS_STORAGE_KEY, JSON.stringify({ at: now, raw })); } catch { /* quota: memory cache still works */ }
    return { list, stale: false };
  } catch (e) {
    try {
      const saved = storage?.getItem(TOKENS_STORAGE_KEY);
      if (saved) {
        const { at, raw } = JSON.parse(saved);
        if (typeof at === "number" && now - at < TOKENS_STORAGE_TTL_MS) return { list: mapTokens(raw), stale: true };
      }
    } catch { /* corrupt cache: fall through */ }
    throw e;
  }
}

/** asset id -> USD price (null when 1Click has none) for the ≈ $ total. */
export const priceMap = (list: TokenOption[]): Map<string, number | null> => new Map(list.map((t) => [t.assetId, t.priceUsd]));
