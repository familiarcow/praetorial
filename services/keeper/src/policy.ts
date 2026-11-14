// Pure decision logic: given current bet state + wall-clock time, decide
// which permissionless contract method (if any) is due. No RPC, no I/O —
// this is the part unit tests exercise directly with fabricated Bet
// fixtures, independent of near-api-js/testnet.
import type { Bet } from "@praetorial/common/types.js";
import type { TaggedBet } from "@praetorial/common/discovery.js";
import { requestNotBeforeNs } from "./liveness.js";

export type KeeperAction =
  | { kind: "request_resolution"; bet_id: number }
  | { kind: "finalize"; bet_id: number }
  | { kind: "void_after_deadline"; bet_id: number }
  | { kind: "expire"; bet_id: number }
  // OQ-T11: replaces the old per-payout-id `retry_payout` action --
  // drain_payouts is the single permissionless entrypoint that fires a
  // bounded batch of a bet's still-pending ledger lines (new lines AND
  // retries of previously-failed ones alike), sized to fit well under
  // NEAR's 300 Tgas per-call ceiling even in the worst case.
  | { kind: "drain_payouts"; bet_id: number }
  // D-UPGRADE1: fired for every still-open bet on a contract version
  // that reports itself shut down (mocked `is_shutdown` view --
  // contracts/escrow/src/lib.rs has no such view today, see
  // common/src/shutdown.ts). Takes priority over whatever
  // nextActionForBet would otherwise decide for that bet.
  | { kind: "emergency_refund"; bet_id: number };

/** RF2c / D-REFUI4: named reason the AI/resolver path is skipped for a bet. A bet with a referee is
 * ruled by a person via `referee_rule`; the escrow refuses `request_resolution` on it, so the keeper
 * never fires it (silent referee: the permissionless `void_after_deadline` below still applies). */
export const REFEREE_BET_HUMAN_ONLY = "referee_bet_human_only";
export function aiPathSkipReason(bet: Bet): string | null {
  return bet.envelope.referee ? REFEREE_BET_HUMAN_ONLY : null;
}

/** lib.rs ROUND_WINDOW_NS: the challenge window after a bonded round is min(settlement_period, 24 h). */
export const ROUND_WINDOW_NS = 24 * 3600 * 1_000_000_000;
/** Request the re-judge at least this long before resolve_deadline, so the run can land before the contract stops taking it. */
export const REJUDGE_DEADLINE_MARGIN_NS = 3600 * 1_000_000_000;

const bondCount = (bet: Bet): number => (Array.isArray(bet.bonds) ? bet.bonds.length : 0);

/** The instant finalize's window check passes (lib.rs finalize: proposed_at + base_window + window_extension_ns), or null without a ruling. */
export function finalizeNotBeforeNs(bet: Bet): number | null {
  if (bet.proposed_at === null || bet.proposed_at === undefined) return null;
  const sp = Number(bet.envelope.settlement_period);
  const base = bondCount(bet) > 0 ? Math.min(sp, ROUND_WINDOW_NS) : sp;
  return Number(bet.proposed_at) + base + Number(bet.window_extension_ns ?? 0);
}

/** Exact mirror of lib.rs finalize's requires (shutdown excluded: the caller handles it). Null = the contract would accept
 * finalize now; otherwise the contract's own panic text. */
export function finalizeRefusal(bet: Bet, nowNs: number): string | null {
  if (!["Proposed", "Challenged", "Evidence"].includes(bet.status)) return "bet not Proposed/Challenged/Evidence";
  if (bondCount(bet) > 0 && (bet.status === "Challenged" || bet.status === "Evidence")) {
    if (!(nowNs >= Number(bet.envelope.resolve_deadline) || bet.runs_used >= bet.envelope.max_paid_runs)) return "challenge round pending a ruling";
  }
  const at = finalizeNotBeforeNs(bet);
  if (at === null || nowNs < at) return "settlement_period not elapsed";
  return null;
}

/** Mirror of lib.rs can_request_resolution for a challenged bet (status already Challenged/Evidence). Null = accepted. */
export function rejudgeRefusal(bet: Bet, nowNs: number): string | null {
  if (!["Taken", "Challenged", "Evidence"].includes(bet.status)) return "bet not awaiting resolution";
  if (bet.runs_used >= bet.envelope.max_paid_runs) return "max_paid_runs reached";
  if (nowNs >= Number(bet.envelope.resolve_deadline)) return "resolve_deadline passed";
  if (bet.envelope.referee) return "a person decides this bet (no AI run)";
  if (bet.no_live_judge_until_ns != null && nowNs < Number(bet.no_live_judge_until_ns)) return "waiting for a live judge model";
  return null;
}

/** LIFE1: when the keeper asks for the re-judge of a challenged ruling. Both sides may add evidence (submit_exhibits /
 * objections) while the bet is Challenged/Evidence, and the bond carries no timestamp on chain, so the evidence window is
 * the challenge window the contract itself uses (finalizeNotBeforeNs); never later than resolve_deadline - 1 h, and never
 * before a signed RETRY's next_check_ns. Null when the bet is not a challenged AI ruling. */
export function rejudgeDueNs(bet: Bet): number | null {
  if (!(bet.status === "Challenged" || bet.status === "Evidence") || bondCount(bet) === 0 || bet.envelope.referee) return null;
  const windowEnd = finalizeNotBeforeNs(bet) ?? 0;
  let due = Math.min(windowEnd, Number(bet.envelope.resolve_deadline) - REJUDGE_DEADLINE_MARGIN_NS);
  if (bet.next_check_ns != null) due = Math.max(due, Number(bet.next_check_ns));
  return due;
}

/** Decide the single next due action for one bet, or null if nothing is
 * due yet. Mirrors contract require()s in request_resolution/finalize/
 * void_after_deadline/expire so the keeper never fires a call the
 * contract would reject for being early/late/wrong-state (idempotent:
 * calling this again before the tx lands just re-proposes the same
 * action, which is harmless). */
export function nextActionForBet(bet: Bet, bet_id: number, nowNs: number): KeeperAction | null {
  const env = bet.envelope;
  const status: string = bet.status;

  if (status === "Open") {
    if (nowNs > env.funding_deadline) {
      return { kind: "expire", bet_id };
    }
    return null;
  }

  // Resolve deadline blown with no outcome yet -> permissionless void,
  // regardless of status (contract allows any non-terminal status).
  // "Finalized" (OQ-T11: outcome decided, ledger still draining) is
  // also terminal for this purpose -- void_after_deadline requires no
  // outcome set yet, which a Finalized bet always has.
  const terminal = ["Finalized", "Settled", "Voided", "Cancelled", "Expired", "Open"];
  if (!terminal.includes(status) && bet.outcome === null && nowNs > env.resolve_deadline) {
    return { kind: "void_after_deadline", bet_id };
  }

  // LIFE1 (SM1 SVC-2/LIFE-3): finalize only when the contract's own finalize gate passes (finalizeRefusal mirrors every
  // time/status require of lib.rs finalize: bonded base window, window_extension_ns, and the "challenge round pending a
  // ruling" gate). The old check (proposed_at + settlement_period) sent a refused finalize every tick after any
  // extend_window or challenge.
  if ((status === "Proposed" || status === "Challenged" || status === "Evidence") && finalizeRefusal(bet, nowNs) === null) {
    return { kind: "finalize", bet_id };
  }

  if (aiPathSkipReason(bet) !== null) return null; // RF2c: human-referee bet, no AI path

  // LIFE1 (SM1 LIFE-1/SVC-1): a challenged ruling (bond posted, status Challenged/Evidence) needs request_resolution for
  // the paid re-judge. The contract keeps `outcome` set and never clears `pending_resolution_request` after a verdict, so
  // the round-0 gates below (outcome === null, no pending request) must not apply here; without this branch nobody ever
  // asked for the re-judge and finalize at resolve_deadline forfeited the challenger's bond unreviewed.
  if ((status === "Challenged" || status === "Evidence") && bondCount(bet) > 0) {
    const due = rejudgeDueNs(bet);
    return due !== null && nowNs >= due && rejudgeRefusal(bet, nowNs) === null ? { kind: "request_resolution", bet_id } : null;
  }

  if (status === "Taken" || status === "Challenged" || status === "Evidence") {
    const earlyOk = env.early_settle_outcome !== null;
    // LH5: close-at-T sheets are requested from T + 5 min (earlier would just burn a RETRY run).
    const notBefore = requestNotBeforeNs(bet) ?? env.funding_deadline;
    const dueForResolution = nowNs >= notBefore || earlyOk;
    const runsLeft = bet.runs_used < env.max_paid_runs;
    const beforeDeadline = nowNs < env.resolve_deadline;
    // D-RESOLVE1 / item 7d3: the resolver signed RETRY (no admissible
    // data yet) and set bet.next_check_ns on-chain. submit_outcome's
    // RETRY branch never clears pending_resolution_request, so without
    // this branch the keeper's normal noPendingRequest gate below would
    // permanently block any further request_resolution for this bet.
    // Re-request once now >= next_check_ns; never before it.
    //
    // Item 7d4 (D-RESOLVE1 live wiring, resolver/README.md's job schema):
    // the resolver's live dispatch now reads first_unavailable_ns/retry_count
    // from the JOB JSON (chain-supplied, from get_bet) to decide RETRY vs
    // VOID:unavailable. This keeper only calls `request_resolution({bet_id})`
    // (services/keeper/src/runner.ts) -- it does NOT build the resolver's job
    // JSON itself, so there is no payload here to thread those two fields
    // through. Documented requirement for whoever DOES build that job JSON
    // (the OutLayer-side job builder): copy bet.first_unavailable_ns and
    // bet.retry_count (both already on the Bet type, services/common/src/types.ts)
    // onto the job verbatim every time, never leave them out once set.
    // JCB1 (D-JCB1): mirrors the contract's can_request_resolution gate after a RETRY:no_live_judge
    // (bet.no_live_judge_until_ns = max(signed next_check_ns, submit + 12h)); an earlier call is refused on-chain.
    if (bet.no_live_judge_until_ns != null && nowNs < Number(bet.no_live_judge_until_ns)) {
      return null;
    }
    // KEEPLIVE1: get_bet returns next_check_ns: null (not absent) when no RETRY was signed; null must NOT mean "due at 0".
    if (bet.next_check_ns != null && bet.outcome === null) {
      const nextCheckNs = Number(bet.next_check_ns);
      if (nowNs >= nextCheckNs && runsLeft && beforeDeadline) {
        return { kind: "request_resolution", bet_id };
      }
      return null;
    }
    const noPendingRequest = bet.pending_resolution_request === null;
    if (dueForResolution && noPendingRequest && runsLeft && beforeDeadline && bet.outcome === null) {
      return { kind: "request_resolution", bet_id };
    }
  }

  return null;
}

export function planActions(
  bets: Map<number, Bet>,
  nowNs: number,
  // OQ-T11: distinct bet_ids that have at least one not-yet-done
  // ledger line (from the contract's pending_payouts_view), not raw
  // payout ids -- one drain_payouts action per such bet, which the
  // contract internally batches/caps at MAX_DRAIN_BATCH.
  pendingPayoutBetIds: number[] = [],
): KeeperAction[] {
  const actions: KeeperAction[] = [];
  for (const [id, bet] of bets) {
    const a = nextActionForBet(bet, id, nowNs);
    if (a) actions.push(a);
  }
  for (const bet_id of pendingPayoutBetIds) {
    actions.push({ kind: "drain_payouts", bet_id });
  }
  return actions;
}

// Bet statuses that are already done -- emergency_refund on a
// shut-down contract only makes sense for a bet that still has funds
// escrowed and no final payout settled yet.
const TERMINAL_STATUSES = new Set(["Settled", "Voided", "Cancelled", "Expired"]);
// `Finalized` already had 100% of its money scheduled by the call that
// finalized it; the contract's emergency_refund is a no-op on it, so the
// only useful keeper action there is drain_payouts (red-team kill-switch run).
const NO_REFUND_STATUSES = new Set([...TERMINAL_STATUSES, "Finalized"]);

export interface ContractAction {
  contractId: string;
  action: KeeperAction;
}

/** D-UPGRADE1 multi-contract planner: for every bet across every
 * configured contract, either plans the normal next action (contract
 * still live) or, if the contract is in `shutdownContracts`, plans
 * `emergency_refund` for every bet on it that isn't already terminal
 * -- regardless of what nextActionForBet would otherwise have decided,
 * since a shut-down contract's only due action is getting user funds
 * back out. */
export function planActionsForContracts(
  bets: Map<string, TaggedBet>,
  nowNs: number,
  shutdownContracts: Set<string> = new Set(),
  pendingPayoutBetIds: { contractId: string; betId: number }[] = [],
): ContractAction[] {
  const actions: ContractAction[] = [];
  const refunded = new Set<string>();
  for (const [, tb] of bets) {
    if (shutdownContracts.has(tb.contractId)) {
      if (!NO_REFUND_STATUSES.has(tb.bet.status)) {
        actions.push({ contractId: tb.contractId, action: { kind: "emergency_refund", bet_id: tb.betId } });
        refunded.add(`${tb.contractId}:${tb.betId}`);
      }
      continue;
    }
    const a = nextActionForBet(tb.bet, tb.betId, nowNs);
    if (a) actions.push({ contractId: tb.contractId, action: a });
  }
  for (const { contractId, betId } of pendingPayoutBetIds) {
    // emergency_refund only SCHEDULES ledger lines (it never fires the
    // transfers), so on a shut-down contract they still need drain_payouts.
    // Skip only a bet being refunded in THIS tick: it has no refund lines
    // yet, and the next tick drains them.
    if (shutdownContracts.has(contractId) && refunded.has(`${contractId}:${betId}`)) continue;
    actions.push({ contractId, action: { kind: "drain_payouts", bet_id: betId } });
  }
  return actions;
}
