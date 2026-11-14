// DR7 expectations, computed from chain views only (get_bet + side_fee via harness money.ts), never from the UI.
// Contract rule (contracts/escrow/src/lib.rs void_after_deadline, read 2026-11-09): status Voided/outcome VOID, pay_tips() (a silent referee
// still earns an opted-in tip), then each side is refunded stake - own tip and its own storage charge (keep_terms=false). NO protocol fee is taken.
import { expectedSettlement, assertEscrowDrained, loadFeeConfig, type Params, type Settlement, type Role } from "../harness/money.js";

export interface BetView {
  envelope: { maker: string; stake_maker: string; stake_taker: string; fee_bps: number; maker_side: string; maker_asset: string; taker_asset: string; keep_terms?: boolean; tip_maker?: boolean; funding_deadline?: string | number; resolve_deadline?: string | number; referee?: { account: string; mode: string } | null };
  status: string; taker: string | null;
  fee_min_maker: string; fee_min_taker: string; storage_maker: string; storage_taker: string;
  tip_taker?: string | null; outcome?: string | null;
}

/** Escrow methods that mean a resolution run or ruling happened. Any of these in the tx list = DR7 failure (void_after_deadline is the ONLY ending). */
export const FORBIDDEN_METHODS = ["submit_outcome", "request_resolution", "on_resolution", "challenge", "finalize", "referee_rule", "concede"] as const;
/** D-DR1c: a no-AI-ruling ending may SKIP these verifier checks (reason must be 'not available' / 'no submitted results'). */
export const ALLOWED_SKIPS = ["B3", "B4", "B5", "B6"] as const;
/** Allowed offline-only SKIP for the E4 online check. */
export const ALLOWED_SKIP_E4 = "E4";

export const MIN_RESOLVE_NOTE = "UI minimum: the Referee deadline is a <input type=date> (00:00 UTC) that must be after the event time; the contract only requires resolve_deadline > funding_deadline (> now+60s). Earliest = next UTC midnight after the event.";

export function expectedDeadlineRefund(bet: BetView, tips: { tipMaker: boolean; tipTaker: boolean } = { tipMaker: false, tipTaker: false }, feeBps?: bigint, minFee?: bigint): Settlement {
  const p: Params = {
    stakeMaker: BigInt(bet.envelope.stake_maker), stakeTaker: BigInt(bet.envelope.stake_taker),
    feeBps: feeBps ?? BigInt(bet.envelope.fee_bps),
    minFeeMaker: minFee ?? BigInt(bet.fee_min_maker), minFeeTaker: minFee ?? BigInt(bet.fee_min_taker),
    storageMaker: BigInt(bet.storage_maker), storageTaker: BigInt(bet.storage_taker),
    keepTerms: bet.envelope.keep_terms === true, makerSide: bet.envelope.maker_side as "YES" | "NO", referee: true, tipMaker: tips.tipMaker, tipTaker: tips.tipTaker,
  };
  const s = expectedSettlement("DEADLINE_REFUND", p);
  assertEscrowDrained(s);
  return s;
}

export function paidTo(s: Settlement, role: Role): bigint { return s.lines.filter((l) => l.to === role).reduce((a, l) => a + l.amount, 0n); }
export function forbiddenCalls(methods: string[]): string[] { return methods.filter((m) => (FORBIDDEN_METHODS as readonly string[]).includes(m)); }

/** Parses verify-bet output; unexpected = SKIPped ids outside B3,B4,B5,B6,E4. */
export function verifierSummary(out: string): { pass: number; fail: number; skip: number; skipped: string[]; unexpectedSkips: string[] } {
  const m = out.match(/# (\d+) PASS, (\d+) FAIL, (\d+) SKIP/);
  if (!m) throw new Error("verifier summary line not found");
  const skipped = [...out.matchAll(/^\s*SKIP\s+([A-Z]\d)\b/gm)].map((x) => x[1]);
  const ok: readonly string[] = [...ALLOWED_SKIPS, ALLOWED_SKIP_E4];
  return { pass: +m[1], fail: +m[2], skip: +m[3], skipped, unexpectedSkips: skipped.filter((s) => !ok.includes(s)) };
}
export { loadFeeConfig };
