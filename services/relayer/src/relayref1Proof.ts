// RLYDEP1: pure helpers for the live proof script (scripts/relayref1_proof.ts). No I/O.
export interface HumanReferee { account: string; mode: "Human" }

/** Exact args the relayer policy accepts for escrow amend_referee. */
export function amendRefereeArgs(betId: number, referee: HumanReferee | null): { bet_id: number; new_referee_json: string } {
  return { bet_id: betId, new_referee_json: JSON.stringify(referee) };
}

/** Same call plus one extra key: the relayer must refuse it (PolicyViolation) before any broadcast. */
export function badAmendRefereeArgs(betId: number, referee: HumanReferee | null): Record<string, unknown> {
  return { ...amendRefereeArgs(betId, referee), extra: 1 };
}

/** null when the maker refund settled: balance rose by exactly the deposit and the escrow holds 0 for the bet. */
export function checkRefundSettled(i: { before: string; after: string; deposit: string; escrowLeft: string }): string | null {
  if (BigInt(i.after) - BigInt(i.before) !== BigInt(i.deposit)) return `refund mismatch: balance ${i.before} -> ${i.after}, expected +${i.deposit}`;
  if (BigInt(i.escrowLeft) !== 0n) return `escrow still holds ${i.escrowLeft} for the bet`;
  return null;
}
