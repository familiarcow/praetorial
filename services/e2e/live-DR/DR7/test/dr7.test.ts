// DR7 offline unit test (written BEFORE the live run): expected money per party for a silent-referee deadline refund (void_after_deadline),
// the tx-list guard and the verifier SKIP set (D-DR1c).
import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedDeadlineRefund, paidTo, forbiddenCalls, verifierSummary, ALLOWED_SKIPS, loadFeeConfig } from "../expected.js";

const cfg = loadFeeConfig();
const bet = (stake: string, over: Record<string, unknown> = {}) => ({
  envelope: { maker: "m", stake_maker: stake, stake_taker: stake, fee_bps: Number(cfg.feeBps), maker_side: "YES", maker_asset: "u", taker_asset: "u", keep_terms: false },
  status: "Taken", taker: "t", fee_min_maker: cfg.minFeePerSide.toString(), fee_min_taker: cfg.minFeePerSide.toString(), storage_maker: "1234", storage_taker: "1234", ...over,
});

test("deadline refund without tips: each side gets stake + its own storage back; fee account and referee get nothing; escrow drains", () => {
  for (const stake of [3_000_000_000_000_000_000_000_000n, 10_000_000n]) {
    const s = expectedDeadlineRefund(bet(stake.toString()));
    assert.equal(paidTo(s, "maker"), stake + 1234n);
    assert.equal(paidTo(s, "taker"), stake + 1234n);
    assert.equal(paidTo(s, "fee"), 0n);
    assert.equal(paidTo(s, "referee"), 0n);
    assert.equal(paidTo(s, "maker") + paidTo(s, "taker"), s.deposits.maker + s.deposits.taker);
  }
});

test("no protocol fee is taken on a deadline refund (differs from a decisive ending)", () => {
  const s = expectedDeadlineRefund(bet("10000000"));
  assert.ok(s.lines.every((l) => l.reason.startsWith("void_deadline") || l.reason.startsWith("void_storage_refund")));
});

test("a silent referee still earns an opted-in tip, taken out of that side's refund (pay_tips in void_after_deadline)", () => {
  const stake = 10_000_000n;
  const s = expectedDeadlineRefund(bet(stake.toString()), { tipMaker: true, tipTaker: false });
  const tip = paidTo(s, "referee");
  assert.ok(tip > 0n);
  assert.equal(paidTo(s, "maker"), stake - tip + 1234n);
  assert.equal(paidTo(s, "taker"), stake + 1234n);
});

test("keep_terms sends the storage charges to the fee account instead of refunding them", () => {
  const s = expectedDeadlineRefund(bet("10000000", { envelope: { ...bet("10000000").envelope, keep_terms: true } }));
  assert.equal(paidTo(s, "fee"), 2468n); assert.equal(paidTo(s, "maker"), 10_000_000n);
});

test("tx list guard: any ruling/resolution method is flagged; take/open/void_after_deadline/drain are not", () => {
  assert.deepEqual(forbiddenCalls(["mt_on_transfer", "void_after_deadline", "drain_payouts"]), []);
  assert.deepEqual(forbiddenCalls(["void_after_deadline", "referee_rule", "request_resolution", "submit_outcome"]), ["referee_rule", "request_resolution", "submit_outcome"]);
});

test("verifier SKIP set is B3,B4,B5,B6 (+E4 offline); any other SKIP or any FAIL is unexpected", () => {
  assert.deepEqual([...ALLOWED_SKIPS], ["B3", "B4", "B5", "B6"]);
  const ok = verifierSummary("PASS A1 x\nSKIP B3 not available\nSKIP B4 no submitted results\nSKIP B5 n\nSKIP B6 n\nSKIP E4 offline\n# 6 PASS, 0 FAIL, 5 SKIP");
  assert.deepEqual(ok.unexpectedSkips, []); assert.equal(ok.fail, 0);
  assert.deepEqual(verifierSummary("SKIP C1 y\nSKIP B3 z\n# 5 PASS, 0 FAIL, 2 SKIP").unexpectedSkips, ["C1"]);
  assert.throws(() => verifierSummary("garbage"));
});

test("harness config is single-sourced from apps/web/lib/network.ts and names the frozen escrow", async () => {
  const { ESCROW, STAKE_TOKEN } = await import("../chain.js");
  const { loadWebTestnetConfig } = await import("../webConfig.js");
  const WEB = await loadWebTestnetConfig();
  assert.equal(ESCROW, WEB.escrow);
  // MISS1 (same move as DR6's 84f23c84): the web now targets frz3 (NOKEY1b). Bet 16 itself lives on frz2 (README); the
  // single-sourcing assertion above is unchanged, only the frozen escrow it resolves to moved.
  assert.equal(ESCROW, "praetorial-frz3-2611100414.praetorial-dev-1101.testnet");
  assert.equal(STAKE_TOKEN, "nep141:wrap.testnet");
});
