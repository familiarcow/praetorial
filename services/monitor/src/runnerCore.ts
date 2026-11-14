// Host-neutral half of runner.ts (CF1c): the alert-tick orchestration, no node builtins/NearClient, so the monitor
// Worker runs the very same runAlertTick as the node monitor. runner.ts re-exports everything here.
import type { MonitorResult } from "./invariants.js";
import {
  AlertDedupe, RpcErrorRateTracker, StallTracker, alertsForContractState, alertsForInvariantResults,
  type Alert, type DueAction, type RpcStats,
} from "./alertsCore.js";
import { alertForUncheckable, alertsForStorageHeadroom, appendSample, type HeadroomSample } from "./storageHeadroom.js";
import { alertForRelayerBudgetUnchecked, alertsForRelayerGlobalBudget, type RelayerBudgetSnapshot } from "./relayerBudget.js";
import { RecoveryTracker } from "./opsAlertsCore.js";
import { DEFAULT_STUCK_PAYOUT_THRESHOLD_MS, StuckPayoutTracker, alertForPayoutsUnchecked } from "./stuckPayouts.js";
import type { PendingPayout } from "@praetorial/common/types.js";
import type { AlertChannel } from "./alertChannel.js";

/** Contract-wide results are not tied to a bet; they live under this id. */
export const CONTRACT_WIDE_BET_ID = -1;

/** Everything one alert tick needs, injected so the orchestration
 * logic below has zero direct RPC/chain dependency -- tests supply a
 * fake provider, main() supplies a real one. */
export interface AlertSnapshotProvider {
  contractId: string;
  fetchInvariantResults(): Promise<Map<number, MonitorResult>>;
  fetchDueActions(): Promise<DueAction[]>;
  fetchRpcStats(): Promise<RpcStats>;
  fetchContractState(): Promise<{ paused: boolean; shutdown: boolean }>;
  /** Optional (MON1): one escrow storage-headroom reading; throws if the
   * RPC can't be read (becomes a distinct "cannot check" alert). */
  fetchStorageHeadroomSample?(nowNs: number): Promise<HeadroomSample>;
  /** Optional (RLY1): relayer global daily gas spend vs cap; throws if unreadable. */
  fetchRelayerBudget?(): Promise<RelayerBudgetSnapshot>;
  /** Optional (MON4): currently-active ops alerts (heartbeats, account balances, ...). Recovery is derived. */
  fetchOpsAlerts?(nowNs: number): Promise<Alert[]>;
  /** Optional (MON1 stuck payouts): the escrow's not-done payout lines (stuckPayouts.scanUndonePayouts); throws if unreadable. */
  fetchUndonePayouts?(): Promise<{ undone: PendingPayout[]; complete: boolean }>;
  /** Optional (LIFE1): stuck-Resolving / resolution-exhausted bet alerts (stuckResolving.ts). */
  fetchStuckResolvingAlerts?(nowNs: number): Promise<Alert[]>;
}

export interface AlertRunnerState {
  stallTracker: StallTracker;
  rpcTracker: RpcErrorRateTracker;
  dedupe: AlertDedupe;
  lastSentNs: Map<string, number>;
  /** In-memory headroom sample store (lost on restart; trend rebuilds). */
  headroomSamples: HeadroomSample[];
  /** MON4: turns a cleared ops alert into one recovery message. */
  opsRecovery: RecoveryTracker;
  /** MON1: first-seen clock + once-per-entry set for in-flight payout lines. */
  stuckPayouts: StuckPayoutTracker;
}

export interface AlertRunnerOptions {
  stallGraceNs: number;
  cooldownNs: number;
  rpcErrorThresholdRatio?: number;
  rpcMinConsecutiveTicks?: number;
  rpcMinSamplesPerTick?: number;
  /** Pre-loaded dedupe state (e.g. from disk), so a process restart
   * doesn't immediately re-fire every still-ongoing alert. Defaults to
   * an empty map (nothing sent yet). */
  initialLastSentNs?: Map<string, number>;
  /** MON1: alert when a payout line is seen in flight this long (default 10 min, stuckPayouts.ts). */
  stuckPayoutThresholdNs?: number;
}

export function createAlertRunnerState(opts: AlertRunnerOptions): AlertRunnerState {
  return {
    stallTracker: new StallTracker(opts.stallGraceNs),
    rpcTracker: new RpcErrorRateTracker(
      opts.rpcErrorThresholdRatio,
      opts.rpcMinConsecutiveTicks,
      opts.rpcMinSamplesPerTick,
    ),
    dedupe: new AlertDedupe(opts.cooldownNs),
    lastSentNs: opts.initialLastSentNs ?? new Map(),
    headroomSamples: [],
    opsRecovery: new RecoveryTracker(),
    stuckPayouts: new StuckPayoutTracker(opts.stuckPayoutThresholdNs ?? DEFAULT_STUCK_PAYOUT_THRESHOLD_MS * 1_000_000),
  };
}

/** Runs one full tick: gathers every alert category, dedupes against
 * cooldown, and delivers whatever survives through `channel`. Returns
 * the alerts actually sent (useful for tests and for logging a
 * per-tick summary). Never throws on a channel send failure -- an
 * individual channel already swallows its own errors (see
 * MultiAlertChannel); this function propagates provider errors as-is
 * since a failed snapshot fetch means this tick has nothing reliable
 * to alert on. */
export async function runAlertTick(
  provider: AlertSnapshotProvider,
  state: AlertRunnerState,
  channel: AlertChannel,
  nowNs: number,
): Promise<Alert[]> {
  const [invariantResults, dueActions, rpcStats, contractState] = await Promise.all([
    provider.fetchInvariantResults(),
    provider.fetchDueActions(),
    provider.fetchRpcStats(),
    provider.fetchContractState(),
  ]);

  const raw: Alert[] = [];
  raw.push(...alertsForInvariantResults(provider.contractId, invariantResults));
  raw.push(...state.stallTracker.tick(dueActions, nowNs));
  const rpcAlert = state.rpcTracker.tick(rpcStats, nowNs);
  if (rpcAlert) raw.push(rpcAlert);
  raw.push(...alertsForContractState(provider.contractId, contractState.paused, contractState.shutdown));

  if (provider.fetchStorageHeadroomSample) {
    try {
      const sample = await provider.fetchStorageHeadroomSample(nowNs);
      state.headroomSamples = appendSample(state.headroomSamples, sample);
      raw.push(...alertsForStorageHeadroom(provider.contractId, state.headroomSamples));
    } catch (err) {
      raw.push(alertForUncheckable(provider.contractId, err));
    }
  }

  if (provider.fetchRelayerBudget) {
    try {
      raw.push(...alertsForRelayerGlobalBudget("relayer", await provider.fetchRelayerBudget()));
    } catch (err) {
      raw.push(alertForRelayerBudgetUnchecked("relayer", err));
    }
  }

  if (provider.fetchUndonePayouts) {
    try {
      const scan = await provider.fetchUndonePayouts();
      raw.push(...state.stuckPayouts.tick(provider.contractId, scan.undone, nowNs));
      if (!scan.complete) raw.push(alertForPayoutsUnchecked(provider.contractId, new Error("payout ledger scan hit its per-tick page budget; lines past it were not read")));
    } catch (err) {
      raw.push(alertForPayoutsUnchecked(provider.contractId, err));
    }
  }

  if (provider.fetchStuckResolvingAlerts) raw.push(...(await provider.fetchStuckResolvingAlerts(nowNs)));

  let recoveries: Alert[] = [];
  if (provider.fetchOpsAlerts) {
    try {
      const ops = await provider.fetchOpsAlerts(nowNs);
      raw.push(...ops);
      recoveries = state.opsRecovery.update(ops);
    } catch (err) {
      console.error("ops alerts check failed", err);
    }
  }

  const toSend = state.dedupe.filter(raw, state.lastSentNs, nowNs);
  toSend.push(...recoveries);
  for (const alert of toSend) {
    await channel.send(alert);
  }
  return toSend;
}

// --------------------------- production wiring ---------------------------
