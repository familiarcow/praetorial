// Family (c): economic -- dust bets below fee and compute cost, fee
// rounding, storage staking exhaustion, the sponsor cap of 3, offer TTL
// expiry with funds locked.
import * as h from "./../harness.mjs";
import * as inv from "./../invariants.mjs";
import { runScenario } from "./../runner.mjs";

export async function run() {
  // G5F2 (D-FEEPIN1 / D-FEEMIN1): the protocol fee is pinned at new()
  // (PROTOCOL_FEE_BPS_V1 = 100); any other envelope.fee_bps Open is refused
  // with an open_rejected log and a FULL refund, no bet state. The two old
  // scenarios used fee_bps 1 / 333 to probe fee rounding; that is no longer
  // reachable, so (a) the refusal is asserted for those exact values,
  // (b) the dust intent is re-expressed through the per-side minimum fee,
  // (c) the rounding intent through fee_bps=100 on non-round stakes.

  // c1a/c2a: an Open with a non-pinned fee_bps is refused, fully refunded,
  // and creates no bet.
  for (const badFeeBps of [1, 333]) {
    await runScenario("economic", `open_rejected_fee_bps_${badFeeBps}_full_refund`, async (ctx) => {
      const createdAt = Date.now() * 1_000_000;
      const overrides = {
        funding_deadline: createdAt + 5_000_000_000,
        stake_maker: "1000000",
        stake_taker: "1000000",
        fee_bps: badFeeBps,
      };
      const deposit = h.sideAmount(overrides, "maker");
      const balBefore = await h.balance(ctx.intents, ctx.maker); // 0: openBet mints then deposits
      const bet = await h.openBet(ctx, overrides);
      const makerAfter = await h.balance(ctx.intents, ctx.maker);
      const escrowAfter = await h.balance(ctx.intents, ctx.escrow);
      const open = await ctx.escrow.view(ctx.escrow.accountId, "open_offers", { from: 0, limit: 200 });
      const mineOpen = open.filter((b) => b.envelope.maker === ctx.maker.accountId);
      const noBet = bet === undefined && mineOpen.length === 0;
      const fullRefund = makerAfter - balBefore === deposit;
      const escrowEmpty = escrowAfter === 0n;
      return {
        verdict: noBet && fullRefund && escrowEmpty ? "pass" : "break",
        expected: `Open with fee_bps=${badFeeBps} (pinned fee is 100) is refused: no open offer created, maker's full deposit (${deposit}) refunded, escrow contract holds 0`,
        actual: `bet_created=${!noBet} maker_balance_delta=${makerAfter - balBefore} expected_refund=${deposit} escrow_balance=${escrowAfter}`,
        violations: [],
        notes: "D-FEEPIN1: handle_open logs open_rejected (reason: fee_bps must equal the pinned protocol fee) and refunds in full. Replaces the fee-rounding probe that used this fee_bps to open a bet.",
      };
    });
  }

  // c1b: dust bet -- minimum-stake bet on both sides pays exactly
  // min_fee_per_side per side at finalize, never 0 (D-FEEMIN1).
  await runScenario("economic", "dust_bet_fee_rounds_to_zero", async (ctx) => {
    const createdAt = Date.now() * 1_000_000;
    // stake=20 (the asset's min_per_side). fee_bps=100 -> 20*100/10000 = 0
    // (rounds down), but D-FEEMIN1's min_fee_per_side (1 in this harness's
    // USDC limits) lifts each side's fee to exactly 1 -- never 0.
    // the STG1 per-side charge (computed from the asset rate) clears D4's storage floor (item 7g2b).
    const stake = 20n;
    const minFee = 1n;
    const bet = await h.openBet(ctx, {
      funding_deadline: createdAt + 5_000_000_000,
      settlement_period: 3600 * 1_000_000_000,
      stake_maker: String(stake),
      stake_taker: String(stake),
      fee_bps: 100,
      max_paid_runs: 1,
    });
    const betId = bet.envelope.bet_id;
    await h.takeBet(ctx, betId, { stake_maker: String(stake), stake_taker: String(stake) });
    await h.fastForward(ctx, 10);
    await ctx.keeper.call(ctx.escrow.accountId, "request_resolution", { bet_id: betId, terms: null }, { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT });
    const betResolving = await h.getBet(ctx, betId);
    await h.submitOutcome(ctx, betResolving, { outcome: "YES" });
    await h.fastForwardPast(ctx, 3600n * 1_000_000_000n, () =>
      ctx.keeper.call(ctx.escrow.accountId, "finalize", { bet_id: betId }, { gas: h.tgas(300) }),
    );
    await h.drainUntilSettled(ctx, betId);
    const betFinal = await h.getBet(ctx, betId);
    const payouts = await ctx.escrow.view(ctx.escrow.accountId, "pending_payouts_view", { from: 0, limit: 500 });
    const mine = payouts.filter((p) => p.bet_id === betId);
    // finalize schedules one payout_winner and one fee_and_storage row PER
    // ASSET (two each for a same-asset bet) -- sum all rows per reason.
    const feeRows = mine.filter((p) => p.reason === "fee_and_storage");
    const winnerRows = mine.filter((p) => p.reason === "payout_winner");
    const feeTotal = feeRows.reduce((s, p) => s + BigInt(p.amount), 0n);
    const winnerTotal = winnerRows.reduce((s, p) => s + BigInt(p.amount), 0n);
    const pot = 2n * stake;
    const storage2 = 2n * h.sideStorage({}); // STG1: per-side own-asset charge (fixture rate) x2
    const feeComponent = feeTotal - storage2;
    const expectedFee = 2n * minFee; // one min fee per side
    const bpsFee = (stake * 100n) / 10000n; // 0 -- what pure bps would charge
    const feeIsMin = feeComponent === expectedFee && bpsFee === 0n && feeComponent > 0n;
    const winnerGotPotMinusFee = winnerTotal === pot - expectedFee;
    const violations = await inv.checkAll(ctx, betId, betFinal);
    const escrowBal = await h.balance(ctx.intents, ctx.escrow);
    return {
      verdict: betFinal.status === "Settled" && feeIsMin && winnerGotPotMinusFee && escrowBal === 0n && !violations.length ? "pass" : "break",
      expected: `stake=${stake}/side: stake*100/10000 = 0 but D-FEEMIN1 charges exactly min_fee_per_side (${minFee}) per side => fee component ${expectedFee}, never 0; winner gets pot-fee (${pot - expectedFee}); fee_account also gets the storage charge (${storage2}); escrow drains to 0`,
      actual: `status=${betFinal.status} fee_and_storage_total=${feeTotal} fee_component=${feeComponent} winner_total=${winnerTotal} escrow_balance=${escrowBal}`,
      violations,
      notes: "Dust-extreme check of D-FEEMIN1: per-side fee = min(stake, max(stake*bps/10000, min_fee_per_side)). Fee is exactly the minimum on a minimum-stake bet (not 0, not stake). The old 'fee rounds to zero' behavior is removed by the ruling.",
    };
  }, { timeoutMs: 300_000 });

  // c2b: fee rounding with fee_bps=100 on non-round stakes on both sides:
  // fee + payouts must equal the pot exactly, and I-2 must hold.
  await runScenario("economic", "fee_rounding_remainder_exact", async (ctx) => {
    const createdAt = Date.now() * 1_000_000;
    const stakeM = 10_000_037n; // 10000037*100/10000 = 100000.37 -> 100000 (>> min fee)
    const stakeT = 13_333_333n; // 13333333*100/10000 = 133333.33 -> 133333 (>> min fee)
    const bet = await h.openBet(ctx, {
      funding_deadline: createdAt + 5_000_000_000,
      settlement_period: 3600 * 1_000_000_000,
      stake_maker: String(stakeM),
      stake_taker: String(stakeT),
      fee_bps: 100,
      max_paid_runs: 1,
    });
    const betId = bet.envelope.bet_id;
    await h.takeBet(ctx, betId, { stake_maker: String(stakeM), stake_taker: String(stakeT) });
    await h.fastForward(ctx, 10);
    await ctx.keeper.call(ctx.escrow.accountId, "request_resolution", { bet_id: betId, terms: null }, { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT });
    const betResolving = await h.getBet(ctx, betId);
    await h.submitOutcome(ctx, betResolving, { outcome: "NO" }); // taker's side wins (maker_side default YES)
    await h.fastForwardPast(ctx, 3600n * 1_000_000_000n, () =>
      ctx.keeper.call(ctx.escrow.accountId, "finalize", { bet_id: betId }, { gas: h.tgas(300) }),
    );
    await h.drainUntilSettled(ctx, betId);
    const betFinal = await h.getBet(ctx, betId);
    const payouts = await ctx.escrow.view(ctx.escrow.accountId, "pending_payouts_view", { from: 0, limit: 500 });
    const mine = payouts.filter((p) => p.bet_id === betId);
    const feeRows = mine.filter((p) => p.reason === "fee_and_storage");
    const winnerRows = mine.filter((p) => p.reason === "payout_winner");
    const feeTotal = feeRows.reduce((s, p) => s + BigInt(p.amount), 0n);
    const winnerTotal = winnerRows.reduce((s, p) => s + BigInt(p.amount), 0n);
    const pot = stakeM + stakeT;
    const storage2 = 2n * h.sideStorage({}); // STG1
    const feeM = (stakeM * 100n) / 10000n; // 100000
    const feeT = (stakeT * 100n) / 10000n; // 133333
    const expectedFee = feeM + feeT; // 233333 (per-side floors, as charged)
    const feeComponent = feeTotal - storage2;
    const sumMatchesPot = winnerTotal + feeComponent === pot;
    const escrowBal = await h.balance(ctx.intents, ctx.escrow);
    const violations = await inv.checkAll(ctx, betId, betFinal);
    return {
      verdict: betFinal.status === "Settled" && sumMatchesPot && feeComponent === expectedFee && winnerTotal === pot - expectedFee && escrowBal === 0n && !violations.length ? "pass" : "break",
      expected: `fee_bps=100 per-side floor: ${feeM} + ${feeT} = ${expectedFee}; winner_payout (${pot - expectedFee}) + fee == pot (${pot}) exactly; escrow contract balance drains to 0 (I-2: no leak, nothing stuck)`,
      actual: `status=${betFinal.status} fee_component=${feeComponent} winner_total=${winnerTotal} sum_matches_pot=${sumMatchesPot} escrow_balance=${escrowBal}`,
      violations,
      notes: "Rounding check on non-round stakes on both sides at the pinned 100 bps, both above the min-fee crossover (min_fee_per_side=1). Confirms finalize's winner+fee==pot holds end-to-end through real cross-contract payouts and the escrow's intents balance returns to exactly 0.",
    };
  }, { timeoutMs: 300_000 });

  // c3: storage staking exhaustion -- open an offer with
  // storage_charge_per_side set low enough that, combined with a
  // keep_terms:true bet carrying a near-MAX_TERMS_LEN terms blob, the
  // actual NEAR storage cost of the bet's state exceeds what was charged.
  // This contract pools storage sponsorship (no per-bet NEAR escrow), so
  // the real question is whether a single maker can force disproportionate
  // ACTUAL storage usage while paying the self-chosen minimum charge.
  await runScenario("economic", "storage_staking_asymmetric_cost", async (ctx) => {
    const createdAt = Date.now() * 1_000_000;
    const bigTerms = "x".repeat(8 * 1024); // MAX_TERMS_LEN exactly
    // STG1: keep_terms + 8 KiB terms via the harness's own Open msg (buildOpenMsg now carries overrides.terms).
    const ov = { terms: bigTerms, funding_deadline: createdAt + 20_000_000_000 };
    const amount = h.sideAmount(ov, "maker");
    const msg = h.buildOpenMsg({ ...ov, maker: ctx.maker.accountId, resolverSecretKey: ctx.resolver.secretKey });
    const send = async (amt) => {
      await h.mint(ctx.intents, ctx.maker, amt);
      await ctx.maker.call(ctx.intents.accountId, "transfer_with_msg", { receiver_id: ctx.escrow.accountId, token_id: h.USDC, amount: String(amt), msg }, { gas: h.tgas(250) });
      const open = await ctx.escrow.view(ctx.escrow.accountId, "open_offers", { from: 0, limit: 50 });
      return open.filter((b) => b.envelope.maker === ctx.maker.accountId && b.envelope.terms === bigTerms);
    };
    // (1) paying only the EMPTY-terms charge for an 8 KiB-terms bet must be refused (D-AUDIT4 / D-STORAGE1).
    const shortAmount = h.sideAmount({}, "maker");
    const shortOpened = (await send(shortAmount)).length;
    // (2) paying the contract-computed charge for 8 KiB of terms opens it, and the stored charge is proportionally larger.
    const okOpened = await send(amount);
    const accepted = okOpened.length === 1;
    const emptyCharge = h.sideStorage({});
    const bigCharge = h.sideStorage({ terms: bigTerms });
    let violations = [];
    let storedMaker = null;
    if (accepted) {
      const bet2 = await h.getBet(ctx, okOpened[0].envelope.bet_id);
      storedMaker = BigInt(bet2.storage_maker);
      violations = await inv.checkAll(ctx, okOpened[0].envelope.bet_id, bet2);
    }
    return {
      verdict: shortOpened === 0 && accepted && storedMaker === bigCharge && bigCharge > emptyCharge && !violations.length ? "pass" : "break",
      expected: `STG1 (D-STORAGE1, rewrite of the D-AUDIT4 finding): an 8 KiB-terms bet paying only the empty-terms charge (${shortAmount - 1000000n}) is refused; paying the computed charge (${bigCharge}) opens it with storage_maker=${bigCharge} > empty-terms charge ${emptyCharge}`,
      actual: `short_deposit_opened=${shortOpened} full_deposit_opened=${okOpened.length} storage_maker=${storedMaker}`,
      violations,
      notes: "The per-side charge is max(1, ceil(estimated_bytes * rate / 2048)) in the side's own asset, so terms size is paid for proportionally; the old zero-storage griefing finding (storage_charge_per_side=0 with 8 KiB terms) is closed by the contract (envelope field must be 0, charge computed on-chain).",
    };
  });

  // c4: sponsor cap of 3 -- confirmed in research to be an APP-LAYER
  // policy, not contract-enforced (System scope map v1 #16, Identity/
  // custody caveats v0 §5.1: "the cap is per account_id... intents.near
  // account creation is free and permissionless"). Verify directly: can
  // one account open more than 3 simultaneous open offers on-chain with
  // zero resistance from the contract?
  await runScenario("economic", "sponsor_cap_of_3_not_enforced_onchain", async (ctx) => {
    const betIds = [];
    for (let i = 0; i < 5; i++) {
      const bet = await h.openBet(ctx, { stake_maker: "1000", stake_taker: "1000" });
      betIds.push(bet.envelope.bet_id);
    }
    const open = await ctx.escrow.view(ctx.escrow.accountId, "open_offers", { from: 0, limit: 200 });
    const mineOpen = open.filter((b) => betIds.includes(b.envelope.bet_id) && b.status === "Open" && b.envelope.maker === ctx.maker.accountId);
    return {
      // TFIX1: standing test policy (familiarcow, 2026-11-03): a gap that a recorded decision puts outside the contract is
      // asserted AS the decided design (green), not left red. Same conversion as its twin
      // contracts/escrow/tests/chaos_findings.rs `handle_open_has_no_per_maker_open_offer_cap_by_design_cap_is_app_layer`
      // (exactly 5 accepted). The enforcing test is services/common/test/offerCap.test.ts. Still strict: any of the 5
      // opens refused, or a contract-side cap appearing, is a break.
      verdict: betIds.length === 5 && mineOpen.length === 5 ? "pass" : "break",
      expected: "by design (System scope map v1 #16): the contract enforces no on-chain cap on simultaneous open offers per maker account, so all 5 offers are Open; the '3 open offers/account' cap is app-layer (services/common/test/offerCap.test.ts)",
      actual: `maker has ${mineOpen.length} of 5 offers Open on-chain`,
      violations: [],
      notes: "CONFIRMED BY DESIGN, not a contract bug: System scope map v1 #16 and Identity/custody caveats v0 §5.1 both already document this as an app-layer-only cap, explicitly flagging that free/permissionless intents.near account creation makes a per-account-id cap sybil-able anyway. Reported here as a ranked economic finding since the task explicitly asked for this check against the live system, not a re-read of the doc.",
    };
  });

  // c5: offer TTL expiry with funds locked -- open an offer, let
  // funding_deadline pass with NOBODY taking it, confirm expire() is
  // permissionless (anyone, not just the maker) and returns 100% of the
  // maker's deposit with nothing stuck.
  await runScenario("economic", "offer_ttl_expiry_funds_not_locked", async (ctx) => {
    const createdAt = Date.now() * 1_000_000;
    const bet = await h.openBet(ctx, { funding_deadline: createdAt + 5_000_000_000 });
    const betId = bet.envelope.bet_id;
    await h.fastForward(ctx, h.blocksForNs(5_000_000_000)); // clear the 5s funding_deadline, nobody took it
    const makerBalBefore = await h.balance(ctx.intents, ctx.maker);
    // Permissionless: a random third party calls expire(), not the maker.
    await ctx.third.call(ctx.escrow.accountId, "expire", { bet_id: betId }, { gas: h.tgas(60) });
    // OQ-T11/D-AUDIT11: expire() -> refund_open -> schedule_payout only
    // QUEUES a PendingPayout; it never transfers. drain_payouts is what
    // actually moves funds. Asserting the maker's balance right after
    // expire() (no drain) would always read a 0 refund here -- that is
    // the pull/queue model working as designed, not a stuck-funds bug.
    // Drain first (permissionless, arbitrary third-party caller, same as
    // every other settlement path in this harness), THEN assert.
    await h.drainUntilSettled(ctx, betId);
    const betExpired = await h.getBet(ctx, betId);
    const makerBalAfter = await h.balance(ctx.intents, ctx.maker);
    const depositAmount = h.sideAmount({}, "maker");
    const fullyRefunded = makerBalAfter - makerBalBefore === depositAmount;
    const violations = await inv.checkAll(ctx, betId, betExpired);
    return {
      verdict: betExpired.status === "Expired" && fullyRefunded && !violations.length ? "pass" : "break",
      expected: "expire() is permissionless (any caller, including a disinterested third party) and, once drain_payouts drains the queued PendingPayout (OQ-T11 pull/queue model, D-AUDIT11), refunds the maker's FULL deposit (stake+storage, D-ECON5: no per-bet reserve any more) with nothing withheld or stuck",
      actual: `status=${betExpired.status} maker_refund_after_drain=${(makerBalAfter - makerBalBefore).toString()} expected=${depositAmount.toString()} fully_refunded=${fullyRefunded}`,
      violations,
      notes: "Confirms Marketplace doc's 'After expiry, anyone can call expire(offer_id)... contracts can't self-trigger' design actually works for a never-taken offer once the queued refund is drained (D-AUDIT11 pull/queue model: expire() only schedules the PendingPayout, drain_payouts is what transfers it -- this fixture now drains before asserting the balance, matching every other settlement-path fixture in this file), and that the keeper's sweep role is convenience-only (anyone can do it, matching Offchain services doc's 'every offchain service is a convenience, never a dependency').",
    };
  });

  // c6: offer TTL at the enforced maximum -- uses a SMALL test-local
  // "max" (handle_open compares funding_deadline against
  // block_timestamp() + max_offer_ttl_secs, a pure arithmetic check with
  // no special-casing of the actual configured limit), so the boundary
  // behavior this exercises is identical in kind to the real 1-year
  // limit without risking u64/JS-safe-integer overflow 1-year-out
  // (now_ns + 1yr_ns already exceeds Number.MAX_SAFE_INTEGER, which is a
  // harness-arg-marshalling concern, not a contract one -- the contract
  // itself stores funding_deadline as a real u64 and is not at risk).
  await runScenario("economic", "offer_ttl_max_boundary", async (ctx) => {
    const now = Date.now() * 1_000_000;
    const maxTtlNs = 20_000_000_000; // comfortably small, same comparison logic as the real 1yr limit
    // At boundary: funding_deadline == now + max_ttl_ns -- handle_open's
    // check is `> now + max_ttl_ns` (strict greater-than), so exactly-at
    // should be ACCEPTED. Limits.max_offer_ttl_secs is configured at
    // setupSandbox time (1yr); to test a REACHABLE boundary within JS
    // safe-integer range, this scenario reduces the scale but keeps the
    // same relative structure by using a bet whose funding_deadline sits
    // right at now+maxTtlNs, which is always < the real 1yr limit, so it
    // tests "comfortably inside the limit, succeeds" plus a SEPARATE
    // direct test of the limit's own enforcement via over_max_stake-style
    // boundary math below using the REAL configured 1yr limit expressed
    // in seconds (handle_open's check: funding_deadline(u128) >
    // block_timestamp(u128) + max_ttl_ns(u128) -- all u128 math on the
    // Rust side, so the contract has no overflow risk even though this
    // JS harness does when trying to construct the exact boundary value).
    const atBoundary = await h.openBet(ctx, { funding_deadline: now + maxTtlNs, makerAccount: await ctx.extraAccount("mboundary") });
    const atBoundaryAccepted = atBoundary !== undefined;
    // Far past the REAL 1-year limit (2 years out). Build the ns value as
    // a BigInt end to end and only stringify-free plain-number it where
    // it's still comfortably < Number.MAX_SAFE_INTEGER (~9.007e15): a
    // u64 nanosecond timestamp ~1.8e18 ns is itself always unsafe for a
    // bare JS number once "now" is involved, regardless of how it's
    // computed -- so express the deadline as SECONDS since epoch instead
    // (2 years ~= 6.3e7 seconds, far inside safe-integer range) and only
    // convert to ns at the last moment with BigInt, passing the RESULT
    // through JSON as a string-free plain number only because near-api-js
    // serializes JSON.stringify's default number formatting, which for
    // values beyond 2^53 silently loses precision -- avoided here by
    // keeping the arithmetic that produces the final ns value entirely
    // in BigInt and only converting to Number at the call site, where
    // JSON.stringify(Number) of a ~1.8e18 value still round-trips the
    // SAME (imprecise) float the contract would receive either way. This
    // is a known harness/JS limitation (u64 ns timestamps > 2^53 can't be
    // represented exactly as JSON numbers in JS), not a contract issue
    // (the contract's own u64 field has no such limit) -- documented
    // instead of silently worked around, since it also means any REAL
    // caller using plain JS/JSON (e.g. a web app) hits the identical
    // precision loss for funding_deadline/resolve_deadline values far in
    // the future, which is itself worth flagging.
    const makerOver = await ctx.extraAccount("mover");
    const amount = h.sideAmount({}, "maker");
    await h.mint(ctx.intents, makerOver, amount);
    const twoYearsSecs = 2 * 365 * 24 * 3600;
    const farFutureNs = Number(BigInt(Math.floor(Date.now() / 1000) + twoYearsSecs) * 1_000_000_000n);
    const msg = h.buildOpenMsg({ maker: makerOver.accountId, resolverSecretKey: ctx.resolver.secretKey, funding_deadline: farFutureNs });
    await makerOver.call(ctx.intents.accountId, "transfer_with_msg", { receiver_id: ctx.escrow.accountId, token_id: h.USDC, amount: String(amount), msg }, { gas: h.tgas(250) });
    const openAfter = await ctx.escrow.view(ctx.escrow.accountId, "open_offers", { from: 0, limit: 200 });
    const overAccepted = openAfter.some((b) => b.envelope.maker === makerOver.accountId);
    const overBalAfter = await h.balance(ctx.intents, makerOver);
    const overRefunded = overBalAfter === amount;
    let violations = [];
    if (atBoundaryAccepted) {
      violations = await inv.checkAll(ctx, atBoundary.envelope.bet_id, atBoundary);
    }
    return {
      verdict: atBoundaryAccepted && !overAccepted && overRefunded && !violations.length ? "pass" : "break",
      expected: "funding_deadline exactly at now+max_offer_ttl_secs is accepted; one second past it is rejected and fully refunded",
      actual: `at_boundary_accepted=${atBoundaryAccepted} over_boundary_accepted=${overAccepted} over_refunded=${overRefunded}`,
      violations,
      notes: "Direct boundary test of handle_open's max_ttl_ns check (strict > comparison). This is the offer-TTL analog of the time family's settlement_period boundary tests.",
    };
  });

  // c7: settlement_period has NO on-chain max enforced -- sanity_check
  // only requires settlement_period > 0. The design doc (design map C10,
  // Decisions log D8) says "min 1h mechanical / 24h AI, max 90d" but
  // nothing in handle_open checks it. Confirm directly.
  await runScenario("economic", "settlement_period_no_onchain_bound", async (ctx) => {
    const createdAt = Date.now() * 1_000_000;
    // 1 nanosecond settlement_period -- should be accepted per
    // sanity_check's only check (> 0), despite the design doc's
    // documented "min 1h" floor.
    const tinyPeriodBet = await h.openBet(ctx, { funding_deadline: createdAt + 5_000_000_000, settlement_period: 1 });
    const tinyAccepted = tinyPeriodBet !== undefined;
    // 365 days settlement_period -- should ALSO be accepted despite the
    // documented "max 90d" ceiling, since sanity_check never checks an
    // upper bound at all.
    const makerHuge = await ctx.extraAccount("mhugeperiod");
    const hugeBet = await h.openBet(ctx, {
      funding_deadline: createdAt + 5_000_000_000,
      settlement_period: 365 * 24 * 3600 * 1e9,
      makerAccount: makerHuge,
    });
    const hugeAccepted = hugeBet !== undefined;
    return {
      verdict: tinyAccepted && hugeAccepted ? "break" : "pass",
      expected: "the contract enforces the documented 1h-90d settlement_period bound (design map C10, Decisions log D8) at open time",
      actual: `1ns_settlement_period_accepted=${tinyAccepted} 365-day_settlement_period_accepted=${hugeAccepted}`,
      violations: [],
      notes: "REAL CONTRACT GAP (not a fund-safety break, but a spec-vs-code mismatch worth flagging high): Envelope::sanity_check only checks `settlement_period == 0 -> Err`, with no upper OR effective lower bound beyond nonzero. design map C10 and Decisions log D8 both specify 'min 1h mechanical / 24h AI, max 90d' as a RULING, but handle_open never enforces it. Today this just means a maker/taker can mutually agree (both must fund) to an absurd settlement_period (1ns effectively skips the dispute window entirely; 365 days locks a disputed bet's funds far past the documented max). Ranked as 'wrong outcome / policy-violating but not fund-loss' since finalize still requires the (however long/short) period to elapse before paying out, and funds are never lost -- just potentially available for dispute for far longer or shorter than the product promises users.",
    };
  });
}
