// DR8 offline unit test (written BEFORE the live run): challenge-bond handling per D-ECON5/D-BOND1/D-AUDIT8/D-DISPUTE1 for both endings
// ("round 1 stands" and "flips"), the bond quote formula, per-party money, and the challenger = losing side rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedChallenge, quoteBond, loserOf, bondProblems, REQUIRED_METHODS, FORBIDDEN_METHODS, methodProblems } from "../expected.js";
import { paidTo, loadFeeConfig } from "../../DR1/expected.js";
import { sideFee } from "../../harness/money.js";

const cfg = loadFeeConfig();
const NEAR1 = 10n ** 24n, STAKE = 3n * NEAR1, RUN = 40_000_000_000_000_000_000_000n /* 0.04 NEAR, illustrative */, MINBOND = NEAR1 / 2n;
const bet = (side: "YES" | "NO") => ({
  envelope: { maker: "m", stake_maker: STAKE.toString(), stake_taker: STAKE.toString(), fee_bps: Number(cfg.feeBps), maker_side: side, maker_asset: "w", taker_asset: "w", keep_terms: false },
  status: "Taken", taker: "t", fee_min_maker: cfg.minFeePerSide.toString(), fee_min_taker: cfg.minFeePerSide.toString(), storage_maker: "1234", storage_taker: "5678",
});

test("bond quote = max(min_bond, 10% of pot) * 2^(round-1) + run_price (contract required_challenge_bond)", () => {
  assert.equal(quoteBond({ pot: 2n * STAKE, minBond: MINBOND, runPrice: RUN, round: 1 }), 6n * NEAR1 / 10n + RUN); // 10% of 6 NEAR = 0.6 > min 0.5
  assert.equal(quoteBond({ pot: 2n * STAKE, minBond: MINBOND, runPrice: RUN, round: 2 }), 12n * NEAR1 / 10n + RUN);
  assert.equal(quoteBond({ pot: 2n * NEAR1 / 10n, minBond: MINBOND, runPrice: RUN, round: 1 }), MINBOND + RUN); // min floor applies
});

test("the challenger is the LOSING side of round 1", () => {
  assert.equal(loserOf(bet("YES"), "YES"), "taker");
  assert.equal(loserOf(bet("YES"), "NO"), "maker");
  assert.equal(loserOf(bet("NO"), "YES"), "maker");
});

for (const side of ["YES", "NO"] as const) for (const r1 of ["YES", "NO"] as const) {
  const b = bet(side), B = quoteBond({ pot: 2n * STAKE, minBond: MINBOND, runPrice: RUN, round: 1 }), f = sideFee(STAKE, cfg.feeBps, cfg.minFeePerSide);
  const chal = loserOf(b, r1), other = chal === "maker" ? "taker" : "maker";
  const flipOutcome = r1 === "YES" ? "NO" : "YES";

  test(`maker ${side}, round 1 ${r1}, ROUND 1 STANDS: challenger (${chal}) loses bond: counterparty gets stakes - fees + (bond - run_price), keeper gets run_price, challenger 0`, () => {
    const e = expectedChallenge(b, { round1: r1, final: r1, bond: B, runPrice: RUN });
    assert.equal(e.challenger, chal);
    assert.equal(e.bondResult, "lost");
    assert.equal(e.credits[other], 2n * STAKE - 2n * f + (B - RUN));
    assert.equal(e.credits[chal], 0n);
    assert.equal(e.credits.keeper, RUN);
    assert.equal(e.credits.fee, 2n * f + 1234n + 5678n);
    assert.equal(e.credits.maker + e.credits.taker + e.credits.fee + e.credits.keeper, 2n * STAKE + 1234n + 5678n + B); // escrow drains incl. bond
    assert.equal(e.netChange[chal], -STAKE - B);   // challenger: lost stake and bond
  });

  test(`maker ${side}, round 1 ${r1}, FLIPS: challenger (${chal}) is now the winner and gets the bond back minus run_price; keeper gets run_price; former winner 0`, () => {
    const e = expectedChallenge(b, { round1: r1, final: flipOutcome, bond: B, runPrice: RUN });
    assert.equal(e.bondResult, "won");
    assert.equal(e.credits[chal], 2n * STAKE - 2n * f + (B - RUN));
    assert.equal(e.credits[other], 0n);
    assert.equal(e.credits.keeper, RUN);
    assert.equal(e.credits.maker + e.credits.taker + e.credits.fee + e.credits.keeper, 2n * STAKE + 1234n + 5678n + B);
    assert.equal(e.netChange[chal], STAKE - 2n * f - RUN); // wins the other side's stake net of fees, pays only the run price
    assert.equal(paidTo(e.settlement, chal), 2n * STAKE - 2n * f);
  });
}

test("bondProblems: the bond paid must equal the quoted required_challenge_bond exactly", () => {
  assert.deepEqual(bondProblems({ quoted: 5n, paid: 5n }), []);
  assert.equal(bondProblems({ quoted: 5n, paid: 4n }).length, 1);
  assert.equal(bondProblems({ quoted: 5n, paid: 6n }).length, 1);
});

test("method guard: request_resolution x2, submit_outcome x2, challenge (via bond transfer, web S13), finalize; no concede/referee/void", () => {
  assert.ok(REQUIRED_METHODS.includes("finalize"));
  assert.deepEqual(methodProblems(["request_resolution", "submit_outcome", "mt_on_transfer", "request_resolution", "submit_outcome", "finalize"]), []);
  assert.ok(methodProblems(["request_resolution", "submit_outcome", "finalize"]).some((p) => /round|bond|challenge/.test(p)));
  assert.ok(methodProblems(["request_resolution", "submit_outcome", "request_resolution", "submit_outcome", "finalize", "concede"]).some((p) => /forbidden concede/.test(p)));
  assert.ok(FORBIDDEN_METHODS.includes("void_after_deadline"));
});
