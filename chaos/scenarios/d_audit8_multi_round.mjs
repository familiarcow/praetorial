// D-AUDIT8 sandbox proof (Decision register D-AUDIT8, 2026-11-03,
// OQ-T10 ruling): a full 2-round dispute (D-DISPUTE1's default
// max_rounds, supersedes D-AUDIT8's original default of 3) against the
// real sandboxed nearcore node, where the SAME party (taker) challenges
// and LOSES every round, checking invariant I-1 (funds leave only to
// maker/taker/fee_account/keeper) after EVERY step and confirming
// finalize settles cleanly with no panic.
//
// This is the "loser pays" arm of the ruling: every round's bond must
// now cover challenge_min + run_price (handle_bond rejects the old
// flat amount), each lost round's run_price is paid to the keeper from
// the forfeited bond, and the remainder goes to the counterparty
// (maker) -- D-ECON5 removed the per-bet reserve entirely, so there is
// no longer anything for a challenge round to touch there either way.
// The companion "won rounds overflow the reserve" arm is
// covered by the unit-level property test
// (contracts/escrow/src/tests.rs d_audit8_proptest, 100 random cases)
// and the un-parked repro
// (contracts/escrow/tests/chaos_findings.rs
// d_audit8_three_won_rounds_against_same_party_finalizes_cleanly_not_panics);
// this sandbox scenario proves the real cross-contract, real-wasm path
// for the same-loser multi-round shape specifically, per the task brief
// (originally scoped as 3 rounds; D-DISPUTE1 later lowered the default
// max_rounds to 2 for the reason described in the NOTE below, so this
// now exercises the full default end-to-end, not a reduced subset).
import * as h from "./../harness.mjs";
import * as inv from "./../invariants.mjs";
import { runScenario } from "./../runner.mjs";

export async function run() {
  await runScenario("d_audit8", "multi_round_dispute_same_loser_finalizes_cleanly", async (ctx) => {
    const violationsByStep = {};
    let lifetimeExtraIn = 0n;
    const check = async (label, betId) => {
      const bet = await h.getBet(ctx, betId);
      const v = await inv.checkAll(ctx, betId, bet, { lifetimeExtraIn });
      violationsByStep[label] = v;
      return bet;
    };

    const createdAt = Date.now() * 1_000_000;
    // D-ECON5: run_price moved off Envelope onto the USDC AssetLimit --
    // RUN_PRICE below is that asset's configured value (harness.mjs's
    // setupSandbox USDC asset_limits entry = DEFAULT_RUN_PRICE = 5_000),
    // no longer an envelope field; there is no per-bet reserve any more
    // either. (item 3a3: was stale at 50_000, which made handle_bond's
    // exact-amount check reject every bond below -> status stuck at
    // Proposed instead of Challenged.)
    const RUN_PRICE = 5_000n;
    const bet0 = await h.openBet(ctx, {
      funding_deadline: createdAt + 5_000_000_000,
      settlement_period: 3600 * 1_000_000_000,
      max_paid_runs: 10, // round 0 + up to 3 challenge rounds
    });
    const betId = bet0.envelope.bet_id;
    await h.takeBet(ctx, betId);
    await check("after_take", betId);
    await h.fastForward(ctx, 10);

    // Round 0: initial resolve, YES.
    await ctx.keeper.call(
      ctx.escrow.accountId,
      "request_resolution",
      { bet_id: betId, terms: null },
      { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT },
    );
    let bet = await h.getBet(ctx, betId);
    await h.submitOutcome(ctx, bet, { outcome: "YES", runNo: 1 });
    await check("after_round0_outcome", betId);

    // D-DISPUTE1: the bond must now cover max($10,10% pot) DOUBLED per
    // round (2^(round-1)) + that round's own (undoubled) run_price.
    const pot = Number(bet0.envelope.stake_maker) + Number(bet0.envelope.stake_taker);
    const challengeFloor = Math.max(5_000_000, Math.floor(pot * 0.10));
    const bondAmountForRound = (round) => BigInt(challengeFloor) * (2n ** BigInt(round - 1)) + RUN_PRICE;

    // NOTE (design-gap finding, see final report, now RESOLVED by
    // D-DISPUTE1): a true 3-round case was attempted here first and hit
    // NEAR's protocol-level 300 Tgas per-call ceiling at `finalize`
    // ("Exceeded the prepaid gas") -- ~11 fanned-out payout promises (2
    // per lost bond round + the plan/reserve/run-reimbursement lines)
    // at ~25 Tgas static each is right at that hard ceiling,
    // independent of what's attached client-side. This was a genuine
    // liveness gap introduced by raising the round cap past D8's
    // single-challenge design, not a money-accounting bug (the
    // unit-level property test already proves the ACCOUNTING never
    // panics for 1..=3 rounds under the gas-metering-free mocked VM).
    // D-DISPUTE1 (queue item 5) resolved this the honest way by
    // lowering `crate::DEFAULT_MAX_ROUNDS` itself from 3 to 2 (Review +
    // Final appeal), so ROUNDS below is now the actual default cap,
    // not an ad hoc reduction below a still-live 3-round default.
    const ROUNDS = 2;
    let runNo = 2;
    for (let round = 1; round <= ROUNDS; round++) {
      const bondAmount = bondAmountForRound(round);
      await h.mint(ctx.intents, ctx.taker, bondAmount);
      await ctx.taker.call(
        ctx.intents.accountId,
        "transfer_with_msg",
        {
          receiver_id: ctx.escrow.accountId,
          token_id: h.USDC,
          amount: String(bondAmount),
          msg: JSON.stringify({ kind: "Bond", bet_id: betId, round }),
        },
        { gas: h.tgas(250) },
      );
      lifetimeExtraIn += bondAmount;
      const betChallenged = await check(`after_challenge_round${round}`, betId);
      if (betChallenged.status !== "Challenged") {
        throw new Error(`round ${round}: expected Challenged, got ${betChallenged.status}`);
      }

      await ctx.keeper.call(
        ctx.escrow.accountId,
        "request_resolution",
        { bet_id: betId, terms: null },
        { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT },
      );
      const betResolving = await check(`after_rejudge_request_round${round}`, betId);
      // Taker LOSES every round: the re-judge confirms the SAME outcome.
      await h.submitOutcome(ctx, betResolving, { outcome: "YES", runNo });
      runNo++;
      await check(`after_rejudge_outcome_round${round}`, betId);
    }

    // item 6b: one fastForwardPast(1h) jump instead of looping small
    // fixed-size fastForward calls (which blew the per-scenario timeout).
    await h.fastForwardPast(ctx, 3600n * 1_000_000_000n, () =>
      ctx.keeper.call(ctx.escrow.accountId, "finalize", { bet_id: betId }, { gas: h.tgas(300) }),
    );
    const betAfterFinalize = await check("after_finalize", betId);
    // D-AUDIT11 supersedes OQ-T11's old "finalize always stops at
    // Finalized" assumption: finalize now fires every (receiver,
    // token_id) group INLINE, so a bet can go straight to Settled in
    // the same call if its group count fits in one drain batch.
    // Accept either; drain_payouts below is a documented no-op via
    // drainUntilSettled's own is_fully_paid short-circuit if already
    // Settled.
    if (betAfterFinalize.status !== "Finalized" && betAfterFinalize.status !== "Settled") {
      throw new Error(`expected Finalized or Settled right after finalize, got ${betAfterFinalize.status}`);
    }
    await h.drainUntilSettled(ctx, betId, { checkAfterEach: (n) => check(`after_drain_${n}`, betId) });
    const betFinal = await check("after_finalize", betId);

    const payouts = await ctx.escrow.view(ctx.escrow.accountId, "pending_payouts_view", { from: 0, limit: 500 });
    const mine = payouts.filter((p) => p.bet_id === betId);
    const bondLostToCounterparty = mine.filter((p) => p.reason === "bond_lost_to_counterparty");
    const bondRoundCostToKeeper = mine.filter((p) => p.reason === "bond_round_cost_to_keeper");
    const wonRoundReimbursement = mine.filter((p) => p.reason === "won_round_reimbursement");

    const allViolations = Object.values(violationsByStep).flat();
    const d_audit8Correct =
      betFinal.status === "Settled" &&
      bondLostToCounterparty.length === ROUNDS && // every round lost -> one forfeited-bond-remainder line each
      bondRoundCostToKeeper.length === ROUNDS && // every round's run_price paid from the bond, each round
      wonRoundReimbursement.length === 0; // no round was won, so no reimbursement line at all

    const pass = allViolations.length === 0 && d_audit8Correct;

    return {
      verdict: pass ? "pass" : "break",
      expected:
        `I-1 holds after every step of a ${ROUNDS}-round dispute where the same party (taker) challenges and loses every round; each round's bond covers challenge_min+run_price (D-AUDIT8), finalize settles cleanly with ${ROUNDS} bond_lost_to_counterparty + ${ROUNDS} bond_round_cost_to_keeper lines and zero won_round_reimbursement lines. (${ROUNDS} rounds is D-DISPUTE1's actual default max_rounds, not a reduced subset: the original task asked for a 3-round proof against D-AUDIT8's then-default of 3, but a true 3rd round pushed finalize's payout fan-out at/over NEAR's 300 Tgas per-call protocol ceiling in this live sandbox -- a liveness gap, not a money-accounting one -- which D-DISPUTE1 then resolved by lowering the deployed default itself to 2, so this scenario now proves the real default end-to-end.)`,
      actual: `final_status=${betFinal.status} bond_lost_lines=${bondLostToCounterparty.length} bond_cost_lines=${bondRoundCostToKeeper.length} reimbursement_lines=${wonRoundReimbursement.length} i1_violations_per_step=${JSON.stringify(
        Object.fromEntries(Object.entries(violationsByStep).map(([k, v]) => [k, v.length])),
      )}`,
      violations: allViolations,
      notes:
        `D-AUDIT8 proof (OQ-T10, 'same party loses every round' arm): I-1 checked after take, round-0 outcome, and each of ${ROUNDS} challenge/rejudge-request/rejudge-outcome steps, plus finalize. DESIGN GAP FOUND (historical): a genuine 3rd round in this same scenario hit "Exceeded the prepaid gas" at finalize (NEAR's 300 Tgas/call ceiling) -- flagged in the original final report as a liveness risk for D-AUDIT8's then-default max_rounds=3, not a money-accounting bug (contracts/escrow/src/tests.rs's d_audit8_proptest already proves the accounting itself never panics across 1..=3 rounds in the gas-metering-free mocked VM). RESOLVED by D-DISPUTE1 (queue item 5): the deployed default max_rounds is now 2, so ${ROUNDS} rounds here is the real default, not a workaround.`,
    };
  }, { timeoutMs: 450_000 }); // item 6b: fastForwardPast(1h) jump + multi-round setup needs more than the 120s default
}
