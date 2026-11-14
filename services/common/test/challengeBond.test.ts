import { test } from "node:test";
import assert from "node:assert/strict";
import { requiredChallengeBond } from "../src/challengeBond.js";

// D-AUDIT8: the required challenge bond must include run_price on top
// of the pre-existing max(min_bond, 5% pot) minimum -- this is what
// contracts/escrow/src/lib.rs's handle_bond/required_challenge_bond
// now enforce; this mirrors it for the keeper/UI amount quote.
//
// D-ECON5: run_price moved off Envelope onto each asset's own
// AssetLimit, so requiredChallengeBond takes it as its own parameter
// instead of a field on the envelope object.
//
// D-BOND1 (cross-asset-4): requiredChallengeBond now also takes
// isMaker + sameAsset -- a same-asset bet still uses the real shared
// pot (stake_maker + stake_taker); a cross-asset bet uses 2x the
// challenger's own stake instead (Envelope::pot_for_challenger on the
// Rust side), and challengerMinBond is that CHALLENGER's own asset's
// min_bond floor, not a hardcoded USDC $5.
//
// D-DISPUTE1 (queue item 6): the threshold is now 10% of pot (was
// 5%), and the whole max(min_bond, 10% pot) term DOUBLES per
// challenge round (2^(round-1)) -- run_price is never doubled.
// `requiredChallengeBond` now takes `round` (1-indexed) as a required
// final argument; every pre-existing call site/test below is rewritten
// (not deleted) to pass it and to recompute its expected amount from
// the new 10%-doubling rule, with the arithmetic spelled out in each
// comment.

test("same-asset, round 1, at the floor (small pot): floor + run_price", () => {
  const env = { stake_maker: "1000000", stake_taker: "1000000" };
  // pot=2_000_000, 10%=200_000 < floor 5_000_000 -> floor applies.
  // round 1: floor * 2^0 = 5_000_000, + run_price 5_000 = 5_005_000.
  assert.equal(requiredChallengeBond(env, true, true, "5000000", "5000", 1), 5_005_000n);
});

test("same-asset, round 2, at the floor (small pot): floor DOUBLED + run_price", () => {
  const env = { stake_maker: "1000000", stake_taker: "1000000" };
  // Same floor-dominated pot as round 1 above, but round 2 doubles the
  // WHOLE max(...): floor * 2^1 = 10_000_000, + run_price 5_000 = 10_005_000.
  assert.equal(requiredChallengeBond(env, true, true, "5000000", "5000", 2), 10_005_000n);
});

test("same-asset, round 1, above the floor (large pot): 10% of pot + run_price", () => {
  const env = { stake_maker: "500000000", stake_taker: "500000000" };
  // pot=1_000_000_000, 10%=100_000_000 > floor -> 10% applies.
  // round 1: 100_000_000 * 2^0 + 5_000 = 100_005_000.
  assert.equal(requiredChallengeBond(env, true, true, "5000000", "5000", 1), 100_005_000n);
});

test("same-asset, round 2, above the floor (large pot): 10% of pot DOUBLED + run_price", () => {
  const env = { stake_maker: "500000000", stake_taker: "500000000" };
  // Same pot as above; round 2 doubles the 10%-of-pot term:
  // 100_000_000 * 2^1 + 5_000 = 200_005_000.
  assert.equal(requiredChallengeBond(env, true, true, "5000000", "5000", 2), 200_005_000n);
});

test("same-asset, zero run_price still adds nothing extra (edge case, never used in practice)", () => {
  const env = { stake_maker: "1000000", stake_taker: "1000000" };
  assert.equal(requiredChallengeBond(env, true, true, "5000000", "0", 1), 5_000_000n);
});

test("cross-asset, round 1, maker challenges: pot is 2x the maker's own stake", () => {
  const env = { stake_maker: "10000", stake_taker: "10000000" };
  // pot_for_challenger(maker) = 2*10_000 = 20_000; 10% = 2_000 < BTC
  // min_bond floor (6_501) -> floor applies. Round 1: 6_501 + 1 = 6_502.
  assert.equal(requiredChallengeBond(env, true, false, "6501", "1", 1), 6_502n);
});

test("cross-asset, round 2, maker challenges: floor DOUBLED, same BTC run_price", () => {
  const env = { stake_maker: "10000", stake_taker: "10000000" };
  // Round 2 doubles the floor: 6_501 * 2 + 1 = 13_003.
  assert.equal(requiredChallengeBond(env, true, false, "6501", "1", 2), 13_003n);
});

test("cross-asset, round 1, taker challenges: pot is 2x the taker's own stake, never the maker's", () => {
  const env = { stake_maker: "10000", stake_taker: "10000000" };
  // pot_for_challenger(taker) = 2*10_000_000 = 20_000_000; 10% =
  // 2_000_000 < USDC min_bond floor (5_000_000) -> floor applies.
  // Round 1: 5_000_000 + 5_000 = 5_005_000.
  assert.equal(requiredChallengeBond(env, false, false, "5000000", "5000", 1), 5_005_000n);
});

test("cross-asset, round 2, taker challenges: floor DOUBLED, same USDC run_price", () => {
  const env = { stake_maker: "10000", stake_taker: "10000000" };
  // Round 2: 5_000_000 * 2 + 5_000 = 10_005_000.
  assert.equal(requiredChallengeBond(env, false, false, "5000000", "5000", 2), 10_005_000n);
});
