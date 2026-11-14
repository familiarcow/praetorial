// BET1b (UX-33 section 3): the make-a-bet Stake section's pure helpers.
// "You put in [amount] [token]" / "They put in [amount] [token]" (same token, even by default); editing either sets the odds
// (taker:maker = theirs / yours). Any of the six launch tokens (D-ASSET1) that has an id on this network. Amounts are in token
// units -- never "$" for USDC/USDT (UX-31). Cross-asset taker options are gone (D-SCOPE5): the offer carries only the same token.
import { ASSET_TABLE, CURRENT_NETWORK, assetId, isAssetEnabled, toBaseUnits, type NetworkId } from "./assets";
import { MAX_SAME_ASSET_ODDS } from "./escrowAdapter";
import { formatUnits, sideFee, type StakeLimits } from "./stakeDeadlines";

/** UX-33 order for the token picker. */
export const STAKE_SYMBOLS = ["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"] as const;
/** The form's starting token (unchanged from before BET1b). */
export const DEFAULT_STAKE_SYMBOL = "NEAR";
export const DEFAULT_STAKE_TEXT = "10";

export interface StakeAsset { symbol: string; assetId: string; decimals: number }

/** Tokens offered in the picker: the six launch tokens that are enabled (have a real id) on `network`. */
export function stakeAssets(network: NetworkId = CURRENT_NETWORK): StakeAsset[] {
  return STAKE_SYMBOLS.flatMap((symbol) => {
    const a = ASSET_TABLE.find((x) => x.symbol === symbol);
    const id = assetId(symbol, network);
    return a && id && isAssetEnabled(symbol, network) ? [{ symbol, assetId: id, decimals: a.decimals }] : [];
  });
}

/** "They put in": the same as you until edited (`theirText` null = even). */
export function theirStakeText(stakeText: string, theirText: string | null): string {
  return theirText === null ? stakeText : theirText;
}

const AMOUNT = /^\d+(\.\d+)?$/;
/** taker:maker odds from the two amounts; 0 when either is not a positive number yet. */
export function oddsFor(stakeText: string, theirText: string): number {
  const m = stakeText.trim(), t = theirText.trim();
  if (!AMOUNT.test(m) || !AMOUNT.test(t)) return 0;
  const mine = Number(m), theirs = Number(t);
  return mine > 0 && theirs > 0 ? theirs / mine : 0;
}

function units(symbol: string, text: string): bigint | null {
  try { const t = text.trim(); return AMOUNT.test(t) ? BigInt(toBaseUnits(symbol, t)) : null; } catch { return null; }
}

/** The contract's same-asset rule (hi > lo * 10 is refused), checked exactly in base units; null when fine or not yet parseable. */
export function ratioProblem(symbol: string, stakeText: string, theirText: string): string | null {
  const a = ASSET_TABLE.find((x) => x.symbol === symbol);
  const mine = units(symbol, stakeText), theirs = units(symbol, theirText);
  if (!a || mine === null || theirs === null || mine === 0n || theirs === 0n) return null;
  const max = BigInt(MAX_SAME_ASSET_ODDS);
  if (theirs > mine * max) return `They can put in at most ${MAX_SAME_ASSET_ODDS} times what you put in (${formatUnits(mine * max, a.decimals)} ${symbol}).`;
  if (mine > theirs * max) return `They have to put in at least a tenth of what you put in (${formatUnits((mine + max - 1n) / max, a.decimals)} ${symbol}).`;
  return null;
}

/** Places shown in the summary line (amounts are rounded UP to these, so a shown minimum is always enough). */
const DISPLAY_PLACES: Record<string, number> = { USDC: 2, USDT: 2, NEAR: 2, BTC: 8, ETH: 5, ZEC: 4 };

function shown(u: bigint, l: StakeLimits, padCents: boolean): string {
  const places = Math.min(DISPLAY_PLACES[l.symbol] ?? l.decimals, l.decimals);
  const step = 10n ** BigInt(l.decimals - places);
  const t = formatUnits(((u + step - 1n) / step) * step, l.decimals);
  if (!padCents) return t;
  const [w, f = ""] = t.split(".");
  return `${w}.${f.padEnd(2, "0")}`;
}

/** "Min <min> <token> · fee <fee> <token> each" (or "you, … them" when the stakes differ); just the minimum while an amount is unparseable. */
export function stakeLine(l: StakeLimits, mineUnits: bigint | null, theirUnits: bigint | null): string {
  const min = `Min ${shown(l.minPerSide, l, false)} ${l.symbol}`;
  if (mineUnits === null || theirUnits === null || mineUnits <= 0n || theirUnits <= 0n) return min;
  const fm = shown(sideFee(mineUnits, l.feeBps, l.minFeePerSide), l, true);
  const ft = shown(sideFee(theirUnits, l.feeBps, l.minFeePerSide), l, true);
  return fm === ft ? `${min} · fee ${fm} ${l.symbol} each` : `${min} · fee ${fm} ${l.symbol} you, ${ft} ${l.symbol} them`;
}

/** Base units of a typed amount for `symbol`, or null while it is not a valid amount. */
export const stakeUnits = units;

/** Draft fields this section keeps (CreateDraft.more). Old drafts only have stakeText + odds (and NEAR). */
export interface StakeDraft { stakeText: string; odds: number; stakeSymbol?: string; theirText?: string | null }
export interface StakeState { symbol: string; stakeText: string; theirText: string | null }

export function stakeFromDraft(more: StakeDraft | undefined, network: NetworkId = CURRENT_NETWORK): StakeState {
  if (!more) return { symbol: DEFAULT_STAKE_SYMBOL, stakeText: DEFAULT_STAKE_TEXT, theirText: null };
  const offered = stakeAssets(network).map((a) => a.symbol);
  const symbol = more.stakeSymbol && offered.includes(more.stakeSymbol) ? more.stakeSymbol : DEFAULT_STAKE_SYMBOL;
  if (more.theirText !== undefined) return { symbol, stakeText: more.stakeText, theirText: more.theirText };
  if (!more.odds || more.odds === 1) return { symbol, stakeText: more.stakeText, theirText: null };
  // Old draft (odds only): theirs = yours x odds, cut to the token's decimals.
  const decimals = ASSET_TABLE.find((a) => a.symbol === symbol)!.decimals;
  const mine = units(symbol, more.stakeText);
  if (mine === null) return { symbol, stakeText: more.stakeText, theirText: null };
  const SCALE = 1_000_000_000_000n;
  const theirs = (mine * BigInt(Math.round(more.odds * 1e12))) / SCALE;
  return { symbol, stakeText: more.stakeText, theirText: formatUnits(theirs, decimals) };
}
