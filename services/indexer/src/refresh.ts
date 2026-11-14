// Indexer cache refresh (extracted from server.ts so it is testable).
//
// Desync defences, all display/liveness (funds never depend on the indexer):
//  * a contract whose scan fails keeps its previous entries; others refresh
//  * redeploy at the same account (bet ids restart): an id whose identity
//    (maker, terms_hash, created_at) changed is REPLACED, and entries above a
//    regressed frontier are dropped -- no ghost bets/history/bettors
//  * a lagging/lying read can never move a terminal bet (Settled/Voided/
//    Cancelled/Expired) back to a live status or change its outcome
//    (same identity): the cached terminal value wins
import type { NearClient } from "@praetorial/common/nearClient.js";
import type { EscrowContractRef } from "@praetorial/common/config.js";
import { discoverAllBetsMultiTolerant, type TaggedBet } from "@praetorial/common/discovery.js";
import { runVersionCheck } from "../../monitor/src/serviceAlerts.js";
import { TERMINAL, sameBet, confirmTerminals, type RefreshOptions } from "./refreshCore.js";
export type { RefreshOptions } from "./refreshCore.js";

export async function refreshBets(
  client: NearClient,
  contracts: EscrowContractRef[],
  prev: Map<string, TaggedBet>,
  maxIds: Record<string, number>,
  opts: RefreshOptions = {},
): Promise<{ bets: Map<string, TaggedBet>; maxIds: Record<string, number>; failed: { contractId: string; error: string }[] }> {
  const { bets: fresh, newMaxIds, failed, scanned } = await discoverAllBetsMultiTolerant(client, contracts, maxIds);
  const bets = new Map(prev);
  // Frontier regress => the contract's state was reset (redeploy): drop ghosts above it.
  // (discovery keeps the old max as a floor, so compare the highest id actually read.)
  const seenMax: Record<string, number> = {};
  for (const tb of fresh.values()) seenMax[tb.contractId] = Math.max(seenMax[tb.contractId] ?? 0, tb.betId);
  const outMax: Record<string, number> = { ...newMaxIds };
  for (const c of scanned) {
    const m = seenMax[c] ?? 0;
    if (m >= (maxIds[c] ?? 0)) continue;
    // Only a changed identity on an overlapping id proves a redeploy; a mere
    // shorter read could be a lagging node that has not seen the newest bets.
    let redeployed = false;
    for (const [k, tb] of fresh) {
      const old = prev.get(k);
      if (tb.contractId === c && old && !sameBet(old.bet, tb.bet)) redeployed = true;
    }
    if (!redeployed) continue;
    for (const [k, tb] of prev) if (tb.contractId === c && tb.betId > m) bets.delete(k);
    outMax[c] = m;
  }
  for (const [k, tb] of fresh) {
    const old = prev.get(k);
    if (old && sameBet(old.bet, tb.bet) && TERMINAL.has(old.bet.status)) {
      continue; // terminal is final; a lagging or lying read must not rewrite it
    }
    bets.set(k, tb);
  }
  if (opts.raiser) await runVersionCheck(client, contracts, opts.raiser);
  await confirmTerminals(bets, opts);
  return { bets, maxIds: outMax, failed };
}

// JC1y: per-contract governance event index. A contract whose history fetch fails keeps its previous events.
import type { GovernanceEvent } from "./governance.js";
import { indexGovernance } from "./governance.js";

export async function refreshGovernance(
  fetchHistory: (contractId: string) => Promise<{ hash: string; rc: any }[]>,
  contractIds: string[],
  prev: Map<string, GovernanceEvent[]>,
): Promise<{ events: Map<string, GovernanceEvent[]>; failed: { contractId: string; error: string }[] }> {
  const events = new Map(prev);
  const failed: { contractId: string; error: string }[] = [];
  for (const id of contractIds) {
    try { events.set(id, indexGovernance(id, await fetchHistory(id))); }
    catch (e) { failed.push({ contractId: id, error: e instanceof Error ? e.message : String(e) }); }
  }
  return { events, failed };
}
