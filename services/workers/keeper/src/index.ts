// Keeper Worker entry (CF1a, D-HOST3). scheduled() -> shared dispatcher -> keeper job -> the
// KeeperDO (SQLite-backed Durable Object) which owns state and serialises ticks, so two
// overlapping cron invocations can never double-fire an action.
import { PacedRpcClient, RateLimiter } from "@praetorial/common/rpc.js";
import { runDispatcher, type Job } from "../../common/src/dispatcher.js";
import { WorkerNearClient } from "../../common/src/nearWebClient.js";
import { healthResponse } from "../../common/src/health.js";
import { telegramSink } from "../../common/src/telegram.js";
import { relayerHeartbeatJob } from "../../relayer/src/job.js";
import { monitorTickJob } from "../../monitor/src/job.js";
import { notifierTickJob } from "../../notifier/src/job.js";
import { indexerTickJob, indexerGovernanceJob } from "../../indexer/src/job.js";
import { loadKeeperConfig, type KeeperEnv } from "./env.js";
import { runKeeperTick, emptyState, type KeeperState, type StateStore } from "./tick.js";

/** Free-plan subrequest cap is 50 per invocation; keep headroom for Telegram + the DO hop. */
const SUBREQUEST_BUDGET = 44;

interface SqlStorage { exec(q: string, ...b: unknown[]): { toArray(): any[] }; }
interface DOState { storage: { sql: SqlStorage } }

class SqliteStateStore implements StateStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS keeper_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }
  async load(): Promise<KeeperState> {
    const rows = this.sql.exec("SELECT v FROM keeper_state WHERE k = ?", "state").toArray();
    return rows.length ? { ...emptyState(), ...JSON.parse(rows[0].v) } : emptyState();
  }
  async save(s: KeeperState): Promise<void> {
    this.sql.exec("INSERT OR REPLACE INTO keeper_state (k, v) VALUES (?, ?)", "state", JSON.stringify(s));
  }
}

export class KeeperDO {
  constructor(private readonly ctx: DOState, private readonly env: KeeperEnv) {}

  async fetch(req: Request): Promise<Response> {
    // STACK1: GET /health reads the existing state only (never ticks); public fields only.
    if (req.method === "GET") {
      if (new URL(req.url).pathname !== "/health") return Response.json({ ok: false, error: "not found" }, { status: 404 });
      const st = await new SqliteStateStore(this.ctx.storage.sql).load();
      return healthResponse("keeper", this.env, { lastTickMs: st.lastTickMs ?? 0 });
    }
    try {
      const cfg = loadKeeperConfig(this.env);
      const paced = new PacedRpcClient({ urls: cfg.rpcUrls, limiter: new RateLimiter(cfg.rpcPerSec, 4), fetchImpl: (u, i) => fetch(u, i) });
      const client = new WorkerNearClient({ rpc: paced, accountId: cfg.accountId, privateKey: cfg.privateKey, maxAttachedYocto: cfg.maxAttachedYocto, maxSubrequests: SUBREQUEST_BUDGET });
      const executed = await runKeeperTick({
        client, contracts: cfg.contracts, store: new SqliteStateStore(this.ctx.storage.sql), nowMs: () => Date.now(),
        alerts: telegramSink(cfg.telegramToken, cfg.telegramChatId), limits: cfg.limits, attachedYocto: cfg.attachedYocto, maxAttachedYocto: cfg.maxAttachedYocto,
      });
      return Response.json({ ok: true, executed: executed.length, subrequests: client.subrequestsUsed });
    } catch (err: any) {
      return Response.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
    }
  }
}

const keeperJob: Job<KeeperEnv> = {
  name: "keeper", everyMinutes: 1,
  async run(env) {
    if (!env.KEEPER) throw new Error("KEEPER Durable Object binding missing");
    const r = await env.KEEPER.get(env.KEEPER.idFromName("keeper")).fetch("https://keeper.do/tick", { method: "POST" });
    if (!r.ok) throw new Error(`keeper tick failed: ${((await r.json().catch(() => ({}))) as any).error ?? r.status}`);
  },
};

/** CF1b-d add their jobs here (or in a combined entry) -- one cron trigger serves all. */
export const JOBS: Job<KeeperEnv>[] = [keeperJob, relayerHeartbeatJob as Job<KeeperEnv>, monitorTickJob as Job<KeeperEnv>, notifierTickJob as Job<KeeperEnv>, indexerTickJob as Job<KeeperEnv>, indexerGovernanceJob as Job<KeeperEnv>];

/** STACK1: the private monitor/notifier Workers (workers_dev=false) are health-checked through the keeper's existing service bindings. */
const PROXIED = { "/health/monitor": ["MONITOR_SERVICE", "https://monitor.internal/health"], "/health/notifier": ["NOTIFIER_SERVICE", "https://notifier.internal/health"] } as const;

export default {
  async fetch(req: Request, env: KeeperEnv): Promise<Response> {
    const p = new URL(req.url).pathname;
    if (req.method !== "GET") return Response.json({ ok: false, error: "not found" }, { status: 404 });
    if (p === "/health") {
      if (!env.KEEPER) return Response.json({ ok: false, error: "KEEPER Durable Object binding missing" }, { status: 500 });
      return env.KEEPER.get(env.KEEPER.idFromName("keeper")).fetch("https://keeper.do/health", { method: "GET" });
    }
    const prox = (PROXIED as Record<string, readonly [string, string]>)[p];
    if (prox) {
      const svc = env[prox[0]] as { fetch(u: string, i?: any): Promise<Response> } | undefined;
      if (!svc) return Response.json({ ok: false, error: `${prox[0]} binding missing` }, { status: 500 });
      return svc.fetch(prox[1], { method: "GET" });
    }
    return Response.json({ ok: false, error: "not found" }, { status: 404 });
  },
  async scheduled(_event: unknown, env: KeeperEnv): Promise<void> {
    await runDispatcher(JOBS, env, Date.now());
  },
};
