// Indexer Worker entry (CF1d, D-HOST3): the node indexer (services/indexer) as a Cloudflare Worker with D1 storage.
//  * HTTP API: every route server.ts serves (/offers /history /bet /governance /health), same JSON shapes and status codes,
//    built by the SAME board builders (indexer/src/board.ts) over rows read from D1. No CORS headers (the node server sets none).
//  * POST /tick: one BOUNDED refresh step, reached from the shared dispatcher over INDEXER_SERVICE. The node refresh scans every
//    bet each poll; a Worker invocation is capped (50 subrequests, CPU), so a tick reads up to INDEXER_BATCH_BETS bets from a
//    per-contract sweep cursor and the board converges over several ticks. Merge rules (terminal lock, redeploy identity,
//    D-DSY1 second-RPC confirmation) are the node's own (indexer/src/refreshCore.ts). Confirmations are capped per tick; an
//    unconfirmed terminal bet stays "settling, confirming" (no winner leaked) until a later tick confirms it.
//  * POST /tick/governance: JC1y governance events from the tx indexer, one D1 row per contract, failures keep the old row.
//    IDX1 (D-PM3): the history is fetched INCREMENTALLY (historyCursor.ts): a cursor in indexer_state ("histcursor:<contract>")
//    resumes the listing and the detail queue across runs, <= HISTORY_BUDGET tx-indexer requests per run whatever the history
//    size, fetched txs merged into the stored rows by tx hash. Deleting the cursor row re-backfills over several runs.
//    V1: the same history also gives every bet action's tx (common/src/betTxIndex.ts), one indexer_state row per bet
//    (k = "bettxs:<contract>:<bet_id>"), served on GET /bet/txs?bet_id=N[&contract_id=]. A failed fetch keeps the old rows.
//  * D1 has no serialisation like a Durable Object: an atomic conditional UPDATE on indexer_lock gives single-flight + min interval.
import type { TaggedBet } from "@praetorial/common/discovery.js";
import type { Bet } from "@praetorial/common/types.js";
import { indexBetTxs, type BetTx } from "@praetorial/common/betTxIndex.js";
import { buildOpenOffersBoardMulti, historyHttp, redactUnconfirmed } from "../../../indexer/src/board.js";
import { indexGovernance, type GovernanceEvent } from "../../../indexer/src/governance.js";
import { sameBet } from "../../../indexer/src/refreshCore.js";
import { runVersionCheck, type AlertRaiser } from "../../../monitor/src/serviceAlerts.js";
import { AlertDedupe, type Alert } from "../../../monitor/src/alertsCore.js";
import { countingFetch } from "../../common/src/tickKit.js";
import { healthBody } from "../../common/src/health.js";
import { loadIndexerConfig, loadServedContracts, type D1Like, type D1Stmt, type IndexerEnv } from "./env.js";
import { indexerTickJob, indexerGovernanceJob } from "./job.js";
import { HISTORY_BUDGET, histCursorKey, parseHistCursor, stepHistory, type StepResult } from "./historyCursor.js";
import { COLS, toTagged, mergeReads, upsertStmts, chainClients, type Row } from "./merge.js";
import { handleRefresh } from "./refresh.js";

export { indexerTickJob, indexerGovernanceJob };
const ALERT_COOLDOWN_NS = 15 * 60 * 1_000_000_000, LEASE_MS = 30_000, IN_CHUNK = 90;

const body = (status: number, v: unknown): Response => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

interface Cursor { cursor: number; misses: number; sweepMax: number; redeployed: boolean }
interface State { cursors: Record<string, Cursor>; maxIds: Record<string, number>; lastSent: Record<string, number> }
const freshCursor = (): Cursor => ({ cursor: 1, misses: 0, sweepMax: 0, redeployed: false });

const ORDER = "ORDER BY ord, bet_id";
const inList = (n: number): string => Array.from({ length: n }, () => "?").join(",");

async function loadBets(db: D1Like, where = "", ...args: unknown[]): Promise<Map<string, TaggedBet>> {
  const { results } = await db.prepare(`SELECT ${COLS} FROM indexer_bets ${where}`).bind(...args).all<Row>();
  return new Map(results.map((r) => [r.key, toTagged(r)]));
}

class DbAlertRaiser implements AlertRaiser {
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

async function acquire(db: D1Like, name: string, nowMs: number, minIntervalMs: number): Promise<boolean> {
  const r = await db.prepare("UPDATE indexer_lock SET until_ms = ?, last_ms = ? WHERE name = ? AND until_ms <= ? AND last_ms + ? <= ?").bind(nowMs + LEASE_MS, nowMs, name, nowMs, minIntervalMs, nowMs).run();
  return (r.meta?.changes ?? 0) === 1;
}
const release = (db: D1Like, name: string) => db.prepare("UPDATE indexer_lock SET until_ms = 0 WHERE name = ?").bind(name).run();

async function tickBets(env: IndexerEnv, db: D1Like, clock: () => number): Promise<Record<string, unknown>> {
  const cfg = loadIndexerConfig(env);
  const nowMs = clock();
  // CF1e3: lock acquire + state read + unconfirmed backlog in ONE D1 round trip (deployed CPU is ~1 ms per D1 call / subrequest).
  // The reads are harmless if the lock is not won (single-flight / min interval still decided by the conditional UPDATE).
  const [lock, stateRes, backlogRes] = await db.batch([
    db.prepare("UPDATE indexer_lock SET until_ms = ?, last_ms = ? WHERE name = ? AND until_ms <= ? AND last_ms + ? <= ?").bind(nowMs + LEASE_MS, nowMs, "tick", nowMs, cfg.minTickIntervalMs, nowMs),
    db.prepare("SELECT v FROM indexer_state WHERE k = 'state'"),
    // IDX1: only the served contracts' unconfirmed backlog (other contracts' rows are kept but never re-read or confirmed)
    db.prepare(`SELECT ${COLS} FROM indexer_bets WHERE confirmed = 0 AND contract_id IN (${inList(cfg.contracts.length)}) ORDER BY ord, bet_id LIMIT ?`).bind(...cfg.contracts.map((c) => c.id), cfg.maxConfirms),
  ]) as any[];
  if ((lock?.meta?.changes ?? 0) !== 1) return { ok: true, skipped: true };
  const done = { released: false }; // on success the release rides in the tick's single D1 batch (one statement/round trip fewer)
  try { return await tickBetsLocked(cfg, db, nowMs, done, stateRes?.results?.[0]?.v ?? null, new Map(((backlogRes?.results ?? []) as Row[]).map((r) => [r.key, toTagged(r)]))); } finally { if (!done.released) await release(db, "tick"); }
}

async function tickBetsLocked(cfg: ReturnType<typeof loadIndexerConfig>, db: D1Like, nowMs: number, done: { released: boolean }, stateJson: string | null, backlog: Map<string, TaggedBet>): Promise<Record<string, unknown>> {
  const st: State = { cursors: {}, maxIds: {}, lastSent: {}, ...(stateJson ? JSON.parse(stateJson) : {}) };
  const cf = countingFetch();
  const { client, second } = chainClients(cfg, cf.fetch);
  const raiser = new DbAlertRaiser(new Map(Object.entries(st.lastSent)), nowMs * 1_000_000);

  // 1. bounded sweep window per contract (cursor; 3 consecutive misses past the frontier end a sweep). The cached rows of the
  //    window are loaded first so a changed identity on an overlapping id (= redeploy) is seen while the sweep is still running.
  const perContract = Math.max(1, Math.floor(cfg.batchBets / cfg.contracts.length));
  const cursors = new Map(cfg.contracts.map((c) => [c.id, { ...freshCursor(), ...(st.cursors[c.id] ?? {}) } as Cursor] as const));
  const plan = cfg.contracts.flatMap((c) => Array.from({ length: perContract }, (_, i) => `${c.id}:${cursors.get(c.id)!.cursor + i}`));
  const prev = backlog; // unconfirmed-terminal backlog first (read with the lock), so it drains
  for (let i = 0; i < plan.length; i += IN_CHUNK) {
    const ks = plan.slice(i, i + IN_CHUNK);
    for (const [k, v] of await loadBets(db, `WHERE key IN (${ks.map(() => "?").join(",")})`, ...ks)) if (!prev.has(k)) prev.set(k, v);
  }
  const fresh = new Map<string, TaggedBet>();
  const failed: { contractId: string; error: string }[] = [];
  const dropAbove: [string, number][] = [];
  for (const c of cfg.contracts) {
    const cur = cursors.get(c.id)!;
    let maxId = st.maxIds[c.id] ?? 0;
    const got = new Map<string, TaggedBet>();
    try {
      // FUND2: new bets first. The sweep walks every id in a bounded window, so on its own a new bet waited a full pass
      // (minutes, growing with the bet count). Up to half the budget reads ids above the known frontier until the first miss --
      // only when this tick's sweep window cannot reach the frontier itself (so discovery/redeploy sweeps are unchanged).
      let used = 0;
      const frontierBudget = maxId > 0 && cur.cursor + perContract <= maxId ? Math.max(1, Math.floor(perContract / 2)) : 0;
      for (let id = maxId + 1; used < frontierBudget; id++) {
        used++;
        const bet = await client.view<Bet | null>(c.id, "get_bet", { bet_id: id });
        if (!bet) break;
        got.set(`${c.id}:${id}`, { betId: id, bet, contractId: c.id, version: c.version }); maxId = id;
      }
      for (let reads = used; reads < perContract; reads++) {
        const id = cur.cursor++;
        const bet = await client.view<Bet | null>(c.id, "get_bet", { bet_id: id });
        if (bet) {
          const k = `${c.id}:${id}`, old = prev.get(k);
          if (old && !sameBet(old.bet, bet)) cur.redeployed = true;
          got.set(k, { betId: id, bet, contractId: c.id, version: c.version }); cur.misses = 0; cur.sweepMax = Math.max(cur.sweepMax, id); maxId = Math.max(maxId, id);
        } else if (id > maxId && ++cur.misses >= 3) {
          // sweep complete. A changed identity on an overlapping id proved a redeploy: drop the ghosts above the new frontier (node rule).
          if (cur.redeployed && cur.sweepMax < maxId) { dropAbove.push([c.id, cur.sweepMax]); maxId = cur.sweepMax; }
          Object.assign(cur, freshCursor()); break;
        }
      }
    } catch (err: any) { failed.push({ contractId: c.id, error: String(err?.message ?? err) }); console.error(`indexer: contract ${c.id} unreadable, keeping cached entries`); continue; }
    for (const [k, v] of got) fresh.set(k, v);
    st.cursors[c.id] = cur; st.maxIds[c.id] = maxId;
  }
  if (failed.length === cfg.contracts.length) throw new Error(`all contracts unreadable: ${failed[0]!.error}`);
  await runVersionCheck(client, cfg.contracts, raiser);

  // 2+3. merge into the cached rows + D-DSY1 second-RPC terminal confirmation, capped per tick (merge.ts, shared with POST /refresh)
  const { bets, dirty } = await mergeReads(prev, fresh, { second, raiser, maxConfirms: cfg.maxConfirms });

  // 4. one atomic D1 batch: upserts (multi-row, rowid-stable; IDX2: stamped with this tick's read time, so a newer refresh wins), ghost deletes, state
  const ordOf = new Map(cfg.contracts.map((c, i) => [c.id, i] as const));
  const stmts: D1Stmt[] = upsertStmts(db, [...dirty], bets, ordOf, nowMs);
  for (const [cid, above] of dropAbove) stmts.push(db.prepare("DELETE FROM indexer_bets WHERE contract_id = ? AND bet_id > ?").bind(cid, above));
  const keepAfter = nowMs * 1_000_000 - 2 * ALERT_COOLDOWN_NS;
  const next: State = { cursors: st.cursors, maxIds: st.maxIds, lastSent: Object.fromEntries([...raiser.lastSent].filter(([, t]) => t >= keepAfter)) };
  stmts.push(db.prepare("INSERT INTO indexer_state (k, v) VALUES ('state', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(next)));
  stmts.push(db.prepare("UPDATE indexer_lock SET until_ms = 0 WHERE name = ?").bind("tick"));
  await db.batch(stmts); done.released = true;
  return { ok: true, read: fresh.size, written: dirty.size, failed, alerts: raiser.raised, subrequests: cf.used(), cursors: next.cursors };
}

const BETTX_CHUNK = 40; // 2 binds per row; D1 allows 100 bound parameters per statement
const betTxKey = (contractId: string, betId: number) => `bettxs:${contractId}:${betId}`;
/** V1: one indexer_state row per bet holding its BetTx list (block order). */
function betTxRows(db: D1Like, contractId: string, txs: BetTx[]): D1Stmt[] {
  const byBet = new Map<number, BetTx[]>();
  for (const t of txs) { const l = byBet.get(t.bet_id) ?? []; l.push(t); byBet.set(t.bet_id, l); }
  const rows = [...byBet].map(([id, l]) => [betTxKey(contractId, id), JSON.stringify(l)]);
  const out: D1Stmt[] = [];
  for (let i = 0; i < rows.length; i += BETTX_CHUNK) {
    const chunk = rows.slice(i, i + BETTX_CHUNK);
    out.push(db.prepare(`INSERT INTO indexer_state (k, v) VALUES ${chunk.map(() => "(?, ?)").join(",")} ON CONFLICT(k) DO UPDATE SET v = excluded.v`).bind(...chunk.flat()));
  }
  return out;
}

const byNs = <T>(f: (x: T) => string) => (a: T, b: T): number => { const x = BigInt(f(a)), y = BigInt(f(b)); return x < y ? -1 : x > y ? 1 : 0; };

/** IDX1: merge one run's fetched txs into the stored index: every entry of a fetched tx is replaced by its fresh one (idempotent). */
async function mergeHistory(db: D1Like, contractId: string, oldGov: GovernanceEvent[] | null, step: StepResult): Promise<D1Stmt[]> {
  const out: D1Stmt[] = [];
  const hashes = new Set(step.fetched);
  if (hashes.size || oldGov === null) {
    const events = [...(oldGov ?? []).filter((e) => !hashes.has(e.tx_hash)), ...indexGovernance(contractId, step.hist)].sort(byNs((e) => e.block_timestamp));
    out.push(db.prepare("INSERT INTO indexer_governance (contract_id, events) VALUES (?, ?) ON CONFLICT(contract_id) DO UPDATE SET events = excluded.events").bind(contractId, JSON.stringify(events)));
  }
  const fresh = indexBetTxs(contractId, step.hist);
  if (!fresh.length) return out;
  const bets = [...new Set(fresh.map((t) => t.bet_id))];
  const merged: BetTx[] = [];
  for (let i = 0; i < bets.length; i += IN_CHUNK) {
    const ks = bets.slice(i, i + IN_CHUNK).map((b) => betTxKey(contractId, b));
    const { results } = await db.prepare(`SELECT v FROM indexer_state WHERE k IN (${inList(ks.length)})`).bind(...ks).all<{ v: string }>();
    for (const r of results) { try { merged.push(...(JSON.parse(r.v) as BetTx[]).filter((t) => !hashes.has(t.hash))); } catch { /* corrupt row: rebuilt from what is fetched */ } }
  }
  merged.push(...fresh);
  out.push(...betTxRows(db, contractId, merged.sort(byNs((t) => t.at_ns))));
  return out;
}

async function tickGovernance(env: IndexerEnv, db: D1Like, clock: () => number): Promise<Record<string, unknown>> {
  const cfg = loadIndexerConfig(env);
  const nowMs = clock();
  if (!(await acquire(db, "governance", nowMs, cfg.govMinIntervalMs))) return { ok: true, skipped: true };
  try {
    const cf = countingFetch();
    const updated: string[] = [], failed: { contractId: string; error: string }[] = [];
    const history: Record<string, { used: number; fetched: number; pending: number; segments: number; synced: boolean }> = {};
    const stmts: D1Stmt[] = [];
    // IDX1: cursors + stored governance rows of every contract in one D1 round trip
    const ids = cfg.contracts.map((c) => c.id);
    const [curRes, govRes] = await db.batch([
      db.prepare(`SELECT k, v FROM indexer_state WHERE k IN (${inList(ids.length)})`).bind(...ids.map(histCursorKey)),
      db.prepare(`SELECT contract_id, events FROM indexer_governance WHERE contract_id IN (${inList(ids.length)})`).bind(...ids),
    ]) as any[];
    const curs = new Map(((curRes?.results ?? []) as { k: string; v: string }[]).map((r) => [r.k, r.v] as const));
    const govs = new Map(((govRes?.results ?? []) as { contract_id: string; events: string }[]).map((r) => [r.contract_id, r.events] as const));
    const per = Math.max(1, Math.floor(HISTORY_BUDGET / ids.length));
    for (const c of cfg.contracts) {
      const step = await stepHistory(cfg.txIndexerUrl, c.id, parseHistCursor(curs.get(histCursorKey(c.id))), { fetch: cf.fetch, nowMs, budget: Math.min(per, cf.left()) });
      let oldGov: GovernanceEvent[] | null = null;
      try { const g = govs.get(c.id); oldGov = g === undefined ? null : JSON.parse(g); } catch { oldGov = null; }
      // a failing first request leaves no progress and no row to write (the old rows are kept, node behaviour)
      if (step.error && !step.fetched.length && step.used <= 1) { failed.push({ contractId: c.id, error: step.error }); console.error(`indexer: governance history for ${c.id} unreadable, keeping cached events`); continue; }
      stmts.push(...await mergeHistory(db, c.id, oldGov, step));
      stmts.push(db.prepare("INSERT INTO indexer_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(histCursorKey(c.id), JSON.stringify(step.cursor)));
      history[c.id] = { used: step.used, fetched: step.fetched.length, pending: step.cursor.pending.length, segments: step.cursor.segs.length, synced: step.synced };
      if (step.error) { failed.push({ contractId: c.id, error: step.error }); console.error(`indexer: governance history for ${c.id} partly read (${step.error}); progress kept, resuming next run`); }
      else updated.push(c.id);
    }
    if (stmts.length) await db.batch(stmts);
    return { ok: true, updated, failed, history, subrequests: cf.used() };
  } finally { await release(db, "governance"); }
}

// IDX1: every read endpoint serves ONLY the configured escrow (loadServedContracts); rows of other contracts stay in D1 unserved.
async function serve(url: URL, db: D1Like, env: IndexerEnv): Promise<Response> {
  const p = url.pathname;
  const served = loadServedContracts(env).map((c) => c.id);
  const IN = `contract_id IN (${inList(served.length)})`;
  if (p === "/offers") return body(200, buildOpenOffersBoardMulti(await loadBets(db, `WHERE ${IN} ${ORDER}`, ...served)));
  if (p === "/history") { const h = historyHttp(await loadBets(db, `WHERE ${IN} ${ORDER}`, ...served), url.searchParams); return body(h.status, h.body); }
  if (p === "/bet") {
    const id = Number(url.searchParams.get("bet_id"));
    const contractId = url.searchParams.get("contract_id");
    let found: TaggedBet | null = null;
    // node parity: without contract_id server.ts keeps scanning, so the LAST matching bet (insertion order) wins
    if (Number.isInteger(id) && (!contractId || served.includes(contractId))) {
      const r = contractId
        ? await db.prepare(`SELECT ${COLS} FROM indexer_bets WHERE bet_id = ? AND contract_id = ? ORDER BY ord LIMIT 1`).bind(id, contractId).first<Row>()
        : await db.prepare(`SELECT ${COLS} FROM indexer_bets WHERE bet_id = ? AND ${IN} ORDER BY ord DESC LIMIT 1`).bind(id, ...served).first<Row>();
      if (r) found = toTagged(r);
    }
    return body(200, found ? redactUnconfirmed(found) : null);
  }
  if (p === "/bet/txs") {
    const raw = url.searchParams.get("bet_id");
    const id = Number(raw);
    if (!raw || !Number.isInteger(id) || id < 0) return body(400, { error: "bet_id must be a non-negative integer" });
    const contractId = url.searchParams.get("contract_id") ?? served[0];
    if (!served.includes(contractId)) return body(200, []);
    const r = await db.prepare("SELECT v FROM indexer_state WHERE k = ?").bind(betTxKey(contractId, id)).first<{ v: string }>();
    return body(200, r ? JSON.parse(r.v) : []);
  }
  if (p === "/governance") {
    const cid = url.searchParams.get("contract_id"), kind = url.searchParams.get("kind");
    const { results } = await db.prepare(`SELECT contract_id, events FROM indexer_governance WHERE ${IN} ORDER BY rowid`).bind(...served).all<{ contract_id: string; events: string }>();
    const all = results.filter((r) => !cid || r.contract_id === cid).flatMap((r) => JSON.parse(r.events) as GovernanceEvent[]).filter((e) => !kind || e.kind === kind);
    return body(200, all);
  }
  if (p === "/health") {
    const r = await db.prepare(`SELECT COUNT(*) AS n FROM indexer_bets WHERE ${IN}`).bind(...served).first<{ n: number }>();
    const t = await db.prepare("SELECT last_ms FROM indexer_lock WHERE name = ?").bind("tick").first<{ last_ms: number }>();
    // STACK1: public-field health body (ok/bets_cached kept for existing callers); last_tick_at = the tick lease row's last run time
    return body(200, { ...healthBody("indexer", env as any, { lastTickMs: t?.last_ms ?? 0 }), bets_cached: r?.n ?? 0 });
  }
  return body(404, { error: "not found" });
}

/** Request handler (exported for tests; `clock` injectable). */
export async function handle(req: Request, env: IndexerEnv, clock: () => number = () => Date.now()): Promise<Response> {
  const db = env.INDEXER_DB;
  if (!db) return body(500, { ok: false, error: "INDEXER_DB D1 binding missing" });
  const url = new URL(req.url);
  try {
    if (url.pathname === "/refresh") return await handleRefresh(req, env, db, clock); // IDX2: the web's nudge after an Open/Take
    if (req.method === "POST" && url.pathname === "/tick") return body(200, await tickBets(env, db, clock));
    if (req.method === "POST" && url.pathname === "/tick/governance") return body(200, await tickGovernance(env, db, clock));
    if (url.pathname === "/tick" || url.pathname === "/tick/governance") return body(404, { error: "not found" });
    return await serve(url, db, env);
  } catch (err: any) { return body(500, { ok: false, error: String(err?.message ?? err) }); }
}

export default { fetch: (req: Request, env: IndexerEnv): Promise<Response> => handle(req, env) };
