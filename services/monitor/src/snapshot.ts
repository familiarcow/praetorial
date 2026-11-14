// Live chain-state snapshot reader: pulls exactly what invariants.ts
// needs from the real escrow + mock-intents contracts via NearClient
// (view calls only — this service never signs anything). Used by the
// lifecycle matrix runner after every testnet tx.
import type { NearClient } from "@praetorial/common/nearClient.js";
import type { Bet, PendingPayout } from "@praetorial/common/types.js";
import {
  runMonitor,
  type Actors,
  type LifecycleAction,
  type MonitorResult,
} from "./invariants.js";

export interface ContractAccounts {
  feeAccount: string;
  keeper: string;
}

/** funds_in for a bet = everything the two parties ever transferred into
 * it: both stakes + both storage charges. D-ECON5: no per-bet reserve
 * exists any more -- round-0's judge run is funded entirely by
 * keeper_credit, never drawn from bet money. Bonds and objection
 * deposits are separate transfers tracked as additional payouts
 * (schedule_payout rows), not counted here, so they fall out of the I-2
 * per-bet check naturally (a bond refund payout without a matching
 * "funds_in" bump would look like overpay) — we add it in explicitly
 * from the bet's own bonds/objection_deposits arrays below. */
/** STG1 (D-STORAGE1): each side's stored storage charge (own asset). Falls back to the legacy envelope field only
 * when the bet view predates STG1 (no storage_maker/storage_taker). */
export function sideStorage(bet: Bet): { maker: bigint; taker: bigint } {
  const legacy = BigInt(bet.envelope.storage_charge_per_side ?? 0);
  return {
    maker: bet.storage_maker !== undefined ? BigInt(bet.storage_maker) : legacy,
    taker: bet.storage_taker !== undefined ? BigInt(bet.storage_taker) : legacy,
  };
}

export function fundsInForBet(bet: Bet): bigint {
  const env = bet.envelope;
  let total =
    BigInt(env.stake_maker) +
    BigInt(env.stake_taker) +
    sideStorage(bet).maker + sideStorage(bet).taker;
  for (const b of bet.bonds as any[]) {
    if (b && b.amount !== undefined) total += BigInt(b.amount.toString?.() ?? b.amount);
  }
  for (const d of bet.objection_deposits as any[]) {
    if (d && d.amount !== undefined) total += BigInt(d.amount.toString?.() ?? d.amount);
  }
  return total;
}

/** Contract-wide tracked total: D-ECON5 removed the per-bet reserve, so
 * there is no reserve_remaining counter left to sum -- what the
 * contract still holds against a bet is simply fundsInForBet() (stakes
 * + storage + bonds/objection deposits) minus whatever's already
 * actually left (done payouts), tracked per-bet in `trackedTotal` below
 * plus the amount of every payout row not yet `done` (scheduled but not
 * sent). This is compared against the escrow contract's live intents
 * balance; any gap is flagged, which is exactly what I-2 contract-wide
 * asks for. */
const TERMINAL_STATUSES = new Set(["Settled", "Voided", "Cancelled", "Expired"]);

/** For a non-terminal bet, the contract still holds everything funded in
 * minus whatever's already actually left (done payouts) -- pending
 * (not-yet-done) payouts are still held, which falls out naturally since
 * they're not subtracted. For a terminal bet, every payout that was ever
 * going to be scheduled has been scheduled; whatever's `done` has left,
 * and whatever's still `!done` (a failed-and-not-yet-retried transfer,
 * I-4's exact case) is still sitting in the contract and must still
 * count. Getting this split wrong is exactly how I-2 contract-wide
 * false-positives: see g4 lifecycle matrix run, 2026-11-02 (first draft
 * summed fundsIn only for non-terminal bets but subtracted *every*
 * bet's done payouts regardless of status, driving the tracked total
 * negative for every settled/cancelled/expired bet in history). */
export async function trackedTotal(
  client: NearClient,
  escrowContract: string,
  betIds: number[],
): Promise<bigint> {
  let sum = 0n;
  for (const v of (await trackedTotalByAsset(client, escrowContract, betIds)).values()) sum += v;
  return sum;
}

/** Per-asset funds-in of one bet: each side's stake + storage in its own
 * asset, bonds/objection deposits in their recorded `asset` (D-BOND1). */
export function fundsInByAsset(bet: Bet): Map<string, bigint> {
  const env = bet.envelope;
  const m = new Map<string, bigint>();
  const add = (asset: string, amt: bigint) => m.set(asset, (m.get(asset) ?? 0n) + amt);
  add(env.maker_asset, BigInt(env.stake_maker) + sideStorage(bet).maker);
  add(env.taker_asset, BigInt(env.stake_taker) + sideStorage(bet).taker);
  for (const x of [...(bet.bonds as any[]), ...(bet.objection_deposits as any[])]) {
    if (x && x.amount !== undefined) add(x.asset ?? env.maker_asset, BigInt(x.amount.toString?.() ?? x.amount));
  }
  return m;
}

/** One bet's contribution to the contract-wide tracked total, per asset (pure; CF1c's Worker sums it across ticks). */
export function trackedContributionForBet(bet: Bet, betPayouts: PendingPayout[]): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const add = (asset: string, amt: bigint) => out.set(asset, (out.get(asset) ?? 0n) + amt);
  if (TERMINAL_STATUSES.has(bet.status)) {
    for (const p of betPayouts) {
      if (!p.done) add(p.token_id, BigInt(p.amount));
    }
  } else {
    for (const [asset, amt] of fundsInByAsset(bet)) add(asset, amt);
    for (const p of betPayouts) {
      if (p.done) add(p.token_id, -BigInt(p.amount));
    }
  }
  return out;
}

/** Same semantics as the old single-total trackedTotal, split by asset id. */
export async function trackedTotalByAsset(
  client: NearClient,
  escrowContract: string,
  betIds: number[],
): Promise<Map<string, bigint>> {
  const payouts = await client.view<PendingPayout[]>(escrowContract, "pending_payouts_view", { from: 0, limit: 500 });
  const payoutsByBet = new Map<number, PendingPayout[]>();
  for (const p of payouts) {
    const arr = payoutsByBet.get(p.bet_id) ?? [];
    arr.push(p);
    payoutsByBet.set(p.bet_id, arr);
  }

  const totals = new Map<string, bigint>();
  const add = (asset: string, amt: bigint) => totals.set(asset, (totals.get(asset) ?? 0n) + amt);
  for (const id of betIds) {
    const bet = await client.view<Bet | null>(escrowContract, "get_bet", { bet_id: id });
    if (!bet) continue;
    for (const [asset, amt] of trackedContributionForBet(bet, payoutsByBet.get(id) ?? [])) add(asset, amt);
  }
  return totals;
}

export async function checkAfterStep(opts: {
  client: NearClient; // view-capable client (any signer or view-only)
  escrowContract: string;
  intentsContract: string;
  usdcTokenId: string;
  betId: number;
  allBetIdsForContractWide: number[];
  accounts: ContractAccounts;
  action: LifecycleAction;
  actionWasBlocked: boolean;
  /** Escrow's intents USDC balance captured once before this run's first
   * tx. Contract-wide I-2 is checked as a DELTA from this baseline,
   * scoped to `allBetIdsForContractWide` (this run's own bets) only --
   * not a from-scratch reconstruction of the contract's entire history.
   * There is no view method (or indexed event log) that lets an
   * external monitor replay every bet the contract has ever touched, so
   * reconstructing an absolute "total ever tracked" figure from current
   * state alone is unsound whenever older, still-open bets from earlier
   * sessions are sitting in the same contract (confirmed live here:
   * praetorial-dev-1101.testnet carries bets from the services v0 and
   * g3_round_trip runs that this matrix never touches). A delta from a
   * known-good baseline, scoped to the bets this run itself created, is
   * the correct invariant to check without an indexer. */
  baselineBalanceYocto: bigint;
  /** Bonds/objection deposits ever sent for this bet, cumulative across
   * every round, supplied by the caller (who sent the transfers and
   * knows the exact amounts). `fundsInForBet` reads `bet.bonds` /
   * `bet.objection_deposits` LIVE off current chain state, but
   * `finalize` (and `void_after_deadline`) both `std::mem::take` those
   * arrays as part of settling them in the SAME transaction that pays
   * them out -- so a post-finalize snapshot sees an empty array and
   * silently drops that money from "funds in", producing a false I-2
   * per-bet violation ("paid out X exceeds funded in Y") even though
   * nothing was actually lost on-chain. This field is the fix: it lets
   * the caller carry the true lifetime total forward past the point the
   * contract clears its own bookkeeping. */
  extraFundsInYocto?: bigint;
}): Promise<MonitorResult & { raw: { paused: boolean; betStatus: string | null } }> {
  const { client, escrowContract, intentsContract, usdcTokenId, betId, accounts } = opts;

  const bet = await client.view<Bet | null>(escrowContract, "get_bet", { bet_id: betId });
  const paused = await client.view<boolean>(escrowContract, "is_paused", {});
  const allPayouts = await client.view<PendingPayout[]>(escrowContract, "pending_payouts_view", { from: 0, limit: 500 });
  const betPayouts = allPayouts.filter((p) => p.bet_id === betId);

  const actors: Actors = {
    maker: bet?.envelope.maker ?? "",
    taker: bet?.taker ?? null,
    feeAccount: accounts.feeAccount,
    keeper: accounts.keeper,
    arbiter: bet?.envelope.arbiter ?? null,
  };

  const fundsIn = (bet ? fundsInForBet(bet) : 0n) + (opts.extraFundsInYocto ?? 0n);
  const tracked = await trackedTotal(client, escrowContract, opts.allBetIdsForContractWide);
  const actualBalance = await client.view<string>(intentsContract, "mt_balance_of", {
    account_id: escrowContract,
    token_id: usdcTokenId,
  });
  const actualDelta = BigInt(actualBalance) - opts.baselineBalanceYocto;

  const result = runMonitor({
    betId,
    paused,
    actors,
    payouts: betPayouts,
    fundsIn,
    trackedTotalYocto: tracked,
    actualIntentsBalanceYocto: actualDelta,
    action: opts.action,
    actionWasBlocked: opts.actionWasBlocked,
    bet: bet ?? undefined,
  });

  return { ...result, raw: { paused, betStatus: bet?.status ?? null } };
}
