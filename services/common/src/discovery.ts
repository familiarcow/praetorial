// Bet discovery: the contract has no "list all bets" view (only
// `open_offers`, which filters to status=Open). bet_id is a dense
// sequential counter starting at 1, so a keeper/indexer can discover
// every bet that has ever existed by probing get_bet(id) upward from 1
// until it hits a gap past the known frontier. Cheap at testnet volumes;
// documented here as the thing to replace with an event-indexed store
// (board indexer's own job) before any real scale.
import type { NearClient } from "./nearClient.js";
import type { Bet } from "./types.js";
import type { EscrowContractRef } from "./config.js";

export async function discoverAllBets(
  client: NearClient,
  escrowContract: string,
  knownMaxId: number,
): Promise<{ bets: Map<number, Bet>; newMaxId: number }> {
  const bets = new Map<number, Bet>();
  let id = 1;
  let misses = 0;
  let maxSeen = knownMaxId;
  // Scan from 1 every time (LookupMap view calls are cheap reads); stop
  // once we pass the known frontier and hit a few consecutive misses.
  while (id <= Math.max(knownMaxId + 5, 1) + misses) {
    const bet = await client.view<Bet | null>(escrowContract, "get_bet", { bet_id: id });
    if (bet) {
      bets.set(id, bet);
      maxSeen = Math.max(maxSeen, id);
      misses = 0;
    } else {
      misses += 1;
      if (id > knownMaxId && misses >= 3) break;
    }
    id += 1;
  }
  return { bets, newMaxId: maxSeen };
}

// D-UPGRADE1: a bet discovered from a multi-contract scan, tagged with
// which contract (id + declared version) it came from so every
// downstream consumer (keeper policy, indexer board, notifier) can
// attribute/act on it per-contract.
export interface TaggedBet {
  betId: number;
  bet: Bet;
  contractId: string;
  version: string;
  // D-DSY1: set by the indexer refresh for Settled/Voided bets: true once
  // a second RPC returned the same terminal state, false while unconfirmed.
  // undefined for non-terminal bets.
  confirmed?: boolean;
}

function taggedKey(contractId: string, betId: number): string {
  return `${contractId}:${betId}`;
}

/** Runs discoverAllBets against every configured contract and merges the
 * results into one map keyed by "<contractId>:<betId>" (bet ids are
 * only unique within a single contract, so the plain numeric id alone
 * cannot be the key once more than one contract is in play). */
export async function discoverAllBetsMulti(
  client: NearClient,
  contracts: EscrowContractRef[],
  knownMaxIds: Record<string, number>,
): Promise<{ bets: Map<string, TaggedBet>; newMaxIds: Record<string, number> }> {
  const bets = new Map<string, TaggedBet>();
  const newMaxIds: Record<string, number> = { ...knownMaxIds };
  for (const contract of contracts) {
    const known = knownMaxIds[contract.id] ?? 0;
    const { bets: contractBets, newMaxId } = await discoverAllBets(client, contract.id, known);
    newMaxIds[contract.id] = newMaxId;
    for (const [betId, bet] of contractBets) {
      bets.set(taggedKey(contract.id, betId), { betId, bet, contractId: contract.id, version: contract.version });
    }
  }
  return { bets, newMaxIds };
}

/** Failure-isolated variant of discoverAllBetsMulti: one contract whose scan
 * throws (removed/typo'd account, RPC error on that account) is reported in
 * `failed` and keeps its previous frontier, instead of aborting the scan of
 * every other contract (which would blind the keeper to live bets => missed
 * finalize/request_resolution everywhere). */
export async function discoverAllBetsMultiTolerant(
  client: NearClient,
  contracts: EscrowContractRef[],
  knownMaxIds: Record<string, number>,
): Promise<{
  bets: Map<string, TaggedBet>;
  newMaxIds: Record<string, number>;
  failed: { contractId: string; error: string }[];
  scanned: Set<string>;
}> {
  const bets = new Map<string, TaggedBet>();
  const newMaxIds: Record<string, number> = { ...knownMaxIds };
  const failed: { contractId: string; error: string }[] = [];
  const scanned = new Set<string>();
  for (const contract of contracts) {
    try {
      const { bets: contractBets, newMaxId } = await discoverAllBets(client, contract.id, knownMaxIds[contract.id] ?? 0);
      newMaxIds[contract.id] = newMaxId;
      scanned.add(contract.id);
      for (const [betId, bet] of contractBets) {
        bets.set(taggedKey(contract.id, betId), { betId, bet, contractId: contract.id, version: contract.version });
      }
    } catch (err: any) {
      failed.push({ contractId: contract.id, error: String(err?.message ?? err) });
    }
  }
  return { bets, newMaxIds, failed, scanned };
}
