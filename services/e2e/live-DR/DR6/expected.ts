// DR6 expectations, computed from chain views only (get_bet + side_fee via harness money.ts), never from the UI.
import { expectedSettlement, assertEscrowDrained, loadFeeConfig, type Params, type Settlement, type Role } from "../harness/money.js";

/** get_bet as the escrow returns it (u128 amounts are decimal strings). */
export interface BetView {
  envelope: { maker: string; stake_maker: string; stake_taker: string; fee_bps: number; maker_side: string; maker_asset: string; taker_asset: string };
  status: string; taker: string | null;
  fee_min_maker: string; fee_min_taker: string; storage_maker: string; storage_taker: string;
  outcome?: string | null; proposed_at?: unknown; last_resolution_raw?: unknown;
}

/** Escrow methods that mean a resolution run (and so a NEAR AI call) happened. Any of these in the tx list = DR6 failure. */
export const FORBIDDEN_METHODS = ["submit_outcome", "request_resolution", "on_resolution", "challenge", "finalize", "referee_rule"] as const;
/** Plan section 4: DR6 may SKIP only these verifier checks. */
export const ALLOWED_SKIPS = ["B3", "B5"] as const;

/** Money for the taker conceding (the loser) on a bet that was taken, from chain views. */
export function expectedConcedeByTaker(bet: BetView, feeBps?: bigint, minFee?: bigint): Settlement {
  const p: Params = {
    stakeMaker: BigInt(bet.envelope.stake_maker), stakeTaker: BigInt(bet.envelope.stake_taker),
    feeBps: feeBps ?? BigInt(bet.envelope.fee_bps),
    minFeeMaker: minFee ?? BigInt(bet.fee_min_maker), minFeeTaker: minFee ?? BigInt(bet.fee_min_taker),
    storageMaker: BigInt(bet.storage_maker), storageTaker: BigInt(bet.storage_taker),
    keepTerms: false, makerSide: bet.envelope.maker_side as "YES" | "NO", referee: false, tipMaker: false, tipTaker: false,
  };
  const s = expectedSettlement("CONCEDE_TAKER", p);
  assertEscrowDrained(s);
  return s;
}

/** Cancel of an untaken offer: the maker gets back stake + storage in full, nobody else is paid. */
export function expectedCancelRefund(bet: BetView): { maker: bigint; fee: bigint } {
  return { maker: BigInt(bet.envelope.stake_maker) + BigInt(bet.storage_maker), fee: 0n };
}

export function paidTo(s: Settlement, role: Role): bigint { return s.lines.filter((l) => l.to === role).reduce((a, l) => a + l.amount, 0n); }

/** Tx list assertion: returns the offending methods (empty = no resolution/NEAR AI path touched). */
export function forbiddenCalls(methods: string[]): string[] { return methods.filter((m) => (FORBIDDEN_METHODS as readonly string[]).includes(m)); }

/** Parses verify-bet output lines "SKIP B3 ..." and returns skipped ids; unexpected = skipped ids outside the allowed set. */
export function verifierSummary(out: string): { pass: number; fail: number; skip: number; skipped: string[]; unexpectedSkips: string[] } {
  const m = out.match(/# (\d+) PASS, (\d+) FAIL, (\d+) SKIP/);
  if (!m) throw new Error("verifier summary line not found");
  const skipped = [...out.matchAll(/^\s*SKIP\s+([A-Z]\d)\b/gm)].map((x) => x[1]);
  return { pass: +m[1], fail: +m[2], skip: +m[3], skipped, unexpectedSkips: skipped.filter((s) => !(ALLOWED_SKIPS as readonly string[]).includes(s)) };
}
export { loadFeeConfig };
