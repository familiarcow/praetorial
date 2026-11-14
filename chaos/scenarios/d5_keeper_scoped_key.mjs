// D5 feasibility proof (Decision register D-AUDIT5 follow-up, 2026-11-02):
// `request_resolution` is `#[payable]` (it fronts OutLayer's compute
// cost) but a NEAR function-call access key can never attach a
// deposit -- a protocol-level restriction, not a contract choice. This
// scenario proves the prepaid `keeper_credit` mechanism (D5) lets a
// keeper holding ONLY a function-call key scoped to the escrow contract
// run a full bet lifecycle with zero attached deposit, and that the
// SAME key is incapable of transferring native NEAR or calling any
// other contract -- i.e. a stolen/leaked scoped key cannot drain the
// keeper account or be repurposed against anything else.
import * as h from "./../harness.mjs";
import * as inv from "./../invariants.mjs";
import { runScenario } from "./../runner.mjs";
import { connect, keyStores, KeyPair, utils } from "near-api-js";

export async function run() {
  await runScenario("d5", "keeper_function_call_key_full_lifecycle", async (ctx) => {
    // Fund the prepaid compute pool using the keeper's EXISTING
    // full-access key (topup_keeper_credit requires an attached
    // deposit, so it can only ever be called this way or by
    // fee_account -- never by the scoped key itself).
    await ctx.keeper.call(
      ctx.escrow.accountId,
      "topup_keeper_credit",
      {},
      { gas: h.tgas(30), deposit: BigInt(utils.format.parseNearAmount("1")) },
    );

    // Mint a brand-new function-call access key, scoped to the escrow
    // contract only (no method_names restriction -- null means "any
    // method on this receiver", still never any OTHER receiver and
    // never a non-FunctionCall action), and add it to the keeper
    // account alongside its existing full-access key.
    const scopedKp = KeyPair.fromRandom("ed25519");
    await ctx.keeper.inner.addKey(
      scopedKp.getPublicKey(),
      ctx.escrow.accountId,
      null,
      utils.format.parseNearAmount("2"),
    );

    // Drive a SEPARATE near-api-js connection that only ever knows this
    // scoped key for the keeper account, so every call below is
    // necessarily signed by it (not the keeper's full-access key).
    const rpcUrl = ctx.near.connection.provider.connection.url;
    const scopedStore = new keyStores.InMemoryKeyStore();
    await scopedStore.setKey("sandbox", ctx.keeper.accountId, scopedKp);
    const scopedNear = await connect({ networkId: "sandbox", nodeUrl: rpcUrl, keyStore: scopedStore, headers: {} });
    const scopedInner = await scopedNear.account(ctx.keeper.accountId);

    // --- Full bet lifecycle, resolution step driven by the scoped key ---
    const createdAt = Date.now() * 1_000_000;
    // D1 (already landed): settlement_period must be >= 1h on-chain --
    // use the documented floor exactly, not a test-scaled short value.
    const bet = await h.openBet(ctx, {
      funding_deadline: createdAt + 5_000_000_000,
      settlement_period: 3600 * 1_000_000_000,
    });
    const betId = bet.envelope.bet_id;
    await h.takeBet(ctx, betId);
    await h.fastForward(ctx, 10); // clear funding_deadline

    const creditBefore = BigInt(await ctx.escrow.view(ctx.escrow.accountId, "keeper_credit_balance", {}));

    // Zero attached deposit -- the ONLY shape a function-call key can
    // ever submit; the contract draws compute cost from keeper_credit.
    await scopedInner.functionCall({
      contractId: ctx.escrow.accountId,
      methodName: "request_resolution",
      args: { bet_id: betId, terms: null },
      gas: 300_000_000_000_000n,
      attachedDeposit: 0n,
    });

    const betResolving = await h.getBet(ctx, betId);
    const creditAfter = BigInt(await ctx.escrow.view(ctx.escrow.accountId, "keeper_credit_balance", {}));

    await h.submitOutcome(ctx, betResolving, { outcome: "YES" });
    // D1's 1h settlement_period floor means we need to fast-forward a lot
    // of wall-clock-equivalent time; sandbox block duration isn't fixed
    // here, so retry with growing chunks instead of guessing one count.
    // item 6b: one fastForwardPast(1h) jump instead of looping small
    // fixed-size fastForward calls (which blew the per-scenario timeout).
    await h.fastForwardPast(ctx, 3600n * 1_000_000_000n, () =>
      ctx.keeper.call(ctx.escrow.accountId, "finalize", { bet_id: betId }, { gas: h.tgas(300) }),
    );
    // OQ-T11: finalize only persists the ledger now (status Finalized);
    // drain_payouts is what actually fires transfers and settles it.
    // fastForwardPast throws if finalize never succeeds, so reaching
    // here means it did.
    await h.drainUntilSettled(ctx, betId);
    const betFinal = await h.getBet(ctx, betId);

    // --- Same key: cannot transfer native NEAR ---
    let transferRejected = false;
    let transferErr = null;
    try {
      await scopedInner.sendMoney(ctx.third.accountId, BigInt(utils.format.parseNearAmount("1")));
    } catch (e) {
      transferRejected = true;
      transferErr = e?.message ?? String(e);
    }

    // --- Same key: cannot call any OTHER contract (receiver mismatch) ---
    let otherContractRejected = false;
    let otherErr = null;
    try {
      await scopedInner.functionCall({
        contractId: ctx.outlayer.accountId,
        methodName: "request_execution",
        args: {},
        gas: 30_000_000_000_000n,
        attachedDeposit: 0n,
      });
    } catch (e) {
      otherContractRejected = true;
      otherErr = e?.message ?? String(e);
    }

    const violations = await inv.checkAll(ctx, betId, betFinal);
    const pass =
      betResolving.status === "Resolving" &&
      betFinal.status === "Settled" &&
      creditBefore > creditAfter &&
      transferRejected &&
      otherContractRejected &&
      !violations.length;

    return {
      verdict: pass ? "pass" : "break",
      expected:
        "a keeper account holding ONLY a function-call key scoped to escrow completes open->take->request_resolution (zero deposit, drawn from keeper_credit)->submit_outcome->finalize; the same key rejects a native Transfer and rejects a call to any other contract",
      actual: `resolving_status=${betResolving.status} final_status=${betFinal.status} credit_drawn=${creditBefore - creditAfter} transfer_rejected=${transferRejected} (${transferErr}) other_contract_rejected=${otherContractRejected} (${otherErr})`,
      violations,
      notes:
        "D5 feasibility: confirmed needed (request_resolution is payable; FunctionCall-permission keys cannot attach a deposit, by NEAR protocol validation, independent of method). Both negative checks (transfer, other-contract) are rejected by nearcore's access-key validation before any receipt is even created, proven against the real sandboxed node, not mocked.",
    };
  }, { timeoutMs: 300_000 }); // item 6b: fastForwardPast(1h) jump needs more than the 120s default
}
