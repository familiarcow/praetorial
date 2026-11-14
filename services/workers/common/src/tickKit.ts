// CF1c shared helpers for the monitor/notifier Workers: env parsing, a per-invocation subrequest-counting fetch,
// and a tiny SQLite key/value store for Durable Object state. Host-neutral (no node:* / Buffer / process).
export const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);
export const num = (v: unknown, dflt: number): number => {
  const s = str(v);
  if (s === undefined) return dflt;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid numeric binding value "${s}"`);
  return n;
};
export const needStr = (v: unknown, name: string): string => {
  const s = str(v);
  if (!s) throw new Error(`missing required binding ${name}`);
  return s;
};

/** Free-plan subrequest cap is 50 per invocation; keep headroom for the DO hop. */
export const SUBREQUEST_BUDGET = 44;

/** fetch wrapper that counts every outbound subrequest of one invocation and refuses past the budget with a clean
 * error (instead of the platform killing the invocation mid-batch). Resolves the global fetch lazily. */
export function countingFetch(max: number = SUBREQUEST_BUDGET): { fetch: typeof fetch; used(): number; left(): number } {
  let used = 0;
  const f = (async (input: any, init?: any) => {
    if (used >= max) throw new Error(`subrequest budget exhausted (${max} per invocation)`);
    used++;
    return fetch(input, init);
  }) as typeof fetch;
  return { fetch: f, used: () => used, left: () => max - used };
}

export interface SqlStorage { exec(q: string, ...b: unknown[]): { toArray(): any[] }; }
export interface DOState { storage: { sql: SqlStorage; transactionSync?<T>(fn: () => T): T } }
export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(url: string, init?: any): Promise<Response> };
}

/** JSON key/value rows in the DO's SQLite (one table per service). */
export class SqlKv {
  constructor(private readonly sql: SqlStorage, private readonly table: string) {
    sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (k TEXT PRIMARY KEY, v TEXT NOT NULL)`).toArray();
  }
  get<T>(k: string, dflt: T): T {
    const r = this.sql.exec(`SELECT v FROM ${this.table} WHERE k = ?`, k).toArray();
    return r.length ? (JSON.parse(r[0].v) as T) : dflt;
  }
  set(k: string, v: unknown): void { this.sql.exec(`INSERT OR REPLACE INTO ${this.table} (k, v) VALUES (?, ?)`, k, JSON.stringify(v)).toArray(); }
}

export const json = (status: number, body: unknown): Response => Response.json(body, { status });
