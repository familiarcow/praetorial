// Family (b): adversarial users -- front-running accept/cancel, griefing
// with many tiny offers, request_resolution spam, result shopping (I-7),
// objection deposit games, amend races, a counterparty vanishing.
import * as h from "./../harness.mjs";
import * as inv from "./../invariants.mjs";
import { runScenario } from "./../runner.mjs";

export async function run() {
  // b1: front-running cancel -- maker fires `cancel` and a taker fires
  // `take` (via transfer_with_msg) in the "same moment"; on a real chain
  // these land in some serial order on one shard. Confirm only one wins
  // and the loser's funds come back in full (no double-take, no stuck
  // deposit).
  await runScenario("adversarial", "cancel_vs_take_race", async (ctx) => {
    const bet = await h.openBet(ctx);
    const betId = bet.envelope.bet_id;
    const takerBalBefore = BigInt("1110000"); // taker's mint amount below
    // Fire cancel first (NEAR sandbox processes txs serially; this models
    // "cancel lands first" -- the harness can't force true concurrency on
    // a single-node chain, so we test both orderings as two sub-cases).
    await ctx.maker.call(ctx.escrow.accountId, "cancel", { bet_id: betId }, { gas: h.tgas(60) });
    const betAfterCancel = await h.getBet(ctx, betId);
    let takeRejected = false;
    let takeErr = null;
    const amount = h.sideAmount({}, "taker");
    await h.mint(ctx.intents, ctx.taker, amount);
    try {
      await ctx.taker.call(ctx.intents.accountId, "transfer_with_msg", { receiver_id: ctx.escrow.accountId, token_id: h.USDC, amount: String(amount), msg: JSON.stringify({ kind: "Take", bet_id: betId, invite_sig: null }) }, { gas: h.tgas(250) });
    } catch (e) { takeErr = e.message; }
    const takerBalAfter = await h.balance(ctx.intents, ctx.taker);
    // transfer_with_msg never panics (I-3) -- a rejected Take just
    // refunds via the resolve_transfer credit-back path, so no throw;
    // instead check the taker got their money back (balance unchanged
    // from before the attempt, i.e. the mt_on_transfer reject corrrectly
    // propagated to a full intents-side refund).
    takeRejected = takerBalAfter === amount; // still holds the minted amount, nothing taken
    const betFinal = await h.getBet(ctx, betId);
    const violations = await inv.checkAll(ctx, betId, betFinal);
    return {
      verdict: betAfterCancel.status === "Cancelled" && takeRejected && betFinal.status === "Cancelled" && !violations.length ? "pass" : "break",
      expected: "cancel-then-take race: take on an already-Cancelled bet is rejected and the taker's deposit is fully refunded via the intents resolve_transfer credit-back path (I-3)",
      actual: `cancel_status=${betAfterCancel.status} taker_refunded=${takeRejected} final_status=${betFinal.status}`,
      violations,
      notes: "NEAR serializes receipts per-shard so true simultaneity can't be forced in-sandbox; this tests the deterministic outcome of whichever lands first, which is the real guarantee the contract offers (not 'nobody can race', but 'the loser is made whole').",
    };
  });

  // b2: griefing with many tiny offers -- open N offers just under
  // whatever cap exists, confirm storage/sponsorship cost scales
  // linearly (no amplification) and the maker can still get every one
  // of them back via cancel.
  await runScenario("adversarial", "many_tiny_offers_griefing", async (ctx) => {
    const N = 5; // keep small for sandbox wall-time; the question is per-offer isolation, not absolute scale
    const betIds = [];
    for (let i = 0; i < N; i++) {
      // D4: storage_charge_per_side must cover estimated bytes written
      // (hash fields + worst-case exhibits + overhead); "0" is no
      // longer accepted onchain. 2000/side (D4 floor is ~1.7k/side) covers the
      // ~1792-byte conservative estimate for this bet shape (/2 sides).
      const bet = await h.openBet(ctx, { stake_maker: "20", stake_taker: "20" }) /* STG1b fixture: dust = the USDC min_per_side (20); "1" is outside asset_limits */;
      betIds.push(bet.envelope.bet_id);
    }
    const openOffers = await ctx.escrow.view(ctx.escrow.accountId, "open_offers", { from: 0, limit: 200 });
    const mineOpen = openOffers.filter((b) => betIds.includes(b.envelope.bet_id) && b.status === "Open");
    // Cancel them all back.
    for (const id of betIds) {
      await ctx.maker.call(ctx.escrow.accountId, "cancel", { bet_id: id }, { gas: h.tgas(60) });
    }
    const afterCancel = await Promise.all(betIds.map((id) => h.getBet(ctx, id)));
    const allCancelled = afterCancel.every((b) => b.status === "Cancelled");
    let violations = [];
    for (let i = 0; i < betIds.length; i++) {
      violations = violations.concat(await inv.checkAll(ctx, betIds[i], afterCancel[i]));
    }
    return {
      verdict: mineOpen.length === N && allCancelled && !violations.length ? "pass" : "break",
      expected: "N dust-stake offers (stake=1 unit, D-ECON5: no per-bet reserve any more, storage=2000) all open successfully and all cancel cleanly -- no contract-side amplification, no stuck offer",
      actual: `opened=${mineOpen.length}/${N} all_cancelled=${allCancelled}`,
      violations,
      notes: "The contract has NO on-chain sponsorship cap (the documented '3 open offers/account' cap -- System scope map v1 #16, Identity/custody caveats v0 §5.1 -- is an APP/OFFCHAIN POLICY, not enforced here). A sybil/script can open unlimited dust offers on-chain; the only real cost is storage staking the maker pays (storage_charge_per_side can legally be 0 per sanity_check, so even that floor is a policy choice, not a contract-enforced one). Flagging as an economic finding, not a pass/fail contract bug.",
    };
  });

  // b3: request_resolution spam -- any account (not just keeper) can call
  // the permissionless, payable request_resolution. D-ECON5: round-0's
  // judge run is funded entirely by keeper_credit (repaid by the 1%
  // protocol fee via treasury), never drawn from the bet's own money,
  // so a spammed extra run no longer burns a per-bet reserve budget --
  // this scenario now just confirms the spam itself (and I-1) still
  // behaves safely without that budget to drain.
  await runScenario("adversarial", "request_resolution_spam", async (ctx) => {
    const createdAt = Date.now() * 1_000_000;
    const bet = await h.openBet(ctx, {
      funding_deadline: createdAt + 5_000_000_000,
      max_paid_runs: 3,
    });
    const betId = bet.envelope.bet_id;
    await h.takeBet(ctx, betId, {});
    await h.fastForward(ctx, 10);
    const attacker = ctx.third; // neither maker nor taker
    let spamSucceeded = 0;
    for (let i = 0; i < 3; i++) {
      try {
        await attacker.call(ctx.escrow.accountId, "request_resolution", { bet_id: betId, terms: null }, { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT });
        spamSucceeded++;
        // Each request_resolution leaves the bet in Resolving with a
        // pending request; it must be answered (mock-outlayer always
        // echoes synchronously) before another can be requested, OR the
        // contract must reject a second request while one is pending --
        // verify which, since that's the actual guard against spam.
      } catch (e) {
        break;
      }
    }
    const betAfter = await h.getBet(ctx, betId);
    const violations = await inv.checkAll(ctx, betId, betAfter);
    // D-ECON5: round-0's judge run is funded entirely by keeper_credit,
    // never drawn from or reimbursed out of bet money -- so unlike the
    // pre-D-ECON5 finding this scenario used to pin, spamming
    // request_resolution no longer redirects any of the two parties'
    // own money to the spamming third party. request_resolution is
    // still #[payable] (the attacker fronts their own NEAR for OutLayer
    // compute) and still has no access control, but that NEAR is the
    // attacker's own, never the bet's.
    return {
      verdict: violations.length ? "break" : "pass",
      expected: "a non-party can call request_resolution and front OutLayer's NEAR cost out of their own pocket; no per-bet reserve exists any more for a spammed run to draw from or reimburse out of -- confirm no fund-safety break",
      actual: `attacker_requests_succeeded=${spamSucceeded} runs_used=${betAfter.runs_used}/${betAfter.envelope.max_paid_runs} status=${betAfter.status}`,
      violations,
      notes: "request_resolution still has no access control (deliberately, per design doc -- 'permissionless so anyone can self-trigger if the keeper is down', FM-11). A third party CAN still spam-trigger extra resolution runs up to max_paid_runs, but D-ECON5 removed the per-bet reserve this used to drain and the run-cost reimbursement that used to pay the spammer -- round-0 compute is funded entirely by keeper_credit now, so this is no longer a wealth-transfer-from-the-two-parties finding, just an access-control note already tracked as by-design (FM-11).",
    };
  });

  // b4: result shopping (I-7) -- resolver (or someone who stole/derived
  // its signing key in a bad deployment) tries to submit run_no=2 before
  // run_no=1 is ever submitted (skip-ahead), and tries to submit an
  // EARLIER run_no after a later one already landed (shop backwards).
  await runScenario("adversarial", "result_shopping_run_order", async (ctx) => {
    const createdAt = Date.now() * 1_000_000;
    const bet = await h.openBet(ctx, { funding_deadline: createdAt + 5_000_000_000, max_paid_runs: 3 });
    const betId = bet.envelope.bet_id;
    await h.takeBet(ctx, betId, {});
    await h.fastForward(ctx, 10);
    await ctx.keeper.call(ctx.escrow.accountId, "request_resolution", { bet_id: betId, terms: null }, { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT });
    const betResolving = await h.getBet(ctx, betId);
    // Attempt 1: skip ahead, submit run_no=2 while next_expected_run_no=1.
    let skipAheadRejected = false;
    try {
      await h.submitOutcome(ctx, betResolving, { outcome: "NO", runNo: 2 });
    } catch (e) {
      skipAheadRejected = true;
    }
    // Submit the legit run_no=1 as YES.
    await h.submitOutcome(ctx, betResolving, { outcome: "YES", runNo: 1 });
    const betAfterRun1 = await h.getBet(ctx, betId);
    // Attempt 2: shop backwards, try to resubmit run_no=1 again with a
    // different outcome (NO) now that we don't like YES.
    let shopBackwardsRejected = false;
    try {
      await h.submitOutcome(ctx, betAfterRun1, { outcome: "NO", runNo: 1 });
    } catch (e) {
      shopBackwardsRejected = true;
    }
    const betFinal = await h.getBet(ctx, betId);
    const violations = await inv.checkAll(ctx, betId, betFinal);
    const outcomeStillYes = betFinal.outcome === "YES";
    return {
      verdict: skipAheadRejected && shopBackwardsRejected && outcomeStillYes && !violations.length ? "pass" : "break",
      expected: "both skip-ahead (run_no=2 before 1) and shop-backwards (resubmit run_no=1 with a different outcome) are rejected; final outcome stays the first legitimately accepted YES",
      actual: `skip_ahead_rejected=${skipAheadRejected} shop_backwards_rejected=${shopBackwardsRejected} outcome=${betFinal.outcome}`,
      violations,
      notes: "Direct test of FM-13/I-7's core defense. A pass here confirms the contract-level fix holds against both shopping directions, not just the happy path the existing unit tests (run_no_reuse_rejected) cover.",
    };
  });

  // b5: objection deposit games -- a party objects, then tries to exit the
  // dispute through a side door with the counterparty (the old
  // mutual_settle). 17e: D-SETTLE3 removed mutual_settle, so the call must
  // fail as an unknown method and the dispute (bond + objection) stays
  // exactly as it was: no split, no payout.
  await runScenario("adversarial", "objection_then_mutual_settle_removed", async (ctx) => {
    const createdAt = Date.now() * 1_000_000;
    const bet = await h.openBet(ctx, { funding_deadline: createdAt + 5_000_000_000, max_paid_runs: 3, stake_maker: "10000000", stake_taker: "10000000" });
    const betId = bet.envelope.bet_id;
    await h.takeBet(ctx, betId, { stake_maker: "10000000", stake_taker: "10000000" });
    await h.fastForward(ctx, 10);
    await ctx.keeper.call(ctx.escrow.accountId, "request_resolution", { bet_id: betId, terms: null }, { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT });
    const betResolving = await h.getBet(ctx, betId);
    await h.submitOutcome(ctx, betResolving, { outcome: "YES", runNo: 1 });
    // Taker (loser if YES stands) challenges with a bond.
    const pot = 20000000n; // stake_maker + stake_taker
    // item 6b fixture fix: this used to hardcode the bond amount
    // (challenge_min + a stale run_price constant), which drifted
    // every time the bond schedule or run_price changed (D-AUDIT8,
    // D-ECON5, D-DISPUTE1's item 6 max(min_bond,10%pot)*2^(round-1)
    // schedule) and transfer_with_msg's never-panic convention turned
    // a short bond into a silent refund instead of a visible error
    // (bondsBefore ending up 0 with no obvious cause). Quote the exact
    // amount from the contract's own view instead of recomputing the
    // schedule by hand, same pattern as cross_asset_bond.mjs.
    const quote = await ctx.escrow.view(ctx.escrow.accountId, "required_challenge_bond", { bet_id: betId, challenger: ctx.taker.accountId });
    if (!quote || quote.asset !== h.USDC) {
      throw new Error(`expected a USDC challenge-bond quote for the taker, got ${JSON.stringify(quote)}`);
    }
    const bondAmount = BigInt(quote.amount);
    await h.mint(ctx.intents, ctx.taker, bondAmount);
    await ctx.taker.call(ctx.intents.accountId, "transfer_with_msg", { receiver_id: ctx.escrow.accountId, token_id: h.USDC, amount: String(bondAmount), msg: JSON.stringify({ kind: "Bond", bet_id: betId, round: 0 }) }, { gas: h.tgas(250) });
    const betChallenged = await h.getBet(ctx, betId);
    // Taker also files an objection/exhibit deposit (max($1,0.5%pot)).
    const objAmount = (pot * 50n) / 10000n > 1000000n ? (pot * 50n) / 10000n : 1000000n;
    await h.mint(ctx.intents, ctx.taker, objAmount);
    await ctx.taker.call(ctx.intents.accountId, "transfer_with_msg", { receiver_id: ctx.escrow.accountId, token_id: h.USDC, amount: String(objAmount), msg: JSON.stringify({ kind: "Objection", bet_id: betId, exhibit_hash: "d".repeat(64), is_rebuttal: false }) }, { gas: h.tgas(250) });
    const betEvidence = await h.getBet(ctx, betId);
    const bondsBefore = betEvidence.bonds.length;
    const objBefore = betEvidence.objection_deposits.length;
    // 17e: D-SETTLE3 removed mutual_settle -- both parties try the old
    // door; each call must be rejected as an unknown method.
    const tryCall = async (acct) => {
      try {
        await acct.call(ctx.escrow.accountId, "mutual_settle", { bet_id: betId, split_maker_bps: 5000 }, { gas: h.tgas(300) });
        return { rejected: false, msg: "accepted" };
      } catch (e) {
        return { rejected: true, msg: String(e && e.message || e).slice(0, 200) };
      }
    };
    const makerTry = await tryCall(ctx.maker);
    const takerTry = await tryCall(ctx.taker);
    const betAfter = await h.getBet(ctx, betId);
    const payouts = await ctx.escrow.view(ctx.escrow.accountId, "pending_payouts_view", { from: 0, limit: 500 });
    const mine = payouts.filter((p) => p.bet_id === betId);
    const violations = await inv.checkAll(ctx, betId, betAfter, { lifetimeExtraIn: bondAmount + objAmount });
    const unchanged = betAfter.status === "Evidence" && betAfter.bonds.length === bondsBefore && betAfter.objection_deposits.length === objBefore && mine.length === 0;
    return {
      verdict: makerTry.rejected && takerTry.rejected && unchanged && !violations.length ? "pass" : "break",
      expected: "mutual_settle is gone (D-SETTLE3): both calls fail as an unknown method; the dispute is untouched (status Evidence, bond + objection still held, no payout scheduled)",
      actual: `maker_rejected=${makerTry.rejected} taker_rejected=${takerTry.rejected} status=${betAfter.status} bonds=${betAfter.bonds.length} objections=${betAfter.objection_deposits.length} payouts_for_bet=${mine.length} maker_msg=${makerTry.msg}`,
      violations,
      notes: "17e: replaces the old objection_then_mutual_settle_escape scenario. With mutual_settle removed there is no consent-based exit from an active dispute; it can only end through the judge/finalize, VOID, timeout or emergency paths.",
    };
  });

  // b6: amend races -- maker proposes new_terms_hash=A, taker proposes
  // new_terms_hash=B (mismatch, no commit); then maker changes their mind
  // to match B right as the taker ALSO changes to a third value C. Confirm
  // commit only happens on an exact value match and a party can freely
  // revise their own pending proposal without corrupting the other side's.
  await runScenario("adversarial", "amend_race_mismatched_then_match", async (ctx) => {
    const createdAt = Date.now() * 1_000_000;
    const bet = await h.openBet(ctx, { funding_deadline: createdAt + 20_000_000_000 });
    const betId = bet.envelope.bet_id;
    await h.takeBet(ctx, betId, {});
    const hashA = "1".repeat(64), hashB = "2".repeat(64), hashC = "3".repeat(64);
    await ctx.maker.call(ctx.escrow.accountId, "amend", { bet_id: betId, new_terms_hash: hashA }, { gas: h.tgas(60) });
    await ctx.taker.call(ctx.escrow.accountId, "amend", { bet_id: betId, new_terms_hash: hashB }, { gas: h.tgas(60) });
    const betMismatch = await h.getBet(ctx, betId);
    const noCommitYet = betMismatch.envelope.terms_hash === bet.envelope.terms_hash && betMismatch.amend_count === 0;
    // Taker revises to C; maker revises to match C.
    await ctx.taker.call(ctx.escrow.accountId, "amend", { bet_id: betId, new_terms_hash: hashC }, { gas: h.tgas(60) });
    await ctx.maker.call(ctx.escrow.accountId, "amend", { bet_id: betId, new_terms_hash: hashC }, { gas: h.tgas(60) });
    const betCommitted = await h.getBet(ctx, betId);
    const committed = betCommitted.envelope.terms_hash === hashC && betCommitted.amend_count === 1;
    const violations = await inv.checkAll(ctx, betId, betCommitted);
    return {
      verdict: noCommitYet && committed && !violations.length ? "pass" : "break",
      expected: "mismatched proposals never commit; a party can freely revise their own pending value; commit fires exactly once both sides match on the SAME value (here hashC), bumping amend_count by 1",
      actual: `no_premature_commit=${noCommitYet} final_hash_matches_C=${betCommitted.envelope.terms_hash === hashC} amend_count=${betCommitted.amend_count}`,
      violations,
      notes: "Each commit_two_party call unconditionally overwrites the caller's own proposal slot (no round/nonce), so a party revising their own pending value before the other side catches up is safe by construction -- this test confirms that holds under a 3-way value race (A vs B vs C), not just a simple 2-value case.",
    };
  });

  // b7: counterparty vanishing -- taker takes the bet then never does
  // anything else (no challenge, no objection, no response). Confirm the
  // bet still resolves normally via the keeper's permissionless path with
  // zero taker interaction required.
  await runScenario("adversarial", "counterparty_vanishes_after_take", async (ctx) => {
    const createdAt = Date.now() * 1_000_000;
    // D1: settlement_period must be >= 1h on-chain now; the old 3s
    // test-scaled value is no longer accepted.
    const bet = await h.openBet(ctx, { funding_deadline: createdAt + 5_000_000_000, settlement_period: 3600 * 1_000_000_000 });
    const betId = bet.envelope.bet_id;
    await h.takeBet(ctx, betId, {}); // taker takes, then "vanishes" (no further calls from ctx.taker anywhere below)
    await h.fastForward(ctx, 10);
    await ctx.keeper.call(ctx.escrow.accountId, "request_resolution", { bet_id: betId, terms: null }, { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT });
    const betResolving = await h.getBet(ctx, betId);
    await h.submitOutcome(ctx, betResolving, { outcome: "YES" });
    const betProposed = await h.getBet(ctx, betId);
    // item 6b pattern: one fastForwardPast(1h) jump sized off the
    // measured sim-time/block ratio, instead of looping small fixed
    // 5000-block fastForward calls -- the old loop's per-attempt
    // real-wall-clock cost blew past the 120s default scenario timeout
    // (hence this scenario's documented TIMEOUT). opts.timeoutMs below
    // also raised to the same 300s budget used by economic's 1h-crossing
    // scenarios.
    let finalized = false;
    try {
      await h.fastForwardPast(ctx, 3600n * 1_000_000_000n, () =>
        ctx.keeper.call(ctx.escrow.accountId, "finalize", { bet_id: betId }, { gas: h.tgas(300) }),
      );
      finalized = true;
    } catch (e) {
      if (!String(e?.message ?? e).includes("settlement_period not elapsed")) throw e;
    }
    // OQ-T11: finalize only persists the ledger (status Finalized) --
    // drain_payouts is what actually settles it.
    if (finalized) await h.drainUntilSettled(ctx, betId);
    const betFinal = await h.getBet(ctx, betId);
    const makerBalBefore = 0n; // maker never had USDC before minting for the bet
    const payouts = await ctx.escrow.view(ctx.escrow.accountId, "pending_payouts_view", { from: 0, limit: 500 });
    const mine = payouts.filter((p) => p.bet_id === betId);
    const winnerPaid = mine.some((p) => p.reason === "payout_winner" && p.receiver === bet.envelope.maker); // YES == maker_side
    const violations = await inv.checkAll(ctx, betId, betFinal);
    return {
      verdict: betFinal.status === "Settled" && winnerPaid && !violations.length ? "pass" : "break",
      expected: "a bet resolves to Settled purely via keeper calls with ZERO interaction from the taker after they took it -- no counterparty cooperation required anywhere in the happy path",
      actual: `status=${betFinal.status} winner_payout_scheduled=${winnerPaid}`,
      violations,
      notes: "Confirms the core liveness property: nobody can hold a bet hostage by going silent. This is the 'disappearing counterparty' half of FM-11/FM-12's design intent and it holds in sandbox.",
    };
  }, { timeoutMs: 300_000 }); // item 6b: fastForwardPast(1h) jump needs more than the 120s default
}
