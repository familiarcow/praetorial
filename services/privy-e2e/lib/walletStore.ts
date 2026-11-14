// Local Privy user -> NEAR wallet mapping, backed by SQLite
// (node:sqlite). This is the real idempotency boundary:
// getOrCreateUserWallet() always checks here FIRST and only ever
// calls Privy's create-wallet endpoint when no row exists for the
// given privyUserId. No secrets stored -- ids and public material
// only.
//
// Production-readiness notes:
//  - UNIQUE indexes on privy_user_id and implicit_account_id make a
//    second wallet for the same user (or a NEAR account id collision
//    across two different users) a DB-level impossibility, not just
//    an application-level check.
//  - createIfAbsent() is the atomic create-if-absent primitive: two
//    concurrent signups for the same privyUserId race on the SAME
//    UNIQUE constraint, so exactly one INSERT wins and the loser is
//    handed back the winner's row instead of erroring.
//  - WAL mode is enabled for every file-backed db (safe concurrent
//    readers while a writer is active; also just the right default
//    for a small local service db).
//  - A one-shot migration imports services/privy-e2e/data/wallets.json
//    (the old single-process JSON store) the first time the db is
//    opened with zero rows. Once the db has any row, migration never
//    runs again for that db file.
//  - DB path is configurable via PRIVY_WALLET_DB_PATH (default
//    services/data/wallets.db); the legacy JSON path used for
//    migration is configurable via PRIVY_WALLET_JSON_PATH (default
//    services/privy-e2e/data/wallets.json, i.e. where the old store
//    used to write).
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface WalletRow {
  privyUserId: string; // Privy's did:privy:... user id
  email: string; // the placeholder test email used to create the user
  walletId: string; // Privy wallet id (used for raw_sign calls)
  publicKeyHex: string; // Privy's "address" field, 64 lowercase hex chars
  implicitAccountId: string; // == publicKeyHex for a NEAR implicit account
  createdAt: string; // ISO timestamp of the row's first write
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// services/privy-e2e/lib/../../data -> services/data
function defaultDbPath(): string {
  return path.resolve(__dirname, "../../data/wallets.db");
}

// services/privy-e2e/lib/../data -> services/privy-e2e/data (where the
// old JSON store used to live).
function defaultLegacyJsonPath(): string {
  return path.resolve(__dirname, "../data/wallets.json");
}

function resolveDbPath(dbPathArg?: string): string {
  return dbPathArg ?? process.env.PRIVY_WALLET_DB_PATH ?? defaultDbPath();
}

function resolveJsonPath(jsonPathArg?: string): string {
  return jsonPathArg ?? process.env.PRIVY_WALLET_JSON_PATH ?? defaultLegacyJsonPath();
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

type SqliteError = Error & { code?: string };

const dbCache = new Map<string, DatabaseSync>();

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallets (
      privy_user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      wallet_id TEXT NOT NULL,
      public_key_hex TEXT NOT NULL,
      implicit_account_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_privy_user_id ON wallets(privy_user_id);`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_implicit_account_id ON wallets(implicit_account_id);`);
}

function migrateFromJsonIfPresent(db: DatabaseSync, jsonPath: string): void {
  const countRow = db.prepare("SELECT COUNT(*) as n FROM wallets").get() as { n: number };
  if (countRow.n > 0) return; // one-shot: db already has data, never re-import
  if (!fs.existsSync(jsonPath)) return;

  let legacyRows: WalletRow[];
  try {
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    legacyRows = Array.isArray(raw) ? raw : [];
  } catch {
    return; // malformed/missing legacy file -- nothing to migrate
  }
  if (legacyRows.length === 0) return;

  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO wallets (privy_user_id, email, wallet_id, public_key_hex, implicit_account_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  );
  db.exec("BEGIN");
  try {
    for (const r of legacyRows) {
      insertStmt.run(r.privyUserId, r.email, r.walletId, r.publicKeyHex, r.implicitAccountId, r.createdAt);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Opens (creating/migrating if needed) and caches the db at the given
 * path. Safe to call repeatedly -- returns the same handle for the
 * same resolved path until closeDb() drops it. */
export function getDb(dbPathArg?: string, jsonPathArg?: string): DatabaseSync {
  const dbPath = resolveDbPath(dbPathArg);
  const cached = dbCache.get(dbPath);
  if (cached) return cached;

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  createSchema(db);
  migrateFromJsonIfPresent(db, resolveJsonPath(jsonPathArg));
  dbCache.set(dbPath, db);
  return db;
}

/** Closes and drops the cached handle for a db path. Mainly for tests
 * that need to simulate a process restart (reopen from disk, not from
 * an in-memory cached handle) and for clean shutdown. */
export function closeDb(dbPathArg?: string): void {
  const dbPath = resolveDbPath(dbPathArg);
  const db = dbCache.get(dbPath);
  if (db) {
    db.close();
    dbCache.delete(dbPath);
  }
}

function rowFromDb(raw: any): WalletRow {
  return {
    privyUserId: raw.privy_user_id,
    email: raw.email,
    walletId: raw.wallet_id,
    publicKeyHex: raw.public_key_hex,
    implicitAccountId: raw.implicit_account_id,
    createdAt: raw.created_at,
  };
}

export function findByUserId(privyUserId: string, dbPathArg?: string): WalletRow | undefined {
  const db = getDb(dbPathArg);
  const raw = db.prepare("SELECT * FROM wallets WHERE privy_user_id = ?").get(privyUserId);
  return raw ? rowFromDb(raw) : undefined;
}

export function findByEmail(email: string, dbPathArg?: string): WalletRow | undefined {
  const db = getDb(dbPathArg);
  const raw = db.prepare("SELECT * FROM wallets WHERE email = ?").get(email);
  return raw ? rowFromDb(raw) : undefined;
}

export function findByAccountId(implicitAccountId: string, dbPathArg?: string): WalletRow | undefined {
  const db = getDb(dbPathArg);
  const raw = db.prepare("SELECT * FROM wallets WHERE implicit_account_id = ?").get(implicitAccountId);
  return raw ? rowFromDb(raw) : undefined;
}

export interface CreateIfAbsentResult {
  row: WalletRow;
  created: boolean; // false means a pre-existing row won the race and is returned instead
}

/** Atomic create-if-absent: inserts `row`, relying on the UNIQUE
 * index on privy_user_id as the race arbiter. If another caller's
 * row for the SAME privyUserId already won (e.g. two concurrent
 * signups for one user), returns that existing row with
 * created:false instead of erroring -- the defining idempotency
 * guarantee callers depend on.
 *
 * A UNIQUE violation on implicit_account_id for a DIFFERENT
 * privyUserId is a genuine anomaly (two distinct users colliding on
 * the same NEAR account id) and is rethrown rather than swallowed. */
export function createIfAbsent(row: WalletRow, dbPathArg?: string): CreateIfAbsentResult {
  const db = getDb(dbPathArg);
  try {
    db.prepare(
      `INSERT INTO wallets (privy_user_id, email, wallet_id, public_key_hex, implicit_account_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(row.privyUserId, row.email, row.walletId, row.publicKeyHex, row.implicitAccountId, row.createdAt);
    return { row, created: true };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = findByUserId(row.privyUserId, dbPathArg);
      if (existing) return { row: existing, created: false };
      throw new Error(
        `walletStore: NEAR account id ${row.implicitAccountId} is already claimed by a different privy user -- refusing to insert (${(err as SqliteError).message})`
      );
    }
    throw err;
  }
}
