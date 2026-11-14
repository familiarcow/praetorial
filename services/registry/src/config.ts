import { DEFAULT_TESTNET_RPC_URL } from "@praetorial/common/rpc.js";
export interface RegistryConfig {
  registryId: string; port: number; storePath: string | undefined; rpcUrl: string;
  corsOrigins: string[]; rate: { capacity: number; refillPerSec: number }; trustProxy: boolean;
}
export function loadRegistryConfig(env: Record<string, string | undefined> = process.env): RegistryConfig {
  const registryId = env.REGISTRY_ID;
  if (!registryId) throw new Error("REGISTRY_ID is required (NEP-413 recipient)");
  return {
    registryId,
    port: Number(env.REGISTRY_PORT ?? 8790),
    storePath: env.REGISTRY_STORE_PATH,
    rpcUrl: env.NEAR_RPC_URL ?? DEFAULT_TESTNET_RPC_URL,
    corsOrigins: (env.REGISTRY_CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    rate: { capacity: Number(env.REGISTRY_RATE_CAPACITY ?? 20), refillPerSec: Number(env.REGISTRY_RATE_REFILL_PER_SEC ?? 0.5) },
    trustProxy: env.REGISTRY_TRUST_PROXY === "1",
  };
}
