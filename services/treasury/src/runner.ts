// D-ECON2 follow-up (3): scheduler entrypoint.
//
// Runs planTreasuryRun() (plan -> quote, dry-run) on an interval and
// logs the result. The interval comes from TREASURY_INTERVAL_MS; the
// scheduler is DISABLED BY DEFAULT -- main() below only starts it when
// TREASURY_SCHEDULE_ENABLED=1 is explicitly set (schedulerEnabled()).
//
// Executing a real swap stays impossible from here, on two
// independent layers:
//   1. planTreasuryRun() itself only ever sends dry:true quotes
//      unless liveModeEnabled(cfg) is true, which requires BOTH
//      cfg.live === true AND TREASURY_ALLOW_LIVE_SWAPS=1 (see
//      treasuryJob.ts) -- this module never sets either on the
//      caller's behalf.
//   2. The real 1Click client wired in main() (HttpOneClickClient,
//      src/oneClickHttpClient.ts) structurally refuses to send a
//      non-dry request at all, regardless of env.
//
// runOnce/startScheduler take injected readers/client, exactly like
// planTreasuryRun -- the test suite (test/runner.test.ts) only ever
// exercises those with fakes; no RPC, no HTTP, no network. Only
// main(), gated behind the disabled-by-default flag above AND never
// invoked by the test suite, wires the real RPC/HTTP implementations.
import { planTreasuryRun } from "./treasuryJob.js";
import type { FeeBalanceReader, FloatBalanceReader, TreasuryConfig, TreasuryRunResult } from "./types.js";
import type { OneClickClient } from "./oneClickClient.js";

export const DEFAULT_INTERVAL_MS = 15 * 60_000; // 15 minutes

export function schedulerEnabled(): boolean {
  return process.env.TREASURY_SCHEDULE_ENABLED === "1";
}

/** Reads TREASURY_INTERVAL_MS; falls back to `defaultMs` when unset
 * or not a positive finite number. */
export function resolveIntervalMs(defaultMs: number = DEFAULT_INTERVAL_MS): number {
  const raw = process.env.TREASURY_INTERVAL_MS;
  if (raw === undefined || raw === "") return defaultMs;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

/** Runs exactly one plan -> quote pass and logs a summary line plus
 * one line per planned swap and per skipped asset. Returns the same
 * TreasuryRunResult planTreasuryRun produces -- this function adds
 * logging only, no additional behavior. */
export async function runOnce(
  feeReader: FeeBalanceReader,
  floatReader: FloatBalanceReader,
  client: OneClickClient,
  cfg: TreasuryConfig,
): Promise<TreasuryRunResult> {
  const log = cfg.logger ?? ((m: string) => console.error(m));
  const result = await planTreasuryRun(feeReader, floatReader, client, cfg);

  log(
    `[treasury] run complete: dryRun=${result.dryRun} swaps=${result.swaps.length} skipped=${result.skipped.length} remainingNearDeficit=${result.remainingNearDeficit}`,
  );
  for (const swap of result.swaps) {
    log(
      `[treasury]   swap ${swap.assetId} -> ${swap.destination} amountIn=${swap.amountIn} amountOut=${swap.amountOut}`,
    );
  }
  for (const s of result.skipped) {
    log(`[treasury]   skip ${s.assetId} (${s.amount}): ${s.reason}`);
  }

  return result;
}

export interface SchedulerOptions {
  intervalMs?: number;
  logger?: (message: string) => void;
  onRun?: (result: TreasuryRunResult) => void;
}

export interface SchedulerHandle {
  stop(): void;
}

/** Starts a setInterval loop calling runOnce(). A rejected run is
 * caught and logged, never thrown out of the timer (an unhandled
 * rejection would otherwise crash the process on a transient RPC/HTTP
 * failure -- the next tick should simply try again). */
export function startScheduler(
  feeReader: FeeBalanceReader,
  floatReader: FloatBalanceReader,
  client: OneClickClient,
  cfg: TreasuryConfig,
  opts: SchedulerOptions = {},
): SchedulerHandle {
  const intervalMs = opts.intervalMs ?? resolveIntervalMs();
  const log = opts.logger ?? cfg.logger ?? ((m: string) => console.error(m));
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const result = await runOnce(feeReader, floatReader, client, cfg);
      opts.onRun?.(result);
    } catch (err) {
      log(`[treasury] scheduler run failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const timer = setInterval(tick, intervalMs);
  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}

// ---------------------------------------------------------------------
// Real process entrypoint. Wires the real RPC-backed readers
// (src/rpcBalances.ts) and the real HTTP 1Click client
// (src/oneClickHttpClient.ts), then starts the scheduler ONLY if
// schedulerEnabled() -- never on import, never by the test suite.
// ---------------------------------------------------------------------
async function main(): Promise<void> {
  if (!schedulerEnabled()) {
    console.error(
      "[treasury] scheduler disabled (set TREASURY_SCHEDULE_ENABLED=1 to enable); exiting without starting it",
    );
    return;
  }

  const { buildPacedRpcClient } = await import("@praetorial/common/rpc.js");
  const { RpcFeeBalanceReader, RpcFloatBalanceReader, DEFAULT_INTENTS_CONTRACT_ID } = await import("./rpcBalances.js");
  const { HttpOneClickClient } = await import("./oneClickHttpClient.js");

  const networkId = process.env.NEAR_NETWORK_ID ?? "testnet";
  const treasuryAccountId = requireEnv("TREASURY_ACCOUNT_ID");
  const escrowContractId = requireEnv("ESCROW_CONTRACT_ID");
  const relayerAccountId = requireEnv("TREASURY_RELAYER_ACCOUNT_ID");
  const keeperAccountId = requireEnv("TREASURY_KEEPER_ACCOUNT_ID");
  const nearAssetId = process.env.TREASURY_NEAR_ASSET_ID ?? "nep141:wrap.near";
  const usdAssetId = requireEnv("TREASURY_USD_ASSET_ID");
  const feeAssetIds = (process.env.TREASURY_FEE_ASSET_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const intentsContractId = process.env.TREASURY_INTENTS_CONTRACT_ID ?? DEFAULT_INTENTS_CONTRACT_ID;

  const rpc = buildPacedRpcClient(networkId);
  const feeReader = new RpcFeeBalanceReader(rpc, intentsContractId, treasuryAccountId, feeAssetIds);
  const floatReader = new RpcFloatBalanceReader(rpc, relayerAccountId, keeperAccountId);
  const client = new HttpOneClickClient();

  const cfg: TreasuryConfig = {
    nearAssetId,
    usdAssetId,
    relayerFloatTarget: BigInt(process.env.TREASURY_RELAYER_FLOAT_TARGET ?? "0"),
    keeperFloatTarget: BigInt(process.env.TREASURY_KEEPER_FLOAT_TARGET ?? "0"),
    minSwapSize: {},
    defaultMinSwapSize: BigInt(process.env.TREASURY_DEFAULT_MIN_SWAP_SIZE ?? "0"),
    slippageToleranceBps: parseSlippageBps(process.env.TREASURY_SLIPPAGE_BPS),
    treasuryAccountId,
    escrowContractId,
    // Explicit live opt-in still requires TREASURY_ALLOW_LIVE_SWAPS=1
    // (treasuryJob.ts's liveModeEnabled) on top of this flag.
    live: process.env.TREASURY_LIVE === "1",
  };

  console.error(`[treasury] scheduler starting: interval=${resolveIntervalMs()}ms account=${treasuryAccountId}`);
  startScheduler(feeReader, floatReader, client, cfg);
}

/** Parses TREASURY_SLIPPAGE_BPS: unset/empty => 100; otherwise an integer in [0, 10000]. */
export function parseSlippageBps(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 100;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`TREASURY_SLIPPAGE_BPS must be an integer in [0, 10000], got "${raw}"`);
  }
  const n = Number(raw.trim());
  if (n > 10000) throw new Error(`TREASURY_SLIPPAGE_BPS must be an integer in [0, 10000], got "${raw}"`);
  return n;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var is required to start the treasury scheduler`);
  return v;
}

if (process.argv[1] && process.argv[1].endsWith("runner.ts")) {
  main().catch((err) => {
    console.error(`[treasury] scheduler failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
