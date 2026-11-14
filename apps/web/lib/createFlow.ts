// C1 (UIR1 §3.4, familiarcow UX-37 #5, SM2 gap C1-2): the create review's decisions, pure (App.tsx only holds the state and runs the I/O).
//  - autoCheckOnEnter: the source check runs by itself when Review opens. AI mode: at most ONE automatic (paid) check per reviewed
//    offer (offerKey); after that a button. Person-decides: the silent attestation runs as before (REVIEW1 / D-FE6B1).
//  - onApprovalExpired: AI mode never re-checks by itself; person-decides keeps REVIEW1's one automatic re-check (recheckDecision).
//  - preflightView: the one status line ("Checking sources…" / "Checking sources… ✓") and at most ONE button (no "Retry Retry").
//  - openButton / openProgress / openFlowResult / closingTooSoon: the Open button, the progress line, the result mapping (mirrors
//    take's takeFlowResult) and the chain-time closing check, moved out of App.tsx.
import { recheckDecision } from "./openApproval";
import type { PlainFailure } from "./sourcePreflight";
import type { OpenOutcome } from "./openConfirm";
import type { RelayStatus } from "./useRelayAction";
import type { Bet } from "./escrowAdapter";

export type CheckState = "idle" | "checking" | "ok" | "failed" | "expired";

/** Run the source check now that Review is open? `triedKeys` = offers that already had their automatic AI check. */
export function autoCheckOnEnter(a: { human: boolean; approved: boolean; checking: boolean; key: string; triedKeys: ReadonlySet<string> }): boolean {
  if (a.approved || a.checking) return false;
  if (a.human) return true;
  return !a.triedKeys.has(a.key);
}

/** The approval for the offer under review ran out (or must be redone) while Review is open. */
export function onApprovalExpired(a: { human: boolean; autoRechecksUsed: number }): "auto" | "button" {
  return a.human ? recheckDecision(a.autoRechecksUsed) : "button";
}

export interface PreflightView {
  line: string | null;
  tone: "info" | "good" | "bad" | "warn";
  /** The ONE button under the line (null = none). */
  button: { label: string; disabled: boolean } | null;
  /** Failed: offer "Fix the bet" and "Let a person decide instead". */
  offerFix: boolean;
}

export function preflightView(a: { state: CheckState; failure: PlainFailure | null; waiting: boolean }): PreflightView {
  switch (a.state) {
    case "checking": return { line: "Checking sources…", tone: "info", button: null, offerFix: false };
    case "ok": return { line: "Checking sources… ✓", tone: "good", button: null, offerFix: false };
    case "expired": return { line: null, tone: "warn", button: { label: "Check again", disabled: false }, offerFix: false };
    case "idle": return { line: null, tone: "info", button: { label: "Check the sources", disabled: false }, offerFix: false };
    case "failed": {
      // one Retry whatever the failure (a source can be down for a minute); held while a rate-limit wait runs
      // OFIX1: a stale start time says "Tap Check again", so the button says it too
      return { line: null, tone: "bad", button: { label: a.failure?.termsCode === "OPEN_UTC_SKEW" ? "Check again" : "Retry", disabled: a.waiting }, offerFix: true };
    }
  }
}

/** "Good to open for 59 min." -- minutes, seconds only in the last minute; null when nothing is left (or unknown). */
export function checkedLine(leftMs: number | null): string | null {
  if (leftMs === null || leftMs <= 0) return null;
  if (leftMs < 60_000) return `Good to open for ${Math.max(1, Math.floor(leftMs / 1000))} s.`;
  return `Good to open for ${Math.floor(leftMs / 60_000)} min.`;
}

export interface OpenButtonInput {
  checkState: CheckState; hasAttestation: boolean; leftMs: number | null; address: string | null; gateAllowed: boolean;
  relay: RelayStatus; busy: "confirming" | null; flags: number;
  /** "You pay now" as formatted money (lib/money), or null while the storage quote loads. */
  payNow: string | null;
}
/** The one primary button of the review. */
export function openButton(a: OpenButtonInput): { label: string; disabled: boolean } {
  const disabled = a.checkState !== "ok" || !a.hasAttestation || a.leftMs === 0 || !a.address || !a.gateAllowed
    || a.relay === "signing" || a.relay === "relaying" || a.busy !== null || a.flags > 0;
  return { label: a.payNow ? `Open the bet · ${a.payNow}` : "Open the bet", disabled };
}

/** The progress line while the Open runs (never the raw relay status word). */
export function openProgress(busy: "confirming" | null, relay: RelayStatus): string | null {
  if (busy === "confirming") return "Confirming…";
  if (relay === "signing") return "Waiting for your approval…";
  if (relay === "relaying") return "Sending…";
  return null;
}

export type OpenResultLine = { kind: "declined" | "refused" | "pending" | "failed"; message: string };
export type OpenFlow = { kind: "success"; txHash: string | null } | { kind: "pending"; txHash: string | null } | { kind: "failure"; reason: string };
export type RelayAnswer = { ok: true; txHash?: string | null } | { ok: false; error?: string | null; txHash?: string | null };

/** What the create modal shows once the Open was sent and read back (was App.tsx's inline mapping). */
export function openFlowResult(outcome: OpenOutcome, relay: RelayAnswer): { flow: OpenFlow; shared: { betId: number; bet: Bet } | null; result: OpenResultLine | null } {
  const txHash = relay.ok ? relay.txHash ?? null : null;
  if (outcome.kind === "opened") return { flow: { kind: "success", txHash }, shared: { betId: outcome.betId, bet: outcome.bet }, result: null };
  if (outcome.kind === "refused") return { flow: { kind: "failure", reason: outcome.sentence }, shared: null, result: { kind: "refused", message: outcome.sentence } };
  if (!relay.ok) {
    // FUND2: say why (account setup, relayer refusal); the relayer only returns client-safe reasons.
    const message = relay.error?.startsWith("We couldn't set up your account") ? relay.error
      : `The bet couldn't be sent, so nothing was opened. Try again in a moment.${relay.error ? ` Details: ${relay.error}` : ""}`;
    return { flow: { kind: "failure", reason: message }, shared: null, result: { kind: "failed", message } };
  }
  return { flow: { kind: "pending", txHash }, shared: null, result: { kind: "pending", message: outcome.message } };
}

/** REVIEW1 (#10, CRT-11): the offer must still be open (by chain time) 2 minutes from now, when the Open lands. */
export function closingTooSoon(fundingDeadlineNs: number | string, chainNowMs: number): boolean {
  return Number(fundingDeadlineNs) <= (chainNowMs + 120_000) * 1e6;
}

// ---------------------------------------------------------------- the form (SM2 gaps C1-1, C1-3)
import type { UserRegistry } from "./refereeRegistry";
import { formatMoney } from "./money";
import { amountUnits } from "./reviewCard";

export const COPIED_REFEREE_UNREGISTERED = "The referee from the copied bet has no Praetorial username, so they can't referee. Pick someone by username.";
/** FE15 + SM2 C1-1 (G8): a copied bet's referee must still be a registered @username; the screen gets the name, never the raw id. */
export async function copiedRefereeName(reg: UserRegistry, account: string): Promise<{ kind: "named"; username: string } | { kind: "unregistered"; message: string } | { kind: "unknown" }> {
  try {
    const u = await reg.byAccount(account);
    return u?.username ? { kind: "named", username: u.username } : { kind: "unregistered", message: COPIED_REFEREE_UNREGISTERED };
  } catch { return { kind: "unknown" }; }
}

/** An amount typed on the form, as the number part of lib/money's text ("10.00" USDC, "2.5" NEAR); never a float toFixed. */
export function stakeAmountText(symbol: string, amount: number | bigint): string {
  const units = typeof amount === "bigint" ? amount : amountUnits(symbol, amount);
  return formatMoney({ units, symbol }).text.replace(new RegExp(` ${symbol}$`), "");
}

/** The value an <input type="date"> needs (UTC day), from unix seconds. Not shown as text. */
export function dateInputValue(secs: number): string {
  return new Date(secs * 1000).toISOString().slice(0, 10);
}
