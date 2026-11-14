// DR2 expectations: money from chain views only (reuses DR1's expectedDecisive over harness money.ts) + the VOID/refund path + the verifier expectations.
import { expectedSettlement, assertEscrowDrained, type Params, type Settlement } from "../harness/money.js";
import { type BetView } from "../DR1/expected.js";
export { expectedDecisive, paidTo, winnerOf, loadFeeConfig, methodProblems, REQUIRED_METHODS, FORBIDDEN_METHODS, type BetView } from "../DR1/expected.js";

/** AI judge says VOID (tie/postponed/cannot decide): both stakes back, no fee; keep_terms=true so the storage charges go to the fee account (harness/money.ts refund). */
export function expectedVoid(bet: BetView): Settlement {
  const p: Params = {
    stakeMaker: BigInt(bet.envelope.stake_maker), stakeTaker: BigInt(bet.envelope.stake_taker), feeBps: BigInt(bet.envelope.fee_bps),
    minFeeMaker: BigInt(bet.fee_min_maker), minFeeTaker: BigInt(bet.fee_min_taker), storageMaker: BigInt(bet.storage_maker), storageTaker: BigInt(bet.storage_taker),
    keepTerms: bet.envelope.keep_terms === true, makerSide: bet.envelope.maker_side as "YES" | "NO", referee: false, tipMaker: false, tipTaker: false,
  };
  const s = expectedSettlement("VOID", p);
  assertEscrowDrained(s);
  return s;
}
/** Expected verify-bet result for a live AI run: 0 FAIL; no SKIP except E4 offline. B4 is asserted PASS: if the resolver still records no raw NEAR AI stream (B4 SKIP/PARTIAL) that is an open PM finding and this stays red. */
export const EXPECTED_VERIFIER = { skipsOffline: ["E4"], skipsOnline: [] as string[], b4: "PASS" } as const;

export function verifierProblems(out: string, o: { offline: boolean }): string[] {
  const m = out.match(/# (\d+) PASS, (\d+) FAIL, (\d+) SKIP/);
  if (!m) throw new Error("verifier summary line not found");
  const problems: string[] = [];
  if (+m[2] > 0) problems.push(`${m[2]} FAIL`);
  const allowed: readonly string[] = o.offline ? EXPECTED_VERIFIER.skipsOffline : EXPECTED_VERIFIER.skipsOnline;
  for (const x of out.matchAll(/^\s*SKIP\s+([A-Z]\d)\b/gm)) if (!allowed.includes(x[1])) problems.push(`unexpected SKIP ${x[1]}`);
  return problems;
}
