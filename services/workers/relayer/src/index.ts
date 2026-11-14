// Relayer Worker (CF1b, D-HOST3). fetch() serves the relay HTTP API with parity to services/relayer:
//   POST /relay {signedDelegate: base64}  -> {ok, txHash} | {ok:false, error} (400 caller errors, 429 global cap,
//   413 oversize, 500 internal) | 202 {ok:false, status:"unknown", txHash} (SEC1: sent, outcome not known yet)
//   POST /relay/status {txHash}|{senderId, nonce} -> {ok, state}   GET /budget/global -> monitor feed   POST /heartbeat -> dispatcher job.
// Every request goes to ONE Durable Object (RelayerDO) whose SQLite storage holds the replay guard, rate-limit
// windows and budgets (survives restarts); the DO runs the same RelayerCore / policy / GuardStoreCore as the node
// relayer, with WebCrypto in place of tweetnacl/node:crypto/near-api-js.
import { PacedRpcClient, RateLimiter } from "@praetorial/common/rpc.js";
import { RelayerCore, type RelayerConfig } from "../../../relayer/src/relayerCore.js";
import { GuardStoreCore } from "../../../relayer/src/guardStoreCore.js";
import { indexerBettorLookup, bettorLookupWithFallback, boundedEscrowBettorLookup, type BettorLookup } from "../../../relayer/src/bettor.js";
import { MAX_BODY_BYTES, parseRelayBody, errorResponse, budgetJson, describeInternal } from "../../../relayer/src/httpMap.js";
import { activateImplicitAccount } from "../../../relayer/src/activation.js";
import { BadRequest } from "../../../relayer/src/httpMap.js";
import { healthResponse } from "../../common/src/health.js";
import { telegramSink } from "../../common/src/telegram.js";
import { decodeSignedDelegateWeb, verifySignedDelegateWeb } from "./delegateWeb.js";
import { WorkerRelayChain, type BroadcastShared } from "./chain.js";
import { doBettorScanStore } from "./bettorScan.js";
import { WorkerNearClient } from "../../common/src/nearWebClient.js";
import { doSqlDriver, type DoStorage } from "./guardDriver.js";
import { runFaucet, faucetCfg } from "./faucet.js";
import { ConfigError, loadRelayerConfig, type RelayerEnv, type WorkerRelayerConfig } from "./env.js";

export { relayerHeartbeatJob } from "./job.js";
export type { RelayerEnv } from "./env.js";

/** Free-plan subrequest cap is 50 per invocation (keeper uses 44). Relay chain: block + access key + send_tx = 3;
 * indexer lookup 1; bounded escrow scan <= cfg.bettorScanMaxViews (default 40): 3 + 1 + 40 = 44. */
const SUBREQUEST_BUDGET = 12;
/** SEC1/MON-9 /activate: account view 1 + one balance per stake asset (6 on mainnet) + up to one asset_limit per held asset
 * + block/access key/send_tx 3 = at most 16 on mainnet. */
const ACTIVATE_SUBREQUEST_BUDGET = 24;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Best-effort delegate sender id for logs (public). Never throws. */
function senderOf(body: string): string {
  try { return decodeSignedDelegateWeb(parseRelayBody(body)).delegateAction.senderId; } catch { return "-"; }
}
export class RelayerDO {
  private cfg?: WorkerRelayerConfig;
  private guards?: GuardStoreCore;
  private bettor?: BettorLookup;
  private scanStore?: ReturnType<typeof doBettorScanStore>;
  private readonly shared: BroadcastShared = { lastNonce: 0n, tail: Promise.resolve() };
  constructor(private readonly ctx: { storage: DoStorage }, private readonly env: RelayerEnv) {}

  private init(): { cfg: WorkerRelayerConfig; guards: GuardStoreCore } {
    // Config is (re)validated on every call so a missing secret is a loud 500, never a silent default.
    const cfg = (this.cfg = loadRelayerConfig(this.env));
    this.guards ??= new GuardStoreCore(doSqlDriver(this.ctx.storage), cfg.relayer);
    // RLY1 parity: indexer first (when configured), escrow get_bet scan when it is absent or fails; any failure => non-bettor.
    this.bettor ??= this.makeBettor(cfg);
    return { cfg, guards: this.guards };
  }

  private makeBettor(cfg: WorkerRelayerConfig): BettorLookup {
    const paced = new PacedRpcClient({ urls: cfg.rpcUrls, limiter: new RateLimiter(cfg.rpcPerSec, 4), fetchImpl: (u, i) => fetch(u, i) });
    // View-only client with its own hard cap; created per scan so every request gets a fresh budget.
    const scan: BettorLookup = (a) => boundedEscrowBettorLookup(
      new WorkerNearClient({ rpc: paced, accountId: cfg.accountId, privateKey: cfg.privateKey, maxAttachedYocto: 0n, maxSubrequests: cfg.bettorScanMaxViews }) as any,
      cfg.relayer.escrowContract, this.scanStore ??= doBettorScanStore(this.ctx.storage), { refreshMs: cfg.relayer.bettorCacheTtlMs, maxViews: cfg.bettorScanMaxViews },
    )(a);
    return bettorLookupWithFallback(cfg.indexerUrl ? indexerBettorLookup(cfg.indexerUrl) : undefined, scan);
  }

  private makeCore(cfg: WorkerRelayerConfig, guards: GuardStoreCore): RelayerCore {
    const paced = new PacedRpcClient({ urls: cfg.rpcUrls, limiter: new RateLimiter(cfg.rpcPerSec, 4), fetchImpl: (u, i) => fetch(u, i) });
    const chain = new WorkerRelayChain({ rpc: paced, accountId: cfg.accountId, privateKey: cfg.privateKey, maxSubrequests: SUBREQUEST_BUDGET }, this.shared);
    return new RelayerCore(
      { decode: (b64) => { const d = decodeSignedDelegateWeb(b64); chain.register(d); return d as any; }, verify: (d) => verifySignedDelegateWeb(d as any) },
      chain, cfg.relayer as RelayerConfig, guards, this.bettor,
    );
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let body = "";
    try {
      if (req.method === "POST" && url.pathname === "/heartbeat") return await this.heartbeat();
      if (req.method === "GET" && url.pathname === "/budget/global") {
        const { cfg, guards } = this.init();
        return json(200, budgetJson(this.makeCore(cfg, guards).globalBudgetStatus()));
      }
      if (req.method === "POST" && url.pathname === "/faucet") {
        // FUND1b: testnet-only; the Worker answers 404 on mainnet. The IP comes from the web Worker's x-client-ip (set from cf-connecting-ip).
        const { cfg } = this.init();
        let account: unknown; try { account = (JSON.parse(await req.text()) as any)?.account; } catch { account = undefined; }
        const ip = req.headers.get("x-client-ip") ?? req.headers.get("cf-connecting-ip") ?? "unknown";
        const paced = new PacedRpcClient({ urls: cfg.rpcUrls, limiter: new RateLimiter(cfg.rpcPerSec, 4), fetchImpl: (u, i) => fetch(u, i) });
        const r = await runFaucet({ cfg: faucetCfg(this.env as any, cfg.networkId), storage: this.ctx.storage, rpc: paced, signerId: cfg.accountId, secretKey: cfg.privateKey, account, ip });
        return json(r.status, r.body);
      }
      if (req.method === "POST" && url.pathname === "/activate") return await this.activate(req);
      if (req.method === "POST" && url.pathname === "/relay/status") return await this.relayStatus(req);
      if (req.method !== "POST" || url.pathname !== "/relay") return json(404, { error: "POST /relay only" });
      const declared = Number(req.headers.get("content-length") ?? "0");
      if (declared > MAX_BODY_BYTES) return json(413, { ok: false, error: "request body too large" });
      body = await req.text();
      if (new TextEncoder().encode(body).length > MAX_BODY_BYTES) return json(413, { ok: false, error: "request body too large" });
      const { cfg, guards } = this.init();
      const result = await this.makeCore(cfg, guards).relay(parseRelayBody(body));
      if (result.status === "unknown") {
        // SEC1/MON-2: handed to the chain, outcome not known yet. Never "failed": the client checks /relay/status before re-signing.
        console.warn(`[relayer] outcome-unknown ${senderOf(body)} tx=${result.txHash}`);
        return json(202, { ok: false, status: "unknown", txHash: result.txHash, error: "sent to NEAR, but the result is not known yet; check its status before sending again" });
      }
      if (result.receiptFailure) {
        // LIVE1 2b: relayed and executed, but the user's call failed on chain -- never report that as a success.
        console.warn(`[relayer] executed-with-failure ${senderOf(body)} tx=${result.txHash}: ${result.receiptFailure.slice(0, 300)}`);
        return json(200, { ok: false, txHash: result.txHash, receiptFailure: result.receiptFailure, error: `transaction failed on chain: ${result.receiptFailure}` });
      }
      return json(200, { ok: true, txHash: result.txHash });
    } catch (err: any) {
      if (err instanceof ConfigError) return json(500, { ok: false, error: err.message });
      const e = errorResponse(err);
      // LIVE1 2c: log every refusal reason (public ids and the client-safe message only) so `wrangler tail` shows it.
      if (e.internal) console.error(`[relayer] 500 ${senderOf(body)} internal error: ${describeInternal(err)}`);
      else console.warn(`[relayer] ${e.status} ${senderOf(body)}: ${e.body.error}`);
      return json(e.status, e.body);
    }
  }

  /** SEC1/MON-2: POST /relay/status {txHash} | {senderId, nonce} -> {ok, state: executed|failed|pending|not_executed|not_found, txHash?, receiptFailure?}. */
  private async relayStatus(req: Request): Promise<Response> {
    try {
      const text = await req.text();
      if (text.length > 1024) return json(413, { ok: false, error: "request body too large" });
      let p: any;
      try { p = JSON.parse(text); } catch { throw new BadRequest("body must be JSON"); }
      let by: { txHash: string } | { senderId: string; nonce: bigint };
      if (p && typeof p.txHash === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(p.txHash)) by = { txHash: p.txHash };
      else if (p && typeof p.senderId === "string" && p.senderId.length <= 64 && /^\d{1,20}$/.test(String(p.nonce ?? ""))) by = { senderId: p.senderId, nonce: BigInt(p.nonce) };
      else throw new BadRequest("body must be { txHash } or { senderId, nonce }");
      const { cfg, guards } = this.init();
      const r = await this.makeCore(cfg, guards).status(by);
      return json(200, { ok: true, ...r });
    } catch (err: any) {
      if (err instanceof ConfigError) return json(500, { ok: false, error: err.message });
      const e = errorResponse(err);
      if (e.internal) console.error(`[relayer] status 500: ${describeInternal(err)}`);
      return json(e.status, e.body);
    }
  }

  /** FUND2: POST /activate {accountId} -> create a deposit-only user's implicit account (gate in relayer/src/activation.ts). */
  private async activate(req: Request): Promise<Response> {
    let accountId = "-";
    try {
      const text = await req.text();
      if (text.length > 1024) return json(413, { ok: false, error: "request body too large" });
      let payload: any;
      try { payload = JSON.parse(text); } catch { throw new BadRequest("body must be JSON"); }
      if (!payload || typeof payload.accountId !== "string") throw new BadRequest("body must be { accountId: string }");
      accountId = payload.accountId;
      const { cfg, guards } = this.init();
      const paced = new PacedRpcClient({ urls: cfg.rpcUrls, limiter: new RateLimiter(cfg.rpcPerSec, 4), fetchImpl: (u, i) => fetch(u, i) });
      const chain = new WorkerRelayChain({ rpc: paced, accountId: cfg.accountId, privateKey: cfg.privateKey, maxSubrequests: ACTIVATE_SUBREQUEST_BUDGET }, this.shared);
      const r = await activateImplicitAccount({
        accountId, cfg: cfg.relayer, activationYocto: cfg.activationYocto, guards,
        ports: { accountExists: (a) => chain.accountExists(a), intentsBalance: (a, t) => chain.intentsBalance(cfg.relayer.intentsContract, a, t),
          minStake: (t) => chain.minStake(cfg.relayer.escrowContract, t), transfer: (to, y) => chain.transfer(to, y) },
      });
      if (r.activated) console.log(`[relayer] activated ${accountId} tx=${r.txHash}`);
      else if (r.inProgress) console.log(`[relayer] activate ${accountId}: already in progress`);
      return json(200, { ok: true, ...r });
    } catch (err: any) {
      if (err instanceof ConfigError) return json(500, { ok: false, error: err.message });
      const e = errorResponse(err);
      if (e.internal) console.error(`[relayer] activate 500 ${accountId}: ${describeInternal(err)}`);
      else console.warn(`[relayer] activate ${e.status} ${accountId}: ${e.body.error}`);
      return json(e.status, e.body);
    }
  }

  /** MON4 liveness: one Telegram heartbeat per interval; the last-sent time is persisted so restarts don't spam. */
  private async heartbeat(): Promise<Response> {
    const { cfg, guards } = this.init();
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS relayer_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)").toArray();
    const now = Date.now();
    // SEC1/MON-10: settle a few unresolved (outcome unknown / orphaned mid-send) submissions on every poke.
    try { await this.makeCore(cfg, guards).sweep(3); } catch (e) { console.error(`[relayer] sweep: ${describeInternal(e)}`); }
    const last = Number(sql.exec("SELECT v FROM relayer_meta WHERE k = ?", "lastHeartbeat").toArray()[0]?.v ?? 0);
    if (now - last < cfg.heartbeatEveryMs) return json(200, { ok: true, sent: false });
    sql.exec("INSERT OR REPLACE INTO relayer_meta (k, v) VALUES (?, ?)", "lastHeartbeat", String(now)).toArray();
    const g = guards.globalBudgetStatus();
    await telegramSink(cfg.telegramToken, cfg.telegramChatId).send(`relayer heartbeat ok: global gas ${g.usedYocto}/${g.capYocto} yocto used this window`);
    return json(200, { ok: true, sent: true });
  }
}

export default {
  async fetch(req: Request, env: RelayerEnv): Promise<Response> {
    if (req.method === "GET" && new URL(req.url).pathname === "/health") return healthResponse("relayer", env as any); // STACK1: no DO, no signing
    if (!env.RELAYER) return json(500, { ok: false, error: "RELAYER Durable Object binding missing" });
    return env.RELAYER.get(env.RELAYER.idFromName("relayer")).fetch(req.url, { method: req.method, headers: req.headers, body: req.method === "GET" ? undefined : await req.text() });
  },
};
