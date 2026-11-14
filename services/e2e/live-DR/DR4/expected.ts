// DR4 expectations, computed from chain views only (get_bet + side_fee via harness money.ts), never from the UI.
// AI-judged bet, no referee: decisive finalize pays the winner both stakes minus side_fee per side; fee account gets fees + storage.
import { expectedSettlement, assertEscrowDrained, loadFeeConfig, type Params, type Settlement, type Role } from "../harness/money.js";

export interface BetView {
  envelope: { maker: string; stake_maker: string; stake_taker: string; fee_bps: number; maker_side: string; maker_asset: string; taker_asset: string; keep_terms?: boolean; tip_maker?: boolean; funding_deadline?: string | number; resolve_deadline?: string | number; referee?: { account: string; mode: string } | null };
  status: string; taker: string | null;
  fee_min_maker: string; fee_min_taker: string; storage_maker: string; storage_taker: string;
  tip_taker?: string | null; outcome?: string | null;
}
/** Verifier SKIPs allowed for DR4 (D-DR4c / plan section 4): none, except E4 when run offline. */
export const ALLOWED_SKIPS: readonly string[] = [];
export const ALLOWED_SKIP_E4 = "E4";

export function expectedFor(bet: BetView, outcome: "YES" | "NO" | "VOID", feeBps?: bigint): Settlement {
  const p: Params = {
    stakeMaker: BigInt(bet.envelope.stake_maker), stakeTaker: BigInt(bet.envelope.stake_taker),
    feeBps: feeBps ?? BigInt(bet.envelope.fee_bps),
    minFeeMaker: BigInt(bet.fee_min_maker), minFeeTaker: BigInt(bet.fee_min_taker),
    storageMaker: BigInt(bet.storage_maker), storageTaker: BigInt(bet.storage_taker),
    keepTerms: bet.envelope.keep_terms === true, makerSide: bet.envelope.maker_side as "YES" | "NO", referee: false, tipMaker: false, tipTaker: false,
  };
  const s = expectedSettlement(outcome, p);
  assertEscrowDrained(s);
  return s;
}
export const expectedDecisive = expectedFor;
export function paidTo(s: Settlement, role: Role): bigint { return s.lines.filter((l) => l.to === role).reduce((a, l) => a + l.amount, 0n); }
/** Who wins an outcome: maker iff outcome equals the maker's side. */
export function winnerOf(bet: BetView, outcome: "YES" | "NO"): "maker" | "taker" { return bet.envelope.maker_side === outcome ? "maker" : "taker"; }
/** DR4 resolves through the AI path: these must appear; concede/referee_rule/void_after_deadline must not. */
export const REQUIRED_METHODS = ["request_resolution", "submit_outcome", "finalize"] as const;
export const FORBIDDEN_METHODS = ["concede", "referee_rule", "void_after_deadline", "challenge"] as const;
export function methodProblems(methods: string[]): string[] {
  return [...REQUIRED_METHODS.filter((m) => !methods.includes(m)).map((m) => `missing ${m}`), ...methods.filter((m) => (FORBIDDEN_METHODS as readonly string[]).includes(m)).map((m) => `forbidden ${m}`)];
}
export function verifierSummary(out: string): { pass: number; fail: number; skip: number; skipped: string[]; unexpectedSkips: string[] } {
  const m = out.match(/# (\d+) PASS, (\d+) FAIL, (\d+) SKIP/);
  if (!m) throw new Error("verifier summary line not found");
  const skipped = [...out.matchAll(/^\s*SKIP\s+([A-Z]\d)\b/gm)].map((x) => x[1]);
  const ok = [...ALLOWED_SKIPS, ALLOWED_SKIP_E4];
  return { pass: +m[1], fail: +m[2], skip: +m[3], skipped, unexpectedSkips: skipped.filter((s) => !ok.includes(s)) };
}
export { loadFeeConfig };
