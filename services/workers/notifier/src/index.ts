// Notifier Worker entry (CF1c2, D-HOST3). The shared dispatcher (keeper Worker, one cron) pokes POST /tick over the
// NOTIFIER_SERVICE binding; the request reaches ONE Durable Object (NotifierDO) that serialises ticks and keeps all state
// in its SQLite storage: seen keys, outbox, the PII-free notification log, the high-stake Telegram queue, per-contract sweep
// cursors, alert cooldowns and the encrypted contact table (WebCrypto AES-256-GCM, row-compatible with the node store).
//
// The pipeline is the node notifier's own (notifier/src/notifierCore computeNoticesMulti, confirm.ts second-RPC terminal
// confirm over common/src/terminalConfirmCore, highStakeRouter, monitor/src/serviceAlerts): only the data provider and the
// storage differ. A node tick walks every bet; a Worker invocation is capped (subrequests, CPU), so each tick reads a bounded
// batch of bets from a per-contract cursor and sweeps the whole range over several ticks. Seen keys make every notice fire
// once across sweeps and restarts. Telegram sends are queued in SQLite (account + text, never the contact value) and at most
// NOTIFIER_MAX_SENDS_PER_TICK go out per tick; failures stay queued and retry.
import { PacedRpcClient, RateLimiter } from "@praetorial/common/rpc.js";
import type { Bet } from "@praetorial/common/types.js";
import type { ViewClient } from "@praetorial/common/versionCheck.js";
import { secondRpcUrl } from "@praetorial/common/terminalConfirmCore.js";
import { computeNoticesMulti, type Notice } from "../../../notifier/src/notifierCore.js";
import { filterConfirmedTerminals } from "../../../notifier/src/confirm.js";
import { TelegramChannel } from "../../../notifier/src/telegram.js";
import { buildTelegramMessage, highStakeAccounts, noticesToHighStakeEvents } from "../../../notifier/src/highStakeRouter.js";
import { runVersionCheck, type AlertRaiser } from "../../../monitor/src/serviceAlerts.js";
import { AlertDedupe, type Alert } from "../../../monitor/src/alertsCore.js";
import { WorkerNearClient } from "../../common/src/nearWebClient.js";
import { healthResponse } from "../../common/src/health.js";
import { SqlKv, countingFetch, json, type DOState } from "../../common/src/tickKit.js";
import { WebContactStore, type ContactKind } from "./contactStore.js";
import { loadNotifierConfig, type NotifierConfig, type NotifierEnv } from "./env.js";
import { notifierTickJob } from "./job.js";

export { notifierTickJob };
const ALERT_COOLDOWN_NS = 15 * 60 * 1_000_000_000, CONFIRMED_KEEP = 500, MAX_SEND_ATTEMPTS = 10;

interface State { cursors: Record<string, { cursor: number; misses: number }>; lastSent: Record<string, number>; confirmed: string[]; lastTickMs: number }
const emptyState = (): State => ({ cursors: {}, lastSent: {}, confirmed: [], lastTickMs: 0 });

/** AlertRaiser for the Worker: cooldown dedupe persisted in the DO (restart-safe), due alerts logged and returned in the tick result. */
class DoAlertRaiser implements AlertRaiser {
  readonly raised: Alert[] = [];
  private readonly dedupe = new AlertDedupe(ALERT_COOLDOWN_NS);
  constructor(readonly lastSent: Map<string, number>, private readonly nowNs: number) {}
  async raise(alerts: Alert[]): Promise<Alert[]> {
    const due = this.dedupe.filter(alerts, this.lastSent, this.nowNs);
    for (const a of due) console.error(`[ALERT:${a.severity}] ${a.kind} ${a.key}: ${a.message} -- ${a.detail}`);
    this.raised.push(...due);
    return due;
  }
}

export class NotifierDO {
  private readonly kv: SqlKv;
  private contacts: WebContactStore | undefined;
  constructor(private readonly ctx: DOState, private readonly env: NotifierEnv, private readonly clock: () => number = () => Date.now()) {
    this.kv = new SqlKv(ctx.storage.sql, "notifier_state");
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS notifier_seen (k TEXT PRIMARY KEY)").toArray();
    sql.exec("CREATE TABLE IF NOT EXISTS notifier_outbox (notice TEXT NOT NULL)").toArray();
    // PII-free notification log: bet_id / event / timestamp only (same shape as notifier/src/notificationLog.ts).
    sql.exec("CREATE TABLE IF NOT EXISTS notification_log (bet_id INTEGER NOT NULL, event TEXT NOT NULL, timestamp TEXT NOT NULL)").toArray();
    // High-stake Telegram queue: the account (public chain data) + message text (bet id/event/link). The chat id / contact is
    // resolved (decrypted) only at send time, so no PII sits in this table.
    sql.exec("CREATE TABLE IF NOT EXISTS notifier_tg_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, text TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)").toArray();
  }

  private store(): WebContactStore { return (this.contacts ??= new WebContactStore(this.ctx.storage.sql, this.env.NOTIFIER_CONTACT_KEY as string | undefined, this.clock)); }
  setContact(account: string, kind: ContactKind, value: string) { return this.store().setContact(account, kind, value); }
  getContact(account: string) { return this.store().getContact(account); }
  async deleteContact(account: string): Promise<void> { this.store().deleteContact(account); }
  async rowCountForAccount(account: string): Promise<number> { return this.store().rowCountForAccount(account); }

  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/tick") return json(404, { ok: false, error: "not found" });
    try { return json(200, await this.tick()); } catch (err: any) { return json(500, { ok: false, error: String(err?.message ?? err) }); }
  }

  private async tick(): Promise<Record<string, unknown>> {
    const cfg = loadNotifierConfig(this.env);
    const nowMs = this.clock(), nowNs = nowMs * 1_000_000;
    const st: State = { ...emptyState(), ...this.kv.get<Partial<State>>("state", {}) };
    if (st.lastTickMs && nowMs - st.lastTickMs < cfg.minTickIntervalMs) return { ok: true, skipped: true };
    const store = this.store();

    // every outbound call of this invocation goes through one counting fetch (hard budget)
    const cf = countingFetch();
    const mkClient = (urls: string[], maxRetries: number): ViewClient => new WorkerNearClient({
      rpc: new PacedRpcClient({ urls, limiter: new RateLimiter(cfg.rpcPerSec, 4), fetchImpl: cf.fetch, maxRetries }),
      accountId: cfg.contracts[0]!.id, privateKey: "", maxAttachedYocto: 0n, maxSubrequests: 1000,
    });
    const client = mkClient(cfg.rpcUrls, 2);
    const secondUrl = secondRpcUrl(cfg.rpcUrls);
    const second = secondUrl ? mkClient([secondUrl], 1) : null;
    const raiser = new DoAlertRaiser(new Map(Object.entries(st.lastSent)), nowNs);

    // 1. bounded sweep: up to batchBets/contracts bets per contract from that contract's cursor
    const perContract = Math.max(1, Math.floor(cfg.batchBets / cfg.contracts.length));
    const cursors = { ...st.cursors };
    const betsByContract = new Map<string, Map<number, Bet>>();
    let failures = 0, lastErr: unknown;
    for (const c of cfg.contracts) {
      const cur = { ...(cursors[c.id] ?? { cursor: 1, misses: 0 }) };
      try {
        const bets = new Map<number, Bet>();
        for (let reads = 0; reads < perContract; reads++) {
          const id = cur.cursor++;
          const bet = await client.view<Bet | null>(c.id, "get_bet", { bet_id: id });
          if (bet) { bets.set(id, bet); cur.misses = 0; }
          else if (++cur.misses >= 3) { cur.cursor = 1; cur.misses = 0; break; } // frontier reached: restart the sweep
        }
        betsByContract.set(c.id, bets); cursors[c.id] = cur;
      } catch (err) { failures++; lastErr = err; console.error(`notifier: contract ${c.id} unreadable, skipping this tick`); }
    }
    if (failures === cfg.contracts.length) throw lastErr; // nothing readable: loud, persisted state untouched
    await runVersionCheck(client, cfg.contracts, raiser);

    // 2. D-DSY1: terminal outcomes only after the second RPC agrees
    const cache = new Set(st.confirmed);
    const confirmed = await filterConfirmedTerminals(betsByContract, { second, raiser, cache });

    // 3. notices (seen keys in SQLite) -> outbox + PII-free log + high-stake Telegram queue, one transaction
    const sql = this.ctx.storage.sql;
    const seen = new Set<string>(sql.exec("SELECT k FROM notifier_seen").toArray().map((r) => r.k as string));
    const before = new Set(seen);
    const notices: Notice[] = computeNoticesMulti(confirmed, nowNs, seen);
    const tgTexts: { account: string; text: string }[] = [];
    if (cfg.telegramToken && notices.length) {
      for (const ev of noticesToHighStakeEvents(notices, confirmed, cfg.linkBase)) {
        const text = buildTelegramMessage(ev);
        for (const account of highStakeAccounts(ev, cfg.prices, cfg.highStakeUsd)) tgTexts.push({ account, text });
      }
    }
    const iso = new Date(nowMs).toISOString();
    const write = () => {
      for (const k of seen) if (!before.has(k)) sql.exec("INSERT OR IGNORE INTO notifier_seen (k) VALUES (?)", k).toArray();
      for (const k of before) if (!seen.has(k)) sql.exec("DELETE FROM notifier_seen WHERE k = ?", k).toArray();
      for (const n of notices) {
        sql.exec("INSERT INTO notifier_outbox (notice) VALUES (?)", JSON.stringify(n)).toArray();
        sql.exec("INSERT INTO notification_log (bet_id, event, timestamp) VALUES (?, ?, ?)", n.bet_id, n.kind, iso).toArray();
      }
      for (const t of tgTexts) sql.exec("INSERT INTO notifier_tg_queue (account, text) VALUES (?, ?)", t.account, t.text).toArray();
      for (const t of ["notifier_outbox", "notification_log"]) sql.exec(`DELETE FROM ${t} WHERE rowid <= (SELECT MAX(rowid) FROM ${t}) - ?`, cfg.logKeep).toArray();
      const keepAfter = nowNs - 2 * ALERT_COOLDOWN_NS;
      this.kv.set("state", { cursors, lastSent: Object.fromEntries([...raiser.lastSent].filter(([, t]) => t >= keepAfter)), confirmed: [...cache].slice(-CONFIRMED_KEEP), lastTickMs: nowMs } satisfies State);
    };
    if (this.ctx.storage.transactionSync) this.ctx.storage.transactionSync(write); else write();

    // 4. bounded Telegram delivery (best effort, never throws; failures stay queued)
    const sent = cfg.telegramToken ? await this.drainTelegram(cfg, store, cf) : 0;
    return { ok: true, notices, alerts: raiser.raised, sent, subrequests: cf.used(), cursors };
  }

  private async drainTelegram(cfg: NotifierConfig, store: WebContactStore, cf: ReturnType<typeof countingFetch>): Promise<number> {
    const sql = this.ctx.storage.sql;
    const tg = new TelegramChannel({ fetchImpl: cf.fetch, botToken: cfg.telegramToken!, maxAttempts: 1, sleepImpl: async () => {} });
    const rows = sql.exec("SELECT id, account, text, attempts FROM notifier_tg_queue ORDER BY id LIMIT ?", cfg.maxSendsPerTick).toArray();
    let sent = 0;
    for (const r of rows) {
      let contact;
      try { contact = await store.getContact(r.account as string); } catch { console.error("notifier: a contact could not be decrypted; entry kept"); continue; }
      if (!contact || contact.kind !== "telegram") { sql.exec("DELETE FROM notifier_tg_queue WHERE id = ?", r.id).toArray(); continue; } // opted out / deleted: normal state
      if (cf.left() <= 0) break;
      let ok = false;
      try { ok = await tg.send(contact.value, r.text as string); } catch { ok = false; }
      if (ok) { sent++; sql.exec("DELETE FROM notifier_tg_queue WHERE id = ?", r.id).toArray(); }
      else if ((r.attempts as number) + 1 >= MAX_SEND_ATTEMPTS) sql.exec("DELETE FROM notifier_tg_queue WHERE id = ?", r.id).toArray();
      else sql.exec("UPDATE notifier_tg_queue SET attempts = attempts + 1 WHERE id = ?", r.id).toArray();
    }
    return sent;
  }
}

export default {
  /** Reachable over the NOTIFIER_SERVICE binding only (workers_dev = false); forwards to the single DO. */
  async fetch(req: Request, env: NotifierEnv): Promise<Response> {
    if (req.method === "GET" && new URL(req.url).pathname === "/health") return healthResponse("notifier", env as any); // STACK1
    if (!env.NOTIFIER) return json(500, { ok: false, error: "NOTIFIER Durable Object binding missing" });
    return env.NOTIFIER.get(env.NOTIFIER.idFromName("notifier")).fetch(req.url, { method: req.method });
  },
};
