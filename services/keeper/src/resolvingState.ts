// LIFE1 (SM1 LIFE-9 / CON-2 / CON-3): what a bet in `Resolving` is really waiting for. The escrow is frozen, and a
// Resolving bet whose stored resolver output can never be applied has no permissionless exit while it carries a ruling
// (CON-2: request_resolution, finalize and void_after_deadline all refuse it) and only void_after_deadline at
// resolve_deadline when it has none (CON-3). This classifier is the one place the keeper (relay gate) and the monitor
// (stuck alert) decide that; apps/web/lib/resolvingState.ts mirrors it for the bet page.
//
// How the stored output relates to the in-flight run (lib.rs on_resolution, request_resolution):
//  * request_resolution does NOT clear last_resolution_raw, so while a run is in flight the field still holds an older
//    output: a previous round's signed result (its run_no is in used_run_nos / differs from pending_run_no), or the
//    `{"error":"outlayer_call_failed"}` / null-ish text a failed run left behind (that run restored the prior status).
//  * on_resolution stores any JSON object the run returned and keeps the bet Resolving. A non-object restores the status.
//    So an object with no usable signed result for pending_run_no (e.g. the resolver's unsigned NOKEY1 error object) means
//    the current run is over and nothing can ever be applied: stuck.
//  * a signed result for pending_run_no is only landable if submit_outcome's time gates still pass (RETRY next_check_ns in
//    (now, now + 48 h], model_not_found observations <= 1 h old, VOID:unavailable only once the recovery ladder allows).
import type { Bet } from "@praetorial/common/types.js";
import { planOutcomeRelay } from "@praetorial/common/outcomeRelay.js";

const NS = 1_000_000_000;
export const MAX_RETRY_HORIZON_NS = 48 * 3600 * NS; // lib.rs MAX_RETRY_HORIZON_NS
export const OBSERVATION_MAX_AGE_NS = 3600 * NS; // lib.rs OBSERVATION_MAX_AGE_NS
export const RECOVERY_WINDOW_NS = 7 * 24 * 3600 * NS; // lib.rs RECOVERY_WINDOW_NS
export const MAX_RETRIES = 7; // init args: max_retries omitted -> contract default 7 (release/mainnet-night/args.mainnet.json)
/** The contract's text for a failed OutLayer promise (on_resolution PromiseResult::Failed); that run restored the status. */
const FAILED_PROMISE_ERROR = "outlayer_call_failed";

export type ResolvingState =
  | { kind: "not-resolving" }
  /** A run is in flight (no output for it yet). */
  | { kind: "judging" }
  /** A signed result for the in-flight run is stored and submit_outcome would accept it now (keeper / Apply button). */
  | { kind: "ready" }
  /** The in-flight run is over and its output can never be applied. `hasRuling`: an earlier ruling stands (CON-2). */
  | { kind: "stuck"; reason: string; hasRuling: boolean };

function exactU64s(raw: string, key: string): string[] {
  return [...raw.matchAll(new RegExp(`"${key}"\\s*:\\s*"?(\\d+)"?`, "g"))].map((m) => m[1]);
}

/** submit_outcome's time/ladder gates for a stored signed result (signature, run order, terms already checked). Null = accepted. */
export function submitTimeRefusal(bet: Bet, raw: string, outcome: string, nowNs: number): string | null {
  if (outcome.startsWith("RETRY")) {
    const nc = exactU64s(raw, "next_check_ns")[0];
    if (nc === undefined) return "RETRY requires next_check_ns";
    const n = Number(nc);
    if (!(n > nowNs)) return "next_check_ns must be in the future";
    if (n > nowNs + MAX_RETRY_HORIZON_NS) return "next_check_ns too far ahead (max 48h)";
  }
  for (const o of exactU64s(raw, "observed_ns")) {
    if (Number(o) < nowNs - OBSERVATION_MAX_AGE_NS) return "observation is older than 1h";
  }
  const ladder = outcome === "VOID:unavailable" || (outcome === "VOID" && bet.first_unavailable_ns != null);
  if (ladder) {
    const fu = bet.first_unavailable_ns != null ? Number(bet.first_unavailable_ns) : null;
    const windowOk = fu !== null && nowNs >= fu + RECOVERY_WINDOW_NS;
    if (!windowOk && (bet.retry_count ?? 0) < MAX_RETRIES) return "VOID-for-unavailability refused: recovery window not exhausted";
  }
  return null;
}

export function classifyResolving(contractId: string, betId: number, bet: Bet, nowNs: number): ResolvingState {
  if (bet.status !== "Resolving") return { kind: "not-resolving" };
  const hasRuling = bet.outcome !== null && bet.outcome !== undefined;
  const raw = bet.last_resolution_raw;
  if (typeof raw !== "string" || raw.trim() === "") return { kind: "judging" };
  let o: any;
  try { o = JSON.parse(raw); } catch {
    // Non-JSON text is what a run that returned nothing usable leaves (it restored the status), or a truncated huge object.
    return { kind: "judging" };
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { kind: "judging" }; // non-object output restored the status
  if (o.error === FAILED_PROMISE_ERROR && !o.result) return { kind: "judging" }; // left by an earlier failed run
  const r = o.result;
  if (r && typeof r === "object" && typeof r.run_no === "number") {
    const pending = bet.pending_run_no;
    if (pending === null || pending === undefined) return { kind: "stuck", reason: "no run in flight but the bet is still Resolving", hasRuling };
    if (r.run_no !== pending || (bet.used_run_nos ?? []).includes(r.run_no)) return { kind: "judging" }; // an older round's output
    const plan = planOutcomeRelay(contractId, betId, bet);
    if (!plan.ok) return { kind: "stuck", reason: plan.reason, hasRuling };
    const late = submitTimeRefusal(bet, raw, plan.outcome, nowNs);
    return late ? { kind: "stuck", reason: late, hasRuling } : { kind: "ready" };
  }
  // An object with no usable result for any run: the resolver's unsigned error output (e.g. NOKEY1 no_live_judge_key).
  const err = typeof o.error === "string" ? o.error : "stored output has no result";
  return { kind: "stuck", reason: `unsigned resolver output (${err})`, hasRuling };
}
