// D-ASSET1/D-CAP2/D-BOND3 crosscheck (queue item 7e): lib/assets.ts's
// six-asset table must agree with the contract's own init table,
// contracts/escrow/src/tests.rs::six_asset_v1_limits -- same token ids,
// same min/max per-side stake, run_price, min_bond, min_objection, in
// the asset's own native decimal units.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSET_TABLE, findAsset } from "../lib/assets";

// Token ids and USDC/USDT limits transcribed from contracts/escrow/src/tests.rs::six_asset_v1_limits; BTC/NEAR/ETH/ZEC limits
// updated by VA1b (D-VA1) from release/draft-args.mainnet.json, then by LOGIN1 to release/mainnet-night/args.mainnet.json
// (the FINAL args the live mainnet escrow was deployed with; repriced vs the draft). Originally transcribed from
// (queue item 7e, D-ASSET1 six v1 assets + D-CAP3 launch cap = 10^34 raw (supersedes D-CAP2 $1,000/side) +
// D-BOND3 panel-cost prepay). Token ids use the MAINNET nep141 ids the
// contract's test fixture uses (V1_USDC/V1_USDT/V1_BTC/V1_WNEAR/V1_ETH/V1_ZEC).
const CONTRACT_SIX_ASSET_V1_LIMITS: Record<
  string,
  { tokenId: string; minPerSide: string; minFeePerSide: string; maxPerSide: string; runPrice: string; minBond: string; minObjection: string }
> = {
  USDC: {
    tokenId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    minPerSide: "10000000",
    minFeePerSide: "500000",
    maxPerSide: "10000000000000000000000000000000000",
    runPrice: "5000",
    minBond: "5000000",
    minObjection: "1000000",
  },
  USDT: {
    tokenId: "nep141:usdt.tether-token.near",
    minPerSide: "10000000",
    minFeePerSide: "500000",
    maxPerSide: "10000000000000000000000000000000000",
    runPrice: "5000",
    minBond: "5000000",
    minObjection: "1000000",
  },
  BTC: {
    tokenId: "nep141:btc.omft.near",
    minPerSide: "13591",
    minFeePerSide: "679",
    maxPerSide: "10000000000000000000000000000000000",
    runPrice: "7",
    minBond: "6796",
    minObjection: "1360",
  },
  NEAR: {
    tokenId: "nep141:wrap.near",
    minPerSide: "2731382215970391816778881",
    minFeePerSide: "136569110798519590838944",
    maxPerSide: "10000000000000000000000000000000000",
    runPrice: "1365691107985195908390",
    minBond: "1365691107985195908389441",
    minObjection: "273138221597039181677889",
  },
  ETH: {
    tokenId: "nep141:eth.omft.near",
    minPerSide: "4871834221225121",
    minFeePerSide: "243591711061256",
    maxPerSide: "10000000000000000000000000000000000",
    runPrice: "2435917110613",
    minBond: "2435917110612561",
    minObjection: "487183422122513",
  },
  ZEC: {
    tokenId: "nep141:zec.omft.near",
    minPerSide: "980845",
    minFeePerSide: "49042",
    maxPerSide: "10000000000000000000000000000000000",
    runPrice: "491",
    minBond: "490423",
    minObjection: "98085",
  },
};

test("ASSET_TABLE has exactly the contract's six v1 symbols", () => {
  const symbols = ASSET_TABLE.map((a) => a.symbol).sort();
  assert.deepEqual(symbols, Object.keys(CONTRACT_SIX_ASSET_V1_LIMITS).sort());
});

for (const [symbol, expected] of Object.entries(CONTRACT_SIX_ASSET_V1_LIMITS)) {
  test(`${symbol}: lib/assets.ts agrees with contracts/escrow's six_asset_v1_limits`, () => {
    const asset = findAsset(symbol);
    assert.ok(asset, `${symbol} missing from ASSET_TABLE`);
    assert.equal(asset!.ids.mainnet, expected.tokenId, `${symbol} mainnet token id mismatch`);
    assert.equal(asset!.minStakePerSide, expected.minPerSide, `${symbol} min_per_side mismatch`);
    assert.equal(asset!.minFeePerSide, expected.minFeePerSide, `${symbol} min_fee_per_side mismatch`);
    assert.equal(asset!.maxStakePerSide, expected.maxPerSide, `${symbol} max_per_side mismatch`);
    assert.equal(asset!.runPrice, expected.runPrice, `${symbol} run_price mismatch`);
    assert.equal(asset!.minBond, expected.minBond, `${symbol} min_bond mismatch`);
    assert.equal(asset!.minObjection, expected.minObjection, `${symbol} min_objection mismatch`);
  });
}

// CAP3 (D-CAP3): no stake cap at launch. The builder must not show a "max stake" error or a "Max:" label at launch values.
import { stakeMaxProblem, launchMaxLabel, LAUNCH_MAX_PER_SIDE } from "../lib/assets";

test("CAP3: LAUNCH_MAX_PER_SIDE is 10^34 raw and every asset's maxStakePerSide equals it", () => {
  assert.equal(LAUNCH_MAX_PER_SIDE, "10000000000000000000000000000000000");
  for (const a of ASSET_TABLE) assert.equal(a.maxStakePerSide, LAUNCH_MAX_PER_SIDE, a.symbol);
});

test("CAP3: no 'max stake' error at launch values, for any asset, including absurdly large human amounts", () => {
  for (const a of ASSET_TABLE) {
    for (const amt of ["10", "1000", "1000000", "123456789"]) {
      assert.equal(stakeMaxProblem(a.symbol, amt), null, `${a.symbol} ${amt}`);
    }
  }
});

test("CAP3: no 'Max:' label is shown while the asset is at the launch cap", () => {
  for (const a of ASSET_TABLE) assert.equal(launchMaxLabel(a.symbol), null, a.symbol);
});

test("CAP3: a LOWERED max (guardian propose_params) is still enforced exactly in base units, and shown", () => {
  // USDC 6dp: lowered to 500 USDC.
  assert.equal(stakeMaxProblem("USDC", "500", "500000000"), null);
  assert.match(stakeMaxProblem("USDC", "500.000001", "500000000") ?? "", /max/i);
  assert.equal(launchMaxLabel("USDC", "500000000"), "500");
  // 24dp NEAR: exact compare, no float rounding
  assert.equal(stakeMaxProblem("NEAR", "1.000000000000000000000001", "1000000000000000000000000") !== null, true);
});
