// A1 (UIR1 §3.7): About = "What Praetorial is" + a 3-step card row, every other section collapsed with a one-line summary; the fee
// table follows the amount rule (stables 2 dp, others <= 6 significant figures) but a MINIMUM is rounded up, never understated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ABOUT, ABOUT_STEPS, aboutSummary, feeRows } from "../lib/about";
import { findAsset } from "../lib/assets";
import { toBaseUnits } from "../lib/assets";

test("About: three step cards (Make -> Taken -> Decided & paid), one sentence each", () => {
  assert.deepEqual(ABOUT_STEPS.map((s) => s.title), ["Make an offer", "Someone takes it", "Decided and paid"]);
  for (const s of ABOUT_STEPS) {
    assert.equal((s.text.match(/[.!?](\s|$)/g) ?? []).length, 1, `${s.title}: one sentence`);
    assert.doesNotMatch(s.text, /escrow|FastFS|OutLayer|TEE/i, "no jargon in the cards");
  }
});

test("About: every section but 'what' is collapsed with a one-line summary", () => {
  assert.equal(aboutSummary("what"), null);
  for (const s of ABOUT.filter((x) => x.id !== "what")) {
    const sum = aboutSummary(s.id, { firstPair: "DeepSeek + GLM", pairs: 4 });
    assert.ok(sum && sum.length < 70 && !/\.$/.test(sum), `${s.id}: ${sum}`);
  }
  assert.equal(aboutSummary("models", { firstPair: "DeepSeek-V4.1-Flash + glm-5.3-flash", pairs: 4 }), "4 pairs, first: DeepSeek-V4.1-Flash + glm-5.3-flash");
  assert.match(aboutSummary("fees")!, /1% per side/);
});

const sig = (t: string) => t.replace(/ .*/, "").replace(/^0\.0*/, "").replace(/\./, "").replace(/0+$/, "").length;
test("About fees: stables 2 dp; others <= 6 significant figures, rounded UP (a minimum is never understated)", () => {
  const rows = feeRows(["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"]);
  assert.deepEqual([rows[0]!.minFee, rows[0]!.minStake], ["0.50 USDC", "10.00 USDC"]);
  for (const r of rows.slice(2)) {
    const a = findAsset(r.symbol)!;
    for (const [shown, exact] of [[r.minFee, a.minFeePerSide!], [r.minStake, a.minStakePerSide!]] as const) {
      assert.ok(sig(shown) <= 6, `${shown}: <= 6 significant`);
      assert.ok(BigInt(toBaseUnits(r.symbol, shown.split(" ")[0]!)) >= BigInt(exact), `${shown} >= exact ${exact}`);
    }
  }
  assert.equal(rows.find((r) => r.symbol === "NEAR")!.minStake, "2.73139 NEAR");
});
