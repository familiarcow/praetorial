// D-ECON2 treasury swap job.
//
// Reads collected per-asset protocol fees (fee account) and plans
// swaps, via NEAR Intents 1Click, into two targets:
//   - NEAR_FLOAT: tops up the relayer + keeper gas accounts toward
//     their configured target levels.
//   - USD_STABLE: whatever is left once NEAR_FLOAT is satisfied,
//     funding NEAR AI credits.
//
// Dry-run (quote only, `dry: true`, no deposit address, nothing
// executed) is the default and the ONLY mode this module's own test
// suite exercises. Live execution requires BOTH cfg.live === true AND
// the TREASURY_ALLOW_LIVE_SWAPS=1 env var (liveModeEnabled below);
// this job never flips that on by itself, and no test in this package
// sets the env var, so live mode is never exercised here.
import type {
  AssetBalance,
  FeeBalanceReader,
  FloatBalanceReader,
  PlannedSwap,
  SkippedAsset,
  TreasuryConfig,
  TreasuryRunResult,
} from "./types.js";
import type { OneClickClient, OneClickQuoteRequest } from "./oneClickClient.js";

/** Both an explicit config opt-in AND an explicit env var must agree
 * before any non-dry quote/execution would ever be attempted. Belt and
 * suspenders: a config object alone (e.g. accidentally left over from
 * a test fixture) can never flip live mode on in a real process
 * without the operator also setting the env var, and vice versa. */
export function liveModeEnabled(cfg: TreasuryConfig): boolean {
  return cfg.live === true && process.env.TREASURY_ALLOW_LIVE_SWAPS === "1";
}

function minSwapSizeFor(cfg: TreasuryConfig, assetId: string): bigint {
  return cfg.minSwapSize[assetId] ?? cfg.defaultMinSwapSize;
}

/** Allocates `totalOut` NEAR raised this run across the two floats:
 * relayer's own deficit first, then keeper's, never exceeding either
 * float's individual deficit and never exceeding totalOut. */
function allocateNearFloat(
  totalOut: bigint,
  relayerDeficit: bigint,
  keeperDeficit: bigint,
): { relayer: bigint; keeper: bigint } {
  const toRelayer = totalOut < relayerDeficit ? totalOut : relayerDeficit;
  const remaining = totalOut - toRelayer;
  const toKeeper = remaining < keeperDeficit ? remaining : keeperDeficit;
  return { relayer: toRelayer, keeper: toKeeper };
}

export async function planTreasuryRun(
  feeReader: FeeBalanceReader,
  floatReader: FloatBalanceReader,
  client: OneClickClient,
  cfg: TreasuryConfig,
): Promise<TreasuryRunResult> {
  if (!cfg.escrowContractId) {
    throw new Error("treasury config: escrowContractId (ESCROW_CONTRACT_ID) is required");
  }
  if (cfg.treasuryAccountId === cfg.escrowContractId) {
    throw new Error("treasury config: treasuryAccountId must not be the escrow contract (would swap user escrow funds)");
  }
  const log = cfg.logger ?? ((m: string) => console.error(m));
  const dry = !liveModeEnabled(cfg);

  const balances = await feeReader.getFeeBalances();
  const floats = await floatReader.getFloatBalances();

  const relayerDeficit = cfg.relayerFloatTarget > floats.relayer ? cfg.relayerFloatTarget - floats.relayer : 0n;
  const keeperDeficit = cfg.keeperFloatTarget > floats.keeper ? cfg.keeperFloatTarget - floats.keeper : 0n;
  let remainingNearDeficit = relayerDeficit + keeperDeficit;

  const swaps: PlannedSwap[] = [];
  const skipped: SkippedAsset[] = [];
  let nearRaisedThisRun = 0n;

  // Deterministic order so the plan never depends on reader/array
  // iteration order -- required for the idempotent-re-run guarantee.
  const sorted = [...balances].sort((a: AssetBalance, b: AssetBalance) => a.assetId.localeCompare(b.assetId));

  for (const balance of sorted) {
    if (balance.assetId === cfg.nearAssetId) {
      skipped.push({ assetId: balance.assetId, amount: balance.amount, reason: "native NEAR asset -- no swap needed" });
      continue;
    }
    if (balance.amount <= 0n) {
      skipped.push({ assetId: balance.assetId, amount: balance.amount, reason: "zero balance" });
      continue;
    }
    const minSize = minSwapSizeFor(cfg, balance.assetId);
    if (balance.amount < minSize) {
      skipped.push({
        assetId: balance.assetId,
        amount: balance.amount,
        reason: `below minimum swap size (dust): ${balance.amount} < ${minSize}`,
      });
      continue;
    }

    // Never offer more than what was actually collected for this asset.
    const amountIn = balance.amount;
    const destination = remainingNearDeficit > 0n ? "NEAR_FLOAT" : "USD_STABLE";
    const destinationAsset = destination === "NEAR_FLOAT" ? cfg.nearAssetId : cfg.usdAssetId;

    const req: OneClickQuoteRequest = {
      dry,
      swapType: "EXACT_INPUT",
      slippageTolerance: cfg.slippageToleranceBps,
      originAsset: balance.assetId,
      depositType: "INTENTS",
      destinationAsset,
      amount: amountIn.toString(),
      refundTo: cfg.treasuryAccountId,
      refundType: "INTENTS",
      recipient: cfg.treasuryAccountId,
      recipientType: "INTENTS",
      deadline: new Date(Date.now() + 5 * 60_000).toISOString(),
    };

    let amountOut: bigint;
    try {
      const resp = await client.getQuote(req);
      amountOut = BigInt(resp.quote.amountOut);
    } catch (err) {
      const reason = `quote failed: ${err instanceof Error ? err.message : String(err)}`;
      skipped.push({ assetId: balance.assetId, amount: balance.amount, reason });
      log(`[treasury] skipping ${balance.assetId}: ${reason}`);
      continue;
    }

    if (destination === "NEAR_FLOAT") {
      remainingNearDeficit = remainingNearDeficit > amountOut ? remainingNearDeficit - amountOut : 0n;
      nearRaisedThisRun += amountOut;
      swaps.push({ assetId: balance.assetId, amountIn, destination, amountOut });
    } else {
      swaps.push({ assetId: balance.assetId, amountIn, destination, amountOut });
    }
  }

  // Attribute the NEAR raised across the two floats only after the
  // full pass (a single swap can't be split mid-loop against two
  // independently-moving deficits), deterministically: relayer's own
  // deficit first, then keeper's.
  if (nearRaisedThisRun > 0n) {
    let toDistribute = nearRaisedThisRun;
    for (const swap of swaps) {
      if (swap.destination !== "NEAR_FLOAT") continue;
      const chunk = swap.amountOut < toDistribute ? swap.amountOut : toDistribute;
      const alloc = allocateNearFloat(
        chunk,
        relayerDeficit - swaps.slice(0, swaps.indexOf(swap)).reduce((s, x) => s + (x.allocation?.relayer ?? 0n), 0n),
        keeperDeficit - swaps.slice(0, swaps.indexOf(swap)).reduce((s, x) => s + (x.allocation?.keeper ?? 0n), 0n),
      );
      swap.allocation = alloc;
      toDistribute -= chunk;
    }
  }

  return { dryRun: dry, swaps, skipped, remainingNearDeficit };
}
