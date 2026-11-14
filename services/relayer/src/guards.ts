// Per-user safety rails: rate limiting, a daily sponsored-gas budget, and
// replay protection. Backed by `GuardStore` (SQLite, node:sqlite) so all
// three survive a relayer restart and are safe under concurrent requests
// for the same user (every check+write happens inside one SQLite
// IMMEDIATE transaction -- see guardStore.ts). This class is now a thin
// typed facade kept for backward compatibility with callers/tests that
// constructed a `Guards` directly; `Relayer` talks to it, not to
// GuardStore, so the reserve/settle split lives here.
import { GuardStore, GuardViolation, GlobalCapViolation, type GlobalBudgetStatus, type GuardStoreConfig } from "./guardStore.js";
import type { Submission, SubmissionState } from "./guardStoreCore.js";

export { GuardViolation, GlobalCapViolation };
export type GuardsConfig = GuardStoreConfig;

export class Guards {
  private store: GuardStore;
  private ownsStore: boolean;

  constructor(cfg: GuardsConfig, dbPathOrStore: string | GuardStore = ":memory:", now: () => number = Date.now) {
    if (dbPathOrStore instanceof GuardStore) {
      this.store = dbPathOrStore;
      this.ownsStore = false;
    } else {
      this.store = new GuardStore(dbPathOrStore, cfg, now);
      this.ownsStore = true;
    }
  }

  close(): void {
    if (this.ownsStore) this.store.close();
  }

  checkAndMarkReplay(senderId: string, publicKey: string, nonce: bigint): void {
    this.store.checkAndMarkReplay(senderId, publicKey, nonce);
  }

  releaseReplay(senderId: string, publicKey: string, nonce: bigint): void {
    this.store.releaseReplay(senderId, publicKey, nonce);
  }

  replayMarkedAt(senderId: string, publicKey: string, nonce: bigint): number | undefined {
    return this.store.replayMarkedAt(senderId, publicKey, nonce);
  }

  checkRateLimit(userId: string): void {
    this.store.checkRateLimit(userId);
  }

  /** Reserves the estimated sponsorship cost against the user's daily
   * budget up front (before broadcast). Must be settled or released
   * afterwards -- callers should not reserve without a matching
   * settle/release in a finally-equivalent path. */
  reserveBudget(userId: string, estimateYocto: bigint, opts: { isBettor?: boolean } = {}): { reservationId: number } {
    return this.store.reserveBudget(userId, estimateYocto, opts);
  }

  globalBudgetStatus(): GlobalBudgetStatus {
    return this.store.globalBudgetStatus();
  }

  /** Settles a reservation to the real cost once known (post-broadcast). */
  settleBudget(userId: string, reservationId: number, actualYocto: bigint): void {
    this.store.settleBudget(userId, reservationId, actualYocto);
  }

  /** Releases a reservation with no charge (broadcast never happened). */
  releaseBudget(userId: string, reservationId: number): void {
    this.store.releaseBudget(userId, reservationId);
  }

  recordSending(r: Parameters<GuardStore["recordSending"]>[0]): void { this.store.recordSending(r); }
  setSubmissionState(senderId: string, publicKey: string, nonce: bigint, state: SubmissionState, receiptFailure?: string): void { this.store.setSubmissionState(senderId, publicKey, nonce, state, receiptFailure); }
  submission(by: Parameters<GuardStore["submission"]>[0]): Submission | undefined { return this.store.submission(by); }
  openSubmissions(idleMs: number, limit: number): Submission[] { return this.store.openSubmissions(idleMs, limit); }

  spentYoctoToday(userId: string): bigint {
    return this.store.spentYoctoToday(userId);
  }
}
