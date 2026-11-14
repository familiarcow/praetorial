// Shared fixtures for the CF1d indexer Worker tests (not a *.test.ts, so not collected).
// fakeD1 = the D1 binding API (prepare/bind/first/all/run/batch/exec) over node:sqlite, counting every statement
// (a batch counts each of its statements, the conservative reading of the Free plan's 50 queries/invocation).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATION_SQL = fs.existsSync(path.join(HERE, "../migrations/0001_init.sql")) ? fs.readFileSync(path.join(HERE, "../migrations/0001_init.sql"), "utf8") : "";
/** IDX2: every migration in order (0001_init, 0002_refresh, ...), as `wrangler d1 migrations apply` runs them on a fresh database. */
export const migrationSql = (): string => fs.readdirSync(path.join(HERE, "../migrations")).filter((f) => f.endsWith(".sql")).sort().map((f) => fs.readFileSync(path.join(HERE, "../migrations", f), "utf8")).join("\n");

export function fakeD1(file = ":memory:", migrate = true) {
  const db = new DatabaseSync(file);
  if (migrate) db.exec(migrationSql());
  const c = { queries: 0 };
  const isRead = (q: string) => /^\s*(select|pragma|with)/i.test(q);
  const mk = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => mk(sql, a),
    _exec() {
      c.queries++;
      if (isRead(sql)) return { results: db.prepare(sql).all(...(args as any[])), success: true, meta: { changes: 0 } };
      const r = db.prepare(sql).run(...(args as any[]));
      return { results: [], success: true, meta: { changes: Number(r.changes) } };
    },
    async first() { const r = this._exec(); return r.results[0] ?? null; },
    async all() { return this._exec(); },
    async run() { return this._exec(); },
  });
  const d1 = {
    prepare: (sql: string) => mk(sql),
    async exec(sql: string) { db.exec(sql); return { count: 1, duration: 0 }; },
    async batch(stmts: any[]) {
      db.exec("BEGIN");
      try { const out = stmts.map((s) => s._exec()); db.exec("COMMIT"); return out; } catch (e) { try { db.exec("ROLLBACK"); } catch { /* */ } throw e; }
    },
  };
  return { d1, counters: c, close: () => db.close() };
}

export const RPC_URL = "https://test.rpc.fastnear.com";
export const RPC2_URL = "https://second.rpc.test";
export const TXIDX = "tx.test.fastnear.com";
export const INT = "intents.testnet";
export const OKS = { SuccessValue: "" };

export function mkBet(over: any = {}, env: any = {}): any {
  return { envelope: { maker: "m.testnet", terms_hash: "h1", stake_maker: "1", stake_taker: "1", maker_side: "YES", funding_deadline: 1, taker_allow: { Any: {} }, ...env }, created_at: 5, status: "Open", taker: null, outcome: null, ...over };
}
export const settled = (o: any = {}) => mkBet({ status: "Settled", taker: "t.testnet", outcome: "YES", ...o });

export type Chain = Record<string, Record<number, any> | "dead">;
export interface World {
  chain: Chain; second: Chain | "down" | null; version: string; history: Record<string, { hash: string; rc: any }[]>; historyDown: boolean;
  outbound: number; views: number; secondViews: number; txIdxCalls: number;
  /** IDX1: txs the tx indexer does not list yet (late indexing) / receipts it does not return yet (tx still executing). */
  hiddenTxs?: Set<string>; hiddenReceipts?: Set<string>;
  /** IDX2: bet_count() per contract (default: the highest bet id in `chain`). */
  betCount?: Record<string, number>;
  /** IDX2: awaited before every primary call_function answer (interleaves a refresh with a running tick). */
  onView?: (contract: string, method: string, args: any) => Promise<void> | void;
}

/** A tx's block timestamp (ns) = its earliest receipt's; its height = whole seconds of that (1 s blocks, so the same second = the same block). */
const txTs = (rcs: any[]): bigint => rcs.reduce((m: bigint, r: any) => { const t = BigInt(r?.execution_outcome?.block_timestamp ?? 0); return m < 0n || t < m ? t : m; }, -1n);
/** IDX1: FastNEAR /v0/account as it really behaves: newest first, `limit` rows per page (max 200), opaque `resume_token` for the next (older) page. */
export function accountPage(w: World, body: any): any {
  const hist = w.history[body.account_id] ?? [];
  const byTx = new Map<string, any[]>();
  for (const h of hist) { if (w.hiddenTxs?.has(h.hash)) continue; const l = byTx.get(h.hash) ?? []; l.push(h.rc); byTx.set(h.hash, l); }
  const rows = [...byTx].map(([h, rcs]) => { const t = txTs(rcs); return { account_id: body.account_id, transaction_hash: h, tx_block_height: Number(t / 1_000_000_000n), tx_block_timestamp: t.toString(), tx_index: 0 }; })
    .sort((a, b) => b.tx_block_height - a.tx_block_height || (a.transaction_hash < b.transaction_hash ? 1 : -1));
  const limit = Math.min(200, Number(body.limit ?? 50));
  const from = body.resume_token ? Number(String(body.resume_token).slice(4)) : 0;
  const page = rows.slice(from, from + limit);
  return { account_txs: page, txs_count: rows.length, ...(from + limit < rows.length ? { resume_token: `off:${from + limit}` } : {}) };
}
export const world = (chain: Chain = {}): World => ({ chain, second: {}, version: "1.0.0", history: {}, historyDown: false, outbound: 0, views: 0, secondViews: 0, txIdxCalls: 0 });

/** Node-side ViewClient over the same chain the Worker's mocked fetch serves (the "recorded" fixture). */
export const viewClient = (w: World, which: "primary" | "second" = "primary"): any => ({
  async view(c: string, m: string, a: any) {
    if (m === "contract_version") return w.version;
    const t = which === "primary" ? w.chain[c] : (w.second === "down" ? "dead" : w.second?.[c]);
    if (t === "dead") throw new Error("rpc down");
    return t?.[a.bet_id] ?? null;
  },
});

export function outboundFetch(w: World) {
  return async (input: any, init?: any): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.url);
    w.outbound++;
    const text = init?.body ?? (typeof input === "object" && input.text ? await input.text() : "{}");
    const body: any = JSON.parse(String(text));
    if (url.hostname === TXIDX) {
      w.txIdxCalls++;
      if (w.historyDown) return new Response("down", { status: 500 });
      if (url.pathname === "/v0/account") return Response.json(accountPage(w, body));
      if (url.pathname === "/v0/transactions") {
        const all = Object.values(w.history).flat();
        return Response.json({ transactions: (body.tx_hashes as string[]).filter((h) => all.some((x) => x.hash === h)).map((h) => ({ transaction: { hash: h }, receipts: all.filter((x) => x.hash === h && !w.hiddenReceipts?.has(String(x.rc?.receipt?.receipt_id))).map((x) => x.rc) })) });
      }
    }
    const second = url.hostname === "second.rpc.test";
    if (url.hostname !== "test.rpc.fastnear.com" && !second) throw new Error(`unexpected outbound ${url.hostname}`);
    const p = body.params;
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
    if (body.method === "query" && p.request_type === "call_function") {
      if (second) { w.secondViews++; if (w.second === "down" || w.second === null) return new Response("down", { status: 500 }); } else w.views++;
      const a = JSON.parse(atob(p.args_base64));
      if (!second && w.onView) await w.onView(p.account_id, p.method_name, a);
      const t = second ? (w.second as Chain)[p.account_id] : w.chain[p.account_id];
      let r: unknown;
      if (p.method_name === "contract_version") r = w.version;
      else if (p.method_name === "bet_count") r = w.betCount?.[p.account_id] ?? (t && t !== "dead" ? Math.max(0, ...Object.keys(t).map(Number)) : 0);
      else if (p.method_name === "get_bet") {
        if (t === "dead") return Response.json({ jsonrpc: "2.0", id: body.id, error: { name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR", info: "dead" } } });
        r = t?.[a.bet_id] ?? null;
      } else return Response.json({ jsonrpc: "2.0", id: body.id, error: { name: "HANDLER_ERROR", cause: { name: "CONTRACT_EXECUTION_ERROR", info: "unmocked view" } } });
      return ok({ result: Array.from(new TextEncoder().encode(JSON.stringify(r))) });
    }
    throw new Error(`unmocked rpc ${body.method}`);
  };
}

export const baseEnv = (d1: unknown, extra: Record<string, string> = {}): any => ({
  INDEXER_DB: d1, NEAR_NETWORK_ID: "testnet", ESCROW_CONTRACTS: "a.testnet@v1,b.testnet@v2", INTENTS_CONTRACT_ID: INT,
  NEAR_RPC_URL: RPC_URL, NEAR_RPC_FALLBACKS: RPC2_URL, INDEXER_RPC_PER_SEC: "100000", INDEXER_MIN_TICK_INTERVAL_MS: "0", INDEXER_GOVERNANCE_MIN_INTERVAL_MS: "0",
  ...extra,
});

export const rc = (logs: string[], status: any = OKS, ts = "1700000000000000000", id = "r", receiver = "a.testnet") =>
  ({ receipt: { receipt_id: id, receiver_id: receiver }, execution_outcome: { block_timestamp: ts, outcome: { logs, status } } });
