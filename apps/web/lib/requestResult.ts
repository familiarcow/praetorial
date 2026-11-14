// LH5 / D-HORIZON2: "Request the result now" -- anyone may call the permissionless, payable
// `request_resolution(bet_id)` once a close-at-T result can be decided (T + 5 min), instead of
// waiting for the keeper. Attach mirrors contracts/escrow/src/lib.rs `required_resolution_deposit`:
// MIN_RESOLUTION_COMPUTE_DEPOSIT (= 1.25 x outlayer_estimated_cost at the 150 s tier cap
// = 1.25 x 0.01605 NEAR = 0.0200625 NEAR) + OUTLAYER_STORAGE_PRICE_PER_BYTE for every byte of
// input_data above OUTLAYER_INPUT_DATA_FREE_BYTES (32 KiB). Unused compute is refunded by on_resolution.
import type { Bet } from "./escrowAdapter";
import { canRequestRejudge, isChallengedRuling } from "./betLifecycle";

export const MIN_RESOLUTION_COMPUTE_DEPOSIT_YOCTO = 20_062_500_000_000_000_000_000n;
export const OUTLAYER_INPUT_DATA_FREE_BYTES = 32 * 1024;
export const OUTLAYER_STORAGE_PRICE_PER_BYTE = 10_000_000_000_000_000_000n;
export const REQUEST_RESULT_DELAY_MS = 5 * 60_000;
/** input_data = envelope JSON (which already holds `terms` when kept) + terms again + wrapper fields. */
const INPUT_DATA_OVERHEAD_BYTES = 1024;

function termsOf(bet: Bet): string {
  const t = (bet.envelope as any).terms;
  return typeof t === "string" ? t : "";
}

/** Conservative (never under) estimate of the contract's input_data length. */
export function estimateInputDataLen(bet: Bet): number {
  const env = JSON.stringify(bet.envelope);
  return env.length + termsOf(bet).length + INPUT_DATA_OVERHEAD_BYTES;
}

export function requestResolutionDepositYocto(bet: Bet): bigint {
  const over = Math.max(0, estimateInputDataLen(bet) - OUTLAYER_INPUT_DATA_FREE_BYTES);
  return MIN_RESOLUTION_COMPUTE_DEPOSIT_YOCTO + BigInt(over) * OUTLAYER_STORAGE_PRICE_PER_BYTE;
}

export function formatNear(yocto: bigint): string {
  const whole = yocto / 10n ** 24n;
  const frac = (yocto % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function buildRequestResolutionArgs(betId: number): Record<string, unknown> {
  return { bet_id: betId };
}

/** JCB1 (D-JCB1): ms epoch until which the contract refuses request_resolution after a RETRY:no_live_judge; null when open. */
export function noLiveJudgeWaitUntilMs(bet: Bet, nowMs: number): number | null {
  const g = (bet as any).no_live_judge_until_ns;
  if (g === null || g === undefined) return null;
  const ms = Number(g) / 1_000_000;
  return nowMs < ms ? ms : null;
}

/** The event time T (ms) of a typed close-at-T / touch sheet = funding deadline; other sheets: funding deadline too. */
export function showRequestResultNow(bet: Bet, nowMs: number): boolean {
  const env: any = bet.envelope;
  if (env.referee) return false; // human-ruled: the escrow refuses request_resolution
  // LIFE1 (SM1 LIFE-1): a challenged ruling needs request_resolution for its re-judge. The contract keeps outcome and
  // pending_resolution_request set after the first verdict, so the round-0 gates below would hide it forever.
  if (isChallengedRuling(bet)) return canRequestRejudge(bet, nowMs);
  if (!["Taken", "Challenged", "Evidence"].includes(bet.status)) return false;
  if (bet.outcome !== null && bet.outcome !== undefined) return false;
  if ((bet as any).pending_resolution_request != null) return false;
  if (((bet as any).runs_used ?? 0) >= env.max_paid_runs) return false;
  if (noLiveJudgeWaitUntilMs(bet, nowMs) !== null) return false; // contract: "waiting for a live judge model"
  const tMs = Number(env.funding_deadline) / 1_000_000;
  const deadlineMs = Number(env.resolve_deadline) / 1_000_000;
  return nowMs >= tMs + REQUEST_RESULT_DELAY_MS && nowMs < deadlineMs;
}

/** M1 (SM2 gap M1-4): what the bet page's request-result block shows. "wait" = no AI model is live (JCB1) and the contract refuses
 *  another paid run until `untilMs` (only while that is before the deadline and the AI decides); "request" = the manual fallback. */
export type RequestResultMode = { kind: "none" } | { kind: "wait"; untilMs: number } | { kind: "request" };
export function requestResultMode(bet: Bet, nowMs: number): RequestResultMode {
  const env: any = bet.envelope;
  const waitMs = noLiveJudgeWaitUntilMs(bet, nowMs);
  if (waitMs !== null && waitMs < Number(env.resolve_deadline) / 1_000_000 && !env.referee) return { kind: "wait", untilMs: waitMs };
  return showRequestResultNow(bet, nowMs) ? { kind: "request" } : { kind: "none" };
}

/** M1 (SM2 gap M1-4, LIFE1): did a request_resolution land? A challenged bet already carries an outcome and a stale
 *  pending_resolution_request, so only a new run (runs_used up), a status change, or a NEW pending request proves it. */
export function requestLanded(before: Bet, after: Bet | null): boolean {
  if (!after) return false;
  const b: any = before, a: any = after;
  return a.status !== b.status || (a.runs_used ?? 0) > (b.runs_used ?? 0) || (b.pending_resolution_request == null && a.pending_resolution_request != null);
}
