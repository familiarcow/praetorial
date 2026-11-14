// F2: the swap tracker as a pure state machine (SPEC §4.6): (record, status | null, now) -> record, plus the poll policy.
// `status === null` means the status check itself failed: after CHECKING_AFTER_FAILURES in a row the record shows "checking"
// ("We can't check right now..."), and it NEVER becomes "failed" from our side. Only 1Click's FAILED is "failed".
// credited / refunded are final. expired is not: a late deposit to an expired address is still refunded by 1Click to the
// user's intents account (refundType INTENTS), and the tracker follows it there.
import type { SwapRecord, StatusView, TrackState } from "./types";
import { TERMINAL_STATES } from "./types";
import { isBetTokenId } from "./landing";

/** SPEC §4.6: "still PENDING_DEPOSIT at deadline + 30 min" -> expired. */
export const EXPIRE_GRACE_MS = 30 * 60_000;
export const CHECKING_AFTER_FAILURES = 3;

const FINAL: ReadonlySet<TrackState> = new Set(["credited", "refunded"]);
export const isTerminal = (r: Pick<SwapRecord, "state">): boolean => TERMINAL_STATES.includes(r.state);

export function advance(r: SwapRecord, s: StatusView | null, now: number): SwapRecord {
  if (FINAL.has(r.state)) return r;
  if (s === null) {
    const checkFailures = r.checkFailures + 1;
    const state: TrackState = isTerminal(r) || checkFailures < CHECKING_AFTER_FAILURES ? r.state : "checking";
    return { ...r, checkFailures, state };
  }
  const base = { ...r, lastStatus: s.status, updatedAt: now, checkFailures: 0, correlationId: r.correlationId ?? s.correlationId };
  switch (s.status) {
    case "PENDING_DEPOSIT": {
      const deadline = r.deadline ? Date.parse(r.deadline) : NaN;
      return { ...base, state: Number.isFinite(deadline) && now >= deadline + EXPIRE_GRACE_MS ? "expired" : "waiting" };
    }
    case "KNOWN_DEPOSIT_TX": return { ...base, state: "confirming" };
    case "INCOMPLETE_DEPOSIT": return { ...base, state: "short", received: s.depositedAmount ?? r.received };
    case "PROCESSING": return { ...base, state: "converting", received: s.depositedAmount ?? r.received };
    case "SUCCESS": return { ...base, state: "credited", received: s.depositedAmount ?? r.received, delivered: s.amountOut ?? r.amountOut };
    case "REFUNDED": return { ...base, state: "refunded", received: s.depositedAmount ?? r.received, refunded: s.refundedAmount ?? s.depositedAmount ?? r.received, refundReason: s.refundReason };
    case "FAILED": return { ...base, state: "failed" };
  }
}

/** Where a refund shows up: the betting balance when the origin token is one of the 6, else "Not usable for bets yet". */
export const refundLands = (r: Pick<SwapRecord, "origin">): "betting" | "stray" => (isBetTokenId(r.origin.assetId, "mainnet") ? "betting" : "stray");

export function refundReasonKind(reason: string | null): "partial" | "price" | "unknown" {
  if (!reason) return "unknown";
  return reason === "PARTIAL_DEPOSIT" ? "partial" : "price";
}

/** ms until the next status check, or null = don't poll (final state, or the tab is hidden: resume on visibilitychange). */
export function pollIntervalMs(state: TrackState, view: { sheetOpen: boolean; hidden: boolean }): number | null {
  if (view.hidden || TERMINAL_STATES.includes(state)) return null;
  if (!view.sheetOpen) return 30_000;
  return state === "converting" ? 10_000 : 5_000;
}

/** Cash out / Convert written before signing and never signed: offer [Confirm] [Cancel] while the quote is still valid (§7.4). */
export function needsConfirm(r: SwapRecord, now: number): boolean {
  if (r.kind === "fund" || r.signed !== false || r.state !== "waiting") return false;
  const deadline = r.deadline ? Date.parse(r.deadline) : NaN;
  return Number.isFinite(deadline) && now < deadline;
}

/** Ms left on the address (0 when past; null when the quote has no deadline). Under 10 min: the "get a new address" warning. */
export function msLeft(r: Pick<SwapRecord, "deadline">, now: number): number | null {
  const d = r.deadline ? Date.parse(r.deadline) : NaN;
  return Number.isFinite(d) ? Math.max(0, d - now) : null;
}
export const SOON_MS = 10 * 60_000;
/** The address must be HIDDEN at the deadline (SPEC §4.5): never show an address that can no longer receive. */
export const addressUsable = (r: Pick<SwapRecord, "deadline">, now: number): boolean => (msLeft(r, now) ?? 1) > 0;
