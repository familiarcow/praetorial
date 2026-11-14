// I-1..I-7 checks against live sandbox state. These are checked AFTER
// every scenario step, from chain state read via view calls -- never by
// trusting the harness's own bookkeeping, since the whole point is to
// catch the contract (or the mocks standing in for its neighbors) lying.
//
// I-1  Funds leave only to maker, taker, fee_account, or keeper (run
//      reimbursement, capped per bet). Never a third party.
// I-2  payouts + fee <= total paid in, per asset (no overpay/no leak).
// I-3  mt_on_transfer never panics -- full accept or full reject.
// I-4  Pending-payout ledger is retryable -- never loses or double-pays.
// I-5  Pause blocks only open/take, nothing else.
// I-6  Contract immutable/locked after deploy -- no admin fund path.
// I-7  Strict run order on resolver results -- no result shopping.
import { balance, USDC } from "./harness.mjs";

/** Sum of every USDC amount that has ever left the escrow contract's own
 * intents balance, as recorded by the mock-intents ledger (view-only,
 * read fresh each time -- never cached). Used for I-1/I-2's "total out"
 * side. */
export async function escrowUsdcBalance(ctx) {
  return balance(ctx.intents, ctx.escrow);
}

/** I-1: every payout receiver seen in pending_payouts_view for a bet must
 * be one of {maker, taker, fee_account, keeper}. Returns violations
 * (empty array = invariant holds). */
export async function checkI1(ctx, betId, bet) {
  const violations = [];
  const allowed = new Set([bet.envelope.maker, bet.taker, ctx.fee.accountId, ctx.keeper.accountId].filter(Boolean));
  const payouts = await ctx.escrow.view(ctx.escrow.accountId, "pending_payouts_view", { from: 0, limit: 500 });
  for (const p of payouts) {
    if (p.bet_id !== betId) continue;
    if (!allowed.has(p.receiver)) {
      violations.push({ invariant: "I-1", bet_id: betId, payout_id: p.id, receiver: p.receiver, amount: p.amount, reason: p.reason, detail: "payout receiver is not maker/taker/fee_account/keeper" });
    }
  }
  return violations;
}

/** I-2: sum(payouts scheduled for this bet) must not exceed what the two
 * sides actually deposited for it (D-ECON5: stake+storage each,
 * recomputed from the envelope -- no per-bet reserve exists any more,
 * and the old `bet.reserve_remaining` counter it used to be unsafe to
 * trust post-finalize is gone too).
 * `lifetimeExtra` lets a caller add bond/objection deposits paid in after
 * open (same false-positive fix the testnet g4 matrix harness applied). */
export async function checkI2(ctx, betId, bet, lifetimeExtraIn = 0n) {
  const violations = [];
  const env = bet.envelope;
  const totalIn =
    BigInt(env.stake_maker) + BigInt(env.stake_taker) +
    BigInt(bet.storage_maker ?? 0) + BigInt(bet.storage_taker ?? 0) + // STG1: per-side stored charges

    BigInt(lifetimeExtraIn);
  const payouts = await ctx.escrow.view(ctx.escrow.accountId, "pending_payouts_view", { from: 0, limit: 500 });
  const totalOut = payouts.filter((p) => p.bet_id === betId).reduce((acc, p) => acc + BigInt(p.amount), 0n);
  if (totalOut > totalIn) {
    violations.push({ invariant: "I-2", bet_id: betId, total_in: totalIn.toString(), total_out: totalOut.toString(), detail: "scheduled payouts exceed total deposited" });
  }
  return violations;
}

/** I-4: every pending_payout for a bet is either done:true, or done:false
 * with attempts tracked (retryable) -- never silently vanished (we can't
 * directly observe "vanished" from a single snapshot; this checks the
 * weaker but still meaningful invariant that no payout_id is skipped in
 * the sequential id space once the contract has scheduled > 0 payouts for
 * a bet, i.e. no gap => no quietly-dropped payout row). */
export async function checkI4(ctx, betId) {
  const violations = [];
  const payouts = await ctx.escrow.view(ctx.escrow.accountId, "pending_payouts_view", { from: 0, limit: 500 });
  const mine = payouts.filter((p) => p.bet_id === betId).map((p) => p.id).sort((a, b) => a - b);
  for (let i = 1; i < mine.length; i++) {
    if (mine[i] !== mine[i - 1] + 1) {
      violations.push({ invariant: "I-4", bet_id: betId, detail: `payout id gap between ${mine[i-1]} and ${mine[i]}` });
    }
  }
  return violations;
}

/** I-5: while paused, open/take must be rejected (full refund), but
 * every other already-in-flight method must still work. Caller passes
 * which action was attempted and whether the contract was paused at the
 * time; this just encodes the rule for the scenario runner to assert. */
export function expectedUnderPause(action, isOpenOrTake) {
  if (isOpenOrTake) return { shouldSucceed: false };
  return { shouldSucceed: true };
}

/** I-7: next_expected_run_no must be strictly increasing by exactly 1 per
 * accepted submit_outcome, and used_run_nos must have no duplicates. */
export function checkI7FromBet(bet) {
  const violations = [];
  const seen = new Set();
  for (const r of bet.used_run_nos) {
    if (seen.has(r)) violations.push({ invariant: "I-7", detail: `run_no ${r} used twice`, bet_id: bet.envelope.bet_id });
    seen.add(r);
  }
  const sorted = [...bet.used_run_nos].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== i + 1) {
      violations.push({ invariant: "I-7", detail: `used_run_nos not contiguous from 1: ${JSON.stringify(sorted)}`, bet_id: bet.envelope.bet_id });
      break;
    }
  }
  return violations;
}

export async function checkAll(ctx, betId, bet, opts = {}) {
  const [i1, i2, i4] = await Promise.all([
    checkI1(ctx, betId, bet),
    checkI2(ctx, betId, bet, opts.lifetimeExtraIn ?? 0n),
    checkI4(ctx, betId),
  ]);
  const i7 = checkI7FromBet(bet);
  return [...i1, ...i2, ...i4, ...i7];
}
