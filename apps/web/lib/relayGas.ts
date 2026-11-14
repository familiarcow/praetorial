// REFGAS1: the ONE place prepaid gas for a relayed call is decided. Components and libs never pass a number; useRelayAction looks the
// method up here. Values are the contract's worst-case need (contracts/escrow/src/lib.rs, read-only) capped at NEAR's 300 Tgas per tx.
// Unused prepaid gas is refunded, so over-attaching costs nothing; under-attaching ("Exceeded the prepaid gas") fails the call
// (DR5 live, tx FqawWQJpM67YzBKEutNStjQcqfRiB3bdMkk3NPCgsfyJ: referee_rule at the old 80 Tgas default).
export const MAX_PREPAID_TGAS = 300; // NEAR protocol max prepaid gas per transaction

// lib.rs :248-251 / :267 / :253
const OUTLAYER_GAS = 80, RESOLUTION_CALLBACK_GAS = 20, PAYOUT_GAS = 15, PAYOUT_CALLBACK_GAS = 10, REFUND_GAS = 15;
const cap = (n: number) => Math.min(n, MAX_PREPAID_TGAS);
// Methods that schedule payouts and then drain them in the same call (schedule_payout x N + drain_payouts(MAX_DRAIN_BATCH=10), lib.rs :250-253:
// 10 x (PAYOUT_GAS + PAYOUT_CALLBACK_GAS) = 250 Tgas static + base overhead) -> the full 300.
const PAYOUT_FANOUT = cap(10 * (PAYOUT_GAS + PAYOUT_CALLBACK_GAS) + 50);

export const RELAY_GAS_TGAS: Readonly<Record<string, number>> = {
  // escrow: payout fan-out (lib.rs referee_rule :3399, finalize :3851, concede :4722, cancel :2532, void_after_deadline :4295, emergency_refund :5279, drain_payouts :4660)
  referee_rule: PAYOUT_FANOUT,
  finalize: PAYOUT_FANOUT,
  concede: PAYOUT_FANOUT,
  cancel: PAYOUT_FANOUT,
  void_after_deadline: PAYOUT_FANOUT,
  emergency_refund: PAYOUT_FANOUT,
  drain_payouts: PAYOUT_FANOUT,
  // KEEPSUBMIT1W: submit_outcome (lib.rs :3105, no deposit) verifies the signature and may settle the bet with the payout fan-out -> the full 300
  submit_outcome: PAYOUT_FANOUT,
  // lib.rs :2671: OUTLAYER_GAS + RESOLUTION_CALLBACK_GAS = 100, plus 50 headroom (on_resolution may fire a REFUND_GAS refund)
  request_resolution: OUTLAYER_GAS + RESOLUTION_CALLBACK_GAS + REFUND_GAS + 35,
  // INTENTS1: open / take / challenge = intents mt_transfer_call -> escrow mt_on_transfer (lib.rs MT_ON_TRANSFER_GAS_BUDGET_TGAS 30 :171;
  // real intents.near forwards ALL remaining gas to mt_on_transfer and reserves 15 Tgas for mt_resolve_transfer, the refund leg)
  mt_transfer_call: 150,
  // no promises: state-only writes (lib.rs submit_exhibits :3607, amend_referee)
  amend_referee: 80,
  submit_exhibits: 80,
  // intents / token contracts (not the escrow): the existing live-proven budgets
  ft_withdraw: 100,
  storage_deposit: 30,
  near_deposit: 30,
  ft_transfer_call: 100,
};

export function gasForMethod(methodName: string): number {
  const g = RELAY_GAS_TGAS[methodName];
  if (g === undefined) throw new Error(`no gas entry for relayed method "${methodName}" (add it to lib/relayGas.ts)`);
  return g;
}

export const WITHDRAW_GAS_TGAS = RELAY_GAS_TGAS.ft_withdraw;
export const STORAGE_DEPOSIT_GAS_TGAS = RELAY_GAS_TGAS.storage_deposit;

/** Panic text out of a failed-receipt dump, else the raw text trimmed. */
function reasonOf(raw: string): string {
  const m = /Smart contract panicked: ([^"\\\]}]+)/.exec(raw);
  return (m ? m[1] : raw).trim().slice(0, 240);
}

/** When the relayed tx REACHED the chain and failed, the plain-English refusal; null when it never got that far. */
export function contractRefusalMessage(r: { ok: boolean; txHash?: string; receiptFailure?: string; error?: string }): string | null {
  if (r.ok || !r.txHash) return null;
  const raw = r.receiptFailure ?? r.error;
  if (!raw) return null;
  return `The contract refused this: ${reasonOf(raw)}${/[.!?]$/.test(reasonOf(raw)) ? "" : "."} No money moved.`;
}
