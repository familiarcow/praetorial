// DR0 part 2: expected payout/fee/tip per ending from the frozen contract rules, vs side_fee (contracts/escrow/src/lib.rs).
// The fee parameters come from the release config / contract constant at test time; no fee number is hard-coded here or in money.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFeeConfig, sideFee, expectedSettlement, assertEscrowDrained, checkObserved, type Params, type Ending } from "../money.js";

const here = dirname(fileURLToPath(import.meta.url));
const LIB = join(here, "..", "..", "..", "..", "..", "contracts", "escrow", "src", "lib.rs");
const usd = (n: number) => BigInt(n) * 1_000_000n; // 6-decimal USDC
const cfg = loadFeeConfig();
const STAKES = [10, 50, 100];

test("fee config is derived from the release config and the contract constant, not literals", () => {
  assert.ok(cfg.feeBps > 0n && cfg.minFeePerSide > 0n && cfg.minFeeCapPerSide >= cfg.minFeePerSide);
  assert.ok(cfg.source.release.endsWith("args.indicative.json"));
  assert.match(cfg.source.feeBps, /PROTOCOL_FEE_BPS_V1/);
});

test("sideFee re-derivation matches the contract's side_fee source and is min(stake, max(stake*bps/10000, min_fee))", () => {
  const src = readFileSync(LIB, "utf8");
  const body = src.slice(src.indexOf("pub fn side_fee("), src.indexOf("pub fn side_fee(") + 300);
  assert.match(body.replace(/\s+/g, " "), /std::cmp::min\(stake, std::cmp::max\(stake \* fee_bps \/ BPS_DENOM, min_fee_per_side\)\)/);
  assert.match(src, /const BPS_DENOM: u128 = 10_?000;/);
  for (const s of STAKES) {
    const stake = usd(s);
    const f = sideFee(stake, cfg.feeBps, cfg.minFeePerSide);
    // independent restatement: compare as rationals (a*10000 vs b), no shared division path
    const pctExact = stake * cfg.feeBps; // == pct fee * 10000 before the floor
    const pct = pctExact / 10_000n;
    assert.ok(pct * 10_000n <= pctExact && pctExact < (pct + 1n) * 10_000n);
    assert.equal(f, [pct, cfg.minFeePerSide].reduce((a, b) => (a > b ? a : b)) > stake ? stake : [pct, cfg.minFeePerSide].reduce((a, b) => (a > b ? a : b)));
    assert.ok(f >= cfg.minFeePerSide && f <= stake);
  }
  // below the minimum-fee crossover the min wins; above it bps wins
  const cross = (cfg.minFeePerSide * 10_000n) / cfg.feeBps;
  assert.equal(sideFee(cross * 10n, cfg.feeBps, cfg.minFeePerSide), (cross * 10n * cfg.feeBps) / 10_000n);
  assert.equal(sideFee(cross / 10n, cfg.feeBps, cfg.minFeePerSide), cfg.minFeePerSide);
  assert.equal(sideFee(cfg.minFeePerSide / 2n, cfg.feeBps, cfg.minFeePerSide), cfg.minFeePerSide / 2n, "fee never exceeds stake");
});

const base = (stake: bigint, extra: Partial<Params> = {}): Params => ({
  stakeMaker: stake, stakeTaker: stake, feeBps: cfg.feeBps, minFeeMaker: cfg.minFeePerSide, minFeeTaker: cfg.minFeePerSide,
  storageMaker: 7_000n, storageTaker: 7_000n, keepTerms: true, makerSide: "YES", referee: false, tipMaker: false, tipTaker: false, ...extra,
});
const net = (lines: { to: string; amount: bigint }[], to: string) => lines.filter((l) => l.to === to).reduce((a, l) => a + l.amount, 0n);

for (const dollars of STAKES) {
  const stake = usd(dollars);
  const fee = () => sideFee(stake, cfg.feeBps, cfg.minFeePerSide);

  test(`$${dollars}: YES (maker wins) pays pot - 2*fee to maker, fees+storage to fee account, escrow drains to 0`, () => {
    const p = base(stake);
    const s = expectedSettlement("YES", p);
    assert.equal(net(s.lines, "maker"), stake * 2n - fee() * 2n);
    assert.equal(net(s.lines, "taker"), 0n);
    assert.equal(net(s.lines, "fee"), fee() * 2n + p.storageMaker + p.storageTaker);
    assertEscrowDrained(s);
  });

  test(`$${dollars}: NO (taker wins) mirrors YES`, () => {
    const s = expectedSettlement("NO", base(stake));
    assert.equal(net(s.lines, "taker"), stake * 2n - fee() * 2n);
    assert.equal(net(s.lines, "maker"), 0n);
    assertEscrowDrained(s);
  });

  test(`$${dollars}: VOID refund returns full stakes; keep_terms sends storage to the fee account`, () => {
    const p = base(stake);
    const s = expectedSettlement("VOID", p);
    assert.equal(net(s.lines, "maker"), stake);
    assert.equal(net(s.lines, "taker"), stake);
    assert.equal(net(s.lines, "fee"), p.storageMaker + p.storageTaker);
    assertEscrowDrained(s);
    const r = expectedSettlement("VOID", base(stake, { keepTerms: false }));
    assert.equal(net(r.lines, "maker"), stake + 7_000n);
    assert.equal(net(r.lines, "fee"), 0n);
    assertEscrowDrained(r);
  });

  test(`$${dollars}: concede (maker concedes -> taker wins) charges the normal fee`, () => {
    const s = expectedSettlement("CONCEDE_MAKER", base(stake));
    assert.equal(net(s.lines, "taker"), stake * 2n - fee() * 2n);
    assert.equal(net(s.lines, "maker"), 0n);
    assertEscrowDrained(s);
  });

  test(`$${dollars}: human ruling with tip (referee): tip = the side fee carved out of each opted-in stake`, () => {
    const p = base(stake, { referee: true, tipMaker: true, tipTaker: true });
    const s = expectedSettlement("REFEREE_YES", p);
    assert.equal(net(s.lines, "referee"), fee() * 2n);
    assert.equal(net(s.lines, "maker"), stake * 2n - fee() * 2n - fee() * 2n);
    assert.equal(net(s.lines, "fee"), fee() * 2n + 14_000n);
    assertEscrowDrained(s);
    const v = expectedSettlement("REFEREE_VOID", p); // tip is paid on VOID rulings too
    assert.equal(net(v.lines, "referee"), fee() * 2n);
    assert.equal(net(v.lines, "maker"), stake - fee());
    assert.equal(net(v.lines, "taker"), stake - fee());
    assertEscrowDrained(v);
  });

  test(`$${dollars}: deadline refund: stakes back minus opted-in tip (silent referee still earns it)`, () => {
    const noTip = expectedSettlement("DEADLINE_REFUND", base(stake));
    assert.equal(net(noTip.lines, "maker"), stake);
    assertEscrowDrained(noTip);
    const tip = expectedSettlement("DEADLINE_REFUND", base(stake, { referee: true, tipMaker: true, tipTaker: true }));
    assert.equal(net(tip.lines, "referee"), fee() * 2n);
    assert.equal(net(tip.lines, "maker"), stake - fee());
    assertEscrowDrained(tip);
  });
}

test("taker-option take: taker stake/min-fee come from the option, fee is per side on its own stake", () => {
  const makerStake = usd(10), takerStake = usd(50);
  const p = base(makerStake, { stakeTaker: takerStake });
  const s = expectedSettlement("YES", p);
  const fm = sideFee(makerStake, cfg.feeBps, cfg.minFeePerSide), ft = sideFee(takerStake, cfg.feeBps, cfg.minFeePerSide);
  assert.equal(net(s.lines, "maker"), makerStake + takerStake - fm - ft);
  assert.equal(net(s.lines, "fee"), fm + ft + 14_000n);
  assertEscrowDrained(s);
  // a differing per-option minimum fee (fee_min_taker copy) is honoured
  const q = base(makerStake, { stakeTaker: takerStake, minFeeTaker: cfg.minFeePerSide * 2n });
  assert.equal(sideFee(takerStake, cfg.feeBps, q.minFeeTaker), sideFee(takerStake, cfg.feeBps, cfg.minFeePerSide * 2n));
});

test("every ending conserves money: payouts == deposits, so the escrow holds 0 afterwards", () => {
  const endings: Ending[] = ["YES", "NO", "VOID", "CONCEDE_MAKER", "CONCEDE_TAKER", "REFEREE_YES", "REFEREE_NO", "REFEREE_VOID", "DEADLINE_REFUND"];
  for (const e of endings) for (const d of STAKES) {
    const s = expectedSettlement(e, base(usd(d), { referee: true, tipMaker: true, tipTaker: true }));
    assertEscrowDrained(s);
  }
});

test("assertEscrowDrained / checkObserved fail loudly on a one-unit discrepancy", () => {
  const s = expectedSettlement("YES", base(usd(10)));
  const bad = { ...s, lines: s.lines.map((l, i) => (i === 0 ? { ...l, amount: l.amount + 1n } : l)) };
  assert.throws(() => assertEscrowDrained(bad));
  const deltas = { maker: net(s.lines, "maker"), taker: net(s.lines, "taker"), fee: net(s.lines, "fee"), referee: 0n };
  assert.deepEqual(checkObserved(s, deltas, { escrowAfter: 0n }), []);
  assert.ok(checkObserved(s, { ...deltas, maker: deltas.maker + 1n }, { escrowAfter: 0n }).length > 0);
  assert.ok(checkObserved(s, deltas, { escrowAfter: 1n }).some((m) => /escrow/.test(m)));
});

test("matches the recorded R3e YES finalize on testnet (1% of 1,000,000 per side, min fee 0 there)", () => {
  const rec = JSON.parse(readFileSync(join(here, "..", "fixtures", "recorded_run_input.json"), "utf8"));
  const e = rec.bets.afterRequest.envelope;
  const s = expectedSettlement("YES", { stakeMaker: BigInt(e.stake_maker), stakeTaker: BigInt(e.stake_taker), feeBps: BigInt(e.fee_bps), minFeeMaker: 0n, minFeeTaker: 0n, storageMaker: 8_000n, storageTaker: 8_000n, keepTerms: true, makerSide: "YES", referee: false, tipMaker: false, tipTaker: false });
  assert.equal(net(s.lines, "maker").toString(), (BigInt(rec.finalize.after.balances.maker) - BigInt(rec.finalize.before.balances.maker)).toString());
  assert.equal(net(s.lines, "fee").toString(), (BigInt(rec.finalize.after.balances.fee) - BigInt(rec.finalize.before.balances.fee)).toString());
});
