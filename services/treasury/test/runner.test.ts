// RED -> GREEN: scheduler entrypoint for D-ECON2 follow-up (3). The
// scheduler interval comes from TREASURY_INTERVAL_MS (default
// unset/disabled run never starts on its own -- schedulerEnabled()
// requires TREASURY_SCHEDULE_ENABLED=1). Every test here injects fake
// FeeBalanceReader/FloatBalanceReader/OneClickClient -- no RPC, no
// HTTP, no network, ever. Executing a real (non-dry) swap stays
// impossible from this module: runOnce/startScheduler only ever call
// planTreasuryRun, whose own liveModeEnabled() gate (cfg.live AND
// TREASURY_ALLOW_LIVE_SWAPS=1) is never satisfied in this suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  schedulerEnabled,
  resolveIntervalMs,
  runOnce,
  startScheduler,
} from "../src/runner.js";
import type { AssetBalance, FeeBalanceReader, FloatBalanceReader, FloatBalances, TreasuryConfig } from "../src/types.js";
import type { OneClickClient, OneClickQuoteRequest, OneClickQuoteResponse } from "../src/oneClickClient.js";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function feeReader(balances: AssetBalance[]): FeeBalanceReader {
  return { async getFeeBalances() { return balances; } };
}
function floatReader(relayer: bigint, keeper: bigint): FloatBalanceReader {
  const b: FloatBalances = { relayer, keeper };
  return { async getFloatBalances() { return b; } };
}
function fakeClient(): OneClickClient & { requests: OneClickQuoteRequest[] } {
  const requests: OneClickQuoteRequest[] = [];
  return {
    requests,
    async getQuote(req: OneClickQuoteRequest): Promise<OneClickQuoteResponse> {
      requests.push(req);
      return { quote: { amountIn: req.amount, amountOut: req.amount } };
    },
  };
}
function cfg(overrides: Partial<TreasuryConfig> = {}): TreasuryConfig {
  return {
    nearAssetId: "nep141:wrap.near",
    usdAssetId: "nep141:usdc.near",
    relayerFloatTarget: 10n,
    keeperFloatTarget: 10n,
    minSwapSize: {},
    defaultMinSwapSize: 1n,
    slippageToleranceBps: 100,
    treasuryAccountId: "fees.praetorial-dev-1101.near",
    escrowContractId: "escrow.praetorial-dev-1101.near",
    live: false,
    ...overrides,
  };
}

test("schedulerEnabled() is false unless TREASURY_SCHEDULE_ENABLED=1", () => {
  withEnv({ TREASURY_SCHEDULE_ENABLED: undefined }, () => assert.equal(schedulerEnabled(), false));
  withEnv({ TREASURY_SCHEDULE_ENABLED: "0" }, () => assert.equal(schedulerEnabled(), false));
  withEnv({ TREASURY_SCHEDULE_ENABLED: "1" }, () => assert.equal(schedulerEnabled(), true));
});

test("resolveIntervalMs defaults, is overridden by TREASURY_INTERVAL_MS, and falls back on garbage", () => {
  withEnv({ TREASURY_INTERVAL_MS: undefined }, () => assert.equal(resolveIntervalMs(900000), 900000));
  withEnv({ TREASURY_INTERVAL_MS: "5000" }, () => assert.equal(resolveIntervalMs(900000), 5000));
  withEnv({ TREASURY_INTERVAL_MS: "not-a-number" }, () => assert.equal(resolveIntervalMs(900000), 900000));
  withEnv({ TREASURY_INTERVAL_MS: "-5" }, () => assert.equal(resolveIntervalMs(900000), 900000));
});

test("runOnce plans a dry-run and logs a summary plus every swap/skip line", async () => {
  const logs: string[] = [];
  const client = fakeClient();
  const result = await runOnce(
    feeReader([{ assetId: "nep141:usdc.near", amount: 50n }]),
    floatReader(0n, 0n),
    client,
    cfg({ logger: (m) => logs.push(m) }),
  );
  assert.equal(result.dryRun, true);
  assert.equal(client.requests.length, 1);
  assert.equal(client.requests[0]!.dry, true);
  assert.ok(logs.some((l) => l.includes("dryRun=true")));
  assert.ok(logs.some((l) => l.includes("nep141:usdc.near")));
});

test("runOnce never flips live mode on by itself even when cfg.live is true (env var still required)", async () => {
  const client = fakeClient();
  const result = await withEnv({ TREASURY_ALLOW_LIVE_SWAPS: undefined }, () =>
    runOnce(feeReader([{ assetId: "nep141:usdc.near", amount: 50n }]), floatReader(0n, 0n), client, cfg({ live: true, logger: () => {} })),
  );
  assert.equal(result.dryRun, true);
  assert.equal(client.requests[0]!.dry, true);
});

test("startScheduler runs on the configured interval and stop() halts further ticks", async () => {
  const client = fakeClient();
  const runs: number[] = [];
  const handle = startScheduler(
    feeReader([]),
    floatReader(0n, 0n),
    client,
    cfg({ logger: () => {} }),
    { intervalMs: 15, onRun: () => runs.push(Date.now()) },
  );
  await new Promise((r) => setTimeout(r, 70));
  handle.stop();
  const countAtStop = runs.length;
  assert.ok(countAtStop >= 3, `expected at least 3 ticks in 70ms at 15ms interval, got ${countAtStop}`);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(runs.length, countAtStop, "no further ticks after stop()");
});

test("startScheduler logs a run failure instead of throwing when a reader rejects", async () => {
  const logs: string[] = [];
  const brokenFeeReader: FeeBalanceReader = { async getFeeBalances() { throw new Error("rpc down"); } };
  const handle = startScheduler(
    brokenFeeReader,
    floatReader(0n, 0n),
    fakeClient(),
    cfg({ logger: (m) => logs.push(m) }),
    { intervalMs: 10 },
  );
  await new Promise((r) => setTimeout(r, 40));
  handle.stop();
  assert.ok(logs.some((l) => l.includes("rpc down")));
});
