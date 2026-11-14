// Worker bindings -> keeper config. Every name read here must be in services/ops/src/serviceEnv.ts
// (keeper row); workers/keeper/test/static.test.ts enforces it.
import { DEFAULT_MAINNET_RPC_URL, DEFAULT_TESTNET_RPC_URL } from "@praetorial/common/rpc.js";

export interface KeeperEnv {
  KEEPER?: DurableObjectNamespaceLike;
  [name: string]: unknown;
}
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string, init?: any): Promise<Response> };
}
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

export interface KeeperConfig {
  networkId: string; rpcUrls: string[]; contracts: { id: string; version: string }[];
  accountId: string; privateKey: string; rpcPerSec: number; maxAttachedYocto: bigint; attachedYocto?: bigint;
  telegramToken?: string; telegramChatId?: string;
  limits: { maxActions?: number; maxViews?: number; maxDrains?: number; maxRelays?: number; heartbeatEveryMs?: number };
}

export function loadKeeperConfig(env: KeeperEnv): KeeperConfig {
  const need = (v: unknown, name: string): string => { const s = str(v); if (!s) throw new Error(`missing required binding ${name}`); return s; };
  const networkId = str(env.NEAR_NETWORK_ID) ?? str(env.NEAR_NETWORK) ?? "testnet";
  const primary = str(env.NEAR_RPC_URL) ?? str(env.NEAR_NODE_URL) ?? (networkId === "mainnet" ? DEFAULT_MAINNET_RPC_URL : DEFAULT_TESTNET_RPC_URL);
  const fallbacks = (str(env.NEAR_RPC_FALLBACKS) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  need(env.INTENTS_CONTRACT_ID, "INTENTS_CONTRACT_ID");
  const multi = str(env.ESCROW_CONTRACTS);
  const contracts = multi
    ? multi.split(",").map((e) => { const t = e.trim(); const at = t.indexOf("@"); const id = at === -1 ? t : t.slice(0, at); if (!id) throw new Error(`invalid ESCROW_CONTRACTS entry: "${e}"`); return { id, version: (at === -1 ? "" : t.slice(at + 1)) || "v1" }; })
    : [{ id: need(env.ESCROW_CONTRACT_ID, "ESCROW_CONTRACT_ID (or ESCROW_CONTRACTS)"), version: "v1" }];
  if (new Set(contracts.map((c) => c.id)).size !== contracts.length) throw new Error("duplicate escrow contract id in ESCROW_CONTRACTS");
  const num = (v: unknown) => (str(v) !== undefined ? Number(str(v)) : undefined);
  const attach = str(env.KEEPER_ATTACH_NEAR_YOCTO);
  return {
    networkId, rpcUrls: [primary, ...fallbacks], contracts,
    accountId: need(env.KEEPER_ACCOUNT_ID, "KEEPER_ACCOUNT_ID"),
    privateKey: need(env.KEEPER_PRIVATE_KEY, "KEEPER_PRIVATE_KEY"),
    rpcPerSec: num(env.KEEPER_RPC_PER_SEC) ?? 3,
    maxAttachedYocto: BigInt(str(env.MAX_ATTACHED_NEAR_YOCTO) ?? "50000000000000000000000"),
    attachedYocto: attach !== undefined ? BigInt(attach) : undefined,
    telegramToken: str(env.TELEGRAM_BOT_TOKEN), telegramChatId: str(env.KEEPER_ALERT_TELEGRAM_CHAT_ID),
    limits: { maxActions: num(env.KEEPER_MAX_ACTIONS_PER_TICK), maxViews: num(env.KEEPER_MAX_VIEWS_PER_TICK), maxDrains: num(env.KEEPER_MAX_DRAINS_PER_TICK), maxRelays: num(env.KEEPER_MAX_RELAYS_PER_TICK), heartbeatEveryMs: num(env.KEEPER_HEARTBEAT_EVERY_MS) },
  };
}
