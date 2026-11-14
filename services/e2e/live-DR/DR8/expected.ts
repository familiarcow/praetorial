// DR8 expectations from chain views only. Bond rules (contracts/escrow finalize, D-AUDIT8/D-BOND1/D-DISPUTE1):
//  - quote = max(min_bond, 10% pot) * 2^(round-1) + run_price (view required_challenge_bond), posted in the challenger's own asset.
//  - bond is attributed by the FINAL outcome: challenger_won = final != outcome when the bond was accepted (round1).
//  - lost: bond - run_price -> counterparty, run_price -> keeper. won: bond - run_price -> challenger, run_price -> keeper
//    (reimbursement from the loser's funds happens only on VOID, so not here). Stakes follow the final outcome as in DR1.
import { expectedDecisive, paidTo, winnerOf, type BetView } from "../DR1/expected.js";
import type { Settlement } from "../harness/money.js";
export { paidTo, winnerOf };
export type Outcome = "YES" | "NO";
export type Role = "maker" | "taker";
const BPS_DENOM = 10_000n;

export function quoteBond(i: { pot: bigint; minBond: bigint; runPrice: bigint; round: number }): bigint {
  const floor = i.minBond > (i.pot * 1000n) / BPS_DENOM ? i.minBond : (i.pot * 1000n) / BPS_DENOM;
  return floor * 2n ** BigInt(i.round - 1) + i.runPrice;
}
export function loserOf(bet: BetView, outcome: Outcome): Role { return winnerOf(bet, outcome) === "maker" ? "taker" : "maker"; }

export interface ChallengeExpectation {
  challenger: Role; bondResult: "won" | "lost"; settlement: Settlement;
  credits: Record<Role | "fee" | "keeper", bigint>;
  /** challenger's net change vs before staking (credits - stake - bond); counterparty likewise */
  netChange: Record<Role, bigint>;
}
export function expectedChallenge(bet: BetView, i: { round1: Outcome; final: Outcome; bond: bigint; runPrice: bigint }): ChallengeExpectation {
  const challenger = loserOf(bet, i.round1), other: Role = challenger === "maker" ? "taker" : "maker";
  const settlement = expectedDecisive(bet, i.final);
  const won = i.final !== i.round1; // BD5 attribution
  const credits: Record<Role | "fee" | "keeper", bigint> = { maker: paidTo(settlement, "maker"), taker: paidTo(settlement, "taker"), fee: paidTo(settlement, "fee"), keeper: i.runPrice };
  credits[won ? challenger : other] += i.bond - i.runPrice;
  const stake = (r: Role) => BigInt(r === "maker" ? bet.envelope.stake_maker : bet.envelope.stake_taker);
  return { challenger, bondResult: won ? "won" : "lost", settlement, credits, netChange: { [challenger]: credits[challenger] - stake(challenger) - i.bond, [other]: credits[other] - stake(other) } as Record<Role, bigint> };
}
export function bondProblems(i: { quoted: bigint; paid: bigint }): string[] {
  return i.quoted === i.paid ? [] : [`bond paid ${i.paid} != required_challenge_bond ${i.quoted}`];
}
export const REQUIRED_METHODS = ["request_resolution", "submit_outcome", "finalize"] as const;
export const FORBIDDEN_METHODS = ["concede", "referee_rule", "void_after_deadline"] as const;
/** methods = escrow-side method names in tx order (mt_on_transfer carries the Bond message). Round 0 + round 2 = 2 each of request_resolution/submit_outcome. */
export function methodProblems(methods: string[]): string[] {
  const n = (m: string) => methods.filter((x) => x === m).length;
  const p: string[] = [];
  if (n("request_resolution") < 2) p.push("missing round-2 request_resolution (need 2)");
  if (n("submit_outcome") < 2) p.push("missing round-2 submit_outcome (need 2)");
  if (n("mt_on_transfer") < 1) p.push("missing challenge bond transfer (mt_on_transfer)");
  if (n("finalize") < 1) p.push("missing finalize");
  return [...p, ...methods.filter((m) => (FORBIDDEN_METHODS as readonly string[]).includes(m)).map((m) => `forbidden ${m}`)];
}
