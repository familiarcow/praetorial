// BettorScanStore over the RelayerDO's SQLite storage (CF1b2): the escrow get_bet scan's progress and its
// maker/taker set persist across requests, evictions and restarts, so a fresh cache costs zero subrequests.
import type { BettorScanStore } from "../../../relayer/src/bettor.js";
import type { DoStorage } from "./guardDriver.js";

export function doBettorScanStore(storage: DoStorage): BettorScanStore {
  const sql = storage.sql;
  const q = (s: string, ...b: unknown[]) => sql.exec(s, ...b).toArray();
  q("CREATE TABLE IF NOT EXISTS bettor_scan_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
  q("CREATE TABLE IF NOT EXISTS bettor_scan_bets (id INTEGER PRIMARY KEY, maker TEXT NOT NULL, taker TEXT, checked_at INTEGER NOT NULL)");
  q("CREATE INDEX IF NOT EXISTS bettor_scan_maker ON bettor_scan_bets (maker)");
  q("CREATE INDEX IF NOT EXISTS bettor_scan_taker ON bettor_scan_bets (taker)");
  return {
    getMeta: (k) => Number(q("SELECT v FROM bettor_scan_meta WHERE k = ?", k)[0]?.v ?? 0),
    setMeta: (k, v) => { q("INSERT OR REPLACE INTO bettor_scan_meta (k, v) VALUES (?, ?)", k, v); },
    put: (id, maker, taker, at) => { q("INSERT OR REPLACE INTO bettor_scan_bets (id, maker, taker, checked_at) VALUES (?, ?, ?, ?)", id, maker, taker, at); },
    openIdsCheckedBefore: (before, limit) => q("SELECT id FROM bettor_scan_bets WHERE taker IS NULL AND maker <> '' AND checked_at < ? ORDER BY checked_at, id LIMIT ?", before, limit).map((r) => Number(r.id)),
    has: (a) => q("SELECT 1 AS x FROM bettor_scan_bets WHERE maker = ? OR taker = ? LIMIT 1", a, a).length > 0,
  };
}
