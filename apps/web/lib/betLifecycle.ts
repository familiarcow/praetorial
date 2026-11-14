// LIFE1 (SM1 LIFE-1, LIFE-3, LIFE-9, CON-2, CON-3): the bet-page gates that must match the frozen escrow exactly.
// Each one mirrors a contract require (contracts/escrow/src/lib.rs) and the keeper's planner (services/keeper/src/policy.ts,
// services/keeper/src/resolvingState.ts), so the page never offers an action the contract refuses and never claims progress
// that nobody will make.
import type { Bet } from "./escrowAdapter";
import { ROUND_WINDOW_NS, MAX_DISPUTE_ROUNDS } from "./escrowAdapter";
import { planJudgeRuling } from "./judgeRuling";
import { formatUtc } from "./offerExpiry";

const NS = 1_000_000_000;
/** The keeper asks for the re-judge at least this long before resolve_deadline (policy.ts REJUDGE_DEADLINE_MARGIN_NS). */
export const REJUDGE_DEADLINE_MARGIN_NS = 3600 * NS;
const MAX_RETRY_HORIZON_NS = 48 * 3600 * NS;
const OBSERVATION_MAX_AGE_NS = 3600 * NS;
const RECOVERY_WINDOW_NS = 7 * 24 * 3600 * NS;
const MAX_RETRIES = 7; // mainnet init args leave max_retries at the contract default
const FAILED_PROMISE_ERROR = "outlayer_call_failed";

const bondCount = (bet: Bet) => (Array.isArray(bet.bonds) ? bet.bonds.length : 0);
const toMs = (ns: number) => Math.floor(ns / 1e6);

/** lib.rs finalize window: proposed_at + (bonds ? min(settlement_period, 24h) : settlement_period) + window_extension_ns. */
export function finalizeNotBeforeNs(bet: Bet): number | null {
  if (bet.proposed_at == null) return null;
  const sp = Number(bet.envelope.settlement_period);
  const base = bondCount(bet) > 0 ? Math.min(sp, ROUND_WINDOW_NS) : sp;
  return Number(bet.proposed_at) + base + Number(bet.window_extension_ns ?? 0);
}

/** Exact mirror of lib.rs finalize's requires (shutdown aside). Null = the contract accepts finalize at nowMs. */
export function finalizeRefusal(bet: Bet, nowMs: number): string | null {
  if (!["Proposed", "Challenged", "Evidence"].includes(bet.status)) return "bet not Proposed/Challenged/Evidence";
  const nowNs = nowMs * 1e6;
  if (bondCount(bet) > 0 && (bet.status === "Challenged" || bet.status === "Evidence")) {
    if (!(nowNs >= Number(bet.envelope.resolve_deadline) || ((bet as any).runs_used ?? 0) >= bet.envelope.max_paid_runs)) return "challenge round pending a ruling";
  }
  const at = finalizeNotBeforeNs(bet);
  if (at === null || nowNs < at) return "settlement_period not elapsed";
  return null;
}

/** A challenged AI ruling waiting for its re-judge (bond posted, status Challenged/Evidence). */
export function isChallengedRuling(bet: Bet): boolean {
  return (bet.status === "Challenged" || bet.status === "Evidence") && bondCount(bet) > 0 && !bet.envelope.referee;
}

/** When the re-judge is asked for (keeper; the web button from then on): the end of the evidence window (the challenge window the
 * contract uses), never later than resolve_deadline - 1h, never before a signed RETRY's next_check_ns. Null if not challenged. */
export function rejudgeDueMs(bet: Bet): number | null {
  if (!isChallengedRuling(bet)) return null;
  let due = Math.min(finalizeNotBeforeNs(bet) ?? 0, Number(bet.envelope.resolve_deadline) - REJUDGE_DEADLINE_MARGIN_NS);
  const nc = (bet as any).next_check_ns;
  if (nc != null) due = Math.max(due, Number(nc));
  return toMs(due);
}

/** lib.rs can_request_resolution for a challenged ruling. outcome / pending_resolution_request are NOT checked: the contract keeps
 * both set after the round-0 verdict, which is why the old gate never offered the re-judge (LIFE-1). */
export function canRequestRejudge(bet: Bet, nowMs: number): boolean {
  if (!isChallengedRuling(bet)) return false;
  const nowNs = nowMs * 1e6;
  if (((bet as any).runs_used ?? 0) >= bet.envelope.max_paid_runs) return false;
  if (nowNs >= Number(bet.envelope.resolve_deadline)) return false;
  const nl = (bet as any).no_live_judge_until_ns;
  if (nl != null && nowNs < Number(nl)) return false;
  const due = rejudgeDueMs(bet);
  return due !== null && nowMs >= due;
}

/** LFIX1 (SM1 CON-1): the latest a bond is offered before resolve_deadline. The keeper asks for the re-judge by resolve_deadline -
 * REJUDGE_DEADLINE_MARGIN_NS (1 h) at the latest; 2 h more covers the keeper's rotation, a refused try's backoff and the run itself. */
export const CHALLENGE_DEADLINE_MARGIN_NS = 3 * 3600 * NS;

export type ChallengeRefusalId = "not-ai" | "no-ruling" | "pending-round" | "not-proposed" | "max-rounds" | "window-closed" | "no-runs-left" | "deadline-near" | "no-live-judge";
export interface ChallengeRefusal { id: ChallengeRefusalId; message: string }

/** LFIX1 (SM1 CON-1, CON-5): may a party post a challenge bond now AND get the re-judge it pays for? The frozen escrow's handle_bond
 * checks neither: it takes a bond with no time guard (finalize then forfeits it unreviewed once resolve_deadline passes or the paid
 * runs are used up) and takes a round-2 bond from Evidence before round 1 was re-judged (two bonds, one re-judge, max_rounds spent).
 * Null = offer it. Party / winning-side rules stay in ruling.challengeOffer. */
export function challengeRefusal(bet: Bet, nowMs: number): ChallengeRefusal | null {
  if (bet.envelope.referee) return { id: "not-ai", message: "A person decides this bet, so it can't be challenged." };
  if (bet.outcome == null) return { id: "no-ruling", message: "There is no ruling to challenge yet." };
  if (["Challenged", "Evidence", "Rejudge", "Resolving"].includes(bet.status)) {
    return { id: "pending-round", message: "A challenge is already open. The AI looks at it again before anyone can challenge again." };
  }
  if (bet.status !== "Proposed") return { id: "not-proposed", message: "This ruling can't be challenged any more." };
  if (bondCount(bet) >= MAX_DISPUTE_ROUNDS) return { id: "max-rounds", message: "No more appeals." };
  // handle_bond's intended window (escrowAdapter.appealDeadlineNs): proposed_at + min(settlement_period, 24h) + window_extension_ns.
  const end = bet.proposed_at == null ? null
    : Number(bet.proposed_at) + Math.min(Number(bet.envelope.settlement_period), ROUND_WINDOW_NS) + Number(bet.window_extension_ns ?? 0);
  if (end === null || nowMs >= Math.floor(end / 1e6)) return { id: "window-closed", message: "Challenge window closed" };
  if (((bet as any).runs_used ?? 0) >= bet.envelope.max_paid_runs) {
    return { id: "no-runs-left", message: "The AI has used all its checks on this bet, so it couldn't look at a challenge. The ruling stands." };
  }
  const cutoffNs = Number(bet.envelope.resolve_deadline) - CHALLENGE_DEADLINE_MARGIN_NS;
  if (nowMs * 1e6 >= cutoffNs) {
    return { id: "deadline-near", message: "This bet is too close to its deadline for the AI to look again, so the ruling can't be challenged." };
  }
  const nl = (bet as any).no_live_judge_until_ns;
  if (nl != null && Number(nl) >= cutoffNs) {
    return { id: "no-live-judge", message: "No AI judge is available before this bet's deadline, so the ruling can't be challenged." };
  }
  return null;
}

function exactU64s(raw: string, key: string): string[] {
  return [...raw.matchAll(new RegExp(`"${key}"\\s*:\\s*"?(\\d+)"?`, "g"))].map((m) => m[1]);
}

/** submit_outcome's time / recovery-ladder gates for the stored signed result. Null = the contract would accept it now. */
function submitTimeRefusal(bet: Bet, raw: string, outcome: string, nowNs: number): string | null {
  if (outcome.startsWith("RETRY")) {
    const nc = exactU64s(raw, "next_check_ns")[0];
    if (nc === undefined) return "RETRY requires next_check_ns";
    if (!(Number(nc) > nowNs)) return "next_check_ns must be in the future";
    if (Number(nc) > nowNs + MAX_RETRY_HORIZON_NS) return "next_check_ns too far ahead (max 48h)";
  }
  for (const o of exactU64s(raw, "observed_ns")) if (Number(o) < nowNs - OBSERVATION_MAX_AGE_NS) return "observation is older than 1h";
  const b: any = bet;
  if (outcome === "VOID:unavailable" || (outcome === "VOID" && b.first_unavailable_ns != null)) {
    const windowOk = b.first_unavailable_ns != null && nowNs >= Number(b.first_unavailable_ns) + RECOVERY_WINDOW_NS;
    if (!windowOk && (b.retry_count ?? 0) < MAX_RETRIES) return "VOID-for-unavailability refused: recovery window not exhausted";
  }
  return null;
}

export type ResolvingState =
  | { kind: "not-resolving" }
  | { kind: "judging" }
  | { kind: "ready" }
  | { kind: "stuck"; reason: string; hasRuling: boolean };

/** Mirror of services/keeper/src/resolvingState.ts classifyResolving (see its header for why each case means what it says). */
export function resolvingState(contractId: string, betId: number, bet: Bet, nowMs: number): ResolvingState {
  if (bet.status !== "Resolving") return { kind: "not-resolving" };
  const hasRuling = bet.outcome != null;
  const raw = bet.last_resolution_raw;
  if (typeof raw !== "string" || raw.trim() === "") return { kind: "judging" };
  let o: any;
  try { o = JSON.parse(raw); } catch { return { kind: "judging" }; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { kind: "judging" };
  if (o.error === FAILED_PROMISE_ERROR && !o.result) return { kind: "judging" };
  const r = o.result;
  if (r && typeof r === "object" && typeof r.run_no === "number") {
    const pending = bet.pending_run_no;
    if (pending == null) return { kind: "stuck", reason: "no run in flight but the bet is still Resolving", hasRuling };
    if (r.run_no !== pending || (bet.used_run_nos ?? []).includes(r.run_no)) return { kind: "judging" };
    const plan = planJudgeRuling(contractId, betId, bet);
    if (!plan.ok) return { kind: "stuck", reason: plan.reason, hasRuling };
    const late = submitTimeRefusal(bet, raw, plan.outcome, nowMs * 1e6);
    return late ? { kind: "stuck", reason: late, hasRuling } : { kind: "ready" };
  }
  return { kind: "stuck", reason: `unsigned resolver output (${typeof o.error === "string" ? o.error : "stored output has no result"})`, hasRuling };
}

/** concede settles for the other side and returns every challenge bond (lib.rs concede: concede_bond_refund). So when the earlier
 * ruling picked a winner, the side it went against can concede and get exactly that ruling paid out, with their bond back. */
function concedeWayOut(bet: Bet): string {
  const o = bet.outcome;
  if (o === "YES" || o === "NO") {
    const loser = bet.envelope.maker_side === o ? bet.taker : bet.envelope.maker;
    if (loser) return `The quickest way out: if ${loser} concedes, the earlier ruling is paid out as it stands and every challenge bond is returned.`;
  }
  return "Either of you can end it by conceding: the other side is then paid, and every challenge bond is returned.";
}

export interface LifecycleNotice { id: "stuck-ruling" | "stuck-no-ruling" | "runs-exhausted"; label: string; title: string; lines: string[] }

/** The plain-words case for a bet the contract cannot move on by itself (CON-2 / CON-3 / LIFE-9), or null. */
export function lifecycleNotice(contractId: string, betId: number, bet: Bet, nowMs: number): LifecycleNotice | null {
  const rd = formatUtc(Math.floor(Number(bet.envelope.resolve_deadline) / NS / 60) * 60);
  const s = resolvingState(contractId, betId, bet, nowMs);
  if (s.kind === "stuck" && s.hasRuling) {
    return {
      id: "stuck-ruling", label: "Re-check failed",
      title: "The AI's second look didn't produce a ruling",
      lines: [
        `The challenge was sent to the AI, but its answer can't be used, and this contract can't ask again on its own. The earlier ruling (${bet.outcome}) still stands, but it can't be made final automatically.`,
        concedeWayOut(bet),
        "We've been alerted and are looking at it. Otherwise the money stays locked until the Praetorial team steps in.",
      ],
    };
  }
  if (s.kind === "stuck") {
    return {
      id: "stuck-no-ruling", label: "No result",
      title: "The AI couldn't give a usable result",
      lines: [
        "The AI was asked for the result, but its answer can't be used, and this contract can't ask again on its own.",
        `If nothing else happens, both sides get their stakes back after ${rd}. That refund is automatic. Either of you can also concede to end it sooner.`,
      ],
    };
  }
  const exhausted = bet.status === "Taken" && !bet.envelope.referee && bet.outcome == null
    && ((bet as any).runs_used ?? 0) >= bet.envelope.max_paid_runs && nowMs * 1e6 <= Number(bet.envelope.resolve_deadline);
  if (exhausted) {
    return {
      id: "runs-exhausted", label: "No result",
      title: "The AI used all its checks without a result",
      lines: [`No more checks can be run for this bet. Both sides get their stakes back after ${rd}. That refund is automatic. Either of you can also concede to end it sooner.`],
    };
  }
  return null;
}

/** The Challenged / Evidence sentence: what really happens next (the keeper asks for the re-judge when the evidence window ends). */
export function challengedSentence(bet: Bet): string | null {
  const due = rejudgeDueMs(bet);
  if (due === null) return null;
  return `The ruling was challenged. Both sides can add evidence until ${formatUtc(Math.floor(due / 60_000) * 60)}. Then the AI looks at it again.`;
}

// K0 (UIR1 §2.0, SM1 root cause #1): THE bet phase. Every screen reads the bet's state from phaseOf (through lib/betView.ts),
// never from its own status × outcome × deadline checks, so the UI cannot drift from the contract. Each case is one of the
// mirrors above (finalizeRefusal, resolvingState, lifecycleNotice) or a plain contract status; time is the chain clock in ns.
// LIFE1 shipped the gates but no single phase function; this is it, with the input/output UIR1 specified (bet, chainNowNs).
export type PhaseId =
  | "open" //            Open, the taker window is running
  | "open-lapsed" //     Open, funding_deadline passed: nobody can take it; expire refunds the maker
  | "live" //            Taken, before the event (or before the referee may rule)
  | "awaiting-result" // Taken, AI bet, event passed, no ruling yet
  | "awaiting-referee" // Taken, person decides, ruling window open
  | "refund-due" //      Taken, resolve_deadline passed with no ruling: void_after_deadline refunds both
  | "no-result" //       Taken, the AI used every paid run (LIFE-9 runs-exhausted)
  | "judging" //         Resolving, a run is in flight
  | "stuck" //           Resolving, but the stored result can't be used: no permissionless way on (CON-2/CON-3)
  | "ruling" //          Proposed, still inside the challenge window
  | "ruling-final" //    Proposed, challenge window over: becomes final at finalize
  | "challenged" //      Challenged / Evidence / Rejudge
  | "paying" //          Finalized: payout lines being drained
  | "settled" //         Settled with a winner
  | "refunded" //        Voided, or Settled VOID
  | "cancelled"
  | "expired"
  | "unknown";

export function phaseOf(bet: Bet, chainNowNs: number, contractId: string): PhaseId {
  const nowMs = Math.floor(chainNowNs / 1e6);
  const e = bet.envelope;
  switch (bet.status) {
    case "Open": return chainNowNs < Number(e.funding_deadline) ? "open" : "open-lapsed";
    case "Taken": {
      if (bet.outcome == null && chainNowNs > Number(e.resolve_deadline)) return "refund-due";
      if (lifecycleNotice(contractId, e.bet_id, bet, nowMs)?.id === "runs-exhausted") return "no-result";
      if (chainNowNs < Number(e.funding_deadline)) return "live";
      return e.referee ? "awaiting-referee" : "awaiting-result";
    }
    case "Resolving": return resolvingState(contractId, e.bet_id, bet, nowMs).kind === "stuck" ? "stuck" : "judging";
    case "Proposed": {
      // handle_bond's window (escrowAdapter.appealDeadlineNs): proposed_at + min(settlement_period, 24h) + window_extension_ns.
      const end = bet.proposed_at == null ? null
        : Number(bet.proposed_at) + Math.min(Number(e.settlement_period), ROUND_WINDOW_NS) + Number(bet.window_extension_ns ?? 0);
      return end !== null && chainNowNs < end ? "ruling" : "ruling-final";
    }
    case "Challenged": case "Evidence": case "Rejudge": return "challenged";
    case "Finalized": return "paying";
    case "Settled": return bet.outcome === "VOID" || (typeof bet.outcome === "string" && bet.outcome.startsWith("VOID")) ? "refunded" : "settled";
    case "Voided": return "refunded";
    case "Cancelled": return "cancelled";
    case "Expired": return "expired";
  }
  return "unknown";
}
