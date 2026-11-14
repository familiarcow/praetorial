// Family (d): time -- settlement period min 1h and max 90d edges,
// extend_window once only, a cutoff exactly at the boundary.
//
// Pre-finding from economic.mjs's settlement_period_no_onchain_bound:
// the contract has NO upper or real lower bound on settlement_period
// beyond "> 0". This family focuses on the parts of the time story the
// contract DOES enforce precisely: finalize's elapsed-check boundary,
// extend_window's once-only rule, and resolve_deadline's own ordering
// constraint vs funding_deadline.
import * as h from "./../harness.mjs";
import * as inv from "./../invariants.mjs";
import { runScenario } from "./../runner.mjs";

async function toProposed(ctx, overrides = {}) {
  const createdAt = Date.now() * 1_000_000;
  const bet = await h.openBet(ctx, {
    funding_deadline: createdAt + 5_000_000_000,
    settlement_period: 3600 * 1_000_000_000, // D1: must be >=1h on-chain now
    ...overrides,
  });
  const betId = bet.envelope.bet_id;
  await h.takeBet(ctx, betId, overrides);
  await h.fastForward(ctx, 10); // clear funding_deadline
  await ctx.keeper.call(ctx.escrow.accountId, "request_resolution", { bet_id: betId, terms: null }, { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT });
  const betResolving = await h.getBet(ctx, betId);
  await h.submitOutcome(ctx, betResolving, { outcome: "YES" });
  return betId;
}

export async function run() {
  // R3f: request_resolution before funding_deadline must surface the contract's EXACT error text
  // ("too early to request resolution") from the deployable build. RED when the build lacks `--cfg near`
  // (panic_str then compiles to eprintln!+panic!()=unreachable and the message is lost).
  await runScenario("time", "request_resolution_before_funding_deadline_exact_error_text", async (ctx) => {
    const createdAt = Date.now() * 1_000_000;
    const bet = await h.openBet(ctx, { funding_deadline: createdAt + 600_000_000_000, settlement_period: 3600 * 1_000_000_000 });
    const betId = bet.envelope.bet_id;
    await h.takeBet(ctx, betId, {});
    let msg = "";
    try {
      await ctx.keeper.call(ctx.escrow.accountId, "request_resolution", { bet_id: betId, terms: null }, { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT });
    } catch (e) { msg = String(e?.message ?? e); }
    const exact = msg.includes("too early to request resolution");
    const after = await h.getBet(ctx, betId);
    return {
      verdict: exact && after.status === "Taken" ? "pass" : "break",
      expected: "rejected with the exact contract text 'too early to request resolution'; bet stays Taken",
      actual: `exactText=${exact} status=${after.status} msg=${msg.slice(0, 200)}`,
      violations: [],
      notes: "R3f: panic messages must survive the deployable build.",
    };
  });

  // d1: finalize BEFORE settlement_period elapses -- must be rejected.
  await runScenario("time", "finalize_before_settlement_period_elapsed", async (ctx) => {
    const betId = await toProposed(ctx); // settlement_period = 8s
    let rejected = false;
    try {
      await ctx.keeper.call(ctx.escrow.accountId, "finalize", { bet_id: betId }, { gas: h.tgas(300) });
    } catch (e) {
      rejected = h.isContractRejection(e, "settlement_period not elapsed");
    }
    const bet = await h.getBet(ctx, betId);
    const violations = await inv.checkAll(ctx, betId, bet);
    return {
      verdict: rejected && bet.status === "Proposed" && !violations.length ? "pass" : "break",
      expected: "finalize called immediately after submit_outcome (settlement_period not yet elapsed) is rejected; bet stays Proposed",
      actual: `rejected=${rejected} status=${bet.status}`,
      violations,
      notes: "Baseline sanity check for the settlement-period elapsed gate before testing its exact boundary below.",
    };
  });

  // d2: finalize EXACTLY at the settlement_period boundary. finalize's
  // check is `block_timestamp() >= proposed_at + settlement_period +
  // window_extension_ns` (non-strict >=), so exactly-at should SUCCEED.
  // Sandbox block production isn't sub-second-steerable from this
  // harness, so this tests "comfortably past the boundary, by the
  // smallest margin fast_forward can reliably produce" rather than the
  // literal single-nanosecond edge -- documented as a known harness
  // granularity limit, not evidence the contract's >= vs > choice is
  // untested (that's confirmed by direct code read: lib.rs uses `>=`).
  await runScenario("time", "finalize_at_settlement_period_boundary", async (ctx) => {
    // D1: settlement_period must be >=1h now -- use the documented
    // floor exactly and retry fast-forward in growing chunks (sandbox
    // block duration isn't fixed), same approach as the D5 proof.
    const betId = await toProposed(ctx, { settlement_period: 3600 * 1_000_000_000 });
    // item 6b: one fastForwardPast(1h) jump instead of looping small
    // fixed-size fastForward calls (which blew the per-scenario timeout).
    let succeeded = false;
    let err = null;
    try {
      await h.fastForwardPast(ctx, 3600n * 1_000_000_000n, () =>
        ctx.keeper.call(ctx.escrow.accountId, "finalize", { bet_id: betId }, { gas: h.tgas(300) }),
      );
      succeeded = true;
    } catch (e) {
      err = e.message;
    }
    // OQ-T11: finalize only persists the ledger (status Finalized) now --
    // drain_payouts is what actually settles it.
    if (succeeded) await h.drainUntilSettled(ctx, betId);
    const bet = await h.getBet(ctx, betId);
    const violations = await inv.checkAll(ctx, betId, bet);
    return {
      verdict: succeeded && bet.status === "Settled" && !violations.length ? "pass" : "break",
      expected: "finalize succeeds once settlement_period has elapsed (non-strict >= boundary per lib.rs); bet becomes Finalized then Settled once drain_payouts empties the ledger",
      actual: `succeeded=${succeeded} status=${bet.status} err=${err}`,
      violations,
      notes: "Code-read confirms finalize uses `>=` (inclusive) for the elapsed check, not `>` -- this exercises that it actually behaves that way end-to-end once the sandbox's block-time granularity clears the window, not just at the single-ns edge (sandbox block time isn't that steerable). OQ-T11: finalize->Finalized, then drain_payouts->Settled.",
    };
  }, { timeoutMs: 300_000 }); // item 6b: fastForwardPast(1h) jump needs more than the 120s default

  // d3: extend_window exactly once -- a second call by EITHER party must
  // be rejected ("window already extended once"), even if the second
  // caller is the OTHER party (not the one who called it the first time).
  await runScenario("time", "extend_window_once_only_either_party", async (ctx) => {
    // D1: settlement_period must be >=1h now; no finalize happens in
    // this test so the exact value doesn't matter beyond being legal.
    const betId = await toProposed(ctx, { settlement_period: 3600 * 1_000_000_000 });
    await ctx.maker.call(ctx.escrow.accountId, "extend_window", { bet_id: betId }, { gas: h.tgas(60) });
    const betAfterFirst = await h.getBet(ctx, betId);
    let secondRejectedFromTaker = false;
    try {
      // Taker (the OTHER party) tries to extend again -- must still be
      // blocked by the once-only rule, not just "once per caller".
      await ctx.taker.call(ctx.escrow.accountId, "extend_window", { bet_id: betId }, { gas: h.tgas(60) });
    } catch (e) {
      secondRejectedFromTaker = h.isContractRejection(e, "window already extended once");
    }
    const betFinal = await h.getBet(ctx, betId);
    const violations = await inv.checkAll(ctx, betId, betFinal);
    // window_extension_ns is a plain u64 (not U64), so it serializes as a
    // JSON number, not a string -- compare numerically.
    const extendedOnce = betAfterFirst.window_extended === true && Number(betAfterFirst.window_extension_ns) === 86_400_000_000_000; // +24h in ns
    return {
      verdict: extendedOnce && secondRejectedFromTaker && !violations.length ? "pass" : "break",
      expected: "extend_window succeeds once (either party), sets window_extended=true and +24h; a second call from ANY party (including the one who didn't call it first) is rejected",
      actual: `extended_once=${extendedOnce} window_extension_ns=${betAfterFirst.window_extension_ns} second_call_from_other_party_rejected=${secondRejectedFromTaker}`,
      violations,
      notes: "Directly tests the 'once only' rule is PER-BET, not per-caller -- a naive implementation might only block the SAME account from calling twice, letting maker extend once then taker extend again for a total +48h. Confirmed blocked correctly (bet.window_extended is a single bool, not per-party).",
    };
  });

  // d4: extend_window called with NO proposed outcome yet (bet still
  // Taken, pre-resolution) -- must be rejected regardless of status match,
  // since there's no settlement window running to extend.
  await runScenario("time", "extend_window_before_any_proposal_rejected", async (ctx) => {
    const createdAt = Date.now() * 1_000_000;
    const bet = await h.openBet(ctx, { funding_deadline: createdAt + 20_000_000_000 });
    const betId = bet.envelope.bet_id;
    await h.takeBet(ctx, betId, {});
    let rejected = false;
    try {
      await ctx.maker.call(ctx.escrow.accountId, "extend_window", { bet_id: betId }, { gas: h.tgas(60) });
    } catch (e) {
      rejected = h.isContractRejection(e, "no active dispute/settlement window") || h.isContractRejection(e, "no proposed outcome");
    }
    const betFinal = await h.getBet(ctx, betId);
    const violations = await inv.checkAll(ctx, betId, betFinal);
    return {
      verdict: rejected && !betFinal.window_extended && !violations.length ? "pass" : "break",
      expected: "extend_window on a Taken bet with no proposed outcome yet is rejected -- there is no running settlement window to extend",
      actual: `rejected=${rejected} window_extended=${betFinal.window_extended}`,
      violations,
      notes: "Guards against a party pre-emptively 'banking' their one extension before a dispute window even opens.",
    };
  });

  // d5: resolve_deadline must be strictly after funding_deadline
  // (sanity_check's own ordering rule) -- confirm the boundary: equal
  // values rejected, one ns after funding_deadline accepted.
  await runScenario("time", "resolve_deadline_ordering_boundary", async (ctx) => {
    const createdAt = Date.now() * 1_000_000;
    const fundingDeadline = createdAt + 20_000_000_000;
    // Equal: should be REJECTED ("resolve_deadline must be after funding_deadline").
    const makerEqual = await ctx.extraAccount("mequal");
    const amount = h.sideAmount({}, "maker");
    await h.mint(ctx.intents, makerEqual, amount);
    const msgEqual = h.buildOpenMsg({ maker: makerEqual.accountId, resolverSecretKey: ctx.resolver.secretKey, funding_deadline: fundingDeadline, resolve_deadline: fundingDeadline });
    await makerEqual.call(ctx.intents.accountId, "transfer_with_msg", { receiver_id: ctx.escrow.accountId, token_id: h.USDC, amount: String(amount), msg: msgEqual }, { gas: h.tgas(250) });
    const openAfterEqual = await ctx.escrow.view(ctx.escrow.accountId, "open_offers", { from: 0, limit: 200 });
    const equalAccepted = openAfterEqual.some((b) => b.envelope.maker === makerEqual.accountId);
    const equalRefunded = (await h.balance(ctx.intents, makerEqual)) === amount;

    // funding_deadline + 1s: should be ACCEPTED.
    const makerPlus1 = await ctx.extraAccount("mplus1");
    await h.mint(ctx.intents, makerPlus1, amount);
    const msgPlus1 = h.buildOpenMsg({ maker: makerPlus1.accountId, resolverSecretKey: ctx.resolver.secretKey, funding_deadline: fundingDeadline, resolve_deadline: fundingDeadline + 1_000_000_000 });
    await makerPlus1.call(ctx.intents.accountId, "transfer_with_msg", { receiver_id: ctx.escrow.accountId, token_id: h.USDC, amount: String(amount), msg: msgPlus1 }, { gas: h.tgas(250) });
    const openAfterPlus1 = await ctx.escrow.view(ctx.escrow.accountId, "open_offers", { from: 0, limit: 200 });
    const plus1Accepted = openAfterPlus1.some((b) => b.envelope.maker === makerPlus1.accountId);

    return {
      verdict: !equalAccepted && equalRefunded && plus1Accepted ? "pass" : "break",
      expected: "resolve_deadline == funding_deadline is rejected and fully refunded (sanity_check requires resolve_deadline > funding_deadline, strict); resolve_deadline = funding_deadline+1s is accepted",
      actual: `equal_accepted=${equalAccepted} equal_refunded=${equalRefunded} plus1s_accepted=${plus1Accepted}`,
      violations: [],
      notes: "Direct boundary test of sanity_check's `resolve_deadline <= funding_deadline -> Err` rule (note: <=, so equal is correctly rejected, confirming the strict-greater-than reading).",
    };
  });

  // d6: cutoff exactly at resolve_deadline for request_resolution itself
  // (can_request_resolution / internal_request_resolution's own
  // `now < resolve_deadline` check, separate from void_after_deadline's
  // `now > resolve_deadline` check -- confirm there's no GAP between the
  // two where neither request_resolution NOR void_after_deadline is
  // callable, which would be a liveness bug: a bet frozen in Resolving
  // forever once resolve_deadline is hit at exactly the wrong instant).
  await runScenario("time", "resolve_deadline_no_gap_between_request_and_void", async (ctx) => {
    const createdAt = Date.now() * 1_000_000;
    const bet = await h.openBet(ctx, {
      funding_deadline: createdAt + 5_000_000_000,
      resolve_deadline: createdAt + 10_000_000_000,
    });
    const betId = bet.envelope.bet_id;
    await h.takeBet(ctx, betId, {});
    await h.fastForward(ctx, 10); // clear funding_deadline(5s), approach resolve_deadline(10s)
    // request_resolution requires `now < resolve_deadline` -- at this
    // point we've advanced ~10 blocks (~10s of sim time against a 10s
    // resolve_deadline), so we're right at the seam. Try request first;
    // if it fails because resolve_deadline already passed, void must
    // then succeed (no gap). If it succeeds, fine too -- either is a
    // valid non-gap outcome.
    let requestOk = false;
    let requestErr = null;
    try {
      await ctx.keeper.call(ctx.escrow.accountId, "request_resolution", { bet_id: betId, terms: null }, { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT });
      requestOk = true;
    } catch (e) {
      requestErr = e.message;
    }
    let voidOk = false;
    let voidErr = null;
    if (!requestOk) {
      await h.fastForward(ctx, 3); // make sure we're unambiguously past resolve_deadline now
      try {
        await ctx.keeper.call(ctx.escrow.accountId, "void_after_deadline", { bet_id: betId }, { gas: h.tgas(300) });
        voidOk = true;
      } catch (e) {
        voidErr = e.message;
      }
    }
    const bet2 = await h.getBet(ctx, betId);
    const violations = await inv.checkAll(ctx, betId, bet2);
    const noGap = requestOk || voidOk;
    return {
      verdict: noGap && !violations.length ? "pass" : "break",
      expected: "at the resolve_deadline seam, EITHER request_resolution succeeds (still just before deadline) OR void_after_deadline succeeds (already past deadline) -- never neither, which would freeze the bet with no legal next action",
      actual: `request_resolution_ok=${requestOk} (err=${requestErr}) void_after_deadline_ok=${voidOk} (err=${voidErr}) no_gap=${noGap}`,
      violations,
      notes: "request_resolution requires `now < resolve_deadline` (strict) and void_after_deadline requires `now > resolve_deadline` (strict) -- both strict with opposite direction, so the single instant `now == resolve_deadline` is the only point where NEITHER is callable. That's a real but vanishingly narrow (one nanosecond) liveness gap; any keeper poll interval coarser than a nanosecond will always land on one side or the other in practice, so this is theoretical rather than exploitable. Flagged, not ranked as a practical break.",
    };
  });
}
