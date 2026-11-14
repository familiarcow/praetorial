// Persistent guard store for the node relayer: GuardStoreCore (all guard logic) on node:sqlite (built into
// Node 22+) so a restart does not reset any user's nonce/rate-limit/budget state. The same core runs on a
// Durable Object's SQLite storage in the CF1b Worker (workers/relayer).
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { GuardStoreCore, type GuardStoreConfig, type SqlDriver } from "./guardStoreCore.js";

export {
  GuardViolation, GlobalCapViolation, DEFAULT_GLOBAL_BUDGET_MULTIPLIER, DEFAULT_RESERVED_SHARE,
  type GlobalBudgetStatus, type GuardStoreConfig, type SqlDriver,
} from "./guardStoreCore.js";

function nodeDriver(db: DatabaseSync): SqlDriver {
  return {
    exec: (sql) => { db.exec(sql); },
    run: (sql, ...p) => { const r = db.prepare(sql).run(...(p as any[])); return { lastInsertRowid: Number(r.lastInsertRowid) }; },
    get: (sql, ...p) => db.prepare(sql).get(...(p as any[])) as any,
    // IMMEDIATE: acquire the write lock up front so concurrent callers serialize rather than race read-then-write.
    transaction: (fn) => {
      db.exec("BEGIN IMMEDIATE;");
      try { const r = fn(); db.exec("COMMIT;"); return r; } catch (err) { try { db.exec("ROLLBACK;"); } catch { /* BEGIN itself failed */ } throw err; }
    },
  };
}

function openDb(dbPath: string): DatabaseSync {
  if (dbPath !== ":memory:") {
    const dir = dirname(dbPath);
    if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  // WAL for concurrent readers; busy_timeout so a writer waiting on another writer blocks briefly instead of SQLITE_BUSY.
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA busy_timeout=5000;");
  db.exec("PRAGMA foreign_keys=ON;");
  // legacy databases created before the D-RLY1 global cap lack reservations.pool ('' = no global accounting)
  const cols = db.prepare("PRAGMA table_info(reservations)").all() as { name: string }[];
  if (cols.length > 0 && !cols.some((c) => c.name === "pool")) db.exec("ALTER TABLE reservations ADD COLUMN pool TEXT NOT NULL DEFAULT ''");
  return db;
}

export class GuardStore extends GuardStoreCore {
  private db: DatabaseSync;
  constructor(dbPath: string, cfg: GuardStoreConfig, now: () => number = Date.now) {
    const db = openDb(dbPath);
    super(nodeDriver(db), cfg, now);
    this.db = db;
  }
  close(): void { this.db.close(); }
}
