// CAP3 (D-CAP3, familiarcow 2026-11-08): no stake cap at launch. max_per_side is the LARGEST value that keeps every u128
// computation in the escrow overflow-safe. These property tests model each contract expression (checked u128 math:
// every intermediate must be <= u128::MAX) at the cap and below it, for same-asset and cross-asset bets.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  U128_MAX, STAKE_SAFETY_FACTOR, PEAK_STAKE_MULTIPLIER, launchMaxPerSide, contractIntermediates, MAX_FEE_BPS_MODEL,
} from "../src/stakeCap.js";
import { generate, validateArgs, ReleaseError } from "../src/gen.js";
import { loadContractConstants, maxEnvelopeBytes, storageCharge } from "../src/contractConstants.js";

const M = launchMaxPerSide();
const C = loadContractConstants();
const BYTES = maxEnvelopeBytes(C);

// deterministic xorshift PRNG over BigInt (no deps)
function rng(seed: bigint) {
  let s = seed | 1n;
  return (bound: bigint): bigint => {
    s ^= (s << 13n) & ((1n << 64n) - 1n); s ^= s >> 7n; s ^= (s << 17n) & ((1n << 64n) - 1n);
    const wide = (s << 64n) ^ (s * 0x9e3779b97f4a7c15n);
    return wide % (bound + 1n);
  };
}

test("derivation: M = largest power of ten <= u128::MAX / safety factor; factor and peak are documented constants", () => {
  assert.equal(STAKE_SAFETY_FACTOR, 4096n);
  assert.equal(PEAK_STAKE_MULTIPLIER, 2000n); // pot (2S) * 1000 bps-scale bond intermediate
  const limit = U128_MAX / STAKE_SAFETY_FACTOR;
  assert.ok(M <= limit, "M within the safety budget");
  assert.ok(M * 10n > limit, "M is the LARGEST power of ten within the budget");
  assert.equal(M, 10n ** 34n);
  // headroom: the binding intermediate at M is far below u128::MAX
  assert.ok(M * PEAK_STAKE_MULTIPLIER * 10n < U128_MAX, "binding intermediate has >= 10x headroom at M");
});

test("every contract intermediate at the cap fits u128 (both sides at M, fee up to the 10,000 bps ceiling, rounds up to 8)", () => {
  for (const feeBps of [0n, 1n, 100n, MAX_FEE_BPS_MODEL, 10_000n]) {
    for (const rounds of [1n, 2n, 4n, 8n]) {
      const xs = contractIntermediates({ stakeMaker: M, stakeTaker: M, feeBps, maxRounds: rounds, storageRate: 10240000000000000000000n * 1000n, maxBytes: BYTES, minFee: 1n, minBond: M / 100n, minObjection: M / 1000n, runPrice: M / 1000n });
      for (const x of xs) assert.ok(x.value <= U128_MAX, `${x.name} = ${x.value} overflows u128 (fee ${feeBps} bps, rounds ${rounds})`);
    }
  }
});

test("property: random stakes in [0, M], random fee/bond/objection/storage params: no intermediate overflows (same-asset and cross-asset)", () => {
  const r = rng(0xc0ffee1234n);
  for (let i = 0; i < 4000; i++) {
    const edge = i % 5 === 0;
    const sm = edge ? M - r(3n) : r(M);
    const st = edge ? M - r(3n) : r(M);
    const xs = contractIntermediates({
      stakeMaker: sm, stakeTaker: st, feeBps: r(10_000n), maxRounds: 1n + r(7n),
      storageRate: r(10n ** 30n), maxBytes: BYTES, minFee: r(M / 20n), minBond: r(M), minObjection: r(M), runPrice: r(M),
    });
    for (const x of xs) assert.ok(x.value <= U128_MAX, `${x.name} = ${x.value} overflows u128 for S=${sm} T=${st}`);
  }
});

test("the safety factor is not slack-free to violate: 4096x M would overflow the binding intermediate (the cap is the right order of magnitude)", () => {
  // At 100x M the pot*1000 bond intermediate (2000 * S) still fits, but sums of bonds + payouts + fee*10_000 do not all fit
  // at 100000x M: confirms the model detects overflow rather than being vacuous.
  const big = M * 100_000n;
  const xs = contractIntermediates({ stakeMaker: big, stakeTaker: big, feeBps: 10_000n, maxRounds: 8n, storageRate: 1n, maxBytes: BYTES, minFee: 1n, minBond: 1n, minObjection: 1n, runPrice: 1n });
  assert.ok(xs.some((x) => x.value > U128_MAX), "model flags overflow well above the cap");
});

test("storage charge at the max envelope and a rate far above any real rate stays tiny next to M (stake + storage fits)", () => {
  const rate = 10240000000000000000000n * 1_000_000n; // 10^6 x the wNEAR rate
  assert.ok(BYTES * rate + 2047n < U128_MAX);
  assert.ok(M + storageCharge(BYTES, rate) < U128_MAX);
});

// ---- generator wiring
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const IDS = {
  USDC: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  USDT: "nep141:usdt.tether-token.near", BTC: "nep141:btc.omft.near", WNEAR: "nep141:wrap.near",
  ETH: "nep141:eth.omft.near", ZEC: "nep141:zec.omft.near",
};
const vol = (token_id: string, decimals: number, price: string) => ({
  token_id, decimals, kind: "volatile" as const, price_usd: price, price_ts_ms: NOW - 5 * MIN, second_price_usd: price, second_price_ts_ms: NOW - 6 * MIN,
});
const stable = (token_id: string) => ({ token_id, decimals: 6, kind: "stable" as const });
const hex = (c: string) => c.repeat(64);
function gen() {
  return generate({
    network: "mainnet", intents: "intents.near", usdc_token_id: IDS.USDC, outlayer: "outlayer.near", operator: "operator.praetorial.near",
    guardian: "guardian.praetorial.near", registry: "registry.praetorial.near", fee_account: "fee.praetorial.near", keeper: "keeper.praetorial.near",
    max_offer_ttl_secs: 60 * 86400, outcome_pubkey: hex("a"), attest_pubkey: hex("b"), resolver_wasm_hash: hex("c"),
    outlayer_config: { wasm_base_url: "https://x.example/p/o", secrets_profile: "praetorial-resolver", secrets_account_id: "escrow.praetorial.near" },
    near_price: { price_usd: "3.68", price_ts_ms: NOW - 5 * MIN, second_price_usd: "3.68", second_price_ts_ms: NOW - 6 * MIN },
    assets: [stable(IDS.USDC), stable(IDS.USDT), vol(IDS.BTC, 8, "75823"), vol(IDS.WNEAR, 24, "3.68"), vol(IDS.ETH, 18, "2235"), vol(IDS.ZEC, 8, "126")],
  }, { now_ms: NOW });
}

test("generate: every one of the six assets gets max_per_side = M (no $1,000 default), and limits.max_stake_per_side_near follows", () => {
  const { args } = gen();
  assert.equal(args.asset_limits.length, 6);
  for (const [id, l] of args.asset_limits) {
    assert.equal(l.max_per_side, M.toString(), `${id} max_per_side`);
    assert.ok(BigInt(l.min_per_side) <= M);
    for (const f of ["min_fee_per_side", "min_fee_cap_per_side", "run_price", "min_bond", "min_objection", "storage_per_kib"] as const) {
      assert.ok(BigInt(l[f]) < M / 1000n, `${id} ${f} is far below the cap`);
    }
  }
  assert.equal(args.limits.max_stake_per_side_near, M.toString());
  assert.equal(args.limits.max_stake, M.toString());
});

test("generate: every asset's real limit set passes the full intermediates model at max stake on both sides", () => {
  const { args } = gen();
  for (const [id, l] of args.asset_limits) {
    for (const feeBps of [100n, MAX_FEE_BPS_MODEL]) {
      const xs = contractIntermediates({
        stakeMaker: M, stakeTaker: M, feeBps, maxRounds: BigInt(args.limits.max_rounds), storageRate: BigInt(l.storage_per_kib), maxBytes: BYTES,
        minFee: BigInt(l.min_fee_per_side), minBond: BigInt(l.min_bond), minObjection: BigInt(l.min_objection), runPrice: BigInt(l.run_price),
      });
      for (const x of xs) assert.ok(x.value <= U128_MAX, `${id}: ${x.name} overflows`);
    }
  }
});

test("validateArgs refuses a max_per_side above the overflow-safe launch cap (cannot be hand-edited past M)", () => {
  const { args } = gen();
  const bad = JSON.parse(JSON.stringify(args));
  bad.asset_limits[0][1].max_per_side = (M * 10n).toString();
  assert.throws(() => validateArgs(bad, "mainnet"), (e: unknown) => e instanceof ReleaseError && /max_per_side.*overflow/i.test((e as Error).message));
  const ok = JSON.parse(JSON.stringify(args));
  ok.asset_limits[0][1].max_per_side = (M - 1n).toString(); // lowering is always allowed
  validateArgs(ok, "mainnet");
});

test("the table prints the cap in raw units and in whole units", () => {
  const { table } = gen();
  assert.ok(table.includes(M.toString()));
});
