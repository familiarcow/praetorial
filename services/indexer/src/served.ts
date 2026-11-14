// IDX1: which escrow the indexer ingests and serves. ESCROW_CONTRACT_ID is the escrow the web and every other service use; when
// it is set the indexer reads and serves ONLY that contract (version label taken from ESCROW_CONTRACTS if listed there).
// Without it (ESCROW_CONTRACTS alone) the D-UPGRADE1 multi-contract list is used unchanged.
// Live bug 2026-11-10: after the frz2 -> frz3 switch the testnet indexer kept frz2 in ESCROW_CONTRACTS and served frz2 offers
// to a web pointed at frz3 (get_bet on frz3 -> '?' / 'terms unavailable'). Rows of other contracts stay in storage, unserved.
import type { EscrowContractRef } from "@praetorial/common/config.js";
import type { TaggedBet } from "@praetorial/common/discovery.js";

export function servedContracts(contracts: EscrowContractRef[], escrowContractId: string | undefined): EscrowContractRef[] {
  const id = escrowContractId?.trim();
  if (!id) return contracts;
  return [{ id, version: contracts.find((c) => c.id === id)?.version ?? "v1" }];
}

/** The subset of a cached bet map that belongs to the served contracts (insertion order kept). */
export function onlyServed(bets: Map<string, TaggedBet>, served: readonly string[]): Map<string, TaggedBet> {
  const ids = new Set(served);
  return new Map([...bets].filter(([, tb]) => ids.has(tb.contractId)));
}
