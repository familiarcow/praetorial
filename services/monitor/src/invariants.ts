// Pure invariant checks over chain-state snapshots. No RPC, no I/O here —
// snapshot.ts does the live reads; this file is unit-testable with plain
// fixtures. Mirrors escrow contract spec v1 "Invariants (tested on every
// path)" (I-1, I-2, I-4, I-5). I-3 (mt_on_transfer never panics, full
// accept/reject) and I-6 (no admin power) are structural/code invariants
// already covered by the Rust unit tests, not runtime balance facts, so
// they're out of scope for this runtime monitor per the task brief.
import type { Bet, PendingPayout } from "@praetorial/common/types.js";

export interface Violation {
  invariant: "I-1" | "I-2" | "I-4" | "I-5" | "I-7";
  detail: string;
  /** Set for per-asset contract-wide checks so alerts dedupe per asset. */
  asset?: string;
}

export interface Actors {
  maker: string;
  taker: string | null;
  feeAccount: string;
  keeper: string;
  /** This bet's own named arbiter (Envelope.arbiter), if any. `arbiter_pick`
   * legitimately pays `arbiter_fee` straight to this account -- that's the
   * entire point of the role, not a leak (found live, 2026-11-02: the
   * monitor's allowed-set was missing it, producing a false I-1 violation
   * on every bet with an arbiter configured). Per-bet, not a fixed service
   * account, since different bets can name different arbiters. */
  arbiter?: string | null;
}

/** I-1: funds leave only to maker, taker, fee_account, keeper, or (when the
 * bet has one configured) its own named arbiter. Checked against every
 * payout (pending or done) recorded for the bet — a payout row is the only
 * path money leaves the contract, so if every row's receiver is in the
 * allowed set, no other destination is possible. */
export function checkI1(payouts: PendingPayout[], actors: Actors): Violation[] {
  const allowed = new Set(
    [actors.maker, actors.taker, actors.feeAccount, actors.keeper, actors.arbiter].filter(Boolean),
  );
  const violations: Violation[] = [];
  for (const p of payouts) {
    if (!allowed.has(p.receiver)) {
      violations.push({
        invariant: "I-1",
        detail: `payout id=${p.id} bet=${p.bet_id} reason=${p.reason} receiver=${p.receiver} not in {maker,taker,fee,keeper}`,
      });
    }
  }
  return violations;
}

export interface FundsIn {
  betId: number;
  // D-ECON5: no per-bet reserve any more -- stake + storage only.
  totalInYocto: bigint; // stake_maker+stake_taker+storage_maker+storage_taker (STG1) actually received
}

/** I-2 (per-bet half): total paid out for a bet must never exceed what
 * was funded into it. Only `done` payouts count as actually-left money;
 * pending (not yet executed/retried) payouts are still contract-held. */
export function checkI2PerBet(
  payouts: PendingPayout[],
  fundsIn: Map<number, bigint>,
): Violation[] {
  const outByBet = new Map<number, bigint>();
  for (const p of payouts) {
    if (!p.done) continue;
    outByBet.set(p.bet_id, (outByBet.get(p.bet_id) ?? 0n) + BigInt(p.amount));
  }
  const violations: Violation[] = [];
  for (const [betId, out] of outByBet) {
    const inAmt = fundsIn.get(betId);
    if (inAmt === undefined) continue; // unknown bet, not this monitor's business
    if (out > inAmt) {
      violations.push({
        invariant: "I-2",
        detail: `bet=${betId} paid out ${out} exceeds funded in ${inAmt}`,
      });
    }
  }
  return violations;
}

/** I-2 (contract-wide half): sum of every tracked outstanding balance
 * (D-ECON5: funds-in minus done-payouts per non-terminal bet, no more
 * reserve_remaining counter + undone payout amounts, i.e. everything
 * the contract still "owns" in its own books) must equal the escrow
 * contract's actual intents balance. A mismatch means money either
 * leaked (actual < tracked) or got double-counted/stuck untracked
 * (actual > tracked beyond the safety margin). */
export function checkI2ContractWide(
  trackedTotalYocto: bigint,
  actualIntentsBalanceYocto: bigint,
): Violation[] {
  if (trackedTotalYocto !== actualIntentsBalanceYocto) {
    return [
      {
        invariant: "I-2",
        detail: `contract-wide tracked=${trackedTotalYocto} != intents balance=${actualIntentsBalanceYocto}`,
      },
    ];
  }
  return [];
}

/** MON2/MON3: optional bet data for the I-4 checks. All maps are keyed by
 * bet_id; an absent entry means "unknown" and the matching check is skipped
 * (never a false alarm). */
export interface I4Opts {
  /** MON2: max the bet can pay out as payout_winner per token (gross stakes;
   * the fee is unknown to the monitor so this is a sound upper bound). */
  potByBet?: Map<number, Map<string, bigint>>;
  /** MON3: number of challenge bonds (= rounds) the bet carries. Bounds the
   * `per_bond` reasons: the contract schedules at most one row per bond. */
  roundsByBet?: Map<number, number>;
  /** MON3: number of objection deposits. Bounds the `per_objection` reasons. */
  objectionsByBet?: Map<number, number>;
}

/** The contract schedules at most 2 payout_winner rows per bet: one per
 * side's stake (maker stake in maker_asset, taker stake in taker_asset). */
const MAX_WINNER_ROWS_PER_BET = 2;

export type RowCap = number | "per_bond" | "per_objection";

/** MON3: max rows per (bet, receiver, token, reason) the escrow contract can
 * legitimately schedule, derived from every `schedule_payout` call site in
 * contracts/escrow/src/lib.rs (line numbers as of main b20ed3b; the
 * drift-guard test greps lib.rs and fails if a reason is added or removed
 * without updating this table).
 *  - number: fixed cap.
 *  - "per_bond": one row per challenge bond/round (cap = bet.bonds.length;
 *    the row carries no round number, so this is the safe upper bound that
 *    also covers one holder/counterparty owning several rounds).
 *  - "per_objection": one row per objection deposit (cap = objection count).
 * Per-bond/objection reasons are skipped when the count is unknown.
 * Reasons absent from this table are never flagged (unknown/new reason).
 * A maker==taker account is not a concern: every maker/taker reason below is
 * side-specific (…_maker / …_taker) so it counts its own side's row only. */
export const REASON_ROW_CAPS: Readonly<Record<string, { cap: RowCap; src: string }>> = {
  // 1 stake per side: 2 for a same-asset bet (both rows hit the winner/token);
  // cross-asset has 1 per token. Also enforced per bet by MAX_WINNER_ROWS_PER_BET.
  payout_winner: { cap: 2, src: "lib.rs:3567,3570,4140,4141" },
  // fee account: one per side's asset -> 2 same-asset (maker fee + taker fee), 1 per token cross-asset.
  fee_and_storage: { cap: 2, src: "lib.rs:3577,3580,4142,4143" },
  // RF2 / D-REFUI4: referee tip, one row per bettor (own asset) -> 2 same-asset, 1 per token cross-asset.
  referee_tip: { cap: 2, src: "lib.rs:2978,2981" },
  cancel_expire_refund: { cap: 1, src: "lib.rs:2094" },
  void_refund_maker: { cap: 1, src: "lib.rs:3538" },
  void_refund_taker: { cap: 1, src: "lib.rs:3539" },
  // keep_terms storage to fee_account: same-asset one combined row, cross-asset one per token.
  void_storage_keep_terms: { cap: 1, src: "lib.rs:3546,3553,3556,3690,3697,3700" },
  void_storage_refund_maker: { cap: 1, src: "lib.rs:3548,3559,3692,3703" },
  void_storage_refund_taker: { cap: 1, src: "lib.rs:3549,3560,3693,3704" },
  void_deadline_maker: { cap: 1, src: "lib.rs:3677" },
  void_deadline_taker: { cap: 1, src: "lib.rs:3678" },
  // finalize settles each bond once: remainder/loss to holder or counterparty + run cost to keeper.
  bond_returned_won_minus_run_cost: { cap: "per_bond", src: "lib.rs:3439" },
  bond_lost_to_counterparty: { cap: "per_bond", src: "lib.rs:3442" },
  bond_round_cost_to_keeper: { cap: "per_bond", src: "lib.rs:3445" },
  // one claim per won (void) round.
  won_round_reimbursement: { cap: "per_bond", src: "lib.rs:3529" },
  // BD6 objection deposits: one row per deposit.
  objection_deposit_returned: { cap: "per_objection", src: "lib.rs:3450" },
  objection_deposit_forfeited: { cap: "per_objection", src: "lib.rs:3452" },
  // C1 concede (merge 9692297): every held bond / objection deposit refunded once.
  concede_bond_refund: { cap: "per_bond", src: "lib.rs:4132" },
  concede_objection_refund: { cap: "per_objection", src: "lib.rs:4135" },
  // emergency_refund (once per bet; bet is marked Voided afterwards).
  emergency_refund_maker: { cap: 1, src: "lib.rs:4289" },
  emergency_refund_taker: { cap: 1, src: "lib.rs:4296" },
  emergency_refund_bond: { cap: "per_bond", src: "lib.rs:4304" },
  emergency_refund_objection: { cap: "per_objection", src: "lib.rs:4312" },
};

/** I-4 (MON2 + MON3): real double-pay signals only.
 *  (a) the same payout id marked done more than once, or done -> pending;
 *  (b) done+pending payout_winner amounts for a bet+token summing past the
 *      pot (when `opts.potByBet` is supplied);
 *  (c) more payout_winner rows for a bet than the contract can schedule;
 *  (d) MON3: more rows for one bet+receiver+token+reason than
 *      REASON_ROW_CAPS allows (duplicate refund/fee/bond rows).
 * Two identical-looking winner rows are NOT a violation by themselves: a
 * same-asset finalize/concede legitimately schedules one per stake. */
export function checkI4(payouts: PendingPayout[], opts: I4Opts = {}): Violation[] {
  const violations: Violation[] = [];
  const byId = new Map<number, PendingPayout>();
  for (const p of payouts) {
    const prior = byId.get(p.id);
    if (prior && prior.done && !p.done) {
      violations.push({
        invariant: "I-4",
        detail: `payout id=${p.id} went from done=true back to done=false (impossible transition, state corruption)`,
      });
    }
    if (prior && prior.done && p.done) {
      violations.push({
        invariant: "I-4",
        detail: `payout id=${p.id} marked done more than once (double-pay)`,
      });
    }
    byId.set(p.id, p);
  }
  // Winner-row checks run over distinct ids (latest state per id).
  const winnersByBet = new Map<number, PendingPayout[]>();
  for (const p of byId.values()) {
    if (!/winner$/.test(p.reason)) continue;
    const arr = winnersByBet.get(p.bet_id) ?? [];
    arr.push(p);
    winnersByBet.set(p.bet_id, arr);
  }
  for (const [betId, rows] of winnersByBet) {
    if (rows.length > MAX_WINNER_ROWS_PER_BET) {
      violations.push({
        invariant: "I-4",
        detail: `bet=${betId}: ${rows.length} payout_winner rows, contract schedules at most ${MAX_WINNER_ROWS_PER_BET} (one per side's stake)`,
      });
    }
    const pots = opts.potByBet?.get(betId);
    if (!pots) continue;
    const sumByToken = new Map<string, bigint>();
    for (const r of rows) sumByToken.set(r.token_id, (sumByToken.get(r.token_id) ?? 0n) + BigInt(r.amount));
    for (const [token, sum] of sumByToken) {
      const pot = pots.get(token);
      if (pot !== undefined && sum > pot) {
        violations.push({
          invariant: "I-4",
          detail: `bet=${betId} token=${token}: payout_winner done+pending sum ${sum} exceeds pot ${pot} (double-pay)`,
        });
      }
    }
  }
  // MON3 (d): per-reason row caps over distinct ids. payout_winner is
  // covered by the per-bet rule above; unknown reasons are ignored.
  const groups = new Map<string, { betId: number; receiver: string; token: string; reason: string; n: number }>();
  for (const p of byId.values()) {
    if (p.reason === "payout_winner" || !Object.hasOwn(REASON_ROW_CAPS, p.reason)) continue;
    const key = JSON.stringify([p.bet_id, p.receiver, p.token_id, p.reason]);
    const g = groups.get(key) ?? { betId: p.bet_id, receiver: p.receiver, token: p.token_id, reason: p.reason, n: 0 };
    g.n++;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const spec = REASON_ROW_CAPS[g.reason].cap;
    const cap =
      spec === "per_bond" ? opts.roundsByBet?.get(g.betId)
      : spec === "per_objection" ? opts.objectionsByBet?.get(g.betId)
      : spec;
    if (cap === undefined || g.n <= cap) continue; // unknown bound -> never flag
    violations.push({
      invariant: "I-4",
      detail: `bet=${g.betId} receiver=${g.receiver} token=${g.token} reason=${g.reason}: ${g.n} rows, contract schedules at most ${cap}${typeof spec === "string" ? ` (${spec})` : ""} (duplicate payout)`,
    });
  }
  return violations;
}

/** v1.1 FM-13 / I-7: "no result can be selected among multiple runs by
 * a party." The contract itself is the actual enforcement point
 * (`submit_outcome` rejects any run_no != next_expected_run_no); this is
 * a defense-in-depth sanity check over fetched bet state, run after
 * every step the lifecycle matrix takes, so a logic regression that
 * somehow let a result land out of order would show up here even if a
 * future refactor missed the on-chain guard. Checks:
 *   1. `used_run_nos` is strictly increasing starting at 1 (no gaps, no
 *      skip-ahead, no duplicate).
 *   2. `next_expected_run_no` is exactly one past the last used run (or
 *      1 if none used yet) -- it can never trail behind what was
 *      actually accepted.
 *   3. `all_results` has exactly one entry per `used_run_nos` entry,
 *      same run_nos, same order -- every accepted run was recorded. */
export function checkI7(bet: Bet): Violation[] {
  const violations: Violation[] = [];
  const used = bet.used_run_nos;
  for (let i = 0; i < used.length; i++) {
    const expected = i + 1;
    if (used[i] !== expected) {
      violations.push({
        invariant: "I-7",
        detail: `bet=${bet.envelope.bet_id} used_run_nos[${i}]=${used[i]}, expected ${expected} (strict order 1,2,3,... -- gap or skip-ahead)`,
      });
    }
  }
  const expectedNext = used.length + 1;
  if (bet.next_expected_run_no !== expectedNext) {
    violations.push({
      invariant: "I-7",
      detail: `bet=${bet.envelope.bet_id} next_expected_run_no=${bet.next_expected_run_no}, expected ${expectedNext} given used_run_nos=${JSON.stringify(used)}`,
    });
  }
  const resultRunNos = bet.all_results.map((r) => r.run_no);
  if (JSON.stringify(resultRunNos) !== JSON.stringify(used)) {
    violations.push({
      invariant: "I-7",
      detail: `bet=${bet.envelope.bet_id} all_results run_nos=${JSON.stringify(resultRunNos)} != used_run_nos=${JSON.stringify(used)} (every accepted run must be recorded, in order, not only the final one)`,
    });
  }
  return violations;
}

export type LifecycleAction =
  | "open"
  | "take"
  | "request_resolution"
  | "submit_outcome"
  | "challenge"
  | "object"
  | "rebut"
  | "arbiter_pick"
  | "finalize"
  | "concede" // C1 / D-CONCEDE1: settled-by-concede; pause must not block it
  | "amend"
  | "prune_terms"
  | "cancel"
  | "expire"
  | "reclaim"
  | "void_after_deadline"
  // OQ-T11: drain_payouts is the current permissionless payout action;
  // retry_payout is kept here too since archived tx logs/fixtures from
  // before the fix still reference it.
  | "retry_payout"
  | "drain_payouts"
  | "pause"
  | "unpause"
  | "arbiter_submit_maker"
  | "arbiter_submit_taker"
  | "prune_terms_maker"
  | "prune_terms_taker";

const PAUSE_BLOCKED: ReadonlySet<LifecycleAction> = new Set(["open", "take"]);

/** I-5: pause blocks only open/take. Any other action must not have been
 * rejected on account of pause while paused=true; open/take must have
 * been rejected while paused=true. `wasRejectedForPause` is read from the
 * observed effect (e.g. an Open transfer that bounced back as a refund,
 * or a call that reverted) — this function just enforces the rule given
 * that observation. */
export function checkI5(
  action: LifecycleAction,
  paused: boolean,
  wasBlocked: boolean,
): Violation[] {
  if (!paused) return [];
  const shouldBlock = PAUSE_BLOCKED.has(action);
  if (shouldBlock && !wasBlocked) {
    return [{ invariant: "I-5", detail: `paused=true but ${action} was NOT blocked (should be)` }];
  }
  if (!shouldBlock && wasBlocked) {
    return [{ invariant: "I-5", detail: `paused=true incorrectly blocked ${action} (pause must only block open/take)` }];
  }
  return [];
}

/** I-4 options derived from a bet record: pot, plus (when the record is
 * intact, i.e. not pruned) the bond/objection counts that bound the
 * round-keyed and objection-keyed reasons in REASON_ROW_CAPS. */
function i4OptsFromBet(betId: number, bet?: Bet): I4Opts {
  if (!bet) return {};
  const opts: I4Opts = { potByBet: new Map([[betId, stakePotByToken(bet)]]) };
  if (!bet.pruned) {
    opts.roundsByBet = new Map([[betId, bet.bonds.length]]);
    opts.objectionsByBet = new Map([[betId, bet.objection_deposits.length]]);
  }
  return opts;
}

/** Gross stake pot per token for one bet (each side's stake in its own asset). */
function stakePotByToken(bet: Bet): Map<string, bigint> {
  const env = bet.envelope;
  const m = new Map<string, bigint>();
  const add = (t: string, a: bigint) => m.set(t, (m.get(t) ?? 0n) + a);
  // Partial envelopes (no stakes known) yield no pot -> sum check skipped.
  if (env.stake_maker === undefined || env.stake_taker === undefined) return m;
  add(env.maker_asset, BigInt(env.stake_maker));
  add(env.taker_asset, BigInt(env.stake_taker));
  return m;
}

export interface MonitorSnapshot {
  betId: number;
  paused: boolean;
  actors: Actors;
  payouts: PendingPayout[]; // all payout rows touching this bet, latest known state
  fundsIn: bigint; // total ever funded into this bet (stakes+storage, both sides -- D-ECON5: no reserve)
  trackedTotalYocto: bigint; // contract-wide tracked total (sum over all bets' funds-in-minus-done + undone payouts)
  actualIntentsBalanceYocto: bigint; // escrow's live intents mt_balance_of
  action?: LifecycleAction;
  actionWasBlocked?: boolean;
  /** v1.1: full bet record, when available, for the I-7 sanity check. */
  bet?: Bet;
}

export interface MonitorResult {
  ok: boolean;
  violations: Violation[];
}

/** Run every invariant check for one post-step snapshot. This is what
 * the lifecycle matrix calls after every single testnet transaction. */
export function runMonitor(snap: MonitorSnapshot): MonitorResult {
  const violations: Violation[] = [
    ...checkI1(snap.payouts, snap.actors),
    ...checkI2PerBet(snap.payouts, new Map([[snap.betId, snap.fundsIn]])),
    ...checkI2ContractWide(snap.trackedTotalYocto, snap.actualIntentsBalanceYocto),
    ...checkI4(snap.payouts, i4OptsFromBet(snap.betId, snap.bet)),
    ...(snap.action ? checkI5(snap.action, snap.paused, snap.actionWasBlocked ?? false) : []),
    ...(snap.bet ? checkI7(snap.bet) : []),
  ];
  return { ok: violations.length === 0, violations };
}
