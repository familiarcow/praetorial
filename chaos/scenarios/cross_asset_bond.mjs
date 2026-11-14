// Item 3a3: cross-asset challenge-bond scenario required by the queue
// item -- BTC maker vs USDC taker, result proposed, maker challenges
// with a BTC bond quoted by `required_challenge_bond`, the challenge
// round resolves (maker wins the round AND the final bet), finalize,
// then assert EXACT per-asset balances for maker, taker, fee_account
// and the escrow contract itself (per-asset I-1/I-2).
//
// Formula mirrors contracts/escrow/src/lib.rs `finalize`'s YesNo plan
// + bond settlement exactly (not re-derived/approximated) so this is a
// real per-asset accounting check, not a loosened one.
import * as h from "./../harness.mjs";
import * as inv from "./../invariants.mjs";
import { runScenario } from "./../runner.mjs";

export async function run() {
  await runScenario("cross_asset_bond", "btc_maker_vs_usdc_taker_challenge_round_per_asset_balances", async (ctx) => {
    const FEE_BPS = 100; // 1%
    const STAKE_MAKER_BTC = 10_000n; // sats, inside BTC asset band (6_501..325_059)
    const STAKE_TAKER_USDC = 10_000_000n; // 10 USDC, inside USDC band
    const STORAGE = h.sideStorage({}); // STG1: per-side charge from the fixture rate (same rate on both assets in this harness)

    const createdAt = Date.now() * 1_000_000;
    const bet0 = await h.openBet(ctx, {
      maker_asset: h.BTC,
      taker_asset: h.USDC,
      stake_maker: String(STAKE_MAKER_BTC),
      stake_taker: String(STAKE_TAKER_USDC),
      fee_bps: FEE_BPS,
      funding_deadline: createdAt + 5_000_000_000,
      settlement_period: 3600 * 1_000_000_000, // D1/D4 floor: >=1h
      max_paid_runs: 5,
    });
    const betId = bet0.envelope.bet_id;

    await h.takeBet(ctx, betId, { taker_asset: h.USDC, stake_taker: String(STAKE_TAKER_USDC) });
    await h.fastForward(ctx, 10);

    // Round 0: outcome NO -- maker (side YES) loses initially, giving
    // the maker a real incentive to challenge.
    await ctx.keeper.call(
      ctx.escrow.accountId,
      "request_resolution",
      { bet_id: betId, terms: null },
      { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT },
    );
    let bet = await h.getBet(ctx, betId);
    await h.submitOutcome(ctx, bet, { outcome: "NO", runNo: 1 });

    // Maker challenges round 1, quoting required_challenge_bond --
    // must be posted in BTC (the maker's own stake asset, D-BOND1).
    const quote = await ctx.escrow.view(ctx.escrow.accountId, "required_challenge_bond", { bet_id: betId, challenger: ctx.maker.accountId });
    if (!quote || quote.asset !== h.BTC) {
      throw new Error(`expected a BTC challenge-bond quote for the maker, got ${JSON.stringify(quote)}`);
    }
    const bondAmount = BigInt(quote.amount);
    await h.mint(ctx.intents, ctx.maker, bondAmount, h.BTC);
    await ctx.maker.call(
      ctx.intents.accountId,
      "transfer_with_msg",
      {
        receiver_id: ctx.escrow.accountId,
        token_id: h.BTC,
        amount: String(bondAmount),
        msg: JSON.stringify({ kind: "Bond", bet_id: betId, round: 1 }),
      },
      { gas: h.tgas(250) },
    );
    const betChallenged = await h.getBet(ctx, betId);
    if (betChallenged.status !== "Challenged") {
      throw new Error(`expected Challenged after maker's BTC bond, got ${betChallenged.status}`);
    }

    // Round 1 re-judge: outcome flips to YES -- maker wins BOTH the
    // round (challenger_won, since pre_challenge_outcome "NO" !=
    // final "YES") and the bet overall (winner_is_maker).
    await ctx.keeper.call(
      ctx.escrow.accountId,
      "request_resolution",
      { bet_id: betId, terms: null },
      { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT },
    );
    const betResolving = await h.getBet(ctx, betId);
    await h.submitOutcome(ctx, betResolving, { outcome: "YES", runNo: 2 });

    // item 6b: one fastForwardPast(1h) jump (sized off the measured
    // sim-time/block ratio) instead of looping fixed-size fastForward
    // calls; this scenario's runScenario call below carries the
    // matching timeoutMs override.
    await h.fastForwardPast(ctx, 3600n * 1_000_000_000n, () =>
      ctx.keeper.call(ctx.escrow.accountId, "finalize", { bet_id: betId }, { gas: h.tgas(300) }),
    );

    const betFinal = await h.getBet(ctx, betId);
    const i1 = await inv.checkI1(ctx, betId, betFinal);

    // Exact per-asset accounting, computed with the SAME formula
    // contracts/escrow/src/lib.rs's finalize() uses for the YesNo plan
    // + bond settlement (not approximated/loosened).
    const BPS_DENOM = 10_000n;
    // CX1 (case B): D-FEEMIN1 -- each side's fee = max(1% of its stake, that
    // asset's min_fee_per_side). The harness BTC entry has min_fee_per_side 325
    // (G5F, first red at b82b324, which added it to the harness), so the BTC
    // side pays 325 sats, not 1% = 100. Guard: escrow unit test
    // tests::cx1::cx1_btc_maker_usdc_taker_won_challenge_round_applies_btc_min_fee.
    const BTC_MIN_FEE_PER_SIDE = 325n; // = harness BTC asset_limits.min_fee_per_side
    const pct = (STAKE_MAKER_BTC * BigInt(FEE_BPS)) / BPS_DENOM;
    const feeMakerAssetBtc = pct > BTC_MIN_FEE_PER_SIDE ? pct : BTC_MIN_FEE_PER_SIDE;
    const winnerPayoutMakerAssetBtc = STAKE_MAKER_BTC - feeMakerAssetBtc;
    const feeTakerAssetUsdc = (STAKE_TAKER_USDC * BigInt(FEE_BPS)) / BPS_DENOM;
    const winnerPayoutTakerAssetUsdc = STAKE_TAKER_USDC - feeTakerAssetUsdc;
    // round_cost = min(run_price_btc, bondAmount); run_price_btc=1 (see
    // harness.mjs setupSandbox's BTC asset_limits entry) so round_cost=1.
    const runPriceBtc = 1n;
    const roundCost = runPriceBtc < bondAmount ? runPriceBtc : bondAmount;
    const bondRemainderToMaker = bondAmount - roundCost; // bond_returned_won_minus_run_cost

    const expectedMakerBtc = winnerPayoutMakerAssetBtc + bondRemainderToMaker;
    const expectedMakerUsdc = winnerPayoutTakerAssetUsdc;
    const expectedTakerBtc = 0n;
    const expectedTakerUsdc = 0n;
    const expectedFeeBtc = feeMakerAssetBtc + STORAGE; // fee_and_storage, maker_asset
    const expectedFeeUsdc = feeTakerAssetUsdc + STORAGE; // fee_and_storage, taker_asset
    const expectedKeeperBtc = roundCost; // bond_round_cost_to_keeper
    const expectedEscrowBtc = 0n;
    const expectedEscrowUsdc = 0n;

    const [makerBtc, makerUsdc, takerBtc, takerUsdc, feeBtc, feeUsdc, keeperBtc, escrowBtc, escrowUsdc] = await Promise.all([
      h.balance(ctx.intents, ctx.maker, h.BTC),
      h.balance(ctx.intents, ctx.maker, h.USDC),
      h.balance(ctx.intents, ctx.taker, h.BTC),
      h.balance(ctx.intents, ctx.taker, h.USDC),
      h.balance(ctx.intents, ctx.fee, h.BTC),
      h.balance(ctx.intents, ctx.fee, h.USDC),
      h.balance(ctx.intents, ctx.keeper, h.BTC),
      h.balance(ctx.intents, ctx.escrow, h.BTC),
      h.balance(ctx.intents, ctx.escrow, h.USDC),
    ]);

    const mismatches = [];
    const check = (label, actual, expected) => {
      if (actual !== expected) mismatches.push(`${label}: expected ${expected}, got ${actual}`);
    };
    check("maker_btc", makerBtc, expectedMakerBtc);
    check("maker_usdc", makerUsdc, expectedMakerUsdc);
    check("taker_btc", takerBtc, expectedTakerBtc);
    check("taker_usdc", takerUsdc, expectedTakerUsdc);
    check("fee_btc", feeBtc, expectedFeeBtc);
    check("fee_usdc", feeUsdc, expectedFeeUsdc);
    check("keeper_btc", keeperBtc, expectedKeeperBtc);
    check("escrow_btc", escrowBtc, expectedEscrowBtc);
    check("escrow_usdc", escrowUsdc, expectedEscrowUsdc);

    const pass = betFinal.status === "Settled" && i1.length === 0 && mismatches.length === 0;

    return {
      verdict: pass ? "pass" : "break",
      expected: "BTC-maker/USDC-taker bet: maker challenges round 1 with a BTC bond quoted by required_challenge_bond, wins the round and the bet; finalize (which auto-drains, D-AUDIT11) leaves exact per-asset balances matching finalize()'s YesNo-plan + bond-settlement formula for maker/taker/fee_account/keeper/escrow, with I-1 holding throughout.",
      actual: `status=${betFinal.status} i1_violations=${i1.length} mismatches=${JSON.stringify(mismatches)}`,
      violations: i1,
      notes: `bond_quote=${JSON.stringify(quote)} bondAmount=${bondAmount}`,
    };
  }, { timeoutMs: 300_000 }); // item 6b: fastForwardPast(1h) jump needs more than the 120s default
}
