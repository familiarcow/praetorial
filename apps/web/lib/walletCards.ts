// F3 (FUND4 SPEC §3 + §1 balance map, familiarcow UX-37 / D-FUND4a, SM2 STATES.md M5): the Account screen's view model. Pure; the
// screen (src/components/WalletPage.tsx + src/components/wallet/*) renders it and never re-derives "empty", "failed" or an amount.
//   - one row per bet token, token units only (lib/money.ts formatMoney: stables 2 dp, others <= 6 significant, "< 0.01");
//   - secondary lines (NEAR account B3, in bets B4/B5) only when non-zero; an unread section is "can't read", never 0;
//   - stray tokens (B2) with Convert into one of the 6, unknown ids shown (never hidden), dust can't convert;
//   - being paid out (B6), the user's record and first bet, and the in-flight transfers (B7-B10) as compact lines.
// NAV1's walletCards()/displayAmount()/totalsLine() are gone (SM2 gap F3-3: one amount rule, no second formatter, no totals cards).
import { BET_SYMBOLS, TERMINAL_STATES, type BalanceMap, type BetSymbol, type PayoutHolding, type StrayHolding, type SwapRecord, type TrackState } from "./funding/types";
import { COPY } from "./funding/copy";
import { displayAmount as tokenAmount, shortAddress } from "./funding/format";
import { NETWORKS } from "./funding/tokens";
import { betSymbolForId, convertTargets } from "./funding/landing";
import { payoutsFor } from "./funding/balances";
import { formatMoney } from "./money";
import { findAsset, toBaseUnits, type NetworkId } from "./assets";
import type { Holding, MovableReport } from "./moveToBetting";
import { phaseOf, type PhaseId } from "./betLifecycle";
import { payoutScreen, type PayoutLine } from "./payoutScreen";
import type { Bet } from "./escrowAdapter";

/** D-ASSET1 launch order (the 6 bet tokens). */
export const WALLET_ASSETS = BET_SYMBOLS;

const text = (units: bigint, symbol: string): string => formatMoney({ units, symbol }).text;

// ---------------------------------------------------------------- the user's bets (B4/B5 locked, B6 paying out, record)
export interface BetItem { bet: Bet; pending: PayoutLine[] | null }
export interface BetsSection {
  inBets: Partial<Record<BetSymbol, { units: bigint; bets: number }>>;
  payouts: PayoutHolding[];
  record: { won: number; lost: number };
  /** ms since epoch of the user's first bet, or null. */
  memberSince: number | null;
  /** AFIX1: a Finalized bet's payout lines could not be read, so "Being paid out" may be missing money (never read as "none"). */
  payoutsUnread?: boolean;
}
/** "loading" = not read yet; "error" = the indexer/chain read failed (say so, never 0). */
export type BetsState = BetsSection | "loading" | "error";

/** Phases in which the user's stake (and any bond they posted) sits in the escrow. Open offers lock only the maker's stake. */
const LOCKED: ReadonlySet<PhaseId> = new Set<PhaseId>([
  "open", "open-lapsed", "live", "awaiting-result", "awaiting-referee", "refund-due", "no-result", "judging", "stuck", "ruling", "ruling-final", "challenged",
]);

/** B4 + B5: per bet token, the user's own stake in open offers and live bets plus the bonds they posted, and how many bets. */
export function lockedInBets(items: BetItem[], me: string, chainNowNs: number, contractId: string, network: NetworkId): BetsSection["inBets"] {
  const out: BetsSection["inBets"] = {};
  for (const { bet } of items) {
    const e = bet.envelope;
    const role = e.maker === me ? "maker" : bet.taker === me ? "taker" : null;
    if (!role || !LOCKED.has(phaseOf(bet, chainNowNs, contractId))) continue;
    const add: [string, bigint][] = [role === "maker" ? [e.maker_asset, BigInt(e.stake_maker)] : [e.taker_asset, BigInt(e.stake_taker)]];
    for (const b of bet.bonds ?? []) if (b.holder === me) add.push([b.asset, BigInt(b.amount)]);
    const counted = new Set<BetSymbol>();
    for (const [asset, units] of add) {
      const sym = betSymbolForId(asset, network);
      if (!sym || units === 0n) continue;
      const cur = out[sym] ?? { units: 0n, bets: 0 };
      out[sym] = { units: cur.units + units, bets: cur.bets + (counted.has(sym) ? 0 : 1) };
      counted.add(sym);
    }
  }
  return out;
}

/** B6: the user's unfinished payout lines, per bet (the Finalized bets' pending_payouts). */
export function payoutsFromBets(items: BetItem[], me: string, network: NetworkId): PayoutHolding[] {
  return items.flatMap(({ pending }) => (pending ? payoutsFor(pending, me, network) : []));
}

/** Won / lost among the user's decided bets (lib/payoutScreen's ending; void and refunded bets count as neither). */
export function betRecord(items: BetItem[], me: string): { won: number; lost: number } {
  let won = 0, lost = 0;
  for (const { bet, pending } of items) {
    if (bet.envelope.maker !== me && bet.taker !== me) continue;
    const ending = payoutScreen(bet, me, pending)?.ending;
    if (ending === "won" || ending === "conceded-by-other") won++;
    else if (ending === "lost" || ending === "conceded-by-me") lost++;
  }
  return { won, lost };
}
export const recordText = (r: { won: number; lost: number }): string => (r.won + r.lost === 0 ? "No bets settled yet" : `${r.won} won · ${r.lost} lost`);

/** The user's first bet (created_at, ns on chain -> ms), or null. The registry does not expose the claim date yet. */
export function memberSince(items: BetItem[]): number | null {
  const ts = items.map(({ bet }) => Number(bet.created_at)).filter((n) => Number.isFinite(n) && n > 0);
  return ts.length ? Math.floor(Math.min(...ts) / 1e6) : null;
}

// ---------------------------------------------------------------- token rows
export interface AccountRow {
  symbol: BetSymbol;
  /** B1 betting balance; null = unread (or still loading). */
  betting: bigint | null;
  bettingText: string | null;
  /** B3: "In your NEAR account: 5.1 NEAR" (non-zero only). */
  nearText: string | null;
  nearUnreadable: boolean;
  /** "Move to betting" sources for this token. */
  moves: Holding[];
  /** B4/B5: "In bets: 25.00 USDC (3 bets)"; null = nothing in bets, still loading, or unread (the page says so once). */
  inBetsText: string | null;
  /** B6 for this token: "Being paid out: 18.20 USDC". */
  payoutText: string | null;
  /** 0 betting balance and no secondary line: a compact muted row. */
  compact: boolean;
}

/** Bet tokens on `network` (all 6 on mainnet; USDC + NEAR on testnet). */
export const rowSymbols = (network: NetworkId): BetSymbol[] => BET_SYMBOLS.filter((s) => !!findAsset(s)?.ids[network] && !findAsset(s)?.disabledReason?.[network]);

/** One row per bet token: non-zero betting balances first (D-ASSET1 order), then the rest, compact when nothing else is there. */
export function accountRows(map: BalanceMap | null, report: MovableReport | null, bets: BetsState, network: NetworkId): AccountRow[] {
  const rows = rowSymbols(network).map((symbol): AccountRow => {
    // A successful betting read with no entry for a token is 0 (isEmptyAccount reads it the same way); only unread/loading is null.
    const betting = map && map.betting !== "error" ? map.betting[symbol] ?? 0n : null;
    let near = 0n;
    if (report) {
      near = report.holdings.filter((h) => h.symbol === symbol && h.source === "token").reduce((s, h) => s + BigInt(h.amountUnits), 0n);
      if (symbol === "NEAR") near += BigInt(report.native.yocto);
    }
    const nearUnreadable = !!report && report.readFailed.includes(symbol);
    // An unread bet list is ONE notice on the page (COPY.account.rowInBetsUnread), not the same line under every token.
    const locked = bets === "error" || bets === "loading" ? null : bets.inBets[symbol] ?? null;
    const paying = bets === "error" || bets === "loading" ? 0n : bets.payouts.filter((p) => p.symbol === symbol).reduce((s, p) => s + p.units, 0n);
    const nearText = near > 0n ? COPY.account.rowNearAccount(text(near, symbol)) : null;
    const inBetsText = locked && locked.units > 0n ? COPY.account.rowInBets(text(locked.units, symbol), locked.bets) : null;
    const payoutText = paying > 0n ? `${COPY.account.payoutsTitle}: ${text(paying, symbol)}` : null;
    return {
      symbol, betting, bettingText: betting === null ? null : text(betting, symbol), nearText, nearUnreadable,
      moves: report ? report.holdings.filter((h) => h.symbol === symbol) : [],
      inBetsText, payoutText,
      compact: betting === 0n && !nearText && !nearUnreadable && !inBetsText && !payoutText,
    };
  });
  return [...rows.filter((r) => (r.betting ?? 0n) > 0n), ...rows.filter((r) => !((r.betting ?? 0n) > 0n))];
}

/** First-time state: EVERY source was read and is 0 -- betting (B1, all 6), stray (B2), the NEAR account (B3: tokens + native NEAR),
 * the bet list (B4-B6) and transfers in flight (B7-B10). AFIX1 (familiarcow 11-13): a source that is still loading, or failed (timeout,
 * 429, a funding server that didn't answer), is NOT "nothing there": the page says it can't read, never "Add money". */
export function isEmptyAccount(map: BalanceMap | null, report: MovableReport | null, bets: BetsState, inFlightRead: boolean): boolean {
  if (!map || !report || !inFlightRead) return false;
  if (bets === "loading" || bets === "error") return false;
  if (map.betting === "error" || map.stray === "error" || map.nearAccount === "error") return false;
  if (Object.values(map.betting).some((v) => (v ?? 0n) > 0n) || map.stray.length) return false;
  if (report.holdings.length || BigInt(report.native.yocto) > 0n || report.readFailed.length) return false;
  if (bets.payoutsUnread || Object.values(bets.inBets).some((v) => v && v.units > 0n) || bets.payouts.length) return false;
  return map.inFlight.every((r) => TERMINAL_STATES.includes(r.state));
}

/** What loadMoney read (lib/accountBalances MoneyLoad). inFlightRead = the in-flight list is complete (false: its read failed). */
export interface MoneyRead { map: BalanceMap; report: MovableReport | null; inFlightRead: boolean }
/** AFIX1: the Account body is ONE of: a neutral placeholder until money AND bets have answered; the empty hero (every source read,
 * all 0); or the list (with each failed source's notice). Never a fake list first, never "empty" from a failed read. A re-read
 * (FUND1 focus, Retry, after a sheet) keeps the last answer on screen: only the first read of an account is "loading". */
export type AccountView = "loading" | "empty" | "list";
export function accountView(money: MoneyRead | null, bets: BetsState): AccountView {
  if (!money || bets === "loading") return "loading";
  return isEmptyAccount(money.map, money.report, bets, money.inFlightRead) ? "empty" : "list";
}
/** The page-level "We can't read your balance right now" + Retry: betting unread, the NEAR account wholly unread, or the in-flight
 * list unread. (Stray tokens, one NEAR-account token and the bet list say it in their own place.) */
export function moneyUnread(money: MoneyRead | null): boolean {
  return !!money && (money.map.betting === "error" || money.map.nearAccount === "error" || !money.report || !money.inFlightRead);
}

/** MON-3: "Cash out to my NEAR account" only for tokens a plain NEAR account can use (USDC, USDT, NEAR). BTC/ETH/ZEC sent there
 * were stranded (SM1 MON-3); they cash out through 1Click (F5) instead. */
export const canCashOutToNear = (symbol: string): boolean => symbol === "USDC" || symbol === "USDT" || symbol === "NEAR";

// ---------------------------------------------------------------- stray tokens (B2)
export interface StrayRow {
  assetId: string;
  title: string;
  amountText: string | null;
  unknown: boolean;
  /** Muted note ("Too small to convert"), or null. */
  note: string | null;
  /** Default Convert target (one of the 6), or null when it can't be converted (unknown id, dust). */
  convertTo: BetSymbol | null;
}
const networkName = (blockchain: string): string => NETWORKS[blockchain]?.[0] ?? blockchain;
const shortTokenId = (id: string): string => shortAddress(id.replace(/^nep\d+:/, ""));

export function strayRows(stray: StrayHolding[]): StrayRow[] {
  return stray.map((s) => {
    if (!s.token) return { assetId: s.assetId, title: COPY.account.strayUnknown(shortTokenId(s.assetId)), amountText: `${s.units} units`, unknown: true, note: null, convertTo: null };
    const title = COPY.account.strayRow(s.token.symbol, networkName(s.token.blockchain));
    const amountText = tokenAmount(s.units, s.token.decimals, s.token.symbol);
    return { assetId: s.assetId, title, amountText, unknown: false, note: s.dust ? COPY.account.strayDust : null, convertTo: s.dust ? null : convertTargets({ assetId: s.assetId, symbol: s.token.symbol }, "mainnet").default };
  });
}

// ---------------------------------------------------------------- in flight (B7-B10)
const STATE_WORD: Record<TrackState, string> = {
  waiting: "Waiting for your deposit", confirming: "Confirming", converting: "Converting", short: "Less than expected arrived",
  credited: "Done", refunded: "Returned", failed: "Needs help", expired: "Expired", checking: "Checking…",
};
export interface InFlightLine { id: string; text: string; state: string }

/** One compact line per open transfer, newest first. Token units; the address is never shown here (it lives in the tracker). */
export function inFlightLines(records: SwapRecord[]): InFlightLine[] {
  return records
    .filter((r) => !TERMINAL_STATES.includes(r.state))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => {
      const inText = `${tokenAmount(r.amountIn, r.origin.decimals, r.origin.symbol)} (${networkName(r.origin.blockchain)})`;
      const outSym = r.destination.symbol;
      const t = r.kind === "fund" ? `Adding ${inText} → ${outSym}`
        : r.kind === "convert" ? `Converting ${inText} → ${outSym}`
        : `Cashing out ${tokenAmount(r.amountIn, r.origin.decimals, r.origin.symbol)} as ${outSym} (${networkName(r.destination.blockchain)})`;
      return { id: r.id, text: t, state: STATE_WORD[r.state] };
    });
}
export const inFlightTitle = (records: SwapRecord[]): string | null => {
  const open = records.filter((r) => !TERMINAL_STATES.includes(r.state));
  return open.length ? COPY.account.inFlight(open.length, open.every((r) => r.kind === "fund")) : null;
};

// ---------------------------------------------------------------- the ?asset&need&return hand-off
/** "Your balance: 0.00 USDC. You need 10.00 USDC more." (needed rounds UP); null while the balance is unread. */
export function needHeadline(symbol: string, balance: bigint | null, need: { symbol: string; amount: string } | null): string | null {
  if (balance === null) return null;
  const a = findAsset(symbol);
  if (!a) return null;
  const bal = `Your balance: ${text(balance, symbol)}.`;
  if (!need) return balance === 0n ? `${bal} Add ${symbol} to place a bet.` : bal;
  const short = BigInt(toBaseUnits(need.symbol, need.amount)) - balance;
  if (short <= 0n) return `${bal} You have enough for this bet.`;
  return `${bal} You need ${tokenAmount(short, a.decimals, need.symbol, { round: "up" })} more.`;
}
