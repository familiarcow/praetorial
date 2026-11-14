// D-AUDIT11 sandbox proof: aggregated single-transaction settlement.
// finalize/void_after_deadline now group every scheduled
// payout line by (receiver, token_id) and fire each group's mt_transfer
// INLINE, in the same call, via drain_payouts(bet_id, MAX_DRAIN_BATCH)
// (MAX_DRAIN_BATCH=10; today's single-asset contract tops out at 4
// groups -- maker/taker/fee_account/keeper x 1 asset -- well under that
// ceiling). drain_payouts is no longer the thing that settles a bet in
// the common case; it is purely the permissionless RETRY path for
// whatever group's transfer didn't fire/succeed inline.
//
// e1: the worst-case bet (2 challenge rounds -- D-DISPUTE1's default
// max_rounds, supersedes D-AUDIT8's 3 -- plus 5 exhibits, 5 rebuttals --
// the per-party caps in handle_objection/submit_exhibits) must still
// reach Settled from a SINGLE finalize call with zero follow-up
// drain_payouts calls, proving finalize's own gas cost no longer scales
// with the number of ledger lines the way the pre-D-AUDIT11 design did.
//
// e2: with mock-intents' injected-failure knob on, finalize still fires
// every group inline but every mt_transfer fails, so every line stays
// pending/not-in_flight and the bet stays Finalized (never falsely
// promoted to Settled). Clearing the knob and calling drain_payouts
// exactly once (from an unrelated caller) must retry every group and
// pay it -- proven via a USDC balance delta, not just the `done` flag --
// and each line's `attempts` must read exactly 2 (the inline fire at
// finalize + the one retry), never more.
import * as h from "./../harness.mjs";
import * as inv from "./../invariants.mjs";
import { runScenario } from "./../runner.mjs";

async function toProposed(ctx, overrides = {}) {
  const createdAt = Date.now() * 1_000_000;
  // Both openBet and takeBet must see the SAME merged override set --
  // sideAmount() reads stake/storage straight off whatever object it's
  // handed (D-ECON5: no per-bet reserve any more), so a mismatch here
  // (e.g. maker funded against one storage_charge_per_side but taker's
  // required amount computed off an un-merged default) makes the
  // taker's transfer_with_msg land short; transfer_with_msg's
  // never-panic convention means that comes back as a silent refund,
  // not a thrown error, leaving the bet stuck Open and every call
  // after it failing with a confusing "bet not awaiting resolution"
  // instead of the real cause.
  const merged = {
    funding_deadline: createdAt + 5_000_000_000,
    settlement_period: 3600 * 1_000_000_000,
    max_paid_runs: 10,
    ...overrides,
  };
  const bet = await h.openBet(ctx, merged);
  const betId = bet.envelope.bet_id;
  await h.takeBet(ctx, betId, merged);
  await h.fastForward(ctx, 10);
  await ctx.keeper.call(
    ctx.escrow.accountId,
    "request_resolution",
    { bet_id: betId, terms: null },
    { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT },
  );
  const betResolving = await h.getBet(ctx, betId);
  await h.submitOutcome(ctx, betResolving, { outcome: "YES", runNo: 1 });
  return { betId, envelope: bet.envelope };
}

// Fast-forwards past the bet's 3600s settlement_period (plus any window
// extension) and calls finalize, retrying the fast-forward if the chain
// undershoots real block-production timing. Returns the post-finalize
// bet.
async function fastForwardAndFinalize(ctx, betId) {
  // item 6b: one jump sized off the measured sim-time/block ratio
  // instead of looping 8x5000-block real-time-expensive calls (which
  // took 3+ real fastForward round-trips, ~40s each, to clear a single
  // 1h settlement_period and blew the per-scenario timeout).
  await h.fastForwardPast(ctx, 3600n * 1_000_000_000n, () =>
    ctx.keeper.call(ctx.escrow.accountId, "finalize", { bet_id: betId }, { gas: h.tgas(300) }),
  );
  return h.getBet(ctx, betId);
}

export async function run() {
  // e1: worst-case bet (2 rounds + 5 exhibits + 5 rebuttals) must settle
  // in exactly ONE finalize call -- no drain_payouts needed at all.
  await runScenario("drain_payouts", "worst_case_bet_settles_in_one_finalize_call", async (ctx) => {
    // item 6b: needs a real fastForwardPast(1h) jump (~130s real time
    // for the jump alone) plus 2 challenge rounds worth of setup
    // (bonds, 5 exhibits, 5 rebuttals) -- the 120s default is way too
    // tight; this is the heaviest-setup scenario in the whole suite.
    const { betId, envelope } = await toProposed(ctx);
    let lifetimeExtraIn = 0n;
    const violationsByStep = {};
    const check = async (label) => {
      const bet = await h.getBet(ctx, betId);
      violationsByStep[label] = await inv.checkAll(ctx, betId, bet, { lifetimeExtraIn });
      return bet;
    };
    await check("after_round0_outcome");

    const pot = Number(envelope.stake_maker) + Number(envelope.stake_taker);
    const objAmount = BigInt(Math.max(1_000_000, Math.floor(pot * 0.005)));

    // DEFAULT_MAX_ROUNDS = 2 (D-DISPUTE1, supersedes D-AUDIT8's 3): open
    // both challenge rounds, taker loses every round (resolver
    // re-confirms YES each time).
    const MAX_ROUNDS = 2;
    let runNo = 2;
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      // D-DISPUTE1/D-BOND1: quote per round off the contract's own
      // required_challenge_bond view instead of re-deriving the
      // formula -- the floor is max(min_bond, 10% of pot) and it
      // DOUBLES every round (2^(round-1)), while run_price (added on
      // top) never doubles, so round 2's required amount is NOT the
      // same as round 1's. (Found stale here: a single bondAmount
      // computed once outside the loop from a since-superseded 5%
      // formula, reused for both rounds -- round 2's bond was then
      // short and transfer_with_msg's never-panic convention silently
      // refunded it, leaving the bet stuck at Proposed.)
      const quote = await ctx.escrow.view(ctx.escrow.accountId, "required_challenge_bond", {
        bet_id: betId,
        challenger: ctx.taker.accountId,
      });
      const bondAmount = BigInt(quote.amount);
      await h.mint(ctx.intents, ctx.taker, bondAmount, quote.asset);
      await ctx.taker.call(
        ctx.intents.accountId,
        "transfer_with_msg",
        { receiver_id: ctx.escrow.accountId, token_id: quote.asset, amount: String(bondAmount), msg: JSON.stringify({ kind: "Bond", bet_id: betId, round }) },
        { gas: h.tgas(250) },
      );
      lifetimeExtraIn += bondAmount;
      const betChallenged = await check(`after_challenge_round${round}`);
      if (betChallenged.status !== "Challenged") throw new Error(`round ${round}: expected Challenged, got ${betChallenged.status}`);

      // Round 1 only: max out exhibits (5) and rebuttals (5) -- the
      // per-party caps in handle_objection/submit_exhibits -- before
      // re-judging, so the worst-case evidence fan-out is exercised too.
      if (round === 1) {
        await ctx.taker.call(ctx.escrow.accountId, "submit_exhibits", { bet_id: betId, hashes: ["e1", "e2", "e3", "e4", "e5"] }, { gas: h.tgas(100) });
        for (let i = 0; i < 5; i++) {
          await h.mint(ctx.intents, ctx.taker, objAmount);
          await ctx.taker.call(
            ctx.intents.accountId,
            "transfer_with_msg",
            { receiver_id: ctx.escrow.accountId, token_id: h.USDC, amount: String(objAmount), msg: JSON.stringify({ kind: "Objection", bet_id: betId, exhibit_hash: `r${i}`, is_rebuttal: true }) },
            { gas: h.tgas(250) },
          );
          lifetimeExtraIn += objAmount;
        }
        await check("after_max_evidence");
      }

      await ctx.keeper.call(
        ctx.escrow.accountId,
        "request_resolution",
        { bet_id: betId, terms: null },
        { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT },
      );
      const betResolving = await check(`after_rejudge_request_round${round}`);
      await h.submitOutcome(ctx, betResolving, { outcome: "YES", runNo });
      runNo++;
      await check(`after_rejudge_outcome_round${round}`);
    }

    // Single finalize call, after fast-forwarding past the 3600s
    // settlement_period -- D-AUDIT11's whole point is that this is the
    // ONLY settlement call needed, even for the worst-case line count
    // (bonds x2 rounds + 5 rebuttal refunds + win/fee/reserve/
    // reimbursement lines), because those lines collapse into at most
    // 4 (receiver, token_id) groups, fired inline by finalize itself.
    // (schedule_payout only ever runs inside finalize/
    // void_after_deadline, so the ledger has zero lines before this.)
    const betAfterFinalize = await fastForwardAndFinalize(ctx, betId);
    await check("after_finalize");

    const lines = (await ctx.escrow.view(ctx.escrow.accountId, "pending_payouts_view", { from: 0, limit: 500 })).filter((p) => p.bet_id === betId);
    const groups = new Set(lines.map((p) => `${p.receiver}:${p.token_id}`));
    const fullyPaid = await ctx.escrow.view(ctx.escrow.accountId, "is_fully_paid", { bet_id: betId });

    const allViolations = Object.values(violationsByStep).flat();
    const hadMultipleLines = lines.length > groups.size; // proves aggregation did something
    const settledInOneCall = fullyPaid && betAfterFinalize.status === "Settled";
    const pass = hadMultipleLines && settledInOneCall && allViolations.length === 0;

    return {
      verdict: pass ? "pass" : "break",
      expected: "worst-case bet (2 rounds, 5 exhibits, 5 rebuttals) produces more ledger lines than distinct (receiver, token) groups, and a SINGLE finalize call (no follow-up drain_payouts) takes it straight to Settled with is_fully_paid true, proving D-AUDIT11's aggregated single-transaction settlement replaces the old multi-call drain loop even in the worst case",
      actual: `ledger_lines=${lines.length} distinct_groups=${groups.size} done=${lines.filter((p) => p.done).length} in_flight=${lines.filter((p) => p.in_flight).length} attempts=${JSON.stringify(lines.map((p) => p.attempts))} finalize_status=${betAfterFinalize.status} fully_paid=${fullyPaid} violations=${allViolations.length}`,
      violations: allViolations,
      notes: "D-AUDIT11 supersedes the D-AUDIT9 batching this scenario originally proved (repeated drain_payouts calls). Worst case today is <=4 groups (maker/taker/fee_account/keeper x 1 asset), comfortably under MAX_DRAIN_BATCH=10, so finalize's inline drain settles the bet in the same transaction that finalized it. (D-DISPUTE1: MAX_ROUNDS here is 2, the new default -- down from the superseded D-AUDIT8 default of 3; grouping is per (receiver, token_id), not per round, so the group count/assertions are unaffected by the round-count change, only the loop bound and the per-round bond/payout line arithmetic below are.)",
    };
  }, { timeoutMs: 450_000 }); // item 6b: fastForwardPast(1h) jump + 2-round/5-exhibit setup needs more than the 120s default

  // e2: a failed transfer (every group, via mock-intents' global
  // fail-mt-transfer knob) stays pending after finalize's inline fire;
  // clearing the knob and calling drain_payouts once retries every
  // group and pays it exactly once.
  await runScenario("drain_payouts", "failed_transfer_stays_pending_and_retried_exactly_once", async (ctx) => {
    // item 6b: same fastForwardPast(1h) budget concern as above.
    const { betId } = await toProposed(ctx, {});

    // Inject failure BEFORE finalize: finalize still schedules every
    // line and fires every group inline, but every mt_transfer must
    // fail, so nothing may be marked done and the bet must not falsely
    // promote past Finalized. (schedule_payout only ever runs inside
    // finalize/void_after_deadline, so the ledger has
    // zero lines before this -- the >=2-lines check has to happen
    // after finalize, not before.)
    await ctx.operator.call(ctx.intents.accountId, "set_fail_mt_transfer", { fail: true }, { gas: h.tgas(30) });
    const betAfterFinalize = await fastForwardAndFinalize(ctx, betId);
    if (betAfterFinalize.status !== "Finalized") throw new Error(`expected Finalized (failed transfer must not promote), got ${betAfterFinalize.status}`);

    const afterFailedFinalize = (await ctx.escrow.view(ctx.escrow.accountId, "pending_payouts_view", { from: 0, limit: 500 })).filter((p) => p.bet_id === betId);
    const totalLines = afterFailedFinalize.length;
    if (totalLines < 2) throw new Error(`need >=2 payout lines for a meaningful test, got ${totalLines}`);
    const noneDone = afterFailedFinalize.every((p) => !p.done);
    const noneInFlight = afterFailedFinalize.every((p) => !p.in_flight);
    const allAttemptedOnce = afterFailedFinalize.every((p) => p.attempts === 1);
    const balancesBefore = {};
    for (const p of afterFailedFinalize) {
      if (!(p.receiver in balancesBefore)) balancesBefore[p.receiver] = await h.balance(ctx.intents, { accountId: p.receiver });
    }
    const fullyPaidAfterFailedFinalize = await ctx.escrow.view(ctx.escrow.accountId, "is_fully_paid", { bet_id: betId });

    // Clear the injected failure; the VERY NEXT drain_payouts call --
    // from a totally unrelated caller -- must retry every still-pending
    // group and pay it, exactly once each.
    await ctx.operator.call(ctx.intents.accountId, "set_fail_mt_transfer", { fail: false }, { gas: h.tgas(30) });
    const retryOutcome = await ctx.third.call(ctx.escrow.accountId, "drain_payouts", { bet_id: betId, limit: 10 }, { gas: h.tgas(300) });
    // Account.call() returns the raw FinalExecutionOutcome, not the
    // decoded contract return value -- decode drain_payouts' u64
    // (SuccessValue is base64 JSON) to prove the retry actually fired.
    const fired = JSON.parse(Buffer.from(retryOutcome.status.SuccessValue, "base64").toString());

    const afterRetry = (await ctx.escrow.view(ctx.escrow.accountId, "pending_payouts_view", { from: 0, limit: 500 })).filter((p) => p.bet_id === betId);
    const allDoneNow = afterRetry.every((p) => p.done);
    const allAttemptedExactlyTwice = afterRetry.every((p) => p.attempts === 2); // inline fire at finalize + one retry, never more
    const fullyPaidAfterRetry = await ctx.escrow.view(ctx.escrow.accountId, "is_fully_paid", { bet_id: betId });
    const betFinal = await h.getBet(ctx, betId);

    let paidExactlyOnceEveryLine = true;
    for (const p of afterFailedFinalize) {
      const after = await h.balance(ctx.intents, { accountId: p.receiver });
      const expectedDelta = afterFailedFinalize.filter((q) => q.receiver === p.receiver).reduce((acc, q) => acc + BigInt(q.amount), 0n);
      if (after - balancesBefore[p.receiver] !== expectedDelta) paidExactlyOnceEveryLine = false;
    }

    const violations = await inv.checkAll(ctx, betId, betFinal);

    const pass =
      Number(fired) > 0 &&
      noneDone &&
      noneInFlight &&
      allAttemptedOnce &&
      !fullyPaidAfterFailedFinalize &&
      allDoneNow &&
      allAttemptedExactlyTwice &&
      fullyPaidAfterRetry &&
      paidExactlyOnceEveryLine &&
      betFinal.status === "Settled" &&
      !violations.length;

    return {
      verdict: pass ? "pass" : "break",
      expected: "finalize's inline fire-every-group call fails (every mt_transfer rejected), leaving every ledger line pending/not-in_flight with attempts=1 and the bet stuck at Finalized (never falsely promoted); clearing the failure and calling drain_payouts ONCE (from an unrelated caller) retries every group, pays each receiver exactly once (balance delta == sum of their lines, never double-paid), bumps attempts to exactly 2, and settles the bet",
      actual: `lines_after_failed_finalize_done=${afterFailedFinalize.filter((p) => p.done).length}/${totalLines} none_in_flight=${noneInFlight} all_attempts_1=${allAttemptedOnce} fully_paid_before_retry=${fullyPaidAfterFailedFinalize} retry_fired=${fired} all_done_after_retry=${allDoneNow} all_attempts_2=${allAttemptedExactlyTwice} paid_exactly_once=${paidExactlyOnceEveryLine} final_status=${betFinal.status}`,
      violations,
      notes: "I-4 (retryable, never loses/double-pays) proven against the real cross-contract failure path (mock-intents panics inside mt_transfer, mirroring a real NEP-245 receiver rejecting/erroring), now exercised through finalize's D-AUDIT11 inline fire instead of the superseded standalone drain-loop path.",
    };
  }, { timeoutMs: 450_000 }); // item 6b: fastForwardPast(1h) jump needs more than the 120s default
}
