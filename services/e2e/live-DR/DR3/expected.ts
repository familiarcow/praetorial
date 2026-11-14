// DR3 expectations: money from chain views only (reuses DR1's expectedDecisive over harness money.ts) + the verifier expectations.
export { expectedDecisive, paidTo, winnerOf, loadFeeConfig, methodProblems, REQUIRED_METHODS, FORBIDDEN_METHODS, type BetView } from "../DR1/expected.js";

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
