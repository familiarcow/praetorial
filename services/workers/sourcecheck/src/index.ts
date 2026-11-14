// SRCW1 Worker entry (D-HOST3, Workers Free). POST /sourcecheck (any path): {mode:"sourcecheck",terms} -> signed attestation.
// The only stateful part is the limiter Durable Object (SQLite-backed storage): per-IP SOURCECHECK_IP_PER_HOUR/h (default 10) + global 300/day.
import { DEFAULT_MAINNET_RPC_URL, DEFAULT_TESTNET_RPC_URL } from "@praetorial/common/rpc.js";
import { healthResponse } from "../../common/src/health.js";
import { telegramSink } from "../../common/src/telegram.js";
import { handleSourceCheck, parseAllowedOrigins, type AttestationCache } from "./core.js";
import { SourceCheckLimiter, ipPerHourFromEnv, type CounterStore } from "./limiter.js";
import { realChain, jsonRpcOver } from "./chain.js";
import { sharedLint } from "./lint.js";

export interface SourceCheckEnv {
  LIMITER: { idFromName(n: string): unknown; get(id: unknown): { fetch(u: string, i?: any): Promise<Response> } };
  [k: string]: unknown;
}
const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class SourceCheckLimiterDO {
  constructor(private readonly ctx: { storage: { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void> } }) {}
  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === "/cache/get" || path === "/cache/put") return this.cache(path, await req.json().catch(() => null));
    const { ip, nowMs, ipPerHour } = (await req.json()) as { ip: string; nowMs: number; ipPerHour?: unknown };
    const store: CounterStore = { get: (k) => this.ctx.storage.get(k), put: (k, v) => this.ctx.storage.put(k, v) };
    return json(200, await new SourceCheckLimiter(store, ipPerHourFromEnv(ipPerHour)).consume(ip, nowMs));
  }
  /** SECREV1 SR-2: verified attestations by spec_hash (bounded by the 300/day execution cap; each entry overwritten per sheet). */
  private async cache(path: string, b: any): Promise<Response> {
    if (!b || typeof b.specHash !== "string" || !SPEC.test(b.specHash)) return json(400, { ok: false });
    const key = `att:${b.specHash}`;
    if (path === "/cache/get") return json(200, { hit: (await this.ctx.storage.get(key)) ?? null });
    if (typeof b.checked_at !== "string" || !/^\d{1,20}$/.test(b.checked_at) || typeof b.signature_hex !== "string" || !/^[0-9a-f]{128}$/i.test(b.signature_hex)) return json(400, { ok: false });
    await this.ctx.storage.put(key, { checked_at: b.checked_at, signature_hex: b.signature_hex });
    return json(200, { ok: true });
  }
}
const SPEC = /^[0-9a-f]{64}$/;

/** SECREV1 SR-2: the AttestationCache over the limiter DO stub. */
export function doAttestationCache(stub: { fetch(u: string, i?: any): Promise<Response> }): AttestationCache {
  return {
    async get(specHash) {
      if (!SPEC.test(specHash)) return undefined;
      const r = await stub.fetch("https://limiter/cache/get", { method: "POST", body: JSON.stringify({ specHash }) });
      if (!r.ok) return undefined;
      const hit = ((await r.json()) as any)?.hit;
      return hit && typeof hit.checked_at === "string" && typeof hit.signature_hex === "string" ? { checked_at: hit.checked_at, signature_hex: hit.signature_hex } : undefined;
    },
    async put(specHash, v) {
      if (!SPEC.test(specHash)) return;
      await stub.fetch("https://limiter/cache/put", { method: "POST", body: JSON.stringify({ specHash, ...v }) });
    },
  };
}

export default {
  async fetch(request: Request, env: SourceCheckEnv): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") return healthResponse("sourcecheck", env as any); // STACK1
    const need = (n: string) => { const v = str(env[n]); if (!v) throw new Error(`missing required binding ${n}`); return v; };
    let chain;
    try {
      const rpc = jsonRpcOver(str(env.NEAR_RPC_URL) ?? (str(env.NEAR_NETWORK_ID) === "mainnet" ? DEFAULT_MAINNET_RPC_URL : DEFAULT_TESTNET_RPC_URL), { left: 45 });
      chain = realChain({ rpc, escrowContract: need("ESCROW_CONTRACT_ID"), outlayerContract: need("OUTLAYER_CONTRACT_ID"), attestAccountId: need("ATTEST_ACCOUNT_ID"), attestPrivateKey: need("SOURCECHECK_ATTEST_PRIVATE_KEY") });
    } catch (e: any) {
      console.error("sourcecheck misconfigured:", String(e?.message ?? e).replace(/ed25519:\S+/g, "<key>"));
      return json(500, { ok: false, reason: "service misconfigured" });
    }
    const sink = telegramSink(str(env.TELEGRAM_BOT_TOKEN), str(env.SOURCECHECK_ALERT_TELEGRAM_CHAT_ID));
    const ipPerHour = ipPerHourFromEnv(env.SOURCECHECK_IP_PER_HOUR); // LIVE2: testnet 60 via wrangler [vars]; unset = 10
    const limiter = { async consume(ip: string, nowMs: number) {
      const stub = env.LIMITER.get(env.LIMITER.idFromName("global"));
      return (await (await stub.fetch("https://limiter/consume", { method: "POST", body: JSON.stringify({ ip, nowMs, ipPerHour }) })).json()) as any;
    } };
    return handleSourceCheck(request, {
      allowedOrigins: parseAllowedOrigins(str(env.SOURCECHECK_ALLOWED_ORIGINS)),
      limiter, ipPerHour, lint: sharedLint, chain, alert: (m) => sink.send(m), nowMs: () => Date.now(),
      cache: doAttestationCache(env.LIMITER.get(env.LIMITER.idFromName("global"))),
    });
  },
};
