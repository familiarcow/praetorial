// MON1 stuck payouts (PREMAIN1 MAINNET-RISK #1). The frozen escrow marks a payout line `in_flight` in drain_payouts /
// retry_payout / finalize (lib.rs fire_payout) and clears it only in the `on_payout_result` callback (10 Tgas). If that
// callback ever ran out of gas the line would stay in flight forever: drain/retry skip in-flight lines, there is no
// timeout and no refund path. Only a new escrow version fixes it; this module DETECTS it so an operator can act.
//
// Threshold: 10 minutes of being SEEN in flight. Measured on the frz3 testnet escrow (2026-11-10, 9 real
// drain_payouts/finalize/concede txs): drain -> mt_transfer -> on_payout_result = 3 blocks, 1.5-2.0 s. 10 min is
// ~300x that, so congestion (delayed receipts) or a slow RPC cannot fire it, while a really wedged line is reported
// within ~11 min (one 1-minute monitor tick of jitter). The age is measured from the monitor's first sighting, so a
// monitor outage can only delay an alert, never fire a false one.
//
// Cost bound: pending_payouts_view ids are dense and never pruned (lib.rs:5411), and `done` is terminal, so each scan
// starts at the oldest line that was not done last time (`nextFrom`); a settled ledger costs one short page per tick.
import type { PendingPayout } from "@praetorial/common/types.js";
import type { Alert } from "./alertsCore.js";

export const DEFAULT_STUCK_PAYOUT_THRESHOLD_MS = 10 * 60_000;
export const PAYOUT_SCAN_PAGE = 500;
export const PAYOUT_SCAN_MAX_PAGES = 10;

export interface PayoutViewClient { view<T>(contract: string, method: string, args: Record<string, unknown>): Promise<T> }

export interface UndonePayoutScan {
  /** Every not-done line from `fromId` on (in flight or not). */
  undone: PendingPayout[];
  /** false when the per-tick page budget ran out before the end of the ledger. */
  complete: boolean;
  /** Where the next scan should start: the oldest not-done line seen, else one past the last line seen. */
  nextFrom: number;
}

/** Reads pending_payouts_view from `fromId` to the end of the ledger (at most `maxPages` pages). Throws on any RPC error. */
export async function scanUndonePayouts(
  client: PayoutViewClient, escrow: string, fromId: number, maxPages = PAYOUT_SCAN_MAX_PAGES,
): Promise<UndonePayoutScan> {
  let cur = Math.max(1, Math.floor(fromId));
  const undone: PendingPayout[] = [];
  let lastSeen = cur - 1, complete = false;
  for (let page = 0; page < maxPages; page++) {
    const rows = await client.view<PendingPayout[]>(escrow, "pending_payouts_view", { from: cur, limit: PAYOUT_SCAN_PAGE });
    if (!Array.isArray(rows)) throw new Error(`pending_payouts_view: not an array (${typeof rows})`);
    for (const r of rows) {
      if (typeof r?.id !== "number" || typeof r.in_flight !== "boolean" || typeof r.done !== "boolean") throw new Error(`pending_payouts_view: malformed row ${JSON.stringify(r)}`);
      if (!r.done) undone.push(r);
      lastSeen = Math.max(lastSeen, r.id);
    }
    if (rows.length < PAYOUT_SCAN_PAGE) { complete = true; break; }
    cur = lastSeen + 1;
  }
  // every id below the oldest undone line is done (and done is terminal), so it never needs reading again
  const nextFrom = undone.length ? Math.min(...undone.map((p) => p.id)) : lastSeen + 1;
  return { undone, complete, nextFrom };
}

/** One entry = one in-flight episode of one line (`id:attempts`): a retry after a failed transfer bumps attempts. */
const entryKey = (p: PendingPayout) => `${p.id}:${p.attempts}`;

export interface StuckPayoutTrackerState { firstSeen: [string, number][]; alerted: string[] }

export class StuckPayoutTracker {
  private firstSeen = new Map<string, number>();
  private alerted = new Set<string>();
  constructor(readonly thresholdNs: number) {}

  /** `undone` = the current not-done lines. Returns an alert for each in-flight entry that just crossed the threshold. */
  tick(contractId: string, undone: PendingPayout[], nowNs: number): Alert[] {
    const live = new Set<string>();
    const out: Alert[] = [];
    for (const p of undone) {
      if (p.done || !p.in_flight) continue;
      const k = entryKey(p);
      live.add(k);
      const since = this.firstSeen.get(k) ?? nowNs;
      this.firstSeen.set(k, since);
      if (nowNs - since >= this.thresholdNs && !this.alerted.has(k)) {
        this.alerted.add(k);
        out.push(alertForStuckPayout(contractId, p, nowNs - since));
      }
    }
    for (const k of [...this.firstSeen.keys()]) if (!live.has(k)) this.firstSeen.delete(k);
    for (const k of [...this.alerted]) if (!live.has(k)) this.alerted.delete(k);
    return out;
  }

  exportState(): StuckPayoutTrackerState { return { firstSeen: [...this.firstSeen], alerted: [...this.alerted] }; }
  importState(s: Partial<StuckPayoutTrackerState> | undefined): void {
    this.firstSeen = new Map(s?.firstSeen ?? []);
    this.alerted = new Set(s?.alerted ?? []);
  }
}

export function alertForStuckPayout(contractId: string, p: PendingPayout, ageNs: number): Alert {
  const mins = Math.floor(ageNs / 60_000_000_000);
  return {
    key: `payout_stuck_in_flight:${contractId}:${p.id}:${p.attempts}`,
    kind: "payout_stuck_in_flight",
    severity: "critical",
    message: `payout stuck in flight on ${contractId}: bet ${p.bet_id}, ${p.amount} ${p.token_id} (seen in flight ${mins} min)`,
    detail: `payout id=${p.id} bet=${p.bet_id} asset=${p.token_id} amount=${p.amount} receiver=${p.receiver} reason=${p.reason} attempts=${p.attempts}. `
      + `The on_payout_result callback never cleared in_flight; the frozen escrow has no retry or refund for this line `
      + `(PREMAIN1 MAINNET-RISK #1). Check the last drain_payouts/finalize tx for this bet; recovery needs a new escrow version.`,
  };
}

export function alertForPayoutsUnchecked(contractId: string, err: unknown): Alert {
  return {
    key: `payout_stuck_in_flight_unchecked:${contractId}`,
    kind: "payout_stuck_in_flight_unchecked",
    severity: "warning",
    message: `cannot check escrow ${contractId} for stuck in-flight payouts`,
    detail: `in-flight payout check failed (NOT assumed OK): ${err instanceof Error ? err.message : String(err)}`,
  };
}
