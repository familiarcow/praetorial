// Guard store core: nonce/replay dedupe, per-user rate limiting, per-user daily sponsored-gas budgets and the
// D-RLY1 global cap. Host-agnostic: all SQL goes through the tiny synchronous `SqlDriver` below (node:sqlite in
// guardStore.ts for the node relayer; a Durable Object's SQLite storage in the CF1b Worker), so both hosts run
// exactly the same guard logic. Every check+write happens inside ONE driver transaction (SQLite IMMEDIATE on
// node, transactionSync in a DO), so concurrent requests for the same sender serialize: the second sees the
// first's committed state before evaluating its own limit.

export class GuardViolation extends Error {}

/** Thrown when the relayer-wide (all senders) daily gas cap blocks a
 * reservation. Mapped to HTTP 429 (per-sender violations stay 400).
 * `reserveAvailable` is true when the open share is spent but the
 * bettor-only reserve still has room for this request, i.e. retrying as a
 * known bettor could succeed. */
export class GlobalCapViolation extends GuardViolation {
  constructor(message: string, public readonly reserveAvailable: boolean) {
    super(message);
  }
}

export interface GlobalBudgetStatus {
  capYocto: bigint;
  openCapYocto: bigint;
  reservedCapYocto: bigint;
  /** settled spend + outstanding reservations, per pool, this window */
  openUsedYocto: bigint;
  reservedUsedYocto: bigint;
  usedYocto: bigint;
  windowStartMs: number;
  windowEndsMs: number;
}

export const DEFAULT_GLOBAL_BUDGET_MULTIPLIER = 50n;
export const DEFAULT_RESERVED_SHARE = 0.5;

export interface GuardStoreConfig {
  maxRequestsPerWindow: number;
  windowMs: number;
  dailyBudgetYocto: bigint;
  /** D-RLY1: relayer-wide daily cap across ALL senders. Default 50x dailyBudgetYocto. */
  globalDailyBudgetYocto?: bigint;
  /** D-RLY1: fraction (0..1) of the global cap only existing bettors may draw once the open share is spent. Default 0.5. */
  reservedShare?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** SEC1/MON-9: how long an activation claim blocks another transfer to the same id. */
export const ACTIVATION_CLAIM_TTL_MS = 10 * 60 * 1000;

export interface SqlDriver {
  /** DDL / multi-statement scripts without bindings. */
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): { lastInsertRowid: number };
  get<T = any>(sql: string, ...params: unknown[]): T | undefined;
  /** Atomic: commits on return, rolls back on throw. */
  transaction<T>(fn: () => T): T;
}

export type SubmissionState = "sending" | "submitted" | "executed" | "failed" | "not_executed" | "superseded";
export interface Submission {
  senderId: string; publicKey: string; nonce: bigint; txHash: string; state: SubmissionState; reservationId: number;
  depositYocto: bigint; holdYocto: bigint; maxBlockHeight: bigint; receiptFailure?: string; createdAtMs: number; updatedAtMs: number;
  /** its outcome was once reported "unknown" to the client (so a resend gets the resolved result, not a replay refusal) */
  wasUnknown: boolean;
}
function toSubmission(r: any): Submission {
  return {
    senderId: r.sender_id, publicKey: r.public_key, nonce: BigInt(r.nonce), txHash: r.tx_hash, state: r.state, reservationId: Number(r.reservation_id),
    depositYocto: BigInt(r.deposit_yocto), holdYocto: BigInt(r.hold_yocto), maxBlockHeight: BigInt(r.max_block_height),
    receiptFailure: r.receipt_failure ?? undefined, wasUnknown: Number(r.was_unknown ?? 0) === 1, createdAtMs: Number(r.created_at_ms), updatedAtMs: Number(r.updated_at_ms),
  };
}

export class GuardStoreCore {
  protected d: SqlDriver;
  private globalCap: bigint;
  private reservedCap: bigint;
  private openCap: bigint;

  constructor(driver: SqlDriver, private cfg: GuardStoreConfig, private now: () => number = Date.now) {
    const share = cfg.reservedShare ?? DEFAULT_RESERVED_SHARE;
    if (!Number.isFinite(share) || share < 0 || share > 1) {
      throw new Error(`reservedShare must be a number in [0,1], got ${share}`);
    }
    const global = cfg.globalDailyBudgetYocto ?? cfg.dailyBudgetYocto * DEFAULT_GLOBAL_BUDGET_MULTIPLIER;
    if (global < 0n) throw new Error("globalDailyBudgetYocto must be >= 0");
    this.globalCap = global;
    this.reservedCap = (global * BigInt(Math.round(share * 10_000))) / 10_000n;
    this.openCap = global - this.reservedCap;
    this.d = driver;
    this.migrate();
  }

  private migrate(): void {
    // One statement per exec (the Durable Object driver runs a single statement at a time). Bigints are stored as
    // decimal strings (SQLite ints are 64-bit signed; NEAR nonces/yocto amounts can exceed that).
    for (const stmt of [
      "CREATE TABLE IF NOT EXISTS nonces (sender_id TEXT NOT NULL, public_key TEXT NOT NULL, nonce TEXT NOT NULL, seen_at_ms INTEGER NOT NULL, PRIMARY KEY (sender_id, public_key, nonce))",
      "CREATE TABLE IF NOT EXISTS rate_limit (user_id TEXT NOT NULL, ts_ms INTEGER NOT NULL)",
      "CREATE INDEX IF NOT EXISTS idx_rate_limit_user_ts ON rate_limit(user_id, ts_ms)",
      "CREATE TABLE IF NOT EXISTS budget (user_id TEXT PRIMARY KEY, window_start_ms INTEGER NOT NULL, spent_yocto TEXT NOT NULL, reserved_yocto TEXT NOT NULL DEFAULT '0')",
      "CREATE TABLE IF NOT EXISTS reservations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, amount_yocto TEXT NOT NULL, created_at_ms INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0, pool TEXT NOT NULL DEFAULT '')",
      // SEC1 / MON-2 / MON-10: one row per relayed delegate (sender, key, nonce), written BEFORE send_tx with the outer tx hash.
      // state: sending -> executed | failed | submitted (outcome unknown) -> executed | failed | not_executed | superseded.
      "CREATE TABLE IF NOT EXISTS submissions (sender_id TEXT NOT NULL, public_key TEXT NOT NULL, nonce TEXT NOT NULL, tx_hash TEXT NOT NULL, state TEXT NOT NULL, reservation_id INTEGER NOT NULL, deposit_yocto TEXT NOT NULL, hold_yocto TEXT NOT NULL, max_block_height TEXT NOT NULL, receipt_failure TEXT, was_unknown INTEGER NOT NULL DEFAULT 0, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, PRIMARY KEY (sender_id, public_key, nonce))",
      "CREATE INDEX IF NOT EXISTS idx_submissions_tx ON submissions(tx_hash)",
      "CREATE INDEX IF NOT EXISTS idx_submissions_state ON submissions(state, updated_at_ms)",
      "CREATE TABLE IF NOT EXISTS activations (account_id TEXT PRIMARY KEY, claimed_at_ms INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS global_budget (id INTEGER PRIMARY KEY CHECK (id = 1), window_start_ms INTEGER NOT NULL, open_used_yocto TEXT NOT NULL DEFAULT '0', reserved_used_yocto TEXT NOT NULL DEFAULT '0')",
    ]) this.d.exec(stmt);
  }

  /** Runs `fn` inside an IMMEDIATE transaction (acquires the write lock up
   * front, so two concurrent callers serialize rather than racing a
   * read-then-write check). Rolls back on throw. */
  private withTx<T>(fn: () => T): T {
    return this.d.transaction(fn);
  }

  /** Throws GuardViolation if this (senderId, publicKey, nonce) was
   * already relayed; otherwise marks it seen atomically in the same
   * transaction (so two concurrent callers with the same nonce can never
   * both succeed -- the loser's INSERT hits the PRIMARY KEY and the
   * whole transaction rolls back before any budget/broadcast happens). */
  checkAndMarkReplay(senderId: string, publicKey: string, nonce: bigint): void {
    this.withTx(() => {
      try {
        this.d.run("INSERT INTO nonces (sender_id, public_key, nonce, seen_at_ms) VALUES (?, ?, ?, ?)", senderId, publicKey, nonce.toString(), this.now());
      } catch (err: any) {
        if (String(err?.message ?? err).match(/UNIQUE constraint failed/i)) {
          throw new GuardViolation(
            `replay detected: (${senderId}, ${publicKey}, nonce=${nonce}) already relayed`,
          );
        }
        throw err;
      }
    });
  }

  /** LIVE1: un-mark a (sender, key, nonce) whose broadcast failed WITHOUT executing, so the user's retry (which
   * re-signs the same nonce, because their chain nonce never moved) is not refused as a replay forever. */
  releaseReplay(senderId: string, publicKey: string, nonce: bigint): void {
    this.withTx(() => {
      this.d.run("DELETE FROM nonces WHERE sender_id = ? AND public_key = ? AND nonce = ?", senderId, publicKey, nonce.toString());
    });
  }

  replayMarkedAt(senderId: string, publicKey: string, nonce: bigint): number | undefined {
    const row = this.d.get("SELECT seen_at_ms AS t FROM nonces WHERE sender_id = ? AND public_key = ? AND nonce = ?", senderId, publicKey, nonce.toString()) as { t: number } | undefined;
    return row ? Number(row.t) : undefined;
  }

  /** SEC1/MON-2: record (or re-point, on an InvalidNonce re-sign) the outer tx about to be sent for this delegate. */
  recordSending(r: { senderId: string; publicKey: string; nonce: bigint; txHash: string; reservationId: number; depositYocto: bigint; holdYocto: bigint; maxBlockHeight: bigint }): void {
    this.withTx(() => {
      const now = this.now();
      this.d.run(
        "INSERT OR REPLACE INTO submissions (sender_id, public_key, nonce, tx_hash, state, reservation_id, deposit_yocto, hold_yocto, max_block_height, receipt_failure, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, 'sending', ?, ?, ?, ?, NULL, ?, ?)",
        r.senderId, r.publicKey, r.nonce.toString(), r.txHash, r.reservationId, r.depositYocto.toString(), r.holdYocto.toString(), r.maxBlockHeight.toString(), now, now,
      );
    });
  }

  setSubmissionState(senderId: string, publicKey: string, nonce: bigint, state: SubmissionState, receiptFailure?: string): void {
    this.withTx(() => {
      this.d.run("UPDATE submissions SET state = ?, receipt_failure = ?, updated_at_ms = ?, was_unknown = CASE WHEN ? = 'submitted' THEN 1 ELSE was_unknown END WHERE sender_id = ? AND public_key = ? AND nonce = ?",
        state, receiptFailure ?? null, this.now(), state, senderId, publicKey, nonce.toString());
    });
  }

  /** By outer tx hash, or by (sender, nonce) (any key), or by (sender, key, nonce). */
  submission(by: { txHash: string } | { senderId: string; nonce: bigint; publicKey?: string }): Submission | undefined {
    const row = "txHash" in by
      ? this.d.get("SELECT * FROM submissions WHERE tx_hash = ?", by.txHash)
      : by.publicKey !== undefined
        ? this.d.get("SELECT * FROM submissions WHERE sender_id = ? AND public_key = ? AND nonce = ?", by.senderId, by.publicKey, by.nonce.toString())
        : this.d.get("SELECT * FROM submissions WHERE sender_id = ? AND nonce = ? ORDER BY updated_at_ms DESC", by.senderId, by.nonce.toString());
    return row ? toSubmission(row) : undefined;
  }

  /** MON-10: unresolved rows -- outcome unknown, or still "sending" after `idleMs` (orphaned by an eviction) -- oldest first. */
  openSubmissions(idleMs: number, limit: number): Submission[] {
    const out: Submission[] = [];
    // The driver's get() returns one row; walk by updated_at so a small limit stays cheap.
    let after = -1;
    for (let i = 0; i < limit; i++) {
      const row = this.d.get("SELECT * FROM submissions WHERE (state = 'submitted' OR (state = 'sending' AND updated_at_ms <= ?)) AND updated_at_ms > ? ORDER BY updated_at_ms ASC", this.now() - idleMs, after);
      if (!row) break;
      out.push(toSubmission(row));
      after = Number(row.updated_at_ms);
    }
    return out;
  }

  /** SEC1/MON-9: claim an implicit-account activation for `accountId`. False when a claim younger than `ttlMs` exists
   * (a concurrent call is sending, or one was just sent and the account view may not show it yet). Atomic. */
  claimActivation(accountId: string, ttlMs = ACTIVATION_CLAIM_TTL_MS): boolean {
    return this.withTx(() => {
      const now = this.now();
      const row = this.d.get("SELECT claimed_at_ms AS t FROM activations WHERE account_id = ?", accountId) as { t: number } | undefined;
      if (row && now - Number(row.t) < ttlMs) return false;
      this.d.run("INSERT OR REPLACE INTO activations (account_id, claimed_at_ms) VALUES (?, ?)", accountId, now);
      return true;
    });
  }

  releaseActivation(accountId: string): void {
    this.withTx(() => { this.d.run("DELETE FROM activations WHERE account_id = ?", accountId); });
  }

  checkRateLimit(userId: string): void {
    this.withTx(() => {
      const now = this.now();
      const windowStart = now - this.cfg.windowMs;
      this.d.run("DELETE FROM rate_limit WHERE user_id = ? AND ts_ms < ?", userId, windowStart);
      const row = this.d.get("SELECT COUNT(*) AS n FROM rate_limit WHERE user_id = ? AND ts_ms >= ?", userId, windowStart) as { n: number };
      if (row.n >= this.cfg.maxRequestsPerWindow) {
        throw new GuardViolation(
          `rate limit exceeded for ${userId}: ${row.n}/${this.cfg.maxRequestsPerWindow} in the last ${this.cfg.windowMs}ms`,
        );
      }
      this.d.run("INSERT INTO rate_limit (user_id, ts_ms) VALUES (?, ?)", userId, now);
    });
  }

  private loadBudgetRow(userId: string): { window_start_ms: number; spent_yocto: string; reserved_yocto: string } {
    const now = this.now();
    let row = this.d.get("SELECT * FROM budget WHERE user_id = ?", userId) as any;
    if (!row) {
      this.d.run("INSERT INTO budget (user_id, window_start_ms, spent_yocto, reserved_yocto) VALUES (?, ?, '0', '0')", userId, now);
      row = { window_start_ms: now, spent_yocto: "0", reserved_yocto: "0" };
    } else if (now - row.window_start_ms >= DAY_MS) {
      this.d.run("UPDATE budget SET window_start_ms = ?, spent_yocto = '0', reserved_yocto = '0' WHERE user_id = ?", now, userId);
      row = { window_start_ms: now, spent_yocto: "0", reserved_yocto: "0" };
    }
    return row;
  }

  /** Reserves `estimateYocto` against the user's rolling 24h budget
   * (settled spend + still-outstanding reservations from other in-flight
   * calls must not exceed the cap). Returns a reservationId to later
   * settle(). Throws GuardViolation without reserving anything if the
   * reservation would exceed the cap -- this is the pre-broadcast check
   * that stands in for the real cost, which isn't known until the chain
   * returns an outcome. */
  reserveBudget(
    userId: string,
    estimateYocto: bigint,
    opts: { isBettor?: boolean } = {},
  ): { reservationId: number } {
    return this.withTx(() => {
      const row = this.loadBudgetRow(userId);
      const spent = BigInt(row.spent_yocto);
      const reserved = BigInt(row.reserved_yocto);
      if (spent + reserved + estimateYocto > this.cfg.dailyBudgetYocto) {
        throw new GuardViolation(
          `daily sponsored-gas budget exceeded for ${userId}: ${spent} settled + ${reserved} reserved + ${estimateYocto} new > ${this.cfg.dailyBudgetYocto}`,
        );
      }
      // D-RLY1 global cap, in the same transaction as the per-sender hold:
      // open share first (anyone), then the reserve (existing bettors only).
      const g = this.loadGlobalRow();
      const openUsed = BigInt(g.open_used_yocto);
      const reservedUsed = BigInt(g.reserved_used_yocto);
      let pool: "open" | "reserved";
      if (openUsed + estimateYocto <= this.openCap) {
        pool = "open";
      } else {
        const reserveFits = reservedUsed + estimateYocto <= this.reservedCap;
        if (opts.isBettor && reserveFits) {
          pool = "reserved";
        } else {
          throw new GlobalCapViolation(
            reserveFits
              ? `global daily sponsored-gas cap reached: the open share is spent (${openUsed}/${this.openCap}); the remaining reserve is for accounts with an existing bet on the escrow`
              : `global daily sponsored-gas cap reached: ${openUsed + reservedUsed} of ${this.globalCap} yocto spent today; try again after the daily window resets`,
            reserveFits,
          );
        }
      }
      this.d.run("UPDATE global_budget SET open_used_yocto = ?, reserved_used_yocto = ? WHERE id = 1", 
          (pool === "open" ? openUsed + estimateYocto : openUsed).toString(),
          (pool === "reserved" ? reservedUsed + estimateYocto : reservedUsed).toString(),
        );
      this.d.run("UPDATE budget SET reserved_yocto = ? WHERE user_id = ?", (reserved + estimateYocto).toString(), userId);
      const ins = this.d.run("INSERT INTO reservations (user_id, amount_yocto, created_at_ms, pool) VALUES (?, ?, ?, ?)", userId, estimateYocto.toString(), this.now(), pool);
      return { reservationId: Number(ins.lastInsertRowid) };
    });
  }

  /** Settles a previous reservation to the real cost: releases the
   * original estimate from `reserved_yocto` and adds `actualYocto` to
   * `spent_yocto`. Called after broadcast once the chain tells us what
   * was actually burnt. If actual > estimate, the overage still posts to
   * spent_yocto (the user's budget absorbs the true cost even though the
   * guard check up front only had the estimate to go on) -- this can
   * only push a window's booked total over the nominal cap by the delta
   * between one call's estimate and its real cost, not unboundedly,
   * because every call's reservation step still enforces the cap against
   * the estimate first. */
  settleBudget(userId: string, reservationId: number, actualYocto: bigint): void {
    this.withTx(() => {
      const res = this.d.get("SELECT amount_yocto, pool FROM reservations WHERE id = ? AND user_id = ? AND settled = 0", reservationId, userId) as { amount_yocto: string; pool: string } | undefined;
      if (!res) {
        throw new Error(`settleBudget: reservation ${reservationId} for ${userId} not found or already settled`);
      }
      const estimate = BigInt(res.amount_yocto);
      const row = this.loadBudgetRow(userId);
      const reserved = BigInt(row.reserved_yocto);
      const spent = BigInt(row.spent_yocto);
      // A reservation from a previous budget window was already dropped by the
      // rollover; subtracting it again would erase a newer window's holds.
      const sameWindow = this.reservationInWindow(reservationId, row.window_start_ms);
      const newReserved = sameWindow ? reserved - estimate : reserved; // release the estimate regardless of actual
      this.d.run("UPDATE budget SET reserved_yocto = ?, spent_yocto = ? WHERE user_id = ?", (newReserved < 0n ? 0n : newReserved).toString(), (spent + actualYocto).toString(), userId);
      this.adjustGlobal(reservationId, res.pool, estimate, actualYocto);
      this.d.run("UPDATE reservations SET settled = 1 WHERE id = ?", reservationId);
    });
  }

  /** Releases a reservation without charging anything (broadcast never
   * happened, e.g. a later guard or the chain call itself failed) --
   * frees the held budget back up instead of silently eating it. */
  releaseBudget(userId: string, reservationId: number): void {
    this.withTx(() => {
      const res = this.d.get("SELECT amount_yocto, pool FROM reservations WHERE id = ? AND user_id = ? AND settled = 0", reservationId, userId) as { amount_yocto: string; pool: string } | undefined;
      if (!res) return; // already settled/released -- no-op
      const estimate = BigInt(res.amount_yocto);
      const row = this.loadBudgetRow(userId);
      const reserved = BigInt(row.reserved_yocto);
      const newReserved = this.reservationInWindow(reservationId, row.window_start_ms) ? reserved - estimate : reserved;
      this.d.run("UPDATE budget SET reserved_yocto = ? WHERE user_id = ?", (newReserved < 0n ? 0n : newReserved).toString(), userId);
      this.adjustGlobal(reservationId, res.pool, estimate, 0n);
      this.d.run("UPDATE reservations SET settled = 1 WHERE id = ?", reservationId);
    });
  }

  private loadGlobalRow(): { window_start_ms: number; open_used_yocto: string; reserved_used_yocto: string } {
    const now = this.now();
    let row = this.d.get("SELECT * FROM global_budget WHERE id = 1") as any;
    if (!row) {
      this.d.run("INSERT INTO global_budget (id, window_start_ms, open_used_yocto, reserved_used_yocto) VALUES (1, ?, '0', '0')", now);
      row = { window_start_ms: now, open_used_yocto: "0", reserved_used_yocto: "0" };
    } else if (now - row.window_start_ms >= DAY_MS) {
      this.d.run("UPDATE global_budget SET window_start_ms = ?, open_used_yocto = '0', reserved_used_yocto = '0' WHERE id = 1", now);
      row = { window_start_ms: now, open_used_yocto: "0", reserved_used_yocto: "0" };
    }
    return row;
  }

  /** Replaces a reservation's `estimate` hold in the global pool it drew
   * from with `actual` (0 for a release). A reservation from a previous
   * global window was already dropped by the rollover and is ignored, so it
   * cannot erase a newer window's holds. */
  private adjustGlobal(reservationId: number, pool: string, estimate: bigint, actual: bigint): void {
    if (pool !== "open" && pool !== "reserved") return;
    const g = this.loadGlobalRow();
    if (!this.reservationInWindow(reservationId, g.window_start_ms)) return;
    const col = pool === "open" ? "open_used_yocto" : "reserved_used_yocto";
    const cur = BigInt(g[col]);
    const next = cur - estimate + actual;
    this.d.run(`UPDATE global_budget SET ${col} = ? WHERE id = 1`, (next < 0n ? 0n : next).toString());
  }

  /** Relayer-wide spend vs cap for the current 24h window (monitor feed). */
  globalBudgetStatus(): GlobalBudgetStatus {
    const g = this.withTx(() => this.loadGlobalRow());
    const open = BigInt(g.open_used_yocto);
    const reserved = BigInt(g.reserved_used_yocto);
    return {
      capYocto: this.globalCap,
      openCapYocto: this.openCap,
      reservedCapYocto: this.reservedCap,
      openUsedYocto: open,
      reservedUsedYocto: reserved,
      usedYocto: open + reserved,
      windowStartMs: g.window_start_ms,
      windowEndsMs: g.window_start_ms + DAY_MS,
    };
  }

  private reservationInWindow(reservationId: number, windowStartMs: number): boolean {
    const r = this.d.get("SELECT created_at_ms FROM reservations WHERE id = ?", reservationId) as
      | { created_at_ms: number }
      | undefined;
    return !!r && r.created_at_ms >= windowStartMs;
  }

  /** Test/ops helper: total settled spend this window for a user. */
  spentYoctoToday(userId: string): bigint {
    const row = this.loadBudgetRowReadOnly(userId);
    return BigInt(row.spent_yocto);
  }

  private loadBudgetRowReadOnly(userId: string): { spent_yocto: string; reserved_yocto: string } {
    return this.withTx(() => this.loadBudgetRow(userId));
  }
}
