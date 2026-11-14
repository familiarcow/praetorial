// Worker bindings -> notifier config. Every name read here (via env.X) must be in services/ops/src/serviceEnv.ts (the
// "notifier" row); workers/notifier/test/static.test.ts enforces it. Missing/invalid required bindings are loud.
import { DEFAULT_MAINNET_RPC_URL, DEFAULT_TESTNET_RPC_URL } from "@praetorial/common/rpc.js";
import type { EscrowContractRef } from "@praetorial/common/config.js";
import type { AssetPriceTable } from "../../../notifier/src/highStakeRouter.js";
import { needStr, num, str, type DurableObjectNamespaceLike } from "../../common/src/tickKit.js";
import { parseContactKey } from "./contactStore.js";

export interface NotifierEnv { NOTIFIER?: DurableObjectNamespaceLike; [name: string]: unknown }

export interface NotifierConfig {
  networkId: string; rpcUrls: string[]; contracts: EscrowContractRef[]; contactKeyHex: string;
  rpcPerSec: number; minTickIntervalMs: number; batchBets: number; maxSendsPerTick: number; logKeep: number;
  telegramToken?: string; prices: AssetPriceTable; highStakeUsd: number; linkBase: string;
}

export function loadNotifierConfig(env: NotifierEnv): NotifierConfig {
  const contactKeyHex = str(env.NOTIFIER_CONTACT_KEY);
  parseContactKey(contactKeyHex); // refuse to run without a valid key (throws the same message as the node store)
  const networkId = str(env.NEAR_NETWORK_ID) ?? str(env.NEAR_NETWORK) ?? "testnet";
  const primary = str(env.NEAR_RPC_URL) ?? str(env.NEAR_NODE_URL) ?? (networkId === "mainnet" ? DEFAULT_MAINNET_RPC_URL : DEFAULT_TESTNET_RPC_URL);
  const fallbacks = (str(env.NEAR_RPC_FALLBACKS) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const multi = str(env.ESCROW_CONTRACTS);
  const contracts: EscrowContractRef[] = multi
    ? multi.split(",").map((e) => { const t = e.trim(); const at = t.indexOf("@"); const id = at === -1 ? t : t.slice(0, at); if (!id) throw new Error(`invalid ESCROW_CONTRACTS entry: "${e}"`); return { id, version: (at === -1 ? "" : t.slice(at + 1)) || "v1" }; })
    : [{ id: needStr(env.ESCROW_CONTRACT_ID, "ESCROW_CONTRACT_ID (or ESCROW_CONTRACTS)"), version: "v1" }];
  if (new Set(contracts.map((c) => c.id)).size !== contracts.length) throw new Error("duplicate escrow contract id in ESCROW_CONTRACTS");
  needStr(env.INTENTS_CONTRACT_ID, "INTENTS_CONTRACT_ID");
  let prices: AssetPriceTable;
  const pj = str(env.NOTIFIER_ASSET_PRICES);
  if (pj) { try { prices = JSON.parse(pj) as AssetPriceTable; } catch (e: any) { throw new Error(`NOTIFIER_ASSET_PRICES is not valid JSON: ${e.message}`); } }
  else prices = { [str(env.NOTIFIER_STAKE_ASSET_ID) ?? "usdc.fakes.testnet"]: { decimals: num(env.NOTIFIER_STAKE_ASSET_DECIMALS, 6), usdPerToken: num(env.NOTIFIER_STAKE_ASSET_USD_PRICE, 1) } };
  return {
    networkId, rpcUrls: [primary, ...fallbacks], contracts, contactKeyHex: contactKeyHex!,
    rpcPerSec: num(env.NOTIFIER_RPC_PER_SEC, 3), minTickIntervalMs: num(env.NOTIFIER_MIN_TICK_INTERVAL_MS, 30_000),
    batchBets: Math.max(1, Math.floor(num(env.NOTIFIER_BATCH_BETS, 12))), maxSendsPerTick: Math.max(0, Math.floor(num(env.NOTIFIER_MAX_SENDS_PER_TICK, 10))),
    logKeep: Math.max(1, Math.floor(num(env.NOTIFIER_LOG_KEEP, 1000))),
    ...(str(env.TELEGRAM_BOT_TOKEN) ? { telegramToken: str(env.TELEGRAM_BOT_TOKEN)! } : {}),
    prices, highStakeUsd: num(env.NOTIFIER_HIGH_STAKE_USD, 500), linkBase: str(env.NOTIFIER_BET_LINK_BASE) ?? "https://testnet.praetorial.example/bet",
  };
}
