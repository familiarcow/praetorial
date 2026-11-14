// F3 (FUND4 SPEC §1, SM2 STATES.md gap F3-2): the Account screen's reads. Two independent loads, so the balances never wait for the
// (slower) bet list and one failing never hides the other (FUND1 rule):
//   loadMoney: lib/funding/balances.loadBalanceMap -- B1 betting (one mt_batch_balance_of), B2 stray tokens + 1Click names/prices
//              (mainnet reads only), B3 the NEAR account (moveToBetting.movableReport, all 6 tokens: MON-3), B7-B10 in flight
//              (lib/funding/store: this device + the funding Worker's list when one is configured).
//   loadBets:  the user's bets (indexer /history?account= then get_bet each, pending_payouts for a Finalized bet) -> B4/B5 in bets,
//              B6 being paid out, the record and the first bet.
// Every caller takes a lib/funding/balances createSequence() token, so an older read never overwrites a newer one (SM1 MON-7).
import { loadBalanceMap, readStray } from "./funding/balances";
import type { BalanceMap, BetSymbol, SwapRecord, TokenOption } from "./funding/types";
import { loadTokens } from "./funding/tokens";
import { createFundingClient } from "./funding/fundingClient";
import { loadLocal, syncInFlight } from "./funding/store";
import { movableReport, type MovableReport } from "./moveToBetting";
import { viewFunction } from "./rpc";
import { CURRENT_NETWORK, type NetworkId } from "./assets";
import { NETWORK } from "./network";
import { ESCROW_CONTRACT_ID } from "./config";
import { fetchHistory } from "./indexerClient";
import { getBet } from "./escrowAdapter";
import { chainClock } from "./chainClock";
import type { PayoutLine } from "./payoutScreen";
import { lockedInBets, payoutsFromBets, betRecord, memberSince, type BetItem, type BetsSection } from "./walletCards";

type View = (contract: string, method: string, args: Record<string, unknown>) => Promise<unknown>;
const rpcView: View = (c, m, a) => viewFunction<unknown>(c, m, a);

/** B1 read with a fallback: when `mt_batch_balance_of` is missing or answers in an unexpected shape, one `mt_balance_of` per token
 * (same rule as intentsBalance.fetchIntentsBalances). A failing RPC still throws: the section is "can't read", never 0. */
export function batchFallbackView(view: View): View {
  return async (contract, method, args) => {
    if (method !== "mt_batch_balance_of") return view(contract, method, args);
    const ids = (args.token_ids as string[]) ?? [];
    let r: unknown;
    let threw: unknown = null;
    try { r = await view(contract, method, args); } catch (e) { threw = e; }
    if (Array.isArray(r) && r.length === ids.length && r.every((x) => typeof x === "string" && /^\d+$/.test(x))) return r;
    try {
      // AFIX1: a per-token answer that is not a number (an empty / null body) is a failed read, never "0".
      return await Promise.all(ids.map(async (token_id) => {
        const v = await view(contract, "mt_balance_of", { account_id: args.account_id, token_id });
        if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error("malformed mt_balance_of answer");
        return v;
      }));
    } catch (e) { throw threw ?? e; }
  };
}

/** B3 per bet token from the NEAR-account report (wrapped + native NEAR together). null report = "error". */
export function nearAccountFrom(report: MovableReport | null): Partial<Record<BetSymbol, bigint>> | "error" {
  if (!report) return "error";
  const out: Partial<Record<BetSymbol, bigint>> = {};
  for (const h of report.holdings) if (h.source === "token") out[h.symbol as BetSymbol] = (out[h.symbol as BetSymbol] ?? 0n) + BigInt(h.amountUnits);
  if (BigInt(report.native.yocto) > 0n) out.NEAR = (out.NEAR ?? 0n) + BigInt(report.native.yocto);
  return out;
}

/** inFlightRead (AFIX1): the in-flight list is complete. false when its read threw, or a funding server is configured for this
 * network and did not answer (timeout / 429 / 5xx): this device's records alone may miss a deposit made elsewhere. */
export interface MoneyLoad { map: BalanceMap; report: MovableReport | null; tokens: TokenOption[]; serverInFlight: boolean; inFlightRead: boolean }
/** serverExpected: a funding server's list is part of the answer (false = this device's records are the whole list). */
export type InFlightRead = { records: SwapRecord[]; serverOk: boolean; serverExpected?: boolean };
export interface MoneyDeps {
  network?: NetworkId;
  /** Read stray tokens and 1Click prices (mainnet; a mocked spec turns it on with the deposit-API seam). */
  mainnetReads?: boolean;
  view?: View;
  report?: (account: string) => Promise<MovableReport>;
  tokens?: () => Promise<TokenOption[]>;
  inFlight?: (account: string) => Promise<InFlightRead>;
}

/** The in-flight list: this device's records, plus the funding Worker's list when it is configured (mainnet; never on testnet). */
async function defaultInFlight(account: string): Promise<InFlightRead> {
  if (!NETWORK.fundingUrl || CURRENT_NETWORK !== "mainnet") return { records: loadLocal(account), serverOk: false, serverExpected: false };
  return { ...(await syncInFlight(account, { client: createFundingClient() })), serverExpected: true };
}

export async function loadMoney(account: string, d: MoneyDeps = {}): Promise<MoneyLoad> {
  const network = d.network ?? CURRENT_NETWORK;
  const mainnetReads = d.mainnetReads ?? network === "mainnet";
  const view = batchFallbackView(d.view ?? rpcView);
  let tokens: TokenOption[] = [];
  if (mainnetReads) { try { tokens = d.tokens ? await d.tokens() : (await loadTokens()).list; } catch { tokens = []; } }
  let report: MovableReport | null = null;
  let serverInFlight = false;
  let inFlightRead = false;
  const map = await loadBalanceMap(account, {
    view, network, tokens,
    nearAccount: async () => {
      report = await (d.report ?? ((a) => movableReport(a, network)))(account);
      const m = nearAccountFrom(report);
      if (m === "error") throw new Error("unread");
      return m;
    },
    // B4-B6 come from loadBets (a separate, slower read); the balance map's own sections stay unused here.
    inBets: async () => ({}),
    payouts: async () => [],
    inFlight: async () => {
      const r = await (d.inFlight ?? defaultInFlight)(account);
      serverInFlight = r.serverOk;
      inFlightRead = r.serverOk || r.serverExpected === false;
      return r.records;
    },
  });
  // B2 is a mainnet read: on a testnet build with the mocked mainnet seam, read it against intents.near.
  if (mainnetReads && network !== "mainnet") {
    try { map.stray = await readStray(account, view, tokens, "mainnet"); } catch { map.stray = "error"; }
  }
  return { map, report, tokens, serverInFlight, inFlightRead };
}

// ---------------------------------------------------------------- the user's bets
export interface BetsDeps {
  history?: (account: string) => Promise<{ bet_id: number }[]>;
  getBet?: (id: number) => Promise<import("./escrowAdapter").Bet | null>;
  pendingPayouts?: (id: number) => Promise<PayoutLine[]>;
  nowNs?: () => number;
  network?: NetworkId;
  contractId?: string;
}

export async function loadBets(account: string, d: BetsDeps = {}): Promise<BetsSection> {
  const network = d.network ?? CURRENT_NETWORK;
  const hist = await (d.history ?? fetchHistory)(account);
  const items: BetItem[] = [];
  let payoutsUnread = false;
  for (const id of [...new Set(hist.map((h) => h.bet_id))]) {
    const bet = await (d.getBet ?? getBet)(id);
    if (!bet) continue;
    let pending: PayoutLine[] | null = null;
    // pending_payouts only exists for a Finalized bet (the drain queue); every other status has no lines.
    if (bet.status === "Finalized") {
      try { pending = await (d.pendingPayouts ?? ((b) => viewFunction<PayoutLine[]>(ESCROW_CONTRACT_ID, "pending_payouts", { bet_id: b })))(id); } catch { pending = null; payoutsUnread = true; }
    }
    items.push({ bet, pending });
  }
  const nowNs = d.nowNs ? d.nowNs() : (chainClock.nowMs() ?? Date.now()) * 1e6;
  return {
    inBets: lockedInBets(items, account, nowNs, d.contractId ?? ESCROW_CONTRACT_ID, network),
    payouts: payoutsFromBets(items, account, network),
    record: betRecord(items, account),
    memberSince: memberSince(items),
    payoutsUnread,
  };
}

// ---------------------------------------------------------------- SM2 gap F3-4: is the user findable as a referee?
/** The registry's lookup does not return the "discoverable" flag, but its search lists only discoverable users: the user is
 * listed when searching their exact name returns their own account (search gives a tail: full id for named accounts, the last 8
 * characters of a 64-hex one). true / false, or null when the registry can't be asked (no URL, no name, a failed read). */
export async function refereeListed(registryUrl: string, username: string | null, account: string, fetchImpl?: typeof fetch): Promise<boolean | null> {
  if (!registryUrl || !username) return null;
  const { HttpUserRegistry } = await import("./refereeRegistry");
  try {
    const rows = await new HttpUserRegistry(registryUrl, fetchImpl).searchStrict(username);
    return rows.some((r) => r.username.toLowerCase() === username.toLowerCase() && (r.account === account || account.endsWith(r.account)));
  } catch { return null; }
}
