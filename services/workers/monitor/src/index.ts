// Monitor Worker entry (CF1c, D-HOST3). The shared dispatcher (keeper Worker, one cron) pokes POST /tick over the
// MONITOR_SERVICE binding; the request reaches ONE Durable Object (MonitorDO) that serialises ticks and keeps all
// state in its SQLite storage (alert dedupe/cooldowns, stall + rpc-error trackers, headroom samples, ops-recovery
// set, sweep cursor + partial results), so a restart changes nothing.
//
// The alert logic is the node monitor's own (runAlertTick in monitor/src/runnerCore.ts + alertsCore/opsAlertsCore/
// storageHeadroom/relayerBudget/invariants/snapshot): only the data provider differs. A node tick walks every bet;
// a Worker invocation is capped (subrequests, CPU), so the provider reads a bounded batch of bets per tick and
// sweeps the whole range over several ticks, keeping the latest per-bet findings in SQLite. Contract-wide I-2 is
// judged only when a sweep completes (it needs every bet's contribution). Staleness is therefore at most one sweep.
import { PacedRpcClient, RateLimiter } from "@praetorial/common/rpc.js";
import { checkContractShutdown } from "@praetorial/common/shutdown.js";
import type { Bet, PendingPayout } from "@praetorial/common/types.js";
import { nextActionForBet } from "../../../keeper/src/policy.js";
import { TelegramChannel } from "../../../notifier/src/telegram.js";
import { WorkerNearClient } from "../../common/src/nearWebClient.js";
import { healthResponse } from "../../common/src/health.js";
import { SqlKv, countingFetch, json, type DOState } from "../../common/src/tickKit.js";
import { checkI2ContractWide, runMonitor, type Violation } from "../../../monitor/src/invariants.js";
import { trackedContributionForBet, fundsInForBet } from "../../../monitor/src/snapshot.js";
import { alertsForKeeperCredit } from "../../../monitor/src/opsAlertsCore.js";
import { fetchHeadroomSample, type HeadroomSample } from "../../../monitor/src/storageHeadroom.js";
import { fetchRelayerBudget } from "../../../monitor/src/relayerBudget.js";
import { scanUndonePayouts, type StuckPayoutTrackerState } from "../../../monitor/src/stuckPayouts.js";
import { alertsForStuckResolving, observeBet, type ResolvingWatch } from "../../../monitor/src/stuckResolving.js";
import { CONTRACT_WIDE_BET_ID, createAlertRunnerState, runAlertTick, type AlertSnapshotProvider } from "../../../monitor/src/runnerCore.js";
import type { Alert, DueAction } from "../../../monitor/src/alertsCore.js";
import { loadMonitorConfig, type MonitorConfig, type MonitorEnv } from "./env.js";
import { monitorTickJob } from "./job.js";

export { monitorTickJob };
const MAX_TELEGRAM_POSTS = 3, TELEGRAM_CHUNK = 3500;

interface State {
  lastSent: Record<string, number>; stall: [string, number][]; rpcConsecutive: number;
  headroom: { tsNs: number; headroom: string }[]; ops: Alert[]; prevRpc: { total: number; errors: number };
  cursor: number; misses: number; tracked: Record<string, string>;
  viol: Record<string, Violation[]>; due: Record<string, string>; contractWide: Violation[]; lastTickMs: number;
  payoutFrom: number; stuck: StuckPayoutTrackerState; // MON1 stuck payouts: scan cursor + first-seen clock / once-per-entry set
  resolving: Record<string, ResolvingWatch>; // LIFE1: per-bet stuck-Resolving / runs-exhausted watch (first-seen clock), kept across sweeps
}
const emptyState = (): State => ({ lastSent: {}, stall: [], rpcConsecutive: 0, headroom: [], ops: [], prevRpc: { total: 0, errors: 0 }, cursor: 1, misses: 0, tracked: {}, viol: {}, due: {}, contractWide: [], lastTickMs: 0, payoutFrom: 1, stuck: { firstSeen: [], alerted: [] }, resolving: {} });

export class MonitorDO {
  private readonly kv: SqlKv;
  constructor(ctx: DOState, private readonly env: MonitorEnv, private readonly clock: () => number = () => Date.now()) { this.kv = new SqlKv(ctx.storage.sql, "monitor_state"); }

  async fetch(req: Request): Promise<Response> {
    // STACK1: public-field health body; last_tick_at is the existing state's lastTickMs (null before the first tick)
    if (req.method === "GET" && new URL(req.url).pathname === "/health") return healthResponse("monitor", this.env as any, { lastTickMs: this.kv.get<Partial<State>>("state", {}).lastTickMs ?? 0 });
    if (req.method !== "POST" || new URL(req.url).pathname !== "/tick") return json(404, { ok: false, error: "not found" });
    try { return json(200, await this.tick()); } catch (err: any) { return json(500, { ok: false, error: String(err?.message ?? err) }); }
  }

  private async tick(): Promise<Record<string, unknown>> {
    const cfg = loadMonitorConfig(this.env);
    const nowMs = this.clock(); const nowNs = nowMs * 1_000_000;
    const st: State = { ...emptyState(), ...this.kv.get<Partial<State>>("state", {}) };
    if (st.lastTickMs && nowMs - st.lastTickMs < cfg.minTickIntervalMs) return { ok: true, skipped: true };

    // every outbound call of this invocation goes through one counting fetch (hard budget) + RPC attempt/429 stats
    const cf = countingFetch(); let rpcTotal = 0, rpcErrors = 0;
    const rpcUrls = new Set(cfg.rpcUrls);
    const f: typeof fetch = async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      const res = await cf.fetch(input, init);
      if (rpcUrls.has(url)) { rpcTotal++; if (res.status === 429) rpcErrors++; }
      return res;
    };
    const rpc = new PacedRpcClient({ urls: cfg.rpcUrls, limiter: new RateLimiter(cfg.rpcPerSec, 4), fetchImpl: f });
    const client = new WorkerNearClient({ rpc, accountId: cfg.escrow, privateKey: "", maxAttachedYocto: 0n, maxSubrequests: 1000 });

    const state = createAlertRunnerState({ stallGraceNs: cfg.stallGraceNs, cooldownNs: cfg.cooldownNs, rpcErrorThresholdRatio: cfg.rpcErrorThresholdRatio, rpcMinConsecutiveTicks: cfg.rpcMinConsecutiveTicks, initialLastSentNs: new Map(Object.entries(st.lastSent)), stuckPayoutThresholdNs: cfg.stuckPayoutThresholdMs * 1_000_000 });
    state.stallTracker.importState(st.stall); state.rpcTracker.importState(st.rpcConsecutive); state.opsRecovery.importState(st.ops); state.stuckPayouts.importState(st.stuck);
    state.headroomSamples = st.headroom.map((s): HeadroomSample => ({ tsNs: s.tsNs, headroomYocto: BigInt(s.headroom) }));

    const next: State = { ...st, viol: { ...st.viol }, due: { ...st.due }, resolving: { ...st.resolving } };
    let batch: Promise<{ paused: boolean }> | undefined;
    let payoutScan: Record<string, unknown> | undefined; // MON1: per-tick in-flight scan summary (tick JSON + log)
    const runBatch = () => (batch ??= this.sweepBatch(client, cfg, next, nowNs));

    const provider: AlertSnapshotProvider = {
      contractId: cfg.escrow,
      fetchInvariantResults: async () => {
        await runBatch();
        const m = new Map<number, { ok: boolean; violations: Violation[] }>();
        for (const [id, v] of Object.entries(next.viol)) if (v.length) m.set(Number(id), { ok: false, violations: v });
        if (next.contractWide.length) m.set(CONTRACT_WIDE_BET_ID, { ok: false, violations: next.contractWide });
        return m;
      },
      fetchDueActions: async () => { await runBatch(); return Object.entries(next.due).map(([id, kind]): DueAction => ({ contractId: cfg.escrow, betId: Number(id), kind: kind as DueAction["kind"] })); },
      fetchStuckResolvingAlerts: async (n: number) => { await runBatch(); return alertsForStuckResolving(cfg.escrow, next.resolving, n); },
      fetchRpcStats: async () => st.prevRpc, // previous tick's attempts/429s, like the node's per-call delta
      fetchContractState: async () => ({ paused: (await runBatch()).paused, shutdown: await checkContractShutdown(client, cfg.escrow) }),
      fetchUndonePayouts: async () => {
        const from = next.payoutFrom; const scan = await scanUndonePayouts(client, cfg.escrow, from); next.payoutFrom = scan.nextFrom;
        payoutScan = { scanned_from: from, next_from: scan.nextFrom, undone: scan.undone.length, in_flight: scan.undone.filter((p) => p.in_flight).length, complete: scan.complete };
        console.log(JSON.stringify({ level: "info", msg: "monitor payout scan", escrow: cfg.escrow, payouts: payoutScan }));
        return scan;
      },
      fetchStorageHeadroomSample: (n: number) => fetchHeadroomSample(cfg.rpcUrls[0]!, cfg.escrow, n, f),
      ...(cfg.relayerBudgetUrl ? { fetchRelayerBudget: () => fetchRelayerBudget(cfg.relayerBudgetUrl!, f) } : {}),
      ...(cfg.creditWatch.length ? { fetchOpsAlerts: async () => {
        const out: Alert[] = [];
        for (const w of cfg.creditWatch) {
          const r = await f(cfg.rpcUrls[0]!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: w.account } }) });
          const amount = ((await r.json()) as any)?.result?.amount;
          if (typeof amount === "string") out.push(...alertsForKeeperCredit({ account: w.account, balanceYocto: amount, floorYocto: w.floor, ...(w.burn ? { burnPerDayYocto: w.burn } : {}) }));
        }
        return out;
      } } : {}),
    };

    const collected: Alert[] = [];
    const sent = await runAlertTick(provider, state, { async send(a: Alert) { collected.push(a); } }, nowNs);
    const delivery = await this.deliver(cfg, f, collected);

    // persist only after a fully successful tick (a thrown provider error leaves the stored state untouched)
    const keepAfter = nowNs - 2 * cfg.cooldownNs;
    next.lastSent = Object.fromEntries([...state.lastSentNs].filter(([, t]) => t >= keepAfter));
    next.stall = state.stallTracker.exportState(); next.rpcConsecutive = state.rpcTracker.exportState(); next.ops = state.opsRecovery.exportState();
    next.stuck = state.stuckPayouts.exportState();
    next.headroom = state.headroomSamples.map((s) => ({ tsNs: s.tsNs, headroom: s.headroomYocto.toString() }));
    next.prevRpc = { total: rpcTotal, errors: rpcErrors }; next.lastTickMs = nowMs;
    this.kv.set("state", next);
    return { ok: true, sent, subrequests: cf.used(), cursor: next.cursor, ...(payoutScan ? { payouts: payoutScan } : {}), ...(delivery.unconfigured ? { telegram_unconfigured: true } : {}), ...(delivery.failed ? { telegram_failed: true } : {}) };
  }

  /** Reads up to `batchBets` bets from the sweep cursor; at sweep end judges contract-wide I-2 and restarts the sweep. */
  private async sweepBatch(client: WorkerNearClient, cfg: MonitorConfig, s: State, nowNs: number): Promise<{ paused: boolean }> {
    const payouts = await client.view<PendingPayout[]>(cfg.escrow, "pending_payouts_view", { from: 0, limit: 500 });
    const byBet = new Map<number, PendingPayout[]>();
    for (const p of payouts) { const a = byBet.get(p.bet_id) ?? []; a.push(p); byBet.set(p.bet_id, a); }
    const paused = await client.view<boolean>(cfg.escrow, "is_paused", {});
    const tracked = new Map<string, bigint>(Object.entries(s.tracked).map(([k, v]) => [k, BigInt(v)]));
    let reads = 0, done = false;
    while (reads < cfg.batchBets && !done) {
      const id = s.cursor++; reads++;
      const bet = await client.view<Bet | null>(cfg.escrow, "get_bet", { bet_id: id });
      if (!bet) { if (++s.misses >= 3) done = true; continue; }
      s.misses = 0;
      const res = runMonitor({
        betId: id, paused, actors: { maker: bet.envelope.maker, taker: bet.taker, feeAccount: cfg.feeAccount, keeper: cfg.keeperAccount, arbiter: bet.envelope.arbiter },
        payouts: byBet.get(id) ?? [], fundsIn: fundsInForBet(bet), trackedTotalYocto: 0n, actualIntentsBalanceYocto: 0n, bet,
      });
      if (res.violations.length) s.viol[id] = res.violations; else delete s.viol[id];
      const action = nextActionForBet(bet, id, nowNs);
      if (action) s.due[id] = action.kind; else delete s.due[id];
      const watch = observeBet(cfg.escrow, id, bet, nowNs, s.resolving[id]);
      if (watch) s.resolving[id] = watch; else delete s.resolving[id];
      for (const [asset, amt] of trackedContributionForBet(bet, byBet.get(id) ?? [])) tracked.set(asset, (tracked.get(asset) ?? 0n) + amt);
    }
    if (done) {
      const cw: Violation[] = [];
      for (const asset of [...new Set([cfg.usdc, ...tracked.keys()])].sort()) {
        const actual = BigInt(await client.view<string>(cfg.intents, "mt_balance_of", { account_id: cfg.escrow, token_id: asset }));
        for (const v of checkI2ContractWide(tracked.get(asset) ?? 0n, actual)) cw.push({ ...v, asset, detail: `asset=${asset} ${v.detail}` });
      }
      s.contractWide = cw; s.cursor = 1; s.misses = 0; s.tracked = {};
    } else s.tracked = Object.fromEntries([...tracked].map(([k, v]) => [k, v.toString()]));
    return { paused };
  }

  /** One digest per tick (<= 3 Telegram posts) so a burst of alerts cannot burn the subrequest budget. */
  private async deliver(cfg: MonitorConfig, f: typeof fetch, alerts: Alert[]): Promise<{ unconfigured: boolean; failed: boolean }> {
    for (const a of alerts) console.log(`[ALERT:${a.severity}] ${a.kind} ${a.key}: ${a.message} -- ${a.detail}`);
    // ALRT1a: unset token/chat id must never lose alerts silently: one structured warning per tick that had alerts (kinds + count,
    // never the token) and a flag in the tick/health JSON so a deployed check can see it.
    const unconfigured = !cfg.telegramToken || !cfg.telegramChatId;
    if (unconfigured) {
      if (alerts.length) console.warn(JSON.stringify({ level: "warn", msg: "telegram not configured", alert_count: alerts.length, kinds: [...new Set(alerts.map((a) => a.kind))].sort() }));
      return { unconfigured: true, failed: false };
    }
    if (!alerts.length) return { unconfigured: false, failed: false };
    const lines = alerts.map((a) => `[${a.severity.toUpperCase()}] ${a.message}\n${a.detail}`);
    const chunks: string[] = []; let cur = "";
    for (const l of lines) { if (cur && cur.length + l.length + 2 > TELEGRAM_CHUNK) { chunks.push(cur); cur = ""; } cur += (cur ? "\n\n" : "") + l.slice(0, TELEGRAM_CHUNK); }
    if (cur) chunks.push(cur);
    const tg = new TelegramChannel({ fetchImpl: f, botToken: cfg.telegramToken!, maxAttempts: 2, sleepImpl: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 250))) });
    const posts = chunks.slice(0, MAX_TELEGRAM_POSTS);
    if (chunks.length > posts.length) posts[posts.length - 1] += `\n\n(+${chunks.length - posts.length} more message(s) truncated; see worker logs)`;
    let failedPosts = 0;
    for (const p of posts) {
      let ok = false;
      try { ok = await tg.send(cfg.telegramChatId!, p); } catch { ok = false; } // a delivery problem never fails the tick (alerts are already logged)
      if (!ok) failedPosts++;
    }
    if (failedPosts) console.error(JSON.stringify({ level: "error", msg: "telegram delivery failed", failed_posts: failedPosts, posts: posts.length, alert_count: alerts.length }));
    return { unconfigured: false, failed: failedPosts > 0 };
  }
}

export default {
  /** Reachable over the MONITOR_SERVICE binding only (workers_dev = false); forwards to the single DO. */
  async fetch(req: Request, env: MonitorEnv): Promise<Response> {
    if (!env.MONITOR) return json(500, { ok: false, error: "MONITOR Durable Object binding missing" });
    return env.MONITOR.get(env.MONITOR.idFromName("monitor")).fetch(req.url, { method: req.method });
  },
};
