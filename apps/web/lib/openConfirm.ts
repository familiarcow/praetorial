// FE8 (S8, S9): read-back after Open and after Cancel. The relayer only says "sent"; the contract decides afterwards (a
// refused Open is a full refund, I-3, not an error). So success is shown ONLY when get_bet returns this maker's bet with the
// same terms hash. A refusal is read from the transaction's `open_rejected` log, and the refund is checked from the balance.
import type { Bet } from "./escrowAdapter";
import { parseOpenRejected, plainOpenRefusal, refusalSentence, STILL_CONFIRMING_MESSAGE } from "./openRefusal";
import { e2eConfirm } from "./testHooks";

export interface OpenDeps {
  betCount(): Promise<number>;
  getBet(id: number): Promise<Bet | null>;
  /** The maker's Intents balance of the deposit asset (base units). */
  balance(): Promise<bigint>;
  /** Logs of the finished transaction, or null when it isn't readable (yet). */
  txLogs(txHash: string): Promise<string[] | null>;
  sleep(ms: number): Promise<void>;
}

export type OpenOutcome =
  | { kind: "opened"; betId: number; bet: Bet }
  | { kind: "refused"; reason: string | null; known: boolean; refunded: boolean; sentence: string }
  | { kind: "pending"; message: string };

const MAX_SCAN = 20;

async function safe<T>(f: () => Promise<T>): Promise<T | undefined> {
  try { return await f(); } catch { return undefined; }
}

async function findOpened(deps: OpenDeps, a: { maker: string; termsHash: string; afterCount: number }): Promise<{ betId: number; bet: Bet } | null> {
  const count = await safe(() => deps.betCount());
  if (typeof count !== "number" || !(count > a.afterCount)) return null;
  const from = Math.max(a.afterCount + 1, count - MAX_SCAN + 1);
  for (let id = count; id >= from; id--) {
    const bet = await safe(() => deps.getBet(id));
    if (bet && bet.envelope.maker === a.maker && bet.envelope.terms_hash === a.termsHash) return { betId: id, bet };
  }
  return null;
}

export async function confirmOpen(a: {
  deps: OpenDeps;
  maker: string;
  termsHash: string;
  before: { count: number; balance: bigint };
  txHash: string | null;
  attempts?: number;
  delayMs?: number;
}): Promise<OpenOutcome> {
  const attempts = a.attempts ?? 10;
  const delay = a.delayMs ?? 2000;
  for (let i = 0; i < attempts; i++) {
    const hit = await findOpened(a.deps, { maker: a.maker, termsHash: a.termsHash, afterCount: a.before.count });
    if (hit) return { kind: "opened", ...hit };
    const logs = a.txHash ? await safe(() => a.deps.txLogs(a.txHash!)) : undefined;
    if (logs) {
      // The transaction is final. Look once more (a bet created in the same block), then it is a refusal.
      const late = await findOpened(a.deps, { maker: a.maker, termsHash: a.termsHash, afterCount: a.before.count });
      if (late) return { kind: "opened", ...late };
      const reason = parseOpenRejected(logs);
      const bal = await safe(() => a.deps.balance());
      const refunded = typeof bal === "bigint" && bal >= a.before.balance;
      return { kind: "refused", reason, known: plainOpenRefusal(reason).known, refunded, sentence: refusalSentence(reason, refunded) };
    }
    if (i < attempts - 1) await a.deps.sleep(delay);
  }
  return { kind: "pending", message: STILL_CONFIRMING_MESSAGE };
}

export type CancelOutcome =
  | { kind: "cancelled"; message: string }
  | { kind: "taken"; message: string }
  | { kind: "expired"; message: string }
  | { kind: "pending"; message: string };

export const CANCELLED_MESSAGE = "Your bet is cancelled and your money is back.";
export const TAKEN_MESSAGE = "Someone took this bet a moment ago. It's live now.";

export async function confirmCancel(a: { betId: number; deps: Pick<OpenDeps, "getBet" | "sleep">; attempts?: number; delayMs?: number }): Promise<CancelOutcome> {
  const attempts = a.attempts ?? 8;
  const delay = a.delayMs ?? 1500;
  for (let i = 0; i < attempts; i++) {
    const bet = await safe(() => a.deps.getBet(a.betId));
    if (bet) {
      if (bet.status === "Cancelled") return { kind: "cancelled", message: CANCELLED_MESSAGE };
      if (bet.status === "Expired") return { kind: "expired", message: "This offer had already expired, so your money was already returned." };
      if (bet.status !== "Open") return { kind: "taken", message: TAKEN_MESSAGE };
    }
    if (i < attempts - 1) await a.deps.sleep(delay);
  }
  return { kind: "pending", message: "Still confirming. Your money is safe; check My bets." };
}

/** Test-only seam (lib/testHooks.ts): mocked specs shorten the read-back polling. Defaults apply in the real app. */
export function confirmTiming(): { delayMs?: number; attempts?: number } {
  const w = e2eConfirm();
  return w ? { delayMs: w.delayMs, attempts: w.attempts } : {};
}
