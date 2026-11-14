// F1 funding Worker entry (FUND4 SPEC §7.1, D-FUND4/D-FUND4a). Holds NO NEAR keys. One secret: ONECLICK_API_KEY (1Click partner
// JWT, `wrangler secret put ONECLICK_API_KEY --env mainnet`), read from env only, sent only as X-API-Key to 1Click, never logged
// or returned. State: one SQLite Durable Object (FUNDING_STORE, instance "global") holding the in-flight swap records and the
// rate-limit counters (same single-instance pattern as sourcecheck's limiter; volume is a few quotes per user per day).
import { healthBody } from "../../common/src/health.js";
import { DEFAULT_MAINNET_RPC_URL, DEFAULT_TESTNET_RPC_URL } from "../../../common/src/rpc.js";
import { handleFunding, TokenCache, type FundingConfig } from "./core.js";
import { oneClickClient } from "./oneclick.js";
import { intentsChain } from "./chain.js";
import { FundingState } from "./store.js";
import { configFromEnv, DEFAULT_ONECLICK_BASE_URL, doStore, kvOfStorage, scrubbedLogger, STORE_OPS, type DoNamespace, type DoStorage, type StoreOp } from "./env.js";

const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/** The Durable Object: a thin RPC shell over FundingState (one request = one op, so read-modify-write ops are atomic). */
export class FundingStoreDO {
  private readonly state: FundingState;
  constructor(ctx: { storage: DoStorage }) { this.state = new FundingState(kvOfStorage(ctx.storage)); }
  async fetch(req: Request): Promise<Response> {
    const { op, args } = (await req.json()) as { op: StoreOp; args: unknown[] };
    if (!STORE_OPS.includes(op)) return Response.json({ error: "bad op" }, { status: 400 });
    const result = await (this.state[op] as (...a: unknown[]) => Promise<unknown>)(...args);
    return Response.json({ result: result ?? null });
  }
}

const tokenCache = new TokenCache();

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ...healthBody("funding", env), keyConfigured: !!str(env.ONECLICK_API_KEY) }, { headers: { "cache-control": "no-store" } });
    }
    const apiKey = str(env.ONECLICK_API_KEY);
    const log = scrubbedLogger(apiKey);
    let config: FundingConfig;
    try { config = configFromEnv(env); } catch (e: any) {
      log({ evt: "misconfigured", message: String(e?.message ?? e) });
      return Response.json({ ok: false, code: "misconfigured", message: "service misconfigured" }, { status: 500 });
    }
    return handleFunding(request, {
      config,
      oneclick: oneClickClient({ baseUrl: str(env.ONECLICK_BASE_URL) ?? DEFAULT_ONECLICK_BASE_URL, apiKey, gitSha: str(env.GIT_SHA) }),
      store: doStore(env.FUNDING_STORE as DoNamespace),
      chain: intentsChain({ rpcUrl: str(env.NEAR_RPC_URL) ?? (config.network === "mainnet" ? DEFAULT_MAINNET_RPC_URL : DEFAULT_TESTNET_RPC_URL), intentsContract: str(env.INTENTS_CONTRACT_ID) ?? "intents.near" }),
      tokens: tokenCache,
      log,
      nowMs: () => Date.now(),
    });
  },
};
