// JC1y: governance event index (judge chain, guardian, assets, amendments, model observations) built from the escrow's
// tx-history receipts. Logs of failed receipts are ignored (D-JCD1 #5). Read-only; display/liveness only.
import { GOVERNANCE_EVENT_KIND, indexGovernanceEvents, type IndexedGovernanceEvent } from "@praetorial/common/escrowEvents.js";

export type GovernanceEvent = IndexedGovernanceEvent;
export const GOVERNANCE_KINDS = [...new Set(Object.values(GOVERNANCE_EVENT_KIND))] as readonly string[];
export const indexGovernance = indexGovernanceEvents;
