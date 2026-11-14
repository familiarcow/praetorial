// DR5 expectations, computed from chain views only (get_bet + side_fee via harness money.ts), never from the UI.
import { expectedSettlement, assertEscrowDrained, loadFeeConfig, type Params, type Settlement, type Role } from "../harness/money.js";

/** get_bet as the escrow returns it (u128 amounts are decimal strings). */
export interface BetView {
  envelope: { maker: string; stake_maker: string; stake_taker: string; fee_bps: number; maker_side: string; maker_asset: string; taker_asset: string; referee?: { account: string; mode: string } | null; tip_maker?: boolean; keep_terms?: boolean; funding_deadline?: string | number };
  status: string; taker: string | null;
  fee_min_maker: string; fee_min_taker: string; storage_maker: string; storage_taker: string;
  tip_maker?: string; tip_taker?: string;
  outcome?: string | null; proposed_at?: unknown; last_resolution_raw?: unknown;
}

/** AI-path / non-DR5 methods: any of these in the escrow tx list means the scenario left the human path (and could spend NEAR AI). */
export const FORBIDDEN_METHODS = ["submit_outcome", "request_resolution", "on_resolution", "challenge", "finalize", "concede", "void_after_deadline"] as const;
/** Methods that must appear (the real referee_rule through the relayer). */
export const REQUIRED_METHODS = ["referee_rule"] as const;
/** Plan section 4: DR5 may SKIP only these verifier checks. */
export const ALLOWED_SKIPS = ["B3", "B5"] as const;

/** Money for the named referee ruling YES, from the bet's own chain record. tip flags = what the parties actually ticked. */
export function expectedRefereeYes(bet: BetView, tips: { tipMaker: boolean; tipTaker: boolean }, feeBps?: bigint): Settlement {
  const p: Params = {
    stakeMaker: BigInt(bet.envelope.stake_maker), stakeTaker: BigInt(bet.envelope.stake_taker),
    feeBps: feeBps ?? BigInt(bet.envelope.fee_bps),
    minFeeMaker: BigInt(bet.fee_min_maker), minFeeTaker: BigInt(bet.fee_min_taker),
    storageMaker: BigInt(bet.storage_maker), storageTaker: BigInt(bet.storage_taker),
    keepTerms: bet.envelope.keep_terms ?? true, makerSide: bet.envelope.maker_side as "YES" | "NO",
    referee: !!bet.envelope.referee, tipMaker: tips.tipMaker, tipTaker: tips.tipTaker,
  };
  const s = expectedSettlement("REFEREE_YES", p);
  assertEscrowDrained(s);
  return s;
}

export function paidTo(s: Settlement, role: Role): bigint { return s.lines.filter((l) => l.to === role).reduce((a, l) => a + l.amount, 0n); }
export function forbiddenCalls(methods: string[]): string[] { return methods.filter((m) => (FORBIDDEN_METHODS as readonly string[]).includes(m)); }

/** Parses verify-bet output: summary counts and the skipped check ids; unexpected = skipped ids outside the allowed set. */
export function verifierSummary(out: string): { pass: number; fail: number; skip: number; skipped: string[]; unexpectedSkips: string[] } {
  const m = out.match(/# (\d+) PASS, (\d+) FAIL, (\d+) SKIP/);
  if (!m) throw new Error("verifier summary line not found");
  const skipped = [...out.matchAll(/^\s*SKIP\s+([A-Z]\d)\b/gm)].map((x) => x[1]);
  return { pass: +m[1], fail: +m[2], skip: +m[3], skipped, unexpectedSkips: skipped.filter((s) => !(ALLOWED_SKIPS as readonly string[]).includes(s)) };
}
/** Resume: escrow balance of everything except this bet (balance minus its two stakes and two storage deposits), so residue is measured per bet. */
export function escrowBaseline(bet: BetView, escrowBalance: bigint): bigint {
  return escrowBalance - BigInt(bet.envelope.stake_maker) - BigInt(bet.envelope.stake_taker) - BigInt(bet.storage_maker) - BigInt(bet.storage_taker);
}
/** Gas (raw) attached to the first FunctionCall of `method` anywhere in a tx status (plain or delegate-wrapped), else null. */
export function functionCallGas(status: unknown, method: string): bigint | null {
  let found: bigint | null = null;
  const walk = (o: unknown): void => {
    if (found !== null || !o || typeof o !== "object") return;
    const r = o as Record<string, unknown>;
    if (r.method_name === method && (typeof r.gas === "number" || typeof r.gas === "string")) { found = BigInt(r.gas); return; }
    for (const v of Object.values(r)) walk(v);
  };
  walk(status);
  return found;
}
export { loadFeeConfig };
