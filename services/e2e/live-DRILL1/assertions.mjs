// DRILL1 pure assertion logic (no chain access). Mirrors the frozen escrow contract (freeze-candidate-2, 6e33faa).
export const REFUSALS = {
  onlyGuardian: "only guardian",
  onlyProposed: "only the proposed guardian may accept",
  alreadyShutdown: "already shut down",
  unpauseAfterShutdown: "contract is shut down; unpause is impossible after shutdown",
  voidAfterShutdown: "contract is shut down",
};

/** A contract refusal (panic) is matched as a substring of the failure text; empty/undefined never matches. */
export function matchesRefusal(text, expected) {
  return typeof text === "string" && text.length > 0 && text.includes(expected);
}

/** lib.rs side_fee: min(stake, max(stake*fee_bps/10000, min_fee_per_side)). */
export function sideFee(stake, feeBps, minFee) {
  const pct = (stake * feeBps) / 10000n;
  const f = pct > minFee ? pct : minFee;
  return stake < f ? stake : f;
}

const add = (m, k, v) => m.set(k, (m.get(k) ?? 0n) + v);

/** concede(): winner = the non-conceder, gets (stake_m - fee_m) + (stake_t - fee_t); fee account gets fees + both storage charges. Same asset, no tips/bonds. */
export function concedeCredits({ maker, taker, conceder, stakeM, stakeT, feeBps, minFeeM, minFeeT, storageM, storageT, feeAccount }) {
  const winner = conceder === maker ? taker : maker;
  const fm = sideFee(stakeM, feeBps, minFeeM), ft = sideFee(stakeT, feeBps, minFeeT);
  const c = new Map();
  add(c, winner, stakeM - fm + (stakeT - ft));
  add(c, feeAccount, fm + ft + storageM + storageT);
  return c;
}

/** emergency_refund(): each party gets exactly stake + storage charge back; no fee. A bet with no taker refunds only the maker. */
export function refundCredits({ maker, taker, stakeM, stakeT, storageM, storageT }) {
  const c = new Map();
  add(c, maker, stakeM + storageM);
  if (taker) add(c, taker, stakeT + storageT);
  return c;
}

/** observed delta minus expected delta; 0n means exact. */
export function residue(expected, observed) { return expected - observed; }

/** escrow's intents balance delta attributable to the drill bets. */
export function expectedEscrowDelta({ deposited, paidOut }) { return deposited - paidOut; }

export function mergeCredits(...maps) { const o = new Map(); for (const m of maps) for (const [k, v] of m) add(o, k, v); return o; }
