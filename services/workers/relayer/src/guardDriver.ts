// SqlDriver over a Durable Object's SQLite storage (ctx.storage.sql + transactionSync): the Worker's twin of the
// node:sqlite driver in relayer/src/guardStore.ts. State lives in the DO's SQLite file, so replay/rate-limit/
// budget survive eviction, deploys and restarts. transactionSync gives the same atomic check+write as IMMEDIATE.
import type { SqlDriver } from "../../../relayer/src/guardStoreCore.js";

export interface DoSqlStorage { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } }
export interface DoStorage { sql: DoSqlStorage; transactionSync<T>(fn: () => T): T }

export function doSqlDriver(storage: DoStorage): SqlDriver {
  const sql = storage.sql;
  return {
    exec: (q) => { sql.exec(q).toArray(); },
    run: (q, ...p) => {
      sql.exec(q, ...p).toArray();
      if (!/^\s*insert/i.test(q)) return { lastInsertRowid: 0 };
      const id = sql.exec("SELECT last_insert_rowid() AS id").toArray()[0]?.id;
      return { lastInsertRowid: Number(id ?? 0) };
    },
    get: (q, ...p) => sql.exec(q, ...p).toArray()[0],
    transaction: (fn) => storage.transactionSync(fn),
  };
}
