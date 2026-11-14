// D-DSY1: alerts raised by the long-running services themselves (indexer,
// notifier, keeper) rather than the monitor tick: contract_version vs
// label, and second-RPC terminal confirmation. Same Alert shape / channel /
// dedupe as the rest of the monitor, so they land in the same ops channel.
import type { Alert } from "./alertsCore.js";
import { AlertDedupe } from "./alertsCore.js";
import type { AlertChannel } from "./alertChannel.js";
import type { EscrowContractRef } from "../../common/src/config.js";
import { checkContractVersions, type ViewClient, type VersionCheck } from "../../common/src/versionCheck.js";

export function alertForVersionMismatch(c: VersionCheck): Alert {
  return {
    key: `contract_version_mismatch:${c.contractId}`,
    kind: "contract_version_mismatch",
    severity: "critical",
    message: `escrow ${c.contractId} contract_version does not match its ESCROW_CONTRACTS label`,
    detail: c.detail,
  };
}

export function alertForVersionUnchecked(c: VersionCheck): Alert {
  return {
    key: `contract_version_unchecked:${c.contractId}`,
    kind: "contract_version_unchecked",
    severity: "warning",
    message: `escrow ${c.contractId} contract_version could not be read: version unchecked`,
    detail: `label=${c.label}: ${c.detail}`,
  };
}

export function alertForTerminalUnconfirmed(contractId: string, betId: number, reason: "disagree" | "unavailable", detail: string): Alert {
  return {
    key: `terminal_unconfirmed:${contractId}:${betId}:${reason}`,
    kind: "terminal_unconfirmed",
    severity: "critical",
    message: `terminal outcome of bet #${betId} (${contractId}) unconfirmed by second RPC (${reason}): settling, confirming`,
    detail,
  };
}

export function alertForSingleRpc(): Alert {
  return {
    key: "terminal_single_rpc",
    kind: "terminal_single_rpc",
    severity: "warning",
    message: "single RPC: terminal outcomes unconfirmed",
    detail: "fewer than two RPC URLs configured (need rpcUrls[1]); terminal outcomes stay at 'settling, confirming'",
  };
}

/** What a service needs from an alert raiser (CF1c2): the node's ServiceAlertRaiser (in-memory dedupe -> channel) and the
 * notifier Worker's raiser (dedupe state persisted in its Durable Object, alerts returned in the tick result) both
 * implement it. Returns the alerts that were actually due (not suppressed by cooldown). */
export interface AlertRaiser {
  raise(alerts: Alert[]): Promise<Alert[]>;
}

/** Delivers alerts through a channel with in-memory cooldown dedupe. Never
 * throws: alerting is a convenience, never load-bearing for a service. */
export class ServiceAlertRaiser implements AlertRaiser {
  private readonly lastSent = new Map<string, number>();
  private readonly dedupe: AlertDedupe;
  constructor(
    private readonly channel: AlertChannel,
    cooldownNs: number = 15 * 60 * 1_000_000_000,
    private readonly nowNs: () => number = () => Date.now() * 1_000_000,
  ) {
    this.dedupe = new AlertDedupe(cooldownNs);
  }

  async raise(alerts: Alert[]): Promise<Alert[]> {
    const due = this.dedupe.filter(alerts, this.lastSent, this.nowNs());
    for (const a of due) {
      try {
        await this.channel.send(a);
      } catch (err) {
        console.error("service alert delivery failed", err);
      }
    }
    return due;
  }
}

/** Reads contract_version() for every configured contract and raises a
 * mismatch / unchecked alert as needed. Never throws, never refuses. */
export async function runVersionCheck(
  client: ViewClient,
  contracts: EscrowContractRef[],
  raiser: AlertRaiser,
): Promise<VersionCheck[]> {
  const results = await checkContractVersions(client, contracts);
  const alerts: Alert[] = [];
  for (const r of results) {
    if (r.status === "mismatch") alerts.push(alertForVersionMismatch(r));
    else if (r.status === "unchecked") alerts.push(alertForVersionUnchecked(r));
  }
  await raiser.raise(alerts);
  return results;
}
