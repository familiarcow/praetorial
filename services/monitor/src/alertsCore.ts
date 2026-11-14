// Host-neutral half of alerts.ts (CF1c): no node builtins, so the monitor Worker bundles it. alerts.ts re-exports
// everything here and adds the node-only file persistence.
// Pure monitoring-alert logic: turns invariant-check results, keeper
// due-action lists, RPC stats and contract pause/shutdown state into
// Alert[], plus a cooldown-based dedupe filter. No RPC, no network,
// no timers -- every stateful piece (StallTracker, RpcErrorRateTracker,
// AlertDedupe) is driven purely by nowNs the caller supplies, so it's
// fully unit-testable with a fabricated clock. Persistence (dedupe
// cooldown state surviving a process restart) is a plain JSON file,
// same posture as notifier.ts's loadSeenKeys/saveSeenKeys.
import type { MonitorResult } from "./invariants.js";

export type AlertKind =
  | "invariant_violation"
  | "keeper_stall"
  | "rpc_error_rate"
  | "contract_shutdown"
  | "storage_headroom"
  | "storage_headroom_unchecked"
  | "relayer_global_budget"
  | "relayer_global_budget_unchecked"
  // D-DSY1
  | "contract_version_mismatch"
  | "contract_version_unchecked"
  | "terminal_unconfirmed"
  | "terminal_single_rpc"
  // LH5
  | "keeper_liveness"
  // MON4
  | "nearai_credit_exhausted"
  | "outlayer_unhealthy"
  | "keeper_credit_low"
  | "service_heartbeat_missing"
  | "source_unreachable"
  // MON1 stuck payouts (PREMAIN1 MAINNET-RISK #1)
  | "payout_stuck_in_flight"
  | "payout_stuck_in_flight_unchecked"
  // LIFE1 (SM1 CON-2 / CON-3 / LIFE-9): bets the frozen escrow cannot move on by itself
  | "bet_stuck_resolving"
  | "resolution_exhausted";

/** "info" = a recovery message (MON4). */
export type AlertSeverity = "critical" | "warning" | "info";

export interface Alert {
  /** Stable dedupe identity: the SAME ongoing condition must always
   * produce the same key across ticks, so AlertDedupe can tell "still
   * the same problem" apart from "a new, different problem". */
  key: string;
  kind: AlertKind;
  severity: AlertSeverity;
  message: string;
  detail: string;
}

// ------------------------- (1) invariant violations -------------------------

/** One alert per invariant violation found across every bet's latest
 * MonitorResult (reuses invariants.ts's runMonitor output verbatim --
 * this module does no invariant math of its own). */
export function alertsForInvariantResults(
  contractId: string,
  results: Map<number, MonitorResult>,
): Alert[] {
  const alerts: Alert[] = [];
  for (const [betId, result] of results) {
    for (const v of result.violations) {
      alerts.push({
        key: `invariant:${contractId}:${betId}:${v.invariant}${v.asset ? `:${v.asset}` : ""}`,
        kind: "invariant_violation",
        severity: "critical",
        message:
          betId < 0
            ? `${v.invariant} contract-wide violation (${contractId})`
            : `${v.invariant} violation on bet #${betId} (${contractId})`,
        detail: v.detail,
      });
    }
  }
  return alerts;
}

// ------------------------- (2) keeper stall -------------------------

export interface DueAction {
  contractId: string;
  betId: number;
  /** Mirrors keeper/src/policy.ts's KeeperAction["kind"], carried as a
   * plain string so this module has no compile-time dependency on the
   * keeper's action union (new action kinds need no change here). */
  kind: string;
}

/** Tracks, across ticks, how long each due keeper action has been
 * outstanding and alerts once it's been due for >= graceNs without
 * being acted on. A stateful pure class (no I/O): the caller drives it
 * tick by tick with the due-action list and the current nowNs: */
export class StallTracker {
  private readonly firstSeenDueNs = new Map<string, number>();

  /** CF1c: the Worker persists the due-since clock in its Durable Object SQLite so a restart does not reset the stall grace. */
  exportState(): [string, number][] { return [...this.firstSeenDueNs.entries()]; }
  importState(s: [string, number][]): void { this.firstSeenDueNs.clear(); for (const [k, v] of s) this.firstSeenDueNs.set(k, v); }

  constructor(private readonly graceNs: number) {}

  tick(dueActions: DueAction[], nowNs: number): Alert[] {
    const seenKeys = new Set<string>();
    const alerts: Alert[] = [];
    for (const a of dueActions) {
      const key = `${a.contractId}:${a.betId}:${a.kind}`;
      seenKeys.add(key);
      const firstSeen = this.firstSeenDueNs.get(key);
      if (firstSeen === undefined) {
        this.firstSeenDueNs.set(key, nowNs);
        continue;
      }
      const ageNs = nowNs - firstSeen;
      if (ageNs >= this.graceNs) {
        alerts.push({
          key: `stall:${key}`,
          kind: "keeper_stall",
          severity: "warning",
          message: `keeper stalled on ${a.kind} for bet #${a.betId} (${a.contractId})`,
          detail: `due since ns=${firstSeen}, now=${nowNs}, age=${ageNs}ns >= grace=${this.graceNs}ns`,
        });
      }
    }
    // An action no longer due (keeper acted, or the bet moved past it)
    // loses its tracked due-since timestamp, so a LATER recurrence of
    // the same key is timed fresh rather than against a stale clock.
    for (const key of this.firstSeenDueNs.keys()) {
      if (!seenKeys.has(key)) this.firstSeenDueNs.delete(key);
    }
    return alerts;
  }
}

// ------------------------- (3) RPC 429/error rate -------------------------

export interface RpcStats {
  total: number;
  errors: number;
}

/** Fires only once the error ratio has been >= thresholdRatio for >=
 * minConsecutiveTicks consecutive ticks in a row -- a single noisy tick
 * never alerts alone. Resets its streak the moment a tick drops back
 * under the threshold (or carries zero samples). Keeps firing every
 * tick the condition still holds past the threshold tick count; the
 * runner's AlertDedupe is what actually suppresses repeat sends. */
export class RpcErrorRateTracker {
  private consecutive = 0;

  /** CF1c: persisted by the Worker (see StallTracker.exportState). */
  exportState(): number { return this.consecutive; }
  importState(n: number): void { this.consecutive = n; }

  constructor(
    private readonly thresholdRatio = 0.5,
    private readonly minConsecutiveTicks = 3,
    private readonly minSamplesPerTick = 1,
  ) {}

  tick(stats: RpcStats, nowNs: number): Alert | null {
    const ratio = stats.total > 0 ? stats.errors / stats.total : 0;
    const overThreshold = stats.total >= this.minSamplesPerTick && ratio >= this.thresholdRatio;
    if (!overThreshold) {
      this.consecutive = 0;
      return null;
    }
    this.consecutive++;
    if (this.consecutive < this.minConsecutiveTicks) return null;
    return {
      key: "rpc_error_rate",
      kind: "rpc_error_rate",
      severity: "critical",
      message: "sustained RPC 429/error rate",
      detail: `errors=${stats.errors}/${stats.total} (${(ratio * 100).toFixed(1)}%) over ${this.consecutive} consecutive tick(s), nowNs=${nowNs}`,
    };
  }
}

// ------------------------- (4) paused / shut down -------------------------

export function alertsForContractState(
  contractId: string,
  paused: boolean,
  shutdown: boolean,
): Alert[] {
  const alerts: Alert[] = [];
  if (paused) {
    alerts.push({
      key: `paused:${contractId}`,
      kind: "contract_shutdown",
      severity: "warning",
      message: `escrow contract ${contractId} is paused`,
      detail: "paused=true",
    });
  }
  if (shutdown) {
    alerts.push({
      key: `shutdown:${contractId}`,
      kind: "contract_shutdown",
      severity: "critical",
      message: `escrow contract ${contractId} is shut down`,
      detail: "shutdown=true",
    });
  }
  return alerts;
}

// ------------------------- dedupe / cooldown -------------------------

/** Filters a batch of candidate alerts down to the ones that should
 * actually be delivered right now, given a persisted key -> last-sent
 * map and the cooldown window. A key with no prior send, or whose
 * last send is >= cooldownNs in the past, is sent (and its timestamp
 * is bumped in `lastSentNs` in place); everything else is suppressed
 * -- still a real, ongoing condition, just not re-notified yet. */
export class AlertDedupe {
  constructor(private readonly cooldownNs: number) {}

  filter(alerts: Alert[], lastSentNs: Map<string, number>, nowNs: number): Alert[] {
    const toSend: Alert[] = [];
    for (const a of alerts) {
      const last = lastSentNs.get(a.key);
      if (last === undefined || nowNs - last >= this.cooldownNs) {
        toSend.push(a);
        lastSentNs.set(a.key, nowNs);
      }
    }
    return toSend;
  }
}
