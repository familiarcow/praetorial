// DR5 offline unit test (written BEFORE the live run): Human-mode bet, the named referee rules YES.
// Expected money per party from a get_bet-shaped record + side_fee (harness money.ts), tip handling (only where ticked),
// the "no challenge button" selector contract, forbidden-method guard (no AI path) and the verifier SKIP set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedRefereeYes, paidTo, forbiddenCalls, verifierSummary, ALLOWED_SKIPS, REQUIRED_METHODS, loadFeeConfig } from "../expected.js";
import { sideFee } from "../../harness/money.js";

const cfg = loadFeeConfig();
const bet = (stake: string, over: Record<string, unknown> = {}) => ({
  envelope: { maker: "m", stake_maker: stake, stake_taker: stake, fee_bps: Number(cfg.feeBps), maker_side: "YES", maker_asset: "u", taker_asset: "u", referee: { account: "r", mode: "Human" }, tip_maker: true },
  status: "Taken", taker: "t", fee_min_maker: cfg.minFeePerSide.toString(), fee_min_taker: cfg.minFeePerSide.toString(), storage_maker: "1234", storage_taker: "1234", tip_maker: "0", tip_taker: "0", ...over,
});

test("YES, maker tipped, taker did not: maker gets both stakes minus both side fees minus the tip; referee gets exactly the maker's side_fee; fee account fees + storage; taker 0; drains", () => {
  for (const stake of [10_000_000n, 50_000_000n]) {
    const f = sideFee(stake, cfg.feeBps, cfg.minFeePerSide);
    const s = expectedRefereeYes(bet(stake.toString()), { tipMaker: true, tipTaker: false });
    assert.equal(paidTo(s, "maker"), 2n * stake - 2n * f - f);
    assert.equal(paidTo(s, "referee"), f);
    assert.equal(paidTo(s, "fee"), 2n * f + 2468n);
    assert.equal(paidTo(s, "taker"), 0n);
    assert.equal(paidTo(s, "maker") + paidTo(s, "referee") + paidTo(s, "fee"), s.deposits.maker + s.deposits.taker);
  }
});

test("tip only if ticked: no tick -> referee gets 0 and the maker keeps that amount; taker tick adds the taker's side_fee", () => {
  const b = bet("10000000"); const f = sideFee(10_000_000n, cfg.feeBps, cfg.minFeePerSide);
  const none = expectedRefereeYes(b, { tipMaker: false, tipTaker: false });
  assert.equal(paidTo(none, "referee"), 0n); assert.equal(paidTo(none, "maker"), 20_000_000n - 2n * f);
  const both = expectedRefereeYes(b, { tipMaker: true, tipTaker: true });
  assert.equal(paidTo(both, "referee"), 2n * f); assert.equal(paidTo(both, "maker"), 20_000_000n - 4n * f);
});

test("maker_side NO: a YES ruling pays the TAKER (the ruling outcome is compared with maker_side)", () => {
  const s = expectedRefereeYes(bet("10000000", { envelope: { ...bet("10000000").envelope, maker_side: "NO" } }), { tipMaker: false, tipTaker: false });
  assert.equal(paidTo(s, "maker"), 0n); assert.ok(paidTo(s, "taker") > 0n);
});

test("tx guard: AI-path methods (submit_outcome, request_resolution, challenge, finalize, concede) are flagged; referee_rule is required, not forbidden", () => {
  assert.deepEqual(forbiddenCalls(["mt_on_transfer", "referee_rule", "drain_payouts"]), []);
  assert.deepEqual(forbiddenCalls(["referee_rule", "request_resolution", "submit_outcome", "concede"]), ["request_resolution", "submit_outcome", "concede"]);
  assert.ok(REQUIRED_METHODS.includes("referee_rule"));
});

test("verifier SKIP set is B3 and B5 only", () => {
  assert.deepEqual([...ALLOWED_SKIPS], ["B3", "B5"]);
  const ok = verifierSummary("PASS E2 x\nSKIP B3 none\nSKIP B5 none\n# 8 PASS, 0 FAIL, 2 SKIP\n");
  assert.deepEqual(ok.unexpectedSkips, []); assert.equal(ok.fail, 0);
  assert.deepEqual(verifierSummary("SKIP B2 x\nSKIP B3 y\n# 7 PASS, 0 FAIL, 2 SKIP\n").unexpectedSkips, ["B2"]);
  assert.throws(() => verifierSummary("garbage"));
});

// ---- RESUME path (DR5_PHASE=rule): bet already Taken, only the ruling is driven; helpers are pure so they are tested offline first.
import { escrowBaseline, functionCallGas } from "../expected.js";

test("resume: escrow baseline = balance minus this bet's two stakes and two storage deposits (so residue is measured for this bet only)", () => {
  const b = bet("3000000000000000000000000", { storage_maker: "17160000000000000000000", storage_taker: "17160000000000000000000" });
  assert.equal(escrowBaseline(b, 6_034_320_000_000_000_000_000_000n), 0n);
  assert.equal(escrowBaseline(b, 7_034_320_000_000_000_000_000_000n), 1_000_000_000_000_000_000_000_000n);
});

test("resume: functionCallGas finds the gas of the named method in a tx status (EXPERIMENTAL_tx_status shape) and null when absent", () => {
  const st = { transaction: { actions: [{ Delegate: { delegate_action: { actions: [{ FunctionCall: { method_name: "referee_rule", gas: 300000000000000 } }] } } }] } };
  assert.equal(functionCallGas(st, "referee_rule"), 300_000_000_000_000n);
  assert.equal(functionCallGas(st, "concede"), null);
});
