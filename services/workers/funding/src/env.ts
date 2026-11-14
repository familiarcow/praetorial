// F1: env -> config, the Durable Object store proxy, and the key-scrubbing logger (kept out of index.ts: a workerd entry
// module may only export handlers and Durable Object classes).
import { parseAllowedOrigins, type FundingConfig, type StoreApi } from "./core.js";
import type { Kv } from "./store.js";

import { ONECLICK_OFFICIAL_BASE_URL } from "./oneclick.js";

export const DEFAULT_ONECLICK_BASE_URL = ONECLICK_OFFICIAL_BASE_URL;
const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

export interface DoStorage {
  get<T>(k: string): Promise<T | undefined>;
  put(k: string, v: unknown): Promise<void>;
  list<T>(o: { prefix: string; limit: number }): Promise<Map<string, T>>;
}
export const kvOfStorage = (s: DoStorage): Kv => ({ get: (k) => s.get(k), put: (k, v) => s.put(k, v), list: (prefix, limit) => s.list({ prefix, limit }) });

export const STORE_OPS = ["consume", "get", "insertCapped", "patch", "listAccount"] as const;
export type StoreOp = (typeof STORE_OPS)[number];

export interface DoNamespace { idFromName(n: string): unknown; get(id: unknown): { fetch(u: string, i?: RequestInit): Promise<Response> } }
export function doStore(ns: DoNamespace): StoreApi {
  const stub = ns.get(ns.idFromName("global"));
  const call = async (op: StoreOp, ...args: unknown[]) => {
    const r = await stub.fetch("https://funding-store/op", { method: "POST", body: JSON.stringify({ op, args }) });
    if (!r.ok) throw new Error(`store ${op} failed (${r.status})`);
    return ((await r.json()) as { result: any }).result;
  };
  return {
    consume: (rules, nowMs) => call("consume", rules, nowMs),
    get: (a) => call("get", a),
    insertCapped: (r, max, nowMs) => call("insertCapped", r, max, nowMs),
    patch: (a, p) => call("patch", a, p),
    listAccount: (a, nowMs) => call("listAccount", a, nowMs),
  };
}

export function configFromEnv(env: Record<string, unknown>): FundingConfig {
  const network = str(env.NEAR_NETWORK_ID) === "mainnet" ? "mainnet" : "testnet";
  const ids = (str(env.BETTING_ASSET_IDS) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length !== 6 || ids.some((i) => !/^nep141:[a-z0-9._-]+$/.test(i))) throw new Error("BETTING_ASSET_IDS must list the 6 bet token ids (nep141:...)");
  return {
    network, bettingAssetIds: ids, allowedOrigins: parseAllowedOrigins(str(env.FUNDING_ALLOWED_ORIGINS)),
    referral: str(env.ONECLICK_REFERRAL) ?? "praetorial",
    // fail safe: anything but an explicit "0" on mainnet keeps real quotes off
    dryOnly: !(network === "mainnet" && str(env.FUNDING_DRY_ONLY) === "0"),
  };
}

/** Never print a value that contains the key (belt and braces: nothing logged is built from it). */
export function scrubbedLogger(secret: string | undefined, sink: (line: string) => void = (l) => console.log(l)) {
  return (e: Record<string, unknown>) => {
    let line = JSON.stringify({ svc: "funding", ...e });
    if (secret && secret.length >= 8) line = line.split(secret).join("<redacted>");
    sink(line);
  };
}

