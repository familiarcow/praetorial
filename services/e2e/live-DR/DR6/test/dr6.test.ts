// DR6 offline unit test (written BEFORE the live run): expected money per party for "taker concedes" + untaken-cancel refund,
// computed from a get_bet-shaped record and side_fee (harness money.ts); the tx-list guard; the verifier SKIP set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedConcedeByTaker, expectedCancelRefund, paidTo, forbiddenCalls, verifierSummary, ALLOWED_SKIPS, loadFeeConfig } from "../expected.js";
import { sideFee } from "../../harness/money.js";

const cfg = loadFeeConfig();
const bet = (stake: string, over: Record<string, unknown> = {}) => ({
  envelope: { maker: "m", stake_maker: stake, stake_taker: stake, fee_bps: Number(cfg.feeBps), maker_side: "YES", maker_asset: "u", taker_asset: "u" },
  status: "Taken", taker: "t", fee_min_maker: cfg.minFeePerSide.toString(), fee_min_taker: cfg.minFeePerSide.toString(), storage_maker: "1234", storage_taker: "1234", ...over,
});

test("taker concedes: maker (winner) gets both stakes minus each side's fee; fee account gets fees + storage; taker gets 0; escrow drains", () => {
  for (const stake of [10_000_000n, 50_000_000n]) {
    const b = bet(stake.toString());
    const s = expectedConcedeByTaker(b);
    const f = sideFee(stake, cfg.feeBps, cfg.minFeePerSide);
    assert.equal(paidTo(s, "maker"), 2n * stake - 2n * f);
    assert.equal(paidTo(s, "fee"), 2n * f + 2468n);
    assert.equal(paidTo(s, "taker"), 0n);
    assert.equal(paidTo(s, "maker") + paidTo(s, "fee"), s.deposits.maker + s.deposits.taker);
  }
});

test("maker_side NO does not change a taker concession: the maker still wins", () => {
  const s = expectedConcedeByTaker(bet("10000000", { envelope: { ...bet("10000000").envelope, maker_side: "NO" } }));
  assert.ok(paidTo(s, "maker") > 0n && paidTo(s, "taker") === 0n);
});

test("untaken cancel refunds stake + storage in full, fee account gets nothing", () => {
  const r = expectedCancelRefund(bet("10000000", { status: "Open", taker: null, storage_taker: "0" }));
  assert.equal(r.maker, 10_000_000n + 1234n); assert.equal(r.fee, 0n);
});

test("tx list guard: any resolution-path method is flagged; concede/take/open/drain are not", () => {
  assert.deepEqual(forbiddenCalls(["transfer_with_msg", "mt_on_transfer", "concede", "drain_payouts", "cancel"]), []);
  assert.deepEqual(forbiddenCalls(["concede", "submit_outcome", "request_resolution"]), ["submit_outcome", "request_resolution"]);
});

test("verifier SKIP set is exactly B3 and B5; any other SKIP or any FAIL is unexpected", () => {
  assert.deepEqual([...ALLOWED_SKIPS], ["B3", "B5"]);
  const ok = verifierSummary("PASS B1 x\nSKIP B3 none\nSKIP B5 none\n# 6 PASS, 0 FAIL, 2 SKIP");
  assert.deepEqual(ok.unexpectedSkips, []); assert.equal(ok.fail, 0);
  assert.deepEqual(verifierSummary("SKIP B6 y\nSKIP B3 z\n# 5 PASS, 0 FAIL, 2 SKIP").unexpectedSkips, ["B6"]);
  assert.throws(() => verifierSummary("garbage"));
});

test("harness config is single-sourced from apps/web/lib/network.ts (no hand-edited escrow/RPC literal)", async () => {
  const fs = await import("node:fs");
  const { ESCROW, RPC, INTENTS, STAKE_TOKEN } = await import("../chain.js");
  const { loadWebTestnetConfig } = await import("../webConfig.js");
  const WEB = await loadWebTestnetConfig();
  assert.equal(ESCROW, WEB.escrow);
  assert.equal(INTENTS, WEB.intents);
  // the values resolve to the frozen testnet escrow (frz3, NOKEY1b) and the wNEAR stake token
  assert.equal(ESCROW, "praetorial-frz3-2611100414.praetorial-dev-1101.testnet");
  assert.equal(WEB.stakeToken, "nep141:wrap.testnet");
  assert.equal(STAKE_TOKEN, WEB.stakeToken);
  assert.match(RPC, /^https:\/\//);
  const src = fs.readFileSync(new URL("../chain.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /praetorial-frz\w*-\d+/);
  assert.doesNotMatch(src, /rpc\.[a-z.]*fastnear/);
});
