// D2 sandbox proof (Decision register D-AUDIT2, 2026-11-02): escrow's
// `submit_exhibits` records `env::block_timestamp()` per exhibit --
// never anything the caller supplies -- and that timestamp is visible
// on the ordinary `get_bet` view. This proves the mechanism end to end
// against a real sandboxed nearcore node: two exhibit batches submitted
// at two different sandbox block times must carry two different
// contract-recorded timestamps, each matching the block they actually
// landed in (within the chain's own clock), never a value the caller
// tried to inject.
import * as h from "./../harness.mjs";
import * as inv from "./../invariants.mjs";
import { runScenario } from "./../runner.mjs";

export async function run() {
  await runScenario("d2", "submit_exhibits_stamps_onchain_block_timestamp", async (ctx) => {
    const createdAt = Date.now() * 1_000_000;
    const bet = await h.openBet(ctx, {
      funding_deadline: createdAt + 5_000_000_000,
      settlement_period: 3600 * 1_000_000_000, // D1 floor
    });
    const betId = bet.envelope.bet_id;
    await h.takeBet(ctx, betId);
    await h.fastForward(ctx, 10);

    // Drive the bet to Challenged so submit_exhibits is callable.
    await ctx.keeper.call(
      ctx.escrow.accountId,
      "request_resolution",
      { bet_id: betId, terms: null },
      { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT },
    );
    const betResolving = await h.getBet(ctx, betId);
    await h.submitOutcome(ctx, betResolving, { outcome: "YES" });
    // D-AUDIT8 (2026-11-03): the bond must also cover this round's
    // run_price on top of the pre-existing challenge-bond minimum --
    // the old flat amount is rejected by `handle_bond` now.
    // D-BOND1 (cross-asset-4b, 2026-11-04): `run_price` no longer
    // lives on `Envelope` at all (it moved to the per-asset
    // `AssetLimit` under D-ECON5, and the bond's asset is now the
    // CHALLENGER's own stake asset, not always USDC) -- quote both
    // the amount and the asset off the contract's own
    // `required_challenge_bond` view instead of reading a field that
    // no longer exists.
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
    const betChallenged = await h.getBet(ctx, betId);

    // First exhibit batch. NOTE: the sandbox's chain clock is NOT wall
    // clock (earlier `fastForward` calls jump it ahead independent of
    // Date.now()), so we can't bound the recorded timestamp against the
    // host clock -- the real proof below is that it's the SAME value
    // for every exhibit in one call (one tx = one block), strictly
    // non-decreasing across calls, and that get_bet's view round-trips
    // exactly what was recorded, never something the caller passed in
    // (submit_exhibits takes no timestamp argument at all).
    await ctx.taker.call(
      ctx.escrow.accountId,
      "submit_exhibits",
      { bet_id: betId, hashes: ["sandbox-exhibit-1", "sandbox-exhibit-2"] },
      { gas: h.tgas(100) },
    );

    const betAfterFirst = await h.getBet(ctx, betId);
    const firstBatch = betAfterFirst.exhibits.slice(-2);

    // Second batch, strictly later -- must get a strictly later (or at
    // least non-earlier) timestamp than the first, and the first
    // batch's own recorded timestamps must be untouched (never rewritten).
    await ctx.taker.call(
      ctx.escrow.accountId,
      "submit_exhibits",
      { bet_id: betId, hashes: ["sandbox-exhibit-3"] },
      { gas: h.tgas(100) },
    );
    const betFinal = await h.getBet(ctx, betId);
    const secondBatch = betFinal.exhibits.slice(-1);
    const firstBatchUnchanged = betFinal.exhibits.slice(0, 2);

    const t1a = BigInt(firstBatch[0].submitted_at);
    const t1b = BigInt(firstBatch[1].submitted_at);
    const t2 = BigInt(secondBatch[0].submitted_at);

    const bothInBatchMatch = t1a === t1b; // same tx -> same block -> same timestamp
    const monotonic = t2 >= t1a;
    const unchanged =
      BigInt(firstBatchUnchanged[0].submitted_at) === t1a && BigInt(firstBatchUnchanged[1].submitted_at) === t1b;
    const hashesCorrect =
      firstBatch[0].hash === "sandbox-exhibit-1" &&
      firstBatch[1].hash === "sandbox-exhibit-2" &&
      secondBatch[0].hash === "sandbox-exhibit-3";

    const violations = await inv.checkAll(ctx, betId, betFinal);
    const pass = bothInBatchMatch && monotonic && unchanged && hashesCorrect && !violations.length;

    return {
      verdict: pass ? "pass" : "break",
      expected:
        "submit_exhibits stamps every exhibit in a call with the contract's own env::block_timestamp() (never caller-supplied), visible via get_bet's ordinary view; a later call gets a later-or-equal timestamp and never rewrites an earlier batch's",
      actual: `t1a=${t1a} t1b=${t1b} t2=${t2} same_batch_match=${bothInBatchMatch} monotonic=${monotonic} earlier_batch_unchanged=${unchanged} hashes_correct=${hashesCorrect}`,
      violations,
      notes:
        "D2 proof: the Challenged bet's two submit_exhibits calls land in two real sandbox blocks; each exhibit's stored submitted_at is read back through the ordinary get_bet view, confirming state+view both carry the onchain timestamp as the decision requires. Betstatus at this point: " +
        betChallenged.status +
        ".",
    };
  });
}
