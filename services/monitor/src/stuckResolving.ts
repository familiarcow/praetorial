// LIFE1 (SM1 CON-2 / CON-3 / LIFE-9): alert on bets the frozen escrow can no longer move on by itself.
//  * bet_stuck_resolving: status Resolving and either the stored output for the in-flight run can never be applied
//    (keeper/src/resolvingState.ts classifyResolving -> "stuck"), or the bet has sat in Resolving longer than the
//    threshold (an OutLayer run lands in minutes; a ready result the keeper never relayed shows up here too).
//    CRITICAL when a ruling is already set: request_resolution, finalize and void_after_deadline all refuse such a bet
//    (CON-2), the only exits are concede by a party or a contract-wide emergency shutdown. WARNING without a ruling: the
//    keeper voids it after resolve_deadline (CON-3).
//  * resolution_exhausted: an AI bet back in Taken with no result and every paid run used. Nothing can resolve it any more;
//    void_after_deadline refunds both sides after resolve_deadline (CON-3).
// Operator steps: release/mainnet-night/RUNBOOK-stuck-resolving.md.
import type { Bet } from "@praetorial/common/types.js";
import { classifyResolving } from "../../keeper/src/resolvingState.js";
import type { Alert } from "./alertsCore.js";

export const STUCK_RESOLVING_THRESHOLD_NS = 3600 * 1_000_000_000;
const RUNBOOK = "release/mainnet-night/RUNBOOK-stuck-resolving.md";

export interface ResolvingWatch {
  kind: "resolving" | "exhausted";
  /** ns when the monitor first saw the bet in this condition (kept across sweeps while it lasts). */
  since: number;
  /** classifyResolving's reason when the stored output can never be applied; null while it may still land. */
  stuck: string | null;
  ruling: string | null;
  resolveDeadlineNs: number;
  runs: string;
}

/** The watch entry for one bet read this sweep (null: nothing to watch). `prev` keeps the first-seen clock. */
export function observeBet(contractId: string, betId: number, bet: Bet, nowNs: number, prev?: ResolvingWatch): ResolvingWatch | null {
  const runs = `${bet.runs_used}/${bet.envelope.max_paid_runs}`;
  const base = { ruling: bet.outcome ?? null, resolveDeadlineNs: Number(bet.envelope.resolve_deadline), runs };
  if (bet.status === "Resolving") {
    const c = classifyResolving(contractId, betId, bet, nowNs);
    return { kind: "resolving", since: prev?.kind === "resolving" ? prev.since : nowNs, stuck: c.kind === "stuck" ? c.reason : null, ...base };
  }
  const exhausted = bet.status === "Taken" && !bet.envelope.referee && (bet.outcome === null || bet.outcome === undefined)
    && bet.runs_used >= bet.envelope.max_paid_runs && nowNs <= Number(bet.envelope.resolve_deadline);
  if (exhausted) return { kind: "exhausted", since: prev?.kind === "exhausted" ? prev.since : nowNs, stuck: null, ...base };
  return null;
}

const utc = (ns: number) => new Date(Math.floor(ns / 1e6)).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export function alertsForStuckResolving(contractId: string, watched: Record<string, ResolvingWatch>, nowNs: number, thresholdNs = STUCK_RESOLVING_THRESHOLD_NS): Alert[] {
  const out: Alert[] = [];
  for (const [id, w] of Object.entries(watched)) {
    if (w.kind === "exhausted") {
      out.push({
        key: `resolution_exhausted:${contractId}:${id}`, kind: "resolution_exhausted", severity: "warning",
        message: `bet #${id} (${contractId}) used all its paid AI runs without a result`,
        detail: `runs=${w.runs}; nothing can resolve it now. The keeper refunds both sides (void_after_deadline) after ${utc(w.resolveDeadlineNs)}. See ${RUNBOOK}`,
      });
      continue;
    }
    const ageNs = nowNs - w.since;
    if (w.stuck === null && ageNs < thresholdNs) continue;
    const why = w.stuck ?? `in Resolving for ${Math.floor(ageNs / 60e9)} min with no applicable result`;
    out.push(w.ruling !== null
      ? {
        key: `bet_stuck_resolving:${contractId}:${id}`, kind: "bet_stuck_resolving", severity: "critical",
        message: `bet #${id} (${contractId}) is stuck in Resolving with a ruling (${w.ruling}) set: no permissionless exit`,
        detail: `${why}; runs=${w.runs}. request_resolution, finalize and void_after_deadline all refuse it; only concede by a party or a contract-wide emergency shutdown move it. See ${RUNBOOK}`,
      }
      : {
        key: `bet_stuck_resolving:${contractId}:${id}`, kind: "bet_stuck_resolving", severity: "warning",
        message: `bet #${id} (${contractId}) is stuck in Resolving with no ruling`,
        detail: `${why}; runs=${w.runs}. The keeper refunds both sides (void_after_deadline) after ${utc(w.resolveDeadlineNs)}. See ${RUNBOOK}`,
      });
  }
  return out;
}
