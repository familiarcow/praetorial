// Host-neutral core of the D-DSY1 (2) second-RPC terminal confirmation (CF1c2): no NearClient / near-api-js / node:* here, so
// the notifier Worker bundles it. services/common/src/terminalConfirm.ts re-exports it and adds the node-only client factory.
// D-DSY1 (2): a TERMINAL outcome (Settled / Voided) is shown or announced
// only after a SECOND, independently configured RPC (rpcUrls[1]) returns
// the same state for the same bet: same contract, same bet identity
// (maker, terms_hash, created_at), same status, same outcome.
import type { Bet } from "./types.js";
import type { ViewClient } from "./versionCheck.js";

/** Display state for a terminal bet that the second RPC has not confirmed. */
export const CONFIRMING_DISPLAY = "settling, confirming";

export function isConfirmableTerminal(bet: Bet): boolean {
  return bet.status === "Settled" || bet.status === "Voided";
}

export type ConfirmVerdict =
  | { status: "confirmed" }
  | { status: "disagree"; detail: string }
  | { status: "unavailable"; detail: string }
  | { status: "unconfigured" };

export function sameBetIdentity(a: Bet, b: Bet): boolean {
  return a.envelope.maker === b.envelope.maker && a.envelope.terms_hash === b.envelope.terms_hash && a.created_at === b.created_at;
}

export async function confirmTerminalBet(
  second: ViewClient | null | undefined,
  contractId: string,
  betId: number,
  bet: Bet,
): Promise<ConfirmVerdict> {
  if (!second) return { status: "unconfigured" };
  let other: Bet | null;
  try {
    other = await second.view<Bet | null>(contractId, "get_bet", { bet_id: betId });
  } catch (err: any) {
    return { status: "unavailable", detail: String(err?.message ?? err) };
  }
  if (!other) return { status: "disagree", detail: "second RPC has no such bet" };
  if (!sameBetIdentity(bet, other)) return { status: "disagree", detail: "second RPC returned a different bet identity" };
  if (other.status !== bet.status || other.outcome !== bet.outcome) {
    return { status: "disagree", detail: `second RPC status/outcome ${other.status}/${other.outcome} differs` };
  }
  return { status: "confirmed" };
}

/** The second-RPC endpoint: rpcUrls[1] ONLY (no failover back to the primary: confirmation must come from a different
 * endpoint). null when fewer than two RPC URLs are configured. Host-neutral: the node builds a NearClient on it, the
 * Worker a WebCrypto client. */
export function secondRpcUrl(rpcUrls: readonly string[] | undefined): string | null {
  return rpcUrls?.[1] ?? null;
}
