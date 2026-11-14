// RFRZ2c plan helpers (pure, offline-testable). Money comes from get_bet-shaped records via the DR harness money.ts.
import { expectedConcedeByTaker, paidTo, type BetView } from "../live-DR/DR6/expected.js";

export const STAKE_TOKEN_ID = "nep141:wrap.testnet";
export const MIN_WINDOW_HOURS = 5;
export const WINDOW_HOURS = 6; // event window must be LONGER than 5 h

/** deadline_utc value for the guided form (minute resolution, UTC), WINDOW_HOURS from now. */
export function windowDeadlineUtc(now: Date): string {
  const d = new Date(now.getTime() + WINDOW_HOURS * 3_600_000); d.setUTCSeconds(0, 0);
  return d.toISOString().slice(0, 16);
}

/** Expected raw wNEAR balance deltas when the taker concedes a taken bet. escrowResidue = deposits - paid (must be 0). */
export function expectedMoney(bet: BetView): { maker: bigint; taker: bigint; fee: bigint; escrowResidue: bigint } {
  const s = expectedConcedeByTaker(bet);
  const maker = paidTo(s, "maker"), taker = paidTo(s, "taker"), fee = paidTo(s, "fee");
  return { maker, taker, fee, escrowResidue: s.deposits.maker + s.deposits.taker - maker - taker - fee };
}

/** The review card's "Network storage" cell must show a real NEAR amount: not the "not available" / "loading" placeholders. */
export function storageLineIsReal(text: string): boolean {
  const t = text.trim();
  return !/not available|loading/i.test(t) && /\d/.test(t) && /near/i.test(t);
}

/** Hash of the first tx (history order) whose receipts include `method`; the web has no concede-tx element, so chain history is the source. */
export function findTxByMethod(hist: { hash: string; methods: string[] }[], method: string): string | undefined {
  return hist.find((h) => h.methods.includes(method))?.hash;
}

type Bal = { maker: bigint; taker: bigint; fee: bigint; escrow: bigint };
/** Compares final-minus-mid deltas with the expected settlement and the escrow with its pre-bet balance. Empty = all match. */
export function moneyMismatches(exp: { maker: bigint; taker: bigint; fee: bigint }, mid: Bal, after: Bal, before: { escrow: bigint }): string[] {
  const bad: string[] = [];
  for (const k of ["maker", "taker", "fee"] as const) if (after[k] - mid[k] !== exp[k]) bad.push(`${k} delta ${after[k] - mid[k]} != ${exp[k]}`);
  if (after.escrow !== before.escrow) bad.push(`escrow ${after.escrow} != before ${before.escrow}`);
  return bad;
}
