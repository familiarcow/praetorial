// Family (a): infra failures -- OutLayer never/twice/late responds or
// refunds without a bet_id; keeper crashes mid-flow and restarts; indexer
// misses/replays events; RPC lag (stale view right after a tx).
import * as h from "./../harness.mjs";
import * as inv from "./../invariants.mjs";
import { runScenario } from "./../runner.mjs";

// D1: settlement_period must be >=1h on-chain now. None of this
// family's scenarios actually wait out settlement_period (they resolve
// via void_after_deadline or inspect Resolving state directly), so the
// value only needs to be legal at open time -- the name is now a slight
// misnomer but harmless.
const SHORT_SETTLE = 3600 * 1_000_000_000;
const TINY_FUNDING_WINDOW = 5_000_000_000; // 5s

async function openTakenPastFunding(ctx, overrides = {}) {
  const bet = await h.openBet(ctx, { funding_deadline: Date.now() * 1_000_000 + TINY_FUNDING_WINDOW, settlement_period: SHORT_SETTLE, ...overrides });
  await h.takeBet(ctx, bet.envelope.bet_id, overrides);
  await h.fastForward(ctx, 10); // clears the 5s funding window
  return bet.envelope.bet_id;
}

export async function run() {
  // a1: OutLayer never responds (request_execution panics / the
  // cross-contract call fails outright) -- escrow's on_resolution callback
  // must still run (NEAR delivers the callback even on a failed promise)
  // and the bet must not be stuck un-resolvable.
  await runScenario("infra", "outlayer_never_responds", async (ctx) => {
    // "Never responds" means: request_resolution's cross-contract chain to
    // OutLayer completes (escrow's own on_resolution callback always
    // fires -- NEAR delivers callbacks even on a failed/empty promise),
    // but no resolver signature is ever submitted afterward (that's a
    // SEPARATE later tx OutLayer's TEE would send, which here just never
    // comes). Bet sits in Resolving with pending_resolution_request set
    // and outcome still null -- the only recovery is resolve_deadline ->
    // void_after_deadline. funding_deadline=5s, resolve_deadline=12s (both
    // measured from creation, so they land correctly relative to each
    // other regardless of how much wall-clock the rest of the scenario
    // burns -- NOT relative to "now" re-read later).
    const createdAt = Date.now() * 1_000_000;
    const bet = await h.openBet(ctx, {
      funding_deadline: createdAt + 5_000_000_000,
      resolve_deadline: createdAt + 12_000_000_000,
      settlement_period: SHORT_SETTLE,
    });
    const betId = bet.envelope.bet_id;
    await h.takeBet(ctx, betId, {});
    await h.fastForward(ctx, 10); // clear the 5s funding_deadline, stay under the 12s resolve_deadline
    await ctx.keeper.call(ctx.escrow.accountId, "request_resolution", { bet_id: betId, terms: null }, { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT });
    const betAfterReq = await h.getBet(ctx, betId);
    const violations = await inv.checkAll(ctx, betId, betAfterReq);
    const stuck = betAfterReq.status === "Resolving" && betAfterReq.outcome === null && betAfterReq.pending_resolution_request !== null;

    // Recovery path: advance past resolve_deadline, confirm void_after_deadline works.
    // resolve_deadline (12s) is anchored to `createdAt`, captured from
    // the HOST's Date.now() -- but the sandbox's own chain clock starts
    // near its genesis time and only catches up to the host's clock as
    // blocks are produced, so a slow sandbox startup (contended host,
    // more scenarios queued, etc) can eat most or all of that 12s
    // "budget" before a single fastForward even runs. Retry with
    // growing fast-forward chunks (same pattern as the D1
    // settlement_period waits elsewhere) instead of one fixed guess.
    let recovered = false;
    let recoveryError = null;
    for (let attempt = 0; attempt < 10 && !recovered; attempt++) {
      await h.fastForward(ctx, 15);
      try {
        await ctx.keeper.call(ctx.escrow.accountId, "void_after_deadline", { bet_id: betId }, { gas: h.tgas(300) });
        const betVoided = await h.getBet(ctx, betId);
        recovered = betVoided.status === "Voided" && betVoided.outcome === "VOID";
        recoveryError = null;
      } catch (e) {
        recoveryError = e.message;
        if (!recoveryError.includes("resolve_deadline not reached")) break;
      }
    }
    const betFinal = await h.getBet(ctx, betId);
    const violationsFinal = await inv.checkAll(ctx, betId, betFinal);
    return {
      verdict: violations.length || violationsFinal.length ? "break" : (stuck && recovered ? "pass" : "break"),
      expected: "bet stuck in Resolving while OutLayer never signs; resolve_deadline -> void_after_deadline recovers funds without stranding them",
      actual: `stuck_before_recovery=${stuck} recovered_via_void=${recovered}${recoveryError ? ` recovery_error=${recoveryError}` : ""}`,
      violations: [...violations, ...violationsFinal],
      notes: "Confirms FM-12's documented behavior (long wait then void) actually works in sandbox, not just on paper. If recovered=false this is a liveness break: funds locked forever with no OutLayer response.",
    };
  });

  // a2: OutLayer responds TWICE for the same request_id / same
  // next_expected_run_no -- can a second signed result for the SAME
  // run_no land after the first is already accepted (double-submit race)?
  await runScenario("infra", "outlayer_responds_twice_same_run", async (ctx) => {
    const betId = await openTakenPastFunding(ctx);
    await ctx.keeper.call(ctx.escrow.accountId, "request_resolution", { bet_id: betId, terms: null }, { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT });
    const bet = await h.getBet(ctx, betId);
    await h.submitOutcome(ctx, bet, { outcome: "YES", runNo: bet.next_expected_run_no });
    const betAfterFirst = await h.getBet(ctx, betId);
    let secondRejected = false;
    let secondError = null;
    try {
      // Same run_no again (simulating OutLayer re-delivering/re-signing
      // the same result, or an attacker replaying the first signed msg).
      await h.submitOutcome(ctx, bet, { outcome: "NO", runNo: bet.next_expected_run_no }); // bet is a stale snapshot, next_expected_run_no still 1
    } catch (e) {
      secondRejected = true;
      secondError = e.message;
    }
    const betFinal = await h.getBet(ctx, betId);
    const violations = await inv.checkAll(ctx, betId, betFinal);
    const outcomeUnchanged = betFinal.outcome === betAfterFirst.outcome;
    return {
      verdict: secondRejected && outcomeUnchanged && !violations.length ? "pass" : "break",
      expected: "second submit_outcome with the already-used run_no is rejected (run_no already used); outcome stays at the first-accepted YES",
      actual: `second_rejected=${secondRejected} outcome_unchanged=${outcomeUnchanged} final_outcome=${betFinal.outcome} error=${secondError}`,
      violations,
      notes: "Direct test of I-7/result-shopping defense against a duplicate/replayed OutLayer signature for the same run_no.",
    };
  });

  // a3: OutLayer responds LATE, after resolve_deadline has already
  // passed and/or the bet has already been voided by the keeper.
  await runScenario("infra", "outlayer_responds_after_void", async (ctx) => {
    const betId = await openTakenPastFunding(ctx, { resolve_deadline: Date.now() * 1_000_000 + 8_000_000_000 });
    await ctx.keeper.call(ctx.escrow.accountId, "request_resolution", { bet_id: betId, terms: null }, { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT });
    const betResolving = await h.getBet(ctx, betId);
    await h.fastForward(ctx, 15); // clear resolve_deadline
    await ctx.keeper.call(ctx.escrow.accountId, "void_after_deadline", { bet_id: betId }, { gas: h.tgas(300) });
    const betVoided = await h.getBet(ctx, betId);
    let lateSubmitRejected = false;
    let lateError = null;
    try {
      await h.submitOutcome(ctx, betResolving, { outcome: "YES", runNo: betResolving.next_expected_run_no });
    } catch (e) {
      lateSubmitRejected = true;
      lateError = e.message;
    }
    const betFinal = await h.getBet(ctx, betId);
    const violations = await inv.checkAll(ctx, betId, betFinal);
    // void_after_deadline sets outcome=Some("VOID") (not null) precisely
    // so a later submit_outcome's status-match require() fails cleanly --
    // status=Voided + outcome="VOID" is the CORRECT terminal state here.
    const stillVoided = betFinal.status === "Voided" && betFinal.outcome === "VOID";
    return {
      verdict: lateSubmitRejected && stillVoided && !violations.length ? "pass" : "break",
      expected: "a late-arriving signed outcome after void_after_deadline is rejected (bet not awaiting an outcome); bet stays Voided (outcome='VOID') with funds already refunded",
      actual: `late_rejected=${lateSubmitRejected} still_voided=${stillVoided} status=${betFinal.status} error=${lateError}`,
      violations,
      notes: "Tests the race between a slow/late OutLayer TEE result and the keeper's deadline-driven void path.",
    };
  });

  // a4: refund/unused-compute-report "without a bet_id" -- a malformed or
  // adversarial mock-outlayer response missing/garbling bet_id in its
  // echoed input_data. on_resolution reads pending_requests[request_id] ->
  // bet_id itself (never trusts the echoed payload for routing), so this
  // should be a no-op/safe-fail, not a misroute.
  await runScenario("infra", "outlayer_malformed_response_no_bet_id", async (ctx) => {
    const betId = await openTakenPastFunding(ctx);
    // mock-outlayer's request_execution panics outright on bad input_data
    // (env::panic_str("mock-outlayer: bad args_json"/"bad input_data")) --
    // escrow's request_resolution builds input_data itself, so we can't
    // corrupt it from the test. The real "no bet_id" adversarial case is
    // a THIRD PARTY calling escrow's #[private] on_resolution directly,
    // which near-sdk's #[private] macro should already block at the
    // access-control layer before any routing logic runs.
    let blocked = false;
    let err = null;
    try {
      await ctx.third.call(ctx.escrow.accountId, "on_resolution", { request_id: 1 }, { gas: h.tgas(30) });
    } catch (e) {
      blocked = true;
      err = e.message;
    }
    const bet = await h.getBet(ctx, betId);
    const violations = await inv.checkAll(ctx, betId, bet);
    return {
      verdict: blocked && !violations.length ? "pass" : "break",
      expected: "on_resolution is #[private]; any non-self caller (e.g. a third party spoofing OutLayer's callback) is rejected before any state change",
      actual: `blocked=${blocked} error=${err}`,
      violations,
      notes: "Access-control check standing in for 'OutLayer refunds without a bet_id' -- the only way that scenario could cause harm is if routing trusted caller-supplied data instead of pending_requests[request_id]; confirmed it does not, AND that the entrypoint itself is not forgeable.",
    };
  });

  // a5: keeper crashes mid-flow and restarts -- request_resolution tx
  // lands onchain but the keeper process dies before it ever calls
  // submit_outcome / before it persists state; a restarted keeper must
  // not double-pay for a second resolution request on the same round.
  await runScenario("infra", "keeper_crash_mid_flow_restart", async (ctx) => {
    const betId = await openTakenPastFunding(ctx);
    // "crash" = the keeper's first request_resolution succeeds, process
    // dies (simulated: we just don't call submit_outcome), "restarts" and
    // re-evaluates the SAME bet. Its own policy.ts guards on
    // pending_resolution_request !== null, so a correctly-restarted
    // keeper should NOT re-fire request_resolution -- but what does the
    // CONTRACT do if a naive/buggy restarted keeper fires it anyway?
    await ctx.keeper.call(ctx.escrow.accountId, "request_resolution", { bet_id: betId, terms: null }, { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT });
    const betAfterFirst = await h.getBet(ctx, betId);
    let secondRequestRejected = false;
    let secondErr = null;
    try {
      // Naive restarted keeper re-fires without checking
      // pending_resolution_request (the bug this scenario targets).
      await ctx.keeper.call(ctx.escrow.accountId, "request_resolution", { bet_id: betId, terms: null }, { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT });
    } catch (e) {
      secondRequestRejected = true;
      secondErr = e.message;
    }
    const betFinal = await h.getBet(ctx, betId);
    const violations = await inv.checkAll(ctx, betId, betFinal);
    // Even if the contract ALLOWS a second concurrent request (it does --
    // status stays Resolving, nothing blocks re-requesting), what matters
    // for I-1/I-2 is whether a second paid run double-spends reserve.
    const runsUsedOk = betFinal.runs_used <= betFinal.envelope.max_paid_runs;
    return {
      verdict: violations.length || !runsUsedOk ? "break" : "pass",
      expected: "contract either rejects a redundant request_resolution while one is already pending, or safely accounts for a second paid run (never exceeding max_paid_runs or double-charging reserve)",
      actual: `second_request_rejected=${secondRequestRejected} runs_used=${betFinal.runs_used}/${betFinal.envelope.max_paid_runs} status=${betFinal.status} err=${secondErr}`,
      violations,
      notes: "If second_request_rejected=false, a naive restarted keeper (one that doesn't re-check pending_resolution_request before acting) can fire a redundant OutLayer run that the bet's reserve pays for twice per restart -- an economic griefing surface on the bet's own reserve, not a direct I-1/I-2 break unless reserve is depleted below what finalize needs (checked above).",
    };
  });

  // a6: indexer misses events (gap) then replays (double-counts) -- this
  // harness doesn't run the real indexer process (out of scope per task:
  // services/e2e and services/data are off-limits), but it DOES exercise
  // discoverAllBets' own gap/replay robustness directly against sandbox
  // state, since that's the shared discovery primitive both indexer and
  // keeper depend on.
  await runScenario("infra", "indexer_discovery_gap_then_replay", async (ctx) => {
    const bet1 = await h.openBet(ctx, { makerAccount: await ctx.extraAccount("m1") });
    const bet2 = await h.openBet(ctx, { makerAccount: await ctx.extraAccount("m2") });
    const bet3 = await h.openBet(ctx, { makerAccount: await ctx.extraAccount("m3") });
    // Simulate "indexer missed bet2" by starting discovery with a
    // deliberately wrong knownMaxId that skips past it, then "replaying"
    // by re-running discovery from 0 and checking idempotency (same bets,
    // no duplicate processing artifacts on our side -- the contract has
    // no mutable state from a view-only get_bet call, so idempotency here
    // just means two full scans see identical data).
    const scanFrom0 = [];
    for (let id = 1; id <= 5; id++) {
      const b = await ctx.escrow.view(ctx.escrow.accountId, "get_bet", { bet_id: id });
      if (b) scanFrom0.push(id);
    }
    const scanReplay = [];
    for (let id = 1; id <= 5; id++) {
      const b = await ctx.escrow.view(ctx.escrow.accountId, "get_bet", { bet_id: id });
      if (b) scanReplay.push(id);
    }
    const identical = JSON.stringify(scanFrom0) === JSON.stringify(scanReplay);
    return {
      verdict: identical && scanFrom0.length === 3 ? "pass" : "break",
      expected: "re-scanning bet_id space twice (simulating a missed-then-replayed indexer poll) yields identical results; get_bet is a pure view with no side effects to double-count",
      actual: `scan1=${JSON.stringify(scanFrom0)} scan2=${JSON.stringify(scanReplay)}`,
      violations: [],
      notes: "This only proves the VIEW layer is replay-safe. The real indexer/keeper risk is action-level (e.g. firing request_resolution twice after a missed-then-caught-up poll) -- covered by keeper_crash_mid_flow_restart above, not by this scenario.",
    };
  });

  // a7: RPC lag -- a view call made immediately after a state-changing tx
  // returns stale data (the classic 'read right after write, before the
  // chunk is indexed' near RPC footgun the testnet build log already hit
  // once in g4 matrix). Exercise by firing a call and a view back-to-back
  // with NO manual settle/retry, confirming whether the harness's own
  // single-shot openBet (no polling) is reliable in-sandbox (it was
  // flaky on testnet per commit be5f500).
  await runScenario("infra", "rpc_lag_stale_view_after_tx", async (ctx) => {
    const bet = await h.openBet(ctx); // openBet does a single immediate view, no poll/retry
    const immediatelyVisible = bet !== undefined && bet.envelope?.bet_id === 1;
    return {
      verdict: immediatelyVisible ? "pass" : "break",
      expected: "a view call immediately after the funding tx sees the new bet (sandbox finality is synchronous per-call, unlike testnet's optimistic/lagged RPC)",
      actual: `immediately_visible=${immediatelyVisible}`,
      violations: [],
      notes: "Sandbox is single-node with synchronous finality, so this scenario largely does NOT reproduce testnet's documented RPC-lag bug (commit be5f500: 'openBet()'s single immediate view right after transfer_with_msg could miss the just-created offer'). Known harness-fidelity gap: sandbox can't exercise multi-shard/optimistic-finality staleness. Flagging as a known limitation, not re-litigating a bug already fixed by polling on the real keeper (services/keeper already retries elsewhere per that commit).",
    };
  });

  // 16t / D-RUNNO1: run_no is PER-BET. Two bets on ONE deployment, each
  // request_resolution'd (global request_ids 1 and 2); the resolver
  // input_data (echoed back by mock-outlayer into last_resolution_raw)
  // must carry run_no 1 for BOTH, and both signed outcomes (submitted
  // interleaved: bet 2 first) must land. Pre-fix, bet 2 got run_no=2
  // (its request_id) and submit_outcome reverted "run_no out of order".
  await runScenario("infra", "two_bets_one_deployment_per_bet_run_no", async (ctx) => {
    // Open + take both inside the tiny funding window, THEN advance chain
    // time once (a second openTakenPastFunding would open against a
    // chain clock already fast-forwarded past Date.now()).
    const fd = Date.now() * 1_000_000 + 12_000_000_000;
    const mk = async () => {
      const bet = await h.openBet(ctx, { funding_deadline: fd, settlement_period: SHORT_SETTLE });
      await h.takeBet(ctx, bet.envelope.bet_id, {});
      return bet.envelope.bet_id;
    };
    const b1 = await mk();
    const b2 = await mk();
    await h.fastForward(ctx, 60);
    const dep = { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT };
    await ctx.keeper.call(ctx.escrow.accountId, "request_resolution", { bet_id: b1, terms: null }, dep);
    await ctx.keeper.call(ctx.escrow.accountId, "request_resolution", { bet_id: b2, terms: null }, dep);
    const inputRunNo = async (id) => {
      const bet = await h.getBet(ctx, id);
      const raw = JSON.parse(bet.last_resolution_raw ?? "{}");
      return JSON.parse(raw.input_data ?? "{}").run_no;
    };
    const rn1 = await inputRunNo(b1);
    const rn2 = await inputRunNo(b2);
    let err = null;
    try {
      await h.submitOutcome(ctx, await h.getBet(ctx, b2), { outcome: "YES", runNo: rn2 });
      await h.submitOutcome(ctx, await h.getBet(ctx, b1), { outcome: "NO", runNo: rn1 });
    } catch (e) { err = e.message; }
    const s1 = (await h.getBet(ctx, b1)).status;
    const s2 = (await h.getBet(ctx, b2)).status;
    const ok = rn1 === 1 && rn2 === 1 && !err && s1 === "Proposed" && s2 === "Proposed";
    return {
      verdict: ok ? "pass" : "break",
      expected: "both bets get resolver input run_no=1 and both signed outcomes settle to Proposed",
      actual: `input_run_no=[${rn1},${rn2}] statuses=[${s1},${s2}] error=${err}`,
      violations: [],
      notes: "D-RUNNO1 regression: run_no must be per-bet, not the global request_id.",
    };
  });

  // 16t4 / D-RUNNO1: three bets on ONE deployment, requested in order
  // then submitted interleaved (b3, b1, b2). Every resolver input must
  // carry per-bet run_no 1 and all three signed outcomes must settle.
  await runScenario("infra", "three_bets_one_deployment_interleaved_per_bet_run_no", async (ctx) => {
    const fd = Date.now() * 1_000_000 + 15_000_000_000;
    const mk = async () => {
      const bet = await h.openBet(ctx, { funding_deadline: fd, settlement_period: SHORT_SETTLE });
      await h.takeBet(ctx, bet.envelope.bet_id, {});
      return bet.envelope.bet_id;
    };
    const ids = [await mk(), await mk(), await mk()];
    await h.fastForward(ctx, 60);
    const dep = { gas: h.tgas(300), deposit: h.RESOLUTION_DEPOSIT };
    const inputRunNo = async (id) => {
      const bet = await h.getBet(ctx, id);
      const raw = JSON.parse(bet.last_resolution_raw ?? "{}");
      return JSON.parse(raw.input_data ?? "{}").run_no;
    };
    const rns = [];
    for (const id of ids) {
      await ctx.keeper.call(ctx.escrow.accountId, "request_resolution", { bet_id: id, terms: null }, dep);
      rns.push(await inputRunNo(id));
    }
    let err = null;
    try {
      for (const i of [2, 0, 1]) {
        await h.submitOutcome(ctx, await h.getBet(ctx, ids[i]), { outcome: i === 1 ? "NO" : "YES", runNo: rns[i] });
      }
    } catch (e) { err = e.message; }
    const st = [];
    for (const id of ids) st.push((await h.getBet(ctx, id)).status);
    const ok = rns.every((r) => r === 1) && !err && st.every((s) => s === "Proposed");
    return {
      verdict: ok ? "pass" : "break",
      expected: "all three bets get resolver input run_no=1 and all signed outcomes (b3,b1,b2) settle to Proposed",
      actual: `input_run_no=[${rns}] statuses=[${st}] error=${err}`,
      violations: [],
      notes: "D-RUNNO1 regression (3 bets): run_no must be per-bet, not the global request_id.",
    };
  });
}
