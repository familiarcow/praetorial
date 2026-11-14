// The bets-cache merge, shared by the bounded tick (index.ts tickBetsLocked) and IDX2's POST /refresh (refresh.ts): ONE copy of
// the rules -- terminal lock + redeploy identity (refreshCore sameBet), unchanged re-read = no write, D-DSY1 second-RPC terminal
// confirmation (refreshCore confirmTerminals) -- and ONE upsert statement shape.
// IDX2 concurrency: the tick and a refresh write the same rows without a common lock (a refresh never takes the tick lease). The
// upsert is guarded in SQL, so whichever commits last cannot undo the other:
//   * read_ms: a row is only replaced by a read that STARTED at or after the stored row's read (an older read is stale);
//   * terminal: a terminal row is never replaced by a non-terminal read of the same bet (sameBet identity), whatever its age.
import type { TaggedBet } from "@praetorial/common/discovery.js";
import type { Bet } from "@praetorial/common/types.js";
import { TERMINAL, sameBet, confirmTerminals, type RefreshOptions } from "../../../indexer/src/refreshCore.js";
import { PacedRpcClient, RateLimiter } from "@praetorial/common/rpc.js";
import type { ViewClient } from "@praetorial/common/versionCheck.js";
import { secondRpcUrl } from "@praetorial/common/terminalConfirmCore.js";
import { WorkerNearClient } from "../../common/src/nearWebClient.js";
import type { D1Stmt, D1Like, IndexerConfig } from "./env.js";

export interface Row { key: string; contract_id: string; bet_id: number; ord: number; version: string; confirmed: number | null; bet: string }
export const COLS = "key, contract_id, bet_id, ord, version, confirmed, bet";
export const toTagged = (r: Row): TaggedBet => ({ betId: r.bet_id, bet: JSON.parse(r.bet) as Bet, contractId: r.contract_id, version: r.version, ...(r.confirmed === null ? {} : { confirmed: r.confirmed === 1 }) });
const toRow = (k: string, tb: TaggedBet, ord: number): unknown[] => [k, tb.contractId, tb.betId, ord, tb.version, tb.confirmed === undefined ? null : tb.confirmed ? 1 : 0, JSON.stringify(tb.bet)];
const UPSERT_CHUNK = 14; // 7 binds per row; D1 allows 100 bound parameters per statement (read_ms is an inline integer literal)

/** Merge fresh chain reads into the cached rows and confirm terminals. Returns every bet and the keys whose row must be written. */
export async function mergeReads(prev: Map<string, TaggedBet>, fresh: Map<string, TaggedBet>, opts: RefreshOptions): Promise<{ bets: Map<string, TaggedBet>; dirty: Set<string> }> {
  const bets = new Map(prev);
  const before = new Map([...prev].map(([k, tb]) => [k, tb.confirmed] as const));
  const dirty = new Set<string>();
  for (const [k, tb] of fresh) {
    const old = prev.get(k);
    if (old && sameBet(old.bet, tb.bet) && TERMINAL.has(old.bet.status)) continue; // terminal is final; a lagging or lying read must not rewrite it
    bets.set(k, tb);
    if (old && old.version === tb.version && JSON.stringify(old.bet) === JSON.stringify(tb.bet)) { bets.set(k, { ...tb, ...(old.confirmed === undefined ? {} : { confirmed: old.confirmed }) }); continue; } // CF1e3: unchanged re-read -> no D1 row write (keeps the confirmation flag)
    dirty.add(k);
  }
  // D-DSY1: second-RPC terminal confirmation (capped per call by opts.maxConfirms)
  await confirmTerminals(bets, opts);
  for (const [k, tb] of bets) if (!dirty.has(k) && before.get(k) !== tb.confirmed) dirty.add(k);
  return { bets, dirty };
}

const TERM_SQL = [...TERMINAL].map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
const jx = (t: string, p: string) => `json_extract(${t}.bet, '$.${p}')`;
const SAME_BET_SQL = ["envelope.maker", "envelope.terms_hash", "created_at"].map((p) => `${jx("indexer_bets", p)} IS ${jx("excluded", p)}`).join(" AND ");
const GUARD = `excluded.read_ms >= indexer_bets.read_ms AND NOT (${jx("indexer_bets", "status")} IN (${TERM_SQL}) AND ${jx("excluded", "status")} NOT IN (${TERM_SQL}) AND ${SAME_BET_SQL})`;

/** Multi-row, rowid-stable upserts of `keys`, stamped with the time their chain reads started (readMs), guarded as above. */
export function upsertStmts(db: D1Like, keys: string[], bets: Map<string, TaggedBet>, ordOf: Map<string, number>, readMs: number): D1Stmt[] {
  const ms = Math.max(0, Math.trunc(Number(readMs))) || 0;
  const out: D1Stmt[] = [];
  for (let i = 0; i < keys.length; i += UPSERT_CHUNK) {
    const ks = keys.slice(i, i + UPSERT_CHUNK);
    out.push(db.prepare(`INSERT INTO indexer_bets (${COLS}, read_ms) VALUES ${ks.map(() => `(?,?,?,?,?,?,?,${ms})`).join(",")} ON CONFLICT(key) DO UPDATE SET ord = excluded.ord, version = excluded.version, confirmed = excluded.confirmed, bet = excluded.bet, read_ms = excluded.read_ms WHERE ${GUARD}`)
      .bind(...ks.flatMap((k) => toRow(k, bets.get(k)!, ordOf.get(bets.get(k)!.contractId) ?? 0))));
  }
  return out;
}

/** The primary view client (rpcUrls, 2 retries) and the D-DSY1 second-RPC client (rpcUrls[1], built only when a confirmation needs it). */
export function chainClients(cfg: IndexerConfig, fetchImpl: typeof fetch): { client: ViewClient; second: ViewClient | null } {
  const mk = (urls: string[], maxRetries: number): ViewClient => new WorkerNearClient({
    rpc: new PacedRpcClient({ urls, limiter: new RateLimiter(cfg.rpcPerSec, 4), fetchImpl, maxRetries }),
    accountId: cfg.contracts[0]!.id, privateKey: "", maxAttachedYocto: 0n, maxSubrequests: 1000,
  });
  const client = mk(cfg.rpcUrls, 2);
  const secondUrl = secondRpcUrl(cfg.rpcUrls);
  let secondClient: ViewClient | null | undefined; // built only when a confirmation actually needs it
  const second: ViewClient | null = secondUrl ? { view: (...a: Parameters<ViewClient["view"]>) => (secondClient ??= mk([secondUrl], 1)!).view(...a) } as ViewClient : null;
  return { client, second };
}
