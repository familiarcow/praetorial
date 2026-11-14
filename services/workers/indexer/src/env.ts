// Worker bindings -> indexer config. Every name read here (via env.X) must be in services/ops/src/serviceEnv.ts (the
// "indexer" row); workers/indexer/test/static.test.ts enforces it. Missing/invalid required bindings are loud.
import { DEFAULT_MAINNET_RPC_URL, DEFAULT_TESTNET_RPC_URL } from "@praetorial/common/rpc.js";
import type { EscrowContractRef } from "@praetorial/common/config.js";
import { needStr, num, str, SUBREQUEST_BUDGET } from "../../common/src/tickKit.js";
import { servedContracts } from "../../../indexer/src/served.js";

export interface D1Stmt { bind(...a: unknown[]): D1Stmt; first<T = any>(): Promise<T | null>; all<T = any>(): Promise<{ results: T[] }>; run(): Promise<{ meta?: { changes?: number } }> }
export interface D1Like { prepare(sql: string): D1Stmt; batch(stmts: D1Stmt[]): Promise<unknown[]> }
export interface IndexerEnv { INDEXER_DB?: D1Like; [name: string]: unknown }

export interface IndexerConfig {
  networkId: string; rpcUrls: string[]; contracts: EscrowContractRef[]; txIndexerUrl: string;
  rpcPerSec: number; minTickIntervalMs: number; govMinIntervalMs: number; batchBets: number; maxConfirms: number;
}

/** IDX1: the escrow contracts the indexer ingests AND serves. ESCROW_CONTRACT_ID set -> exactly that one (the escrow the web
 * and every other service use; its version label comes from ESCROW_CONTRACTS when listed). Only ESCROW_CONTRACTS -> that list
 * (D-UPGRADE1). Rows of any other contract stay in D1 but are never read, confirmed or served. */
export function loadServedContracts(env: IndexerEnv): EscrowContractRef[] {
  const multi = str(env.ESCROW_CONTRACTS);
  const contracts: EscrowContractRef[] = multi
    ? multi.split(",").map((e) => { const t = e.trim(); const at = t.indexOf("@"); const id = at === -1 ? t : t.slice(0, at); if (!id) throw new Error(`invalid ESCROW_CONTRACTS entry: "${e}"`); return { id, version: (at === -1 ? "" : t.slice(at + 1)) || "v1" }; })
    : [{ id: needStr(env.ESCROW_CONTRACT_ID, "ESCROW_CONTRACT_ID (or ESCROW_CONTRACTS)"), version: "v1" }];
  if (new Set(contracts.map((c) => c.id)).size !== contracts.length) throw new Error("duplicate escrow contract id in ESCROW_CONTRACTS");
  return servedContracts(contracts, str(env.ESCROW_CONTRACT_ID));
}

export function loadIndexerConfig(env: IndexerEnv): IndexerConfig {
  const networkId = str(env.NEAR_NETWORK_ID) ?? str(env.NEAR_NETWORK) ?? "testnet";
  const primary = str(env.NEAR_RPC_URL) ?? str(env.NEAR_NODE_URL) ?? (networkId === "mainnet" ? DEFAULT_MAINNET_RPC_URL : DEFAULT_TESTNET_RPC_URL);
  const fallbacks = (str(env.NEAR_RPC_FALLBACKS) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const contracts = loadServedContracts(env);
  needStr(env.INTENTS_CONTRACT_ID, "INTENTS_CONTRACT_ID");
  const maxConfirms = Math.max(0, Math.floor(num(env.INDEXER_MAX_CONFIRMS_PER_TICK, 3)));
  // hard subrequest budget per invocation: version checks (1 per contract) + confirmations + bet reads must all fit
  const readCap = Math.max(1, SUBREQUEST_BUDGET - contracts.length - maxConfirms - 2);
  return {
    networkId, rpcUrls: [primary, ...fallbacks], contracts,
    txIndexerUrl: (str(env.NEAR_TX_INDEXER_URL) ?? (networkId === "mainnet" ? "https://tx.main.fastnear.com" : "https://tx.test.fastnear.com")).replace(/\/+$/, ""),
    rpcPerSec: num(env.INDEXER_RPC_PER_SEC, 8), minTickIntervalMs: num(env.INDEXER_MIN_TICK_INTERVAL_MS, 20_000),
    govMinIntervalMs: num(env.INDEXER_GOVERNANCE_MIN_INTERVAL_MS, 240_000),
    batchBets: Math.min(readCap, Math.max(1, Math.floor(num(env.INDEXER_BATCH_BETS, 12)))), maxConfirms,
  };
}
