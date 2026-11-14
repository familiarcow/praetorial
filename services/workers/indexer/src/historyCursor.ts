// IDX1 (D-PM3): incremental escrow tx-history fetch for the indexer Worker's governance tick.
// Before IDX1 each run re-fetched the WHOLE history (FastNEAR tx indexer: 1 listing request per 200 txs + 1 detail request per
// 5 txs), so past ~240 txs a run exceeded the Workers Free cap of 50 subrequests and the index froze. Now one run spends at most
// `budget` requests and the rest resumes next run from a cursor persisted in D1 (indexer_state, k = "histcursor:<contract>").
//
// The cursor:
//  * head    highest tx_block_height listed so far. Each run lists the newest page(s) down to `head - OVERLAP_BLOCKS` (txs can be
//            listed late at an older height: receipts executing a few blocks after the tx, tx-indexer lag). `recent` remembers the
//            hashes already queued inside that overlap so they are not fetched twice.
//  * segs    listings still to continue (opaque resume_token + the height to stop at, inclusive): the initial backfill (stop 0)
//            and, if a burst outran the head pages of one run, the gap below it.
//  * pending listed txs whose receipts are still to fetch (newest first). A tx fetched while younger than SETTLE_NS may still have
//            receipts executing (yield/resume callbacks, payouts): it is fetched again on a later run, once settled.
// Results are merged by tx hash by the caller (index.ts), so re-fetching a tx is always harmless (idempotent).
// Read-only: only the public tx indexer is called. Host-neutral (no node:*).
import { postJson } from "@praetorial/common/txHistoryCore.js";
import type { HistEntry } from "@praetorial/common/betTxIndex.js";

export const HISTORY_BUDGET = 30;          // tx-indexer requests per run, all contracts together (cap 50, tests assert < 40)
export const PAGE_LIMIT = 200;             // rows per /v0/account page (the indexer's max)
export const TX_BATCH = 5;                 // hashes per /v0/transactions request
export const HEAD_PAGES = 3;               // newest pages read per run before the rest is left to a gap segment
export const OVERLAP_BLOCKS = 300;         // ~5 min of blocks re-listed below the head (late-listed txs; yield callbacks are <= 200 blocks)
export const SETTLE_NS = 10n * 60n * 1_000_000_000n; // a tx younger than this when fetched is fetched again later
const MAX_MISSES = 3;                      // a listed tx the indexer never returns is dropped after this many tries

export interface Seg { token: string; stop: number }
export interface Pend { h: string; t: string; n: number; again?: 1; miss?: number }
export interface HistCursor { v: 1; head: number; recent: Record<string, number>; segs: Seg[]; pending: Pend[] }

export const histCursorKey = (contractId: string) => `histcursor:${contractId}`;
export const freshHistCursor = (): HistCursor => ({ v: 1, head: 0, recent: {}, segs: [], pending: [] });

/** A missing, corrupt or unknown-version cursor is a reset: the history is re-listed from the newest tx (re-backfill). */
export function parseHistCursor(s: string | null | undefined): HistCursor {
  if (!s) return freshHistCursor();
  try {
    const c = JSON.parse(s);
    if (c?.v !== 1 || !Number.isFinite(c.head) || !Array.isArray(c.segs) || !Array.isArray(c.pending) || typeof c.recent !== "object" || c.recent === null) return freshHistCursor();
    return c as HistCursor;
  } catch { return freshHistCursor(); }
}

export interface StepResult {
  cursor: HistCursor;
  /** receipts of the txs fetched this run (all receipts of each tx, deduped by receipt id) */
  hist: HistEntry[];
  /** hashes of the txs fetched this run (their previous index entries are replaced by the caller) */
  fetched: string[];
  used: number;
  /** nothing left to list or fetch */
  synced: boolean;
  error?: string;
}

interface Row { h: string; t: string; n: number }
const rowOf = (r: any): Row | null => {
  const h = r?.transaction_hash, n = Number(r?.tx_block_height);
  return typeof h === "string" && Number.isFinite(n) ? { h, t: String(r.tx_block_timestamp ?? "0"), n } : null;
};

/** One bounded step. Never throws: a failing request ends the step, keeping the progress made before it. */
export async function stepHistory(base: string, escrow: string, prev: HistCursor, o: { fetch: typeof fetch; nowMs: number; budget: number }): Promise<StepResult> {
  const c: HistCursor = structuredClone(prev);
  const d = { fetch: o.fetch, sleep: async () => {}, attempts: 1 };
  let used = 0;
  const hist: HistEntry[] = [], fetched: string[] = [];
  const queued = new Set(c.pending.map((p) => p.h));
  const list = async (token?: string): Promise<{ rows: Row[]; next: string | null }> => {
    used++;
    const j = await postJson(`${base}/v0/account`, { account_id: escrow, limit: PAGE_LIMIT, ...(token ? { resume_token: token } : {}) }, d);
    const raw: any[] = j?.account_txs ?? [];
    return { rows: raw.map(rowOf).filter((r): r is Row => r !== null), next: j?.resume_token && raw.length ? String(j.resume_token) : null };
  };
  const take = (r: Row, into: Pend[], head: number) => {
    if (r.h in c.recent) return; // already queued/fetched (the overlap below the head is listed again every run)
    if (r.n >= head - OVERLAP_BLOCKS) c.recent[r.h] = r.n;
    if (queued.has(r.h)) return;
    queued.add(r.h); into.push({ h: r.h, t: r.t, n: r.n });
  };
  const done = (error?: string): StepResult => {
    for (const [h, n] of Object.entries(c.recent)) if (n < c.head - OVERLAP_BLOCKS) delete c.recent[h];
    return { cursor: c, hist, fetched, used, synced: !error && !c.segs.length && !c.pending.length, ...(error ? { error } : {}) };
  };
  if (o.budget < 1) return done();

  // 1. head: newest txs first (liveness), down to the old head minus the overlap. All or nothing: a failure leaves the cursor as it was.
  try {
    const stop = c.head > 0 ? c.head - OVERLAP_BLOCKS : 0;
    const front: Pend[] = [];
    let head = c.head, token: string | undefined, gap: Seg | null = null;
    for (let p = 0; ; p++) {
      const { rows, next } = await list(token);
      for (const r of rows) head = Math.max(head, r.n);
      let reached = false;
      for (const r of rows) { if (r.n < stop) reached = true; else take(r, front, head); }
      if (reached || !next) break;
      if (c.head === 0 || p + 1 >= HEAD_PAGES || used >= o.budget) { gap = { token: next, stop }; break; } // first run: the rest is the backfill
      token = next;
    }
    c.head = head;
    if (gap) c.segs.unshift(gap);
    c.pending = [...front, ...c.pending];
  } catch (e: any) { return { ...done(String(e?.message ?? e)), cursor: prev, synced: false }; }

  // 2. fetch queued txs; list more of a segment only when the queue runs short
  const again: Pend[] = [];
  const nowNs = BigInt(Math.floor(o.nowMs)) * 1_000_000n;
  try {
    while (used < o.budget) {
      if (c.pending.length >= TX_BATCH || (c.pending.length && !c.segs.length)) {
        const batch = c.pending.slice(0, TX_BATCH);
        used++;
        const j = await postJson(`${base}/v0/transactions`, { tx_hashes: batch.map((p) => p.h) }, d);
        c.pending.splice(0, batch.length);
        const got = new Set<string>(), seen = new Set<string>();
        for (const t of j?.transactions ?? []) {
          const hash = String(t?.transaction?.hash ?? "");
          if (!batch.some((p) => p.h === hash)) continue;
          got.add(hash); fetched.push(hash);
          for (const rc of t.receipts ?? []) {
            const id = rc?.receipt?.receipt_id;
            if (id !== undefined) { if (seen.has(id)) continue; seen.add(id); }
            hist.push({ hash, signer: t.transaction.signer_id, rc });
          }
        }
        for (const p of batch) {
          if (!got.has(p.h)) { if ((p.miss ?? 0) + 1 < MAX_MISSES) again.push({ ...p, miss: (p.miss ?? 0) + 1 }); continue; }
          let young = false;
          try { young = nowNs - BigInt(p.t) < SETTLE_NS; } catch { /* unparseable time: treat as settled */ }
          if (young) again.push({ h: p.h, t: p.t, n: p.n, again: 1 });
        }
        continue;
      }
      const seg = c.segs[0];
      if (!seg) break;
      const { rows, next } = await list(seg.token);
      const back: Pend[] = [];
      let reached = false;
      for (const r of rows) { if (r.n < seg.stop) reached = true; else take(r, back, c.head); }
      c.pending.push(...back);
      if (reached || !next) c.segs.shift(); else seg.token = next;
    }
  } catch (e: any) { c.pending = [...again, ...c.pending]; return done(String(e?.message ?? e)); }
  c.pending = [...again, ...c.pending];
  return done();
}
