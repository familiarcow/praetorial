// D-ECON2 treasury swap job. All tests run the default/only mode the
// real runner ever exercises: dry-run (cfg.live is always false/absent
// here). No network call is made anywhere in this file -- the 1Click
// client is a hand-rolled fake implementing OneClickClient.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planTreasuryRun } from "../src/treasuryJob.js";
import type {
  AssetBalance,
  FeeBalanceReader,
  FloatBalanceReader,
  FloatBalances,
  TreasuryConfig,
} from "../src/types.js";
import type { OneClickClient, OneClickQuoteRequest, OneClickQuoteResponse } from "../src/oneClickClient.js";

const NEAR = "nep141:wrap.near";
const USDC = "nep141:usdc.near";
const USDT = "nep141:usdt.near";
const TREASURY = "fees.praetorial-dev-1101.near";

function feeReader(balances: AssetBalance[]): FeeBalanceReader {
  return { async getFeeBalances() { return balances; } };
}

function floatReader(relayer: bigint, keeper: bigint): FloatBalanceReader {
  const b: FloatBalances = { relayer, keeper };
  return { async getFloatBalances() { return b; } };
}

/** A fake 1Click client with a fixed exchange rate per origin asset
 * (into whatever destinationAsset is requested), and the ability to
 * force a quote failure for a specific asset. Records every request
 * it received so tests can assert on dry/amount/destination. */
function fakeOneClick(opts: {
  rateToNear?: Record<string, number>; // assetId -> units of NEAR out per unit in
  rateToUsd?: Record<string, number>;
  failFor?: Set<string>;
} = {}): OneClickClient & { requests: OneClickQuoteRequest[] } {
  const rateToNear = opts.rateToNear ?? {};
  const rateToUsd = opts.rateToUsd ?? {};
  const failFor = opts.failFor ?? new Set();
  const requests: OneClickQuoteRequest[] = [];
  return {
    requests,
    async getQuote(req: OneClickQuoteRequest): Promise<OneClickQuoteResponse> {
      requests.push(req);
      if (failFor.has(req.originAsset)) {
        throw new Error(`simulated quote failure for ${req.originAsset}`);
      }
      const rateTable = req.destinationAsset === NEAR ? rateToNear : rateToUsd;
      const rate = rateTable[req.originAsset] ?? 1;
      const amountOut = BigInt(Math.floor(Number(req.amount) * rate));
      return {
        quote: {
          amountIn: req.amount,
          amountOut: amountOut.toString(),
          ...(req.dry ? {} : { depositAddress: "fake.deposit.near" }),
        },
      };
    },
  };
}

function baseConfig(overrides: Partial<TreasuryConfig> = {}): TreasuryConfig {
  return {
    nearAssetId: NEAR,
    usdAssetId: USDC,
    relayerFloatTarget: 10_000n,
    keeperFloatTarget: 10_000n,
    minSwapSize: {},
    defaultMinSwapSize: 100n,
    slippageToleranceBps: 100,
    treasuryAccountId: TREASURY,
    escrowContractId: "escrow.praetorial-dev-1101.near",
    live: false,
    ...overrides,
  };
}

test("nothing to swap: no collected balances -> empty plan, floats unchanged", async () => {
  const result = await planTreasuryRun(
    feeReader([]),
    floatReader(10_000n, 10_000n), // already at target
    fakeOneClick(),
    baseConfig(),
  );
  assert.deepEqual(result.swaps, []);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.remainingNearDeficit, 0n);
  assert.equal(result.dryRun, true);
});

test("partial top-up: available swap value is less than the NEAR float deficit", async () => {
  // relayer+keeper deficit = 8000+9000 = 17000; USDT->NEAR rate 0.5,
  // only 5000 USDT collected -> only 2500 NEAR-equivalent available,
  // nowhere near enough. Everything should go to NEAR_FLOAT, nothing
  // left for the USD bucket, and remainingNearDeficit stays positive.
  const client = fakeOneClick({ rateToNear: { [USDT]: 0.5 } });
  const result = await planTreasuryRun(
    feeReader([{ assetId: USDT, amount: 5_000n }]),
    floatReader(2_000n, 1_000n), // deficits: 8000, 9000
    client,
    baseConfig(),
  );
  assert.equal(result.swaps.length, 1);
  const swap = result.swaps[0];
  assert.equal(swap.assetId, USDT);
  assert.equal(swap.destination, "NEAR_FLOAT");
  assert.equal(swap.amountIn, 5_000n);
  assert.equal(swap.amountOut, 2_500n);
  assert.equal(result.skipped.length, 0);
  // 17000 deficit - 2500 raised = 14500 remaining
  assert.equal(result.remainingNearDeficit, 14_500n);
  // every outbound request must have been a dry-run quote
  for (const req of client.requests) assert.equal(req.dry, true);
});

test("full top-up with leftover routed to the USD bucket", async () => {
  // relayer+keeper deficit = 1000+500 = 1500. USDC->NEAR rate 1:1,
  // 1500 USDC collected exactly covers it. USDT->NEAR rate irrelevant
  // once the deficit is filled -- it should be quoted into USD_STABLE
  // instead (USDT->USD rate 1:1), not NEAR.
  const client = fakeOneClick({
    rateToNear: { [USDC]: 1 },
    rateToUsd: { [USDT]: 1 },
  });
  const result = await planTreasuryRun(
    feeReader([
      { assetId: USDC, amount: 1_500n },
      { assetId: USDT, amount: 300n },
    ]),
    floatReader(9_000n, 9_500n), // deficits: 1000, 500
    client,
    baseConfig(),
  );
  assert.equal(result.remainingNearDeficit, 0n);
  const nearSwap = result.swaps.find((s) => s.destination === "NEAR_FLOAT")!;
  assert.equal(nearSwap.assetId, USDC);
  assert.equal(nearSwap.amountOut, 1_500n);
  // 1000 to relayer first, remaining 500 to keeper -- matches each
  // float's own individual deficit exactly.
  assert.deepEqual(nearSwap.allocation, { relayer: 1_000n, keeper: 500n });
  const usdSwap = result.swaps.find((s) => s.destination === "USD_STABLE")!;
  assert.equal(usdSwap.assetId, USDT);
  assert.equal(usdSwap.amountOut, 300n);
});

test("below-minimum dust is skipped, never quoted", async () => {
  const client = fakeOneClick({ rateToNear: { [USDT]: 1 } });
  const result = await planTreasuryRun(
    feeReader([{ assetId: USDT, amount: 10n }]),
    floatReader(0n, 0n),
    client,
    baseConfig({ defaultMinSwapSize: 100n }),
  );
  assert.equal(result.swaps.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].assetId, USDT);
  assert.equal(result.skipped[0].amount, 10n);
  assert.match(result.skipped[0].reason, /minimum|dust/i);
  // dust must never even reach the 1Click client
  assert.equal(client.requests.length, 0);
});

test("native NEAR collected balance is never swapped", async () => {
  const client = fakeOneClick();
  const result = await planTreasuryRun(
    feeReader([{ assetId: NEAR, amount: 50_000n }]),
    floatReader(0n, 0n),
    client,
    baseConfig(),
  );
  assert.equal(result.swaps.length, 0);
  assert.equal(client.requests.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].assetId, NEAR);
});

test("quote failure: asset is skipped and logged, no swap recorded", async () => {
  const logs: string[] = [];
  const client = fakeOneClick({ rateToNear: { [USDT]: 1 }, failFor: new Set([USDT]) });
  const result = await planTreasuryRun(
    feeReader([{ assetId: USDT, amount: 5_000n }]),
    floatReader(0n, 0n), // deficit = 20000, USDT would have filled plenty if it worked
    client,
    baseConfig({ logger: (m) => logs.push(m) }),
  );
  assert.equal(result.swaps.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].assetId, USDT);
  assert.match(result.skipped[0].reason, /quote/i);
  assert.ok(logs.some((l) => l.includes(USDT) && /quote/i.test(l)), "quote failure must be logged");
});

test("never swaps more than the collected balance for an asset", async () => {
  // Deficit (relayer+keeper) is far larger than what's collected --
  // amountIn offered to 1Click must be capped at the collected 4000,
  // never anything more, even though the float "wants" far more.
  const client = fakeOneClick({ rateToNear: { [USDT]: 10 } }); // would richly overshoot if amount weren't capped
  const result = await planTreasuryRun(
    feeReader([{ assetId: USDT, amount: 4_000n }]),
    floatReader(0n, 0n), // deficit 20000
    client,
    baseConfig(),
  );
  assert.equal(result.swaps.length, 1);
  assert.equal(result.swaps[0].amountIn, 4_000n);
  assert.equal(client.requests[0].amount, "4000");
});

test("idempotent re-run: same inputs produce the same plan every time", async () => {
  const cfg = baseConfig();
  const balances: AssetBalance[] = [
    { assetId: USDC, amount: 1_500n },
    { assetId: USDT, amount: 300n },
  ];
  const client1 = fakeOneClick({ rateToNear: { [USDC]: 1 }, rateToUsd: { [USDT]: 1 } });
  const result1 = await planTreasuryRun(feeReader(balances), floatReader(9_000n, 9_500n), client1, cfg);

  // Dry-run never mutates the fee account or the floats, so a second
  // run against fresh readers carrying the SAME unchanged balances
  // must produce an identical plan.
  const client2 = fakeOneClick({ rateToNear: { [USDC]: 1 }, rateToUsd: { [USDT]: 1 } });
  const result2 = await planTreasuryRun(feeReader(balances), floatReader(9_000n, 9_500n), client2, cfg);

  assert.deepEqual(result1.swaps, result2.swaps);
  assert.deepEqual(result1.skipped, result2.skipped);
  assert.equal(result1.remainingNearDeficit, result2.remainingNearDeficit);
});

test("live mode is never attempted implicitly: cfg.live=false always sends dry:true", async () => {
  const client = fakeOneClick({ rateToNear: { [USDC]: 1 } });
  await planTreasuryRun(
    feeReader([{ assetId: USDC, amount: 1_000n }]),
    floatReader(0n, 20_000n),
    client,
    baseConfig({ live: false }),
  );
  assert.ok(client.requests.length > 0);
  for (const req of client.requests) assert.equal(req.dry, true);
});

test("live mode requires both cfg.live and the explicit env flag -- neither set in this suite", async () => {
  const { liveModeEnabled } = await import("../src/treasuryJob.js");
  delete process.env.TREASURY_ALLOW_LIVE_SWAPS;
  assert.equal(liveModeEnabled(baseConfig({ live: true })), false, "env flag absent -> still not live");
  assert.equal(liveModeEnabled(baseConfig({ live: false })), false);
});
