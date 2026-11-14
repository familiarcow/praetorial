// Worker bindings -> monitor config. Every name read here (via env.X) must be in services/ops/src/serviceEnv.ts
// (the "monitor:alerts" row); workers/monitor/test/static.test.ts enforces it. Missing required bindings are loud.
import { DEFAULT_MAINNET_RPC_URL, DEFAULT_TESTNET_RPC_URL } from "@praetorial/common/rpc.js";
import { needStr, num, str } from "../../common/src/tickKit.js";
import { DEFAULT_STUCK_PAYOUT_THRESHOLD_MS } from "../../../monitor/src/stuckPayouts.js";

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string, init?: any): Promise<Response> };
}
export interface MonitorEnv {
  MONITOR?: DurableObjectNamespaceLike;
  [name: string]: unknown;
}

export interface MonitorConfig {
  networkId: string; rpcUrls: string[]; escrow: string; intents: string; usdc: string; feeAccount: string; keeperAccount: string;
  stallGraceNs: number; cooldownNs: number; rpcErrorThresholdRatio: number; rpcMinConsecutiveTicks: number;
  rpcPerSec: number; minTickIntervalMs: number; batchBets: number;
  stuckPayoutThresholdMs: number;
  relayerBudgetUrl?: string; creditWatch: { account: string; floor: string; burn?: string }[];
  telegramToken?: string; telegramChatId?: string;
}

export function loadMonitorConfig(env: MonitorEnv): MonitorConfig {
  const networkId = str(env.NEAR_NETWORK_ID) ?? str(env.NEAR_NETWORK) ?? "testnet";
  const primary = str(env.NEAR_RPC_URL) ?? str(env.NEAR_NODE_URL) ?? (networkId === "mainnet" ? DEFAULT_MAINNET_RPC_URL : DEFAULT_TESTNET_RPC_URL);
  const fallbacks = (str(env.NEAR_RPC_FALLBACKS) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const creditWatch = (str(env.CREDIT_WATCH) ?? "").split(",").filter(Boolean).map((e) => {
    const [account, floor, burn] = e.split(":");
    if (!account || !floor) throw new Error(`invalid CREDIT_WATCH entry: "${e}" (want account:floor[:burnPerDay])`);
    return { account, floor, ...(burn ? { burn } : {}) };
  });
  const telegramToken = str(env.ALERT_TELEGRAM_BOT_TOKEN), telegramChatId = str(env.ALERT_TELEGRAM_CHAT_ID);
  return {
    networkId, rpcUrls: [primary, ...fallbacks],
    escrow: needStr(env.ESCROW_CONTRACT_ID, "ESCROW_CONTRACT_ID"), intents: needStr(env.INTENTS_CONTRACT_ID, "INTENTS_CONTRACT_ID"),
    usdc: str(env.USDC_TOKEN_ID) ?? "usdc.fakes.testnet", feeAccount: str(env.FEE_ACCOUNT_ID) ?? "", keeperAccount: str(env.KEEPER_ACCOUNT_ID) ?? "",
    stallGraceNs: num(env.ALERT_STALL_GRACE_MS, 10 * 60_000) * 1e6, cooldownNs: num(env.ALERT_COOLDOWN_MS, 30 * 60_000) * 1e6,
    rpcErrorThresholdRatio: num(env.ALERT_RPC_ERROR_THRESHOLD, 0.5), rpcMinConsecutiveTicks: num(env.ALERT_RPC_MIN_CONSECUTIVE_TICKS, 3),
    rpcPerSec: num(env.MONITOR_RPC_PER_SEC, 3), minTickIntervalMs: num(env.MONITOR_MIN_TICK_INTERVAL_MS, 30_000),
    batchBets: Math.max(1, Math.floor(num(env.MONITOR_BATCH_BETS, 20))),
    stuckPayoutThresholdMs: num(env.ALERT_STUCK_PAYOUT_MS, DEFAULT_STUCK_PAYOUT_THRESHOLD_MS),
    ...(str(env.RELAYER_BUDGET_URL) ? { relayerBudgetUrl: str(env.RELAYER_BUDGET_URL)! } : {}), creditWatch,
    ...(telegramToken && telegramChatId ? { telegramToken, telegramChatId } : {}),
  };
}
