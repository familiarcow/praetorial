// BET1b (UX-33 section 3): the Stake section's pure helpers -- token choices, "You put in" / "They put in" (even by default),
// odds derived from the two amounts, the one-line "Min . fee" summary in token units (never "$"), old-draft migration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STAKE_SYMBOLS, stakeAssets, theirStakeText, oddsFor, ratioProblem, stakeLine, stakeFromDraft, DEFAULT_STAKE_SYMBOL } from "../lib/stakeSection";
import { limitsFor } from "../lib/stakeDeadlines";

test("the six launch tokens, in the UX-33 order", () => {
  assert.deepEqual(STAKE_SYMBOLS, ["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"]);
  assert.deepEqual(stakeAssets("mainnet").map((a) => a.symbol), ["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"]);
  // testnet has no ids for USDT/BTC/ETH/ZEC: they are not offered there (never a guessed id)
  assert.deepEqual(stakeAssets("testnet").map((a) => a.symbol), ["USDC", "NEAR"]);
  for (const a of stakeAssets("mainnet")) assert.ok(a.assetId.startsWith("nep141:"), a.symbol);
});

test("they put in the same as you until they are edited (even by default)", () => {
  assert.equal(theirStakeText("10", null), "10");
  assert.equal(theirStakeText("12.5", null), "12.5");
  assert.equal(theirStakeText("10", "25"), "25");
  assert.equal(theirStakeText("10", ""), "");
});

test("odds are taker:maker, taken from the two amounts", () => {
  assert.equal(oddsFor("10", "10"), 1);
  assert.equal(oddsFor("10", "25"), 2.5);
  assert.equal(oddsFor("20", "5"), 0.25);
  assert.equal(oddsFor("3", "10"), 10 / 3);
  assert.equal(oddsFor("", "10"), 0);
  assert.equal(oddsFor("10", "abc"), 0);
});

test("ratioProblem mirrors the contract's same-asset 10:1 rule (hi > lo * 10 is refused), in base units", () => {
  assert.equal(ratioProblem("USDC", "10", "100"), null);
  assert.equal(ratioProblem("USDC", "100", "10"), null);
  assert.equal(ratioProblem("USDC", "10", "100.000001"), "They can put in at most 10 times what you put in (100 USDC).");
  assert.equal(ratioProblem("USDC", "100", "9.999999"), "They have to put in at least a tenth of what you put in (10 USDC).");
  assert.equal(ratioProblem("NEAR", "abc", "10"), null); // amount errors are reported by the amount checks, not twice
});

test("one small line: Min <min> <token> . fee <fee> <token> each, in token units, never $", () => {
  const usdc = limitsFor("USDC", { min_per_side: "10000000", min_fee_per_side: "500000" }, 100);
  assert.equal(stakeLine(usdc, 10_000_000n, 10_000_000n), "Min 10 USDC · fee 0.50 USDC each");
  assert.equal(stakeLine(usdc, 200_000_000n, 200_000_000n), "Min 10 USDC · fee 2.00 USDC each");
  // uneven stakes: each side pays its own fee
  assert.equal(stakeLine(usdc, 100_000_000n, 300_000_000n), "Min 10 USDC · fee 1.00 USDC you, 3.00 USDC them");
  // an amount still being typed: the minimum only
  assert.equal(stakeLine(usdc, null, null), "Min 10 USDC");
  const near = limitsFor("NEAR", { min_per_side: "2731382215970391816778881", min_fee_per_side: "136569110798519590838944" }, 100);
  assert.equal(stakeLine(near, 10n * 10n ** 24n, 10n * 10n ** 24n), "Min 2.74 NEAR · fee 0.14 NEAR each");
  const btc = limitsFor("BTC", { min_per_side: "13591", min_fee_per_side: "679" }, 100);
  assert.equal(stakeLine(btc, 13_591n, 13_591n), "Min 0.00013591 BTC · fee 0.00000679 BTC each");
  assert.equal(stakeLine(btc, 100_000n, 100_000n), "Min 0.00013591 BTC · fee 0.00001 BTC each");
  const eth = limitsFor("ETH", { min_per_side: "4871834221225121", min_fee_per_side: "243591711061256" }, 100);
  // shown amounts are rounded UP to the token's display places, so typing the shown minimum is always enough
  assert.equal(stakeLine(eth, 10n ** 16n, 10n ** 16n), "Min 0.00488 ETH · fee 0.00025 ETH each");
  assert.doesNotMatch(stakeLine(usdc, 10_000_000n, 10_000_000n), /\$/);
});

test("stakeFromDraft: defaults, current drafts, and old drafts that only kept odds (FE3 edit / MODAL1c1 resume)", () => {
  assert.deepEqual(stakeFromDraft(undefined), { symbol: DEFAULT_STAKE_SYMBOL, stakeText: "10", theirText: null });
  assert.deepEqual(stakeFromDraft({ stakeText: "5", odds: 1 }), { symbol: "NEAR", stakeText: "5", theirText: null });
  assert.deepEqual(stakeFromDraft({ stakeText: "10", odds: 2 }), { symbol: "NEAR", stakeText: "10", theirText: "20" });
  assert.deepEqual(stakeFromDraft({ stakeText: "10", odds: 1.5, stakeSymbol: "USDC", theirText: "15" }), { symbol: "USDC", stakeText: "10", theirText: "15" });
  assert.deepEqual(stakeFromDraft({ stakeText: "10", odds: 1, stakeSymbol: "USDC", theirText: null }), { symbol: "USDC", stakeText: "10", theirText: null });
  // an odds float that does not fit the token's decimals is rounded down to them
  assert.deepEqual(stakeFromDraft({ stakeText: "3", odds: 10 / 3, stakeSymbol: "USDC" }), { symbol: "USDC", stakeText: "3", theirText: "9.999999" });
  // an unknown / disabled token falls back to the default
  assert.equal(stakeFromDraft({ stakeText: "1", odds: 1, stakeSymbol: "DOGE" }).symbol, DEFAULT_STAKE_SYMBOL);
});
