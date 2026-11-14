// FE8 (S9): the share-link screen model. Pure; the dates come from the bet read back from the contract.
import type { Bet } from "./escrowAdapter";

/** Link to /bet/:id on the same origin (no query, no hash). */
export function buildBetUrl(base: string, betId: number): string {
  const u = new URL(base);
  return `${u.origin}/bet/${betId}`;
}

/** UTC "YYYY-MM-DD HH:MM UTC" from a nanosecond timestamp (the contract's funding_deadline). */
export function expiresLabel(ns: number | string | bigint): string {
  const ms = Number(BigInt(ns) / 1_000_000n);
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export interface ShareModel {
  title: string;
  link: string;
  status: string;
  help: string;
  namedTaker: string | null;
  inviteNote: string | null;
}

export function shareScreenModel(a: { betId: number; bet: Bet; origin: string; takerLabel?: string | null }): ShareModel {
  const allow: any = a.bet.envelope.taker_allow;
  const account = allow && typeof allow === "object" && "Account" in allow ? String(allow.Account) : null;
  const invite = allow && typeof allow === "object" && "InvitePubkey" in allow;
  return {
    title: "Your bet is open. Share the link so the other person can take it.",
    link: buildBetUrl(a.origin, a.betId),
    status: `Waiting for someone to take it · expires ${expiresLabel(a.bet.envelope.funding_deadline)}`,
    help: "Send this link to the person you're betting. They'll see the bet and can take it or pass.",
    namedTaker: account ? `Only ${a.takerLabel || account} can take this.` : null,
    inviteNote: invite ? "This bet is invite-only. Open the bet page, enter the other person's account, and send them their personal link." : null,
  };
}
