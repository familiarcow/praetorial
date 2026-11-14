// MODAL1c4: pure helpers for the cancel-offer and change-referee modals. No React.
// Amounts are BigInt end to end; the refund is the contract's own (cancel -> refund_open: stake_maker + storage_maker, to the maker's Escrow balance, no fee).
import type { Bet } from "./escrowAdapter";
import type { FlowStep } from "./flowModal";
import { money } from "./refereeScreen";

/** Each admin action is one irreversible step: read exactly what happens, then confirm. */
export const OFFER_ADMIN_STEPS: FlowStep[] = [{ id: "confirm", title: "Confirm" }];
export const OFFER_ADMIN_DRAFT_KEY = (kind: string, betId: number) => `offeradmin-${kind}-${betId}`;

const big = (v: unknown): bigint => { try { return BigInt(String(v ?? "0")); } catch { return 0n; } };

export interface CancelTerms { refundText: string; stakeText: string; storageText: string | null; lines: string[] }
export function cancelOfferTerms(bet: Bet): CancelTerms {
  const e: any = bet.envelope;
  const stake = big(e.stake_maker);
  const storage = big((bet as any).storage_maker);
  const refundText = money(stake + storage, e.maker_asset);
  const stakeText = money(stake, e.maker_asset);
  const storageText = storage > 0n ? money(storage, e.maker_asset) : null;
  return {
    refundText, stakeText, storageText,
    lines: [
      storageText
        ? `Your ${refundText} (your stake of ${stakeText} plus ${storageText} of storage you paid) goes back to your Escrow balance.`
        : `Your ${refundText} goes back to your Escrow balance.`,
      "There is no fee for cancelling.",
      "The offer closes and nobody can take it. This cannot be undone.",
    ],
  };
}

export interface RefereeTerms { title: string; confirmLabel: string; lines: string[] }
export function refereeChangeTerms(a: { bet: Bet; mode: "maker-alone" | "propose"; account: string | null; agreeing: boolean; me: string | null }): RefereeTerms {
  const e: any = a.bet.envelope;
  const current = e.referee?.account ?? "the AI";
  const who = a.account ?? "the AI";
  const other = (e.maker === a.me ? a.bet.taker : e.maker) ?? "the other side";
  const free = "No bet money moves and there is no fee.";
  if (a.mode === "maker-alone") {
    return {
      title: a.account ? "Change the referee" : "Switch to the AI",
      confirmLabel: a.account ? `Change referee to ${a.account}` : "Switch to the AI",
      lines: [
        `${who} will decide this bet instead of ${current}. It takes effect right away.`,
        ...(a.account ? [] : ["Any referee tip on this bet is cleared."]),
        free,
        "Nobody has taken the bet yet, so you can change it again until someone does.",
      ],
    };
  }
  if (a.agreeing) {
    return {
      title: "Agree to this referee",
      confirmLabel: a.account ? `Agree: ${a.account} decides` : "Agree: the AI decides",
      lines: [
        `${other} already proposed ${who}. Agreeing makes ${who} the one who decides this bet, right away.`,
        free,
      ],
    };
  }
  return {
    title: a.account ? "Propose a referee" : "Propose the AI",
    confirmLabel: a.account ? `Propose ${a.account}` : "Propose the AI",
    lines: [
      `You propose that ${who} decides this bet instead of ${current}. Nothing changes until ${other} proposes the same.`,
      ...(a.account ? [] : ["If it goes ahead, any referee tip on this bet is cleared."]),
      free,
    ],
  };
}

export type AdminPhase = "success" | "pending" | "failure";
/** Only an outcome the bet itself shows is a success. A sent-but-unseen transaction is pending; everything else is a failure. */
export function adminFlowPhase(kind: string): AdminPhase {
  if (kind === "cancelled" || kind === "expired" || kind === "changed" || kind === "proposed") return "success";
  if (kind === "pending") return "pending";
  return "failure";
}
