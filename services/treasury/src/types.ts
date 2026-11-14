// D-ECON2: offchain treasury job. Collected per-asset protocol fees
// (1% per asset + per-asset run_price, collected into a single fee
// account) are periodically swapped via NEAR Intents 1Click into two
// targets: the NEAR float (relayer + keeper gas accounts, topped up to
// configured target levels) and a USD-stable bucket (funding NEAR AI
// credits). Dry-run is the default and only mode the test suite
// exercises; live execution requires an explicit opt-in (see
// liveModeEnabled() in treasuryJob.ts) and is never run by tests.

/** One asset's collected balance in the fee account, smallest units of
 * that asset (NEP-141 convention: decimal amounts are always integers
 * in base units, never floats). */
export interface AssetBalance {
  assetId: string; // 1Click asset id, e.g. "nep141:usdc.near"
  amount: bigint;
}

/** Reads the fee account's current per-asset collected balances.
 * Injected so tests never touch a real account/RPC. */
export interface FeeBalanceReader {
  getFeeBalances(): Promise<AssetBalance[]>;
}

/** Current NEAR balances of the two float accounts this job tops up. */
export interface FloatBalances {
  relayer: bigint;
  keeper: bigint;
}

/** Reads the relayer/keeper float accounts' current NEAR balances.
 * Injected so tests never touch a real account/RPC. */
export interface FloatBalanceReader {
  getFloatBalances(): Promise<FloatBalances>;
}

export type SwapDestination = "NEAR_FLOAT" | "USD_STABLE";

export interface PlannedSwap {
  assetId: string;
  amountIn: bigint; // always <= the collected balance read for this asset
  destination: SwapDestination;
  amountOut: bigint; // from the 1Click quote
  /** Only set for destination === "NEAR_FLOAT": how this swap's output
   * NEAR is attributed across the two float accounts. */
  allocation?: { relayer: bigint; keeper: bigint };
}

export interface SkippedAsset {
  assetId: string;
  amount: bigint;
  reason: string;
}

export interface TreasuryRunResult {
  dryRun: boolean;
  swaps: PlannedSwap[];
  skipped: SkippedAsset[];
  /** Remaining NEAR float deficit (relayer + keeper) after every planned
   * swap's quoted output is applied. Zero means both floats reached
   * their target; positive means this run's available balances were
   * not enough to fully top them up (a "partial top-up"). */
  remainingNearDeficit: bigint;
}

export interface TreasuryConfig {
  /** 1Click asset id treated as "native NEAR" for float top-ups -- a
   * collected balance in this asset is never swapped (swapping NEAR
   * for NEAR is meaningless); it is left for a direct transfer, which
   * is outside this job's scope. */
  nearAssetId: string;
  /** 1Click asset id for the USD-stable bucket (NEAR AI credits). */
  usdAssetId: string;
  relayerFloatTarget: bigint;
  keeperFloatTarget: bigint;
  /** Per-asset minimum swap size (dust floor), smallest units of that
   * asset. Falls back to defaultMinSwapSize when an asset has no
   * entry. */
  minSwapSize: Record<string, bigint>;
  defaultMinSwapSize: bigint;
  slippageToleranceBps: number;
  /** Account id used as the quote's refundTo/recipient -- the fee
   * account itself receives both the NEAR float top-up and the USD
   * bucket swap outputs (routing those onward to the relayer/keeper
   * accounts and NEAR AI credits is a separate, already-onchain or
   * already-offchain step outside this job). */
  treasuryAccountId: string;
  /** Escrow contract id (ESCROW_CONTRACT_ID). Required; treasuryAccountId
   * must never equal it (that would plan swapping user escrow funds). */
  escrowContractId: string;
  /** Explicit live-mode opt-in. Must be true AND the
   * TREASURY_ALLOW_LIVE_SWAPS env var must be "1" for the job to ever
   * attempt a non-dry quote/execution; tests never set either, so the
   * test suite never exercises live mode. */
  live: boolean;
  logger?: (message: string) => void;
}
