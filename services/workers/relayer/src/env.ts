// Worker bindings -> relayer config. Every name read here must be in services/ops/src/serviceEnv.ts
// (relayer row); workers/relayer/test/static.test.ts enforces it. Mirrors relayer/src/runner.ts defaults.
import { DEFAULT_MAINNET_RPC_URL, DEFAULT_TESTNET_RPC_URL } from "@praetorial/common/rpc.js";
import { LAUNCH_TOKEN_CONTRACTS } from "../../../relayer/src/policy.js";
import type { RelayerConfig } from "../../../relayer/src/relayerCore.js";
import { DEFAULT_ACTIVATION_YOCTO } from "../../../relayer/src/activation.js";

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string, init?: any): Promise<Response> };
}
export interface RelayerEnv {
  RELAYER?: DurableObjectNamespaceLike;
  RELAYER_SERVICE?: { fetch(input: any, init?: any): Promise<Response> };
  [name: string]: unknown;
}
/** Missing/invalid configuration: the one 500 whose message is safe (and useful) to return. */
export class ConfigError extends Error {}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

export interface WorkerRelayerConfig {
  relayer: RelayerConfig; networkId: string; rpcUrls: string[]; accountId: string; privateKey: string; rpcPerSec: number;
  indexerUrl?: string; bettorScanMaxViews: number; activationYocto: bigint; telegramToken?: string; telegramChatId?: string; heartbeatEveryMs: number;
}

export function loadRelayerConfig(env: RelayerEnv): WorkerRelayerConfig {
  const need = (v: unknown, name: string): string => { const s = str(v); if (!s) throw new ConfigError(`missing required binding ${name}`); return s; };
  const big = (name: string, dflt?: string): bigint | undefined => { const s = str(env[name]) ?? dflt; if (s === undefined) return undefined; try { return BigInt(s); } catch { throw new ConfigError(`binding ${name} must be an integer`); } };
  const num = (name: string, dflt: number): number => { const s = str(env[name]); const n = s === undefined ? dflt : Number(s); if (!Number.isFinite(n)) throw new ConfigError(`binding ${name} must be a number`); return n; };
  const networkId = str(env.NEAR_NETWORK_ID) ?? str(env.NEAR_NETWORK) ?? "testnet";
  const primary = str(env.NEAR_RPC_URL) ?? str(env.NEAR_NODE_URL) ?? (networkId === "mainnet" ? DEFAULT_MAINNET_RPC_URL : DEFAULT_TESTNET_RPC_URL);
  const fallbacks = (str(env.NEAR_RPC_FALLBACKS) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const relayer: RelayerConfig = {
    escrowContract: need(env.ESCROW_CONTRACT_ID, "ESCROW_CONTRACT_ID"),
    intentsContract: need(env.INTENTS_CONTRACT_ID, "INTENTS_CONTRACT_ID"),
    usdcTokenId: str(env.USDC_TOKEN_ID) ?? "usdc.fakes.testnet",
    // LIVE1 / D-CAP3: every asset the escrow enables may be staked (wrangler.toml STAKE_ASSET_IDS, both envs).
    stakeAssetIds: str(env.STAKE_ASSET_IDS) ? str(env.STAKE_ASSET_IDS)!.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    fundTokenContracts: str(env.FUND_TOKEN_CONTRACTS) ? str(env.FUND_TOKEN_CONTRACTS)!.split(",").map((s) => s.trim()).filter(Boolean) : [...LAUNCH_TOKEN_CONTRACTS],
    wnearContract: str(env.WNEAR_CONTRACT_ID) ?? "wrap.testnet",
    maxTransferAmount: big("RELAYER_MAX_TRANSFER_AMOUNT", "1000000000000")!,
    maxBlockHeightFuture: big("RELAYER_MAX_BLOCK_HEIGHT_FUTURE", "1200")!,
    perCallSponsorshipYocto: big("RELAYER_PER_CALL_SPONSORSHIP_YOCTO", "5000000000000000000000")!,
    maxRequestsPerWindow: num("RELAYER_MAX_REQUESTS_PER_WINDOW", 20),
    windowMs: num("RELAYER_WINDOW_MS", 60_000),
    dailyBudgetYocto: big("RELAYER_DAILY_BUDGET_YOCTO", "100000000000000000000000")!,
    globalDailyBudgetYocto: big("RELAYER_GLOBAL_DAILY_BUDGET_YOCTO"),
    reservedShare: num("RELAYER_RESERVED_SHARE", 0.5),
    bettorCacheTtlMs: num("RELAYER_BETTOR_CACHE_TTL_MS", 60_000),
    bettorLookupTimeoutMs: num("RELAYER_BETTOR_LOOKUP_TIMEOUT_MS", 2_000),
    replayStaleMs: num("RELAYER_REPLAY_STALE_MS", 120_000), // LIVE1
  };
  return {
    relayer, networkId, rpcUrls: [primary, ...fallbacks],
    accountId: need(env.RELAYER_ACCOUNT_ID, "RELAYER_ACCOUNT_ID"),
    privateKey: need(env.RELAYER_PRIVATE_KEY, "RELAYER_PRIVATE_KEY"),
    rpcPerSec: num("RELAYER_RPC_PER_SEC", 5),
    activationYocto: big("RELAYER_ACTIVATION_YOCTO", DEFAULT_ACTIVATION_YOCTO.toString())!, // FUND2: 0 = off
    indexerUrl: str(env.INDEXER_URL), bettorScanMaxViews: Math.max(1, Math.min(40, Math.floor(num("RELAYER_BETTOR_SCAN_MAX_VIEWS", 40)))),
    telegramToken: str(env.TELEGRAM_BOT_TOKEN), telegramChatId: str(env.RELAYER_ALERT_TELEGRAM_CHAT_ID),
    heartbeatEveryMs: num("RELAYER_HEARTBEAT_INTERVAL_MS", 15 * 60_000),
  };
}
