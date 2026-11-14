// D3 sandbox proof (Decision register D-AUDIT3, 2026-11-02): a full
// challenge -> evidence -> re-judge round against the real sandboxed
// nearcore node, checking invariant I-1 (funds leave only to
// maker/taker/fee_account/keeper) after EVERY step, and confirming the
// re-judge round's cost lands on the round's actual loser (the
// overturned counterparty), not split evenly, with the winning
// challenger's bond returned in full.
import * as h from "./../harness.mjs";
import * as inv from "./../invariants.mjs";
import { runScenario } from "./../runner.mjs";

export async function run() {
  await runScenario("d3", "challenge_evidence_rejudge_round_funding", async (ctx) => {
    const violationsByStep = {};
    let lifetimeExtraIn = 0n; // bond/objection deposits paid in AFTER open/take (I-2 false-positive fix, same as adversarial.mjs)
    const check = async (label, betId) => {
      const bet = await h.getBet(ctx, betId);
      const v = await inv.checkAll(ctx, betId, bet, { lifetimeExtraIn });
      violationsByStep[label] = v;
      return bet;
    };

    const createdAt = Date.now() * 1_000_000;
    const bet0 = await h.openBet(ctx, {
      funding_deadline: createdAt + 5_000_000_000,
      settlement_period: 3600 * 1_000_000_000, // D1 floor
    });
    const betId = bet0.envelope.bet_id;
    await h.takeBet(ctx, betId);
    await check("after_take", betId);
    await h.fastForward(ctx, 10); // clear funding_deadline

    // Round 0 resolution: YES.
    await ctx.keeper.call(
      ctx.escrow.accountId,
      "request_resolution",
      { bet_id: betId, terms: null },
      { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT },
    );
    const betResolving = await h.getBet(ctx, betId);
    await h.submitOutcome(ctx, betResolving, { outcome: "YES", runNo: 1 });
    await check("after_round0_outcome", betId);

    // Challenge: taker posts round-1 bond.
    const betBeforeChallenge = await h.getBet(ctx, betId);
    // D-AUDIT8 (ruling #2, landed after this D3 fixture was first
    // written): handle_bond now requires challenge_min + the round's
    // run_price, not challenge_min alone -- this fixture was never
    // updated and was silently sending a short bond, which
    // transfer_with_msg's never-panic convention just refunds instead
    // of erroring, leaving the bet stuck at Proposed (not Challenged)
    // with no visible cause. Pre-existing staleness, unrelated to
    // OQ-T11; fixed here since it otherwise blocks this whole family.
    // D-BOND1 (cross-asset-4b, 2026-11-04): `run_price` no longer
    // lives on `Envelope` (moved to the per-asset `AssetLimit` under
    // D-ECON5), and the bond's asset is now the CHALLENGER's own
    // stake asset -- quote both amount and asset off the contract's
    // own `required_challenge_bond` view instead of re-deriving the
    // formula from a field that no longer exists.
    const quote = await ctx.escrow.view(ctx.escrow.accountId, "required_challenge_bond", {
      bet_id: betId,
      challenger: ctx.taker.accountId,
    });
    const bondAmount = BigInt(quote.amount);
    await h.mint(ctx.intents, ctx.taker, bondAmount, quote.asset);
    await ctx.taker.call(
      ctx.intents.accountId,
      "transfer_with_msg",
      {
        receiver_id: ctx.escrow.accountId,
        token_id: quote.asset,
        amount: String(bondAmount),
        msg: JSON.stringify({ kind: "Bond", bet_id: betId, round: 1 }),
      },
      { gas: h.tgas(250) },
    );
    lifetimeExtraIn += bondAmount;
    const betChallenged = await check("after_challenge", betId);
    if (betChallenged.status !== "Challenged") {
      throw new Error(`expected Challenged after bond, got ${betChallenged.status}`);
    }

    // Evidence: taker submits an exhibit (D2 mechanism exercised here too).
    await ctx.taker.call(
      ctx.escrow.accountId,
      "submit_exhibits",
      { bet_id: betId, hashes: ["rejudge-exhibit-1"] },
      { gas: h.tgas(100) },
    );
    const betEvidence = await check("after_evidence", betId);
    if (betEvidence.status !== "Evidence") {
      throw new Error(`expected Evidence after submit_exhibits, got ${betEvidence.status}`);
    }

    // Re-judge round: a fresh request_resolution (round=1 now, since
    // bonds.len()==1), outcome FLIPS to NO -- the challenger (taker) wins.
    await ctx.keeper.call(
      ctx.escrow.accountId,
      "request_resolution",
      { bet_id: betId, terms: null },
      { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT },
    );
    const betResolvingAgain = await check("after_rejudge_request", betId);
    await h.submitOutcome(ctx, betResolvingAgain, { outcome: "NO", runNo: 2 });
    const betProposedAgain = await check("after_rejudge_outcome", betId);

    // Finalize, then check I-1 one more time and pull the exact payout
    // breakdown to confirm D3's accounting (loser bears the round, not
    // split; bond returns to the winning challenger in full).
    // item 6b: one fastForwardPast(1h) jump instead of looping small
    // fixed-size fastForward calls (which blew the per-scenario timeout).
    await h.fastForwardPast(ctx, 3600n * 1_000_000_000n, () =>
      ctx.keeper.call(ctx.escrow.accountId, "finalize", { bet_id: betId }, { gas: h.tgas(300) }),
    );
    const betAfterFinalize = await check("after_finalize", betId);
    // D-AUDIT11 supersedes OQ-T11's old "finalize always stops at
    // Finalized" assumption: finalize now fires every (receiver,
    // token_id) group INLINE, so a low-group-count bet like this one
    // (D-DISPUTE1 default: 1 round, 1 asset) can go straight to
    // Settled in the same call. Accept either Finalized (drain still
    // needed) or already-Settled (drain_payouts below is then a
    // documented no-op, proven via drainUntilSettled's own
    // is_fully_paid short-circuit) -- anything else is a real bug.
    if (betAfterFinalize.status !== "Finalized" && betAfterFinalize.status !== "Settled") {
      throw new Error(`expected Finalized or Settled right after finalize, got ${betAfterFinalize.status}`);
    }
    await h.drainUntilSettled(ctx, betId, { checkAfterEach: (n) => check(`after_drain_${n}`, betId) });
    const betFinal = await check("after_finalize", betId);

    const payouts = await ctx.escrow.view(ctx.escrow.accountId, "pending_payouts_view", { from: 0, limit: 500 });
    const mine = payouts.filter((p) => p.bet_id === betId);
    // D-AUDIT8 ruling #3 (contracts/escrow/src/lib.rs ~2940-2952, landed
    // after this fixture was first written): round_cost always comes out
    // of the round's OWN bond now, win or lose -- never the loser's
    // reserve. On a won round the challenger gets
    // "bond_returned_won_minus_run_cost" (bond_amount - round_cost) plus
    // a "bond_round_cost_to_keeper" line for round_cost itself; there is
    // no separate "round_cost_to_keeper_from_loser_reserve" reason and no
    // "bond_returned_won" reason (stale names from before this ruling).
    // round_cost = min(run_price, bond.amount); run_price here is the
    // harness's DEFAULT_RUN_PRICE (5000) for the default USDC asset.
    const DEFAULT_RUN_PRICE = 5000n;
    const expectedRoundCost = DEFAULT_RUN_PRICE < bondAmount ? DEFAULT_RUN_PRICE : bondAmount;
    const expectedBondReturn = bondAmount - expectedRoundCost;
    const bondReturned = mine
      .filter((p) => p.reason === "bond_returned_won_minus_run_cost")
      .reduce((s, p) => s + BigInt(p.amount), 0n);
    const keeperRoundCostLines = mine.filter((p) => p.reason === "bond_round_cost_to_keeper");
    const keeperRoundCost = keeperRoundCostLines.reduce((s, p) => s + BigInt(p.amount), 0n);
    const bondLostLines = mine.filter((p) => p.reason === "bond_lost_to_counterparty");
    const loserChargeLines = mine.filter((p) => p.reason === "round_cost_to_keeper_from_loser_reserve");

    const allViolations = Object.values(violationsByStep).flat();
    const d3Correct =
      bondReturned === expectedBondReturn && // winning challenger's bond returned minus this round's own run cost
      bondLostLines.length === 0 && // never ALSO charged via the lost-bond path (that's the loser's path)
      keeperRoundCostLines.length === 1 && // round cost funded exactly once, out of the bond itself
      keeperRoundCost === expectedRoundCost &&
      loserChargeLines.length === 0; // D-AUDIT8 ruling #3: never billed to the loser's reserve

    const pass = allViolations.length === 0 && d3Correct;

    return {
      verdict: pass ? "pass" : "break",
      expected:
        "I-1 holds after every step of a full challenge->evidence->re-judge round; the re-judge's cost is funded from the round that opened it, out of that round's own bond, win or lose (D-AUDIT8 ruling #3) -- here the challenger wins, so bond_returned_won_minus_run_cost == bond_amount - round_cost, exactly one bond_round_cost_to_keeper line == round_cost, no bond_lost_to_counterparty line, and no round_cost_to_keeper_from_loser_reserve line",
      actual: `final_status=${betFinal.status} bond_returned=${bondReturned} expected_bond_return=${expectedBondReturn} bond_amount=${bondAmount} keeper_round_cost=${keeperRoundCost} expected_round_cost=${expectedRoundCost} keeper_round_cost_lines=${keeperRoundCostLines.length} lost_bond_lines=${bondLostLines.length} loser_charge_lines=${loserChargeLines.length} i1_violations_per_step=${JSON.stringify(
        Object.fromEntries(Object.entries(violationsByStep).map(([k, v]) => [k, v.length])),
      )}`,
      violations: allViolations,
      notes:
        "D3 proof: I-1 (funds leave only to maker/taker/fee_account/keeper) checked after take, round-0 outcome, challenge, evidence, re-judge request, re-judge outcome, and finalize -- 7 checkpoints, 0 violations expected at each.",
    };
  }, { timeoutMs: 450_000 }); // item 6b: fastForwardPast(1h) jump + challenge/rejudge setup needs more than the 120s default
}
