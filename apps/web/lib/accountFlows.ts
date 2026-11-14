// MODAL1c5: pure helpers for the account flow modals (move to betting balance, withdraw to wallet). No React.
// Amounts are BigInt end to end (lib/decimal, lib/assets); the NEAR reserve comes from lib/moveToBetting.
import type { FlowStep } from "./flowModal";
import { toBaseUnits } from "./assets";
import { formatMoney } from "./intentsBalance";
import { NEAR_SPENDABLE_RESERVE_YOCTO, type Holding, type MoveSource } from "./moveToBetting";

/** Move is one irreversible step: read exactly what happens, then confirm. Withdraw asks the amount first. */
export const MOVE_STEPS: FlowStep[] = [{ id: "confirm", title: "Confirm" }];
export const WITHDRAW_STEPS: FlowStep[] = [{ id: "amount", title: "Amount" }, { id: "confirm", title: "Confirm" }];
export const MOVE_DRAFT_KEY = (symbol: string, source: MoveSource) => `account-move-${symbol}-${source}`;
export const WITHDRAW_DRAFT_KEY = (symbol: string) => `account-withdraw-${symbol}`;

export interface AccountTerms { amountText: string; confirmLabel: string; lines: string[] }

export function moveTerms(h: Pick<Holding, "symbol" | "source" | "amountUnits">): AccountTerms {
  const amountText = formatMoney(h.symbol, h.amountUnits);
  const lines = [
    `${amountText} goes from your NEAR account into your betting balance, where your bets draw their stakes from.`,
    "There is no fee from us, and the network cost is paid for you.",
  ];
  if (h.source === "native") {
    lines.splice(1, 0, `Your NEAR is wrapped first (so it can be used in bets), then moved. ${formatMoney("NEAR", NEAR_SPENDABLE_RESERVE_YOCTO.toString())} stays in your NEAR account to pay for storage.`);
  }
  // M1 (UIR1 §3.6): short label; the amount is in the body.
  return { amountText, confirmLabel: "Move to betting", lines };
}

export type AmountCheck = { ok: true; units: string } | { ok: false; message: string };
export function parseWithdrawAmount(symbol: string, raw: string, balanceUnits: string | null): AmountCheck {
  const blank: AmountCheck = { ok: false, message: "Enter an amount to withdraw." };
  let units: string;
  try { units = toBaseUnits(symbol, raw); if (BigInt(units) <= 0n) return blank; } catch { return blank; }
  if (balanceUnits !== null && BigInt(units) > BigInt(balanceUnits)) return { ok: false, message: "That's more than your betting balance." };
  return { ok: true, units };
}

export function withdrawTerms(symbol: string, amountUnits: string, _account?: string): AccountTerms {
  const amountText = formatMoney(symbol, amountUnits);
  const lines = [
    // M1 (UIR1 §3.6): the user's own account is "your NEAR account", not a 64-char id over two lines (it is in Account details).
    `${amountText} leaves your betting balance and is sent to your NEAR account.`,
    "There is no fee from us, and the network cost is paid for you.",
    `If your wallet isn't registered for ${symbol} yet, a small one-time registration deposit is taken from your NEAR account first.`,
  ];
  if (symbol === "NEAR") lines.push("NEAR arrives in your wallet as wrapped NEAR.");
  return { amountText, confirmLabel: "Withdraw", lines };
}


export type AccountPhase = "success" | "pending" | "failure";
/** Only a clean, chain-checked outcome is a success. An unknown outcome ("checking": sent, result not known yet) is pending, never a
 * failure (SM2 STATES.md M5/M7, gap F5-2). Everything else is a failure with a plain reason. */
export function accountFlowPhase(kind: string): AccountPhase {
  if (kind === "moved" || kind === "withdrawn") return "success";
  return kind === "checking" ? "pending" : "failure";
}
