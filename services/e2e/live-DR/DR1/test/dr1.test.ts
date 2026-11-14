// DR1 offline unit test (written BEFORE the live run): expected money per party for YES and NO (get_bet + side_fee via harness money.ts),
// ground-truth decision logic, tx-method guard, verifier SKIP set (none except E4 offline).
import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedDecisive, paidTo, winnerOf, methodProblems, verifierSummary, ALLOWED_SKIPS, loadFeeConfig } from "../expected.js";
import { decideTouch, venueVerdict, type Candle } from "../groundTruth.js";
import { sideFee } from "../../harness/money.js";

const cfg = loadFeeConfig();
const NEAR1 = 10n ** 24n, STAKE = 3n * NEAR1;
const bet = (side: "YES" | "NO") => ({
  envelope: { maker: "m", stake_maker: STAKE.toString(), stake_taker: STAKE.toString(), fee_bps: Number(cfg.feeBps), maker_side: side, maker_asset: "w", taker_asset: "w", keep_terms: false },
  status: "Taken", taker: "t", fee_min_maker: cfg.minFeePerSide.toString(), fee_min_taker: cfg.minFeePerSide.toString(), storage_maker: "1234", storage_taker: "5678",
});

for (const [side, outcome] of [["YES", "YES"], ["YES", "NO"], ["NO", "YES"], ["NO", "NO"]] as const) {
  test(`maker ${side}, outcome ${outcome}: winner gets both stakes minus a side_fee per side; fee account gets fees + storage; escrow drains`, () => {
    const b = bet(side);
    const f = sideFee(STAKE, cfg.feeBps, cfg.minFeePerSide);
    const s = expectedDecisive(b, outcome);
    const w = winnerOf(b, outcome), l = w === "maker" ? "taker" : "maker";
    assert.equal(paidTo(s, w), 2n * STAKE - 2n * f);
    assert.equal(paidTo(s, l), 0n);
    assert.equal(paidTo(s, "fee"), 2n * f + 1234n + 5678n);
    assert.equal(paidTo(s, "referee"), 0n);
    assert.equal(paidTo(s, "maker") + paidTo(s, "taker") + paidTo(s, "fee"), s.deposits.maker + s.deposits.taker);
  });
}

const mk = (rows: [number, number][]): Candle[] => rows.map(([t, high]) => ({ t, high, low: high - 50 }));
test("ground truth: YES needs a wick on >=2 venues inside [open, deadline); one venue or a candle outside the window is NO", () => {
  const X = 76000, open = 1000, dl = 1300;
  const hit = mk([[1000, 75900], [1060, 76000]]), miss = mk([[1000, 75900], [1060, 75990]]), late = mk([[1300, 77000]]);
  const v = (name: "Coinbase" | "Kraken" | "Bitstamp", c: Candle[]) => venueVerdict(name, c, "at_or_above", X, open, dl);
  assert.equal(decideTouch([v("Coinbase", hit), v("Kraken", hit), v("Bitstamp", miss)]).outcome, "YES");
  assert.equal(decideTouch([v("Coinbase", hit), v("Kraken", miss), v("Bitstamp", miss)]).outcome, "NO");
  assert.equal(decideTouch([v("Coinbase", late), v("Kraken", late), v("Bitstamp", late)]).outcome, "NO"); // deadline is exclusive
  assert.equal(v("Coinbase", hit).firstTouchT, 1060);
  const below = venueVerdict("Kraken", [{ t: 1000, high: 70100, low: 69900 }], "at_or_below", 70000, 1000, 1300);
  assert.equal(below.touched, true);
});

test("tx guard: AI path needs request_resolution+submit_outcome+finalize; concede/referee_rule/void_after_deadline/challenge are flagged", () => {
  assert.deepEqual(methodProblems(["mt_on_transfer", "request_resolution", "on_resolution", "submit_outcome", "finalize", "drain_payouts"]), []);
  assert.deepEqual(methodProblems(["concede", "request_resolution", "submit_outcome", "finalize"]), ["forbidden concede"]);
  assert.deepEqual(methodProblems(["mt_on_transfer"]), ["missing request_resolution", "missing submit_outcome", "missing finalize"]);
});

test("verifier SKIP set is empty; only E4 (offline) is tolerated; any other SKIP or FAIL is unexpected", () => {
  assert.deepEqual([...ALLOWED_SKIPS], []);
  assert.deepEqual(verifierSummary("PASS A1 x\nSKIP E4 offline\n# 1 PASS, 0 FAIL, 1 SKIP").unexpectedSkips, []);
  assert.deepEqual(verifierSummary("SKIP B3 n\nSKIP E4 o\n# 1 PASS, 0 FAIL, 2 SKIP").unexpectedSkips, ["B3"]);
  assert.throws(() => verifierSummary("garbage"));
});

test("harness config: stake token single-sourced from apps/web/lib; escrow is the bet's own (frz2) even though main's web config now names frz3", async () => {
  const { ESCROW, WEB_ESCROW, STAKE_TOKEN } = await import("../chain.js");
  assert.equal(ESCROW, "praetorial-frz2-2611091914.praetorial-dev-1101.testnet");
  assert.match(WEB_ESCROW, /^praetorial-frz\d-/); // web config still read (single source), but no longer authoritative for bet 18
  assert.equal(STAKE_TOKEN, "nep141:wrap.testnet");
});

import { submitArgsFromRaw } from "../relay.js";
const rawOk = JSON.stringify({ contract: "esc.testnet", result: { bet_id: 18, checked_until: 0, element_results_hash: "ab", judge_pair_index: 0, outcome: "NO", run_no: 1, terms_hash: "th" }, signing: { pubkey_hex: "pk", signature_hex: "sg" } });
test("relay: submit_outcome args come straight from the stored resolver output; checked_until is a U64 string, nothing else is altered", () => {
  const a = submitArgsFromRaw(rawOk, "esc.testnet", 18);
  assert.deepEqual(a, { result: { bet_id: 18, checked_until: "0", element_results_hash: "ab", judge_pair_index: 0, outcome: "NO", run_no: 1, terms_hash: "th" }, signature_hex: "sg" });
});
test("relay: refuses unsigned error output, wrong contract, wrong bet", () => {
  assert.throws(() => submitArgsFromRaw(JSON.stringify({ error: "no_live_judge_key" }), "esc.testnet", 18), /unsigned|no signed result/);
  assert.throws(() => submitArgsFromRaw(rawOk, "other.testnet", 18), /contract/);
  assert.throws(() => submitArgsFromRaw(rawOk, "esc.testnet", 19), /bet/);
});

// DR1b: DR1/money.ts must use the harness per-bet receipt method (the shared-account balance-delta version failed on bet 18).
import { readFileSync } from "node:fs";
test("DR1/money.ts computes credits from the finalize receipts via the harness module and keeps the bettor balance-delta check", () => {
  const src = readFileSync(new URL("../money.ts", import.meta.url), "utf8");
  assert.match(src, /creditsFromReceipts/);
  assert.match(src, /checkPerBetMoney/);
  assert.doesNotMatch(src, /checkObserved/, "the shared-account delta check on maker/fee/escrow is gone");
  assert.match(src, /fresh/i);
});
