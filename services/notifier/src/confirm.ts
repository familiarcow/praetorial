// D-DSY1 (2): notifier announces a terminal outcome (Settled / Voided) only
// after a second RPC (rpcUrls[1]) returns the same terminal state. Unconfirmed
// terminal bets are dropped from this tick's input, so computeNoticesMulti
// never marks them seen and they are announced (once) when later confirmed.
import type { Bet } from "@praetorial/common/types.js";
import { confirmTerminalBet, isConfirmableTerminal } from "@praetorial/common/terminalConfirmCore.js";
import type { ViewClient } from "@praetorial/common/versionCheck.js";
import { alertForSingleRpc, alertForTerminalUnconfirmed, type AlertRaiser } from "../../monitor/src/serviceAlerts.js";
import type { Alert } from "../../monitor/src/alertsCore.js";

export interface ConfirmOptions {
  second: ViewClient | null;
  raiser: AlertRaiser;
  /** In-memory set of confirmed terminal fingerprints (kept across ticks). */
  cache: Set<string>;
}

function fingerprint(contractId: string, id: number, b: Bet): string {
  return `${contractId}:${id}:${b.created_at}|${b.envelope.maker}|${b.envelope.terms_hash}|${b.status}|${b.outcome}`;
}

export async function filterConfirmedTerminals(
  betsByContract: Map<string, Map<number, Bet>>,
  opts: ConfirmOptions,
): Promise<Map<string, Map<number, Bet>>> {
  const out = new Map<string, Map<number, Bet>>();
  const alerts: Alert[] = [];
  for (const [contractId, bets] of betsByContract) {
    const kept = new Map<number, Bet>();
    for (const [id, bet] of bets) {
      if (!isConfirmableTerminal(bet)) { kept.set(id, bet); continue; }
      const fp = fingerprint(contractId, id, bet);
      if (opts.cache.has(fp)) { kept.set(id, bet); continue; }
      const v = await confirmTerminalBet(opts.second, contractId, id, bet);
      if (v.status === "confirmed") { opts.cache.add(fp); kept.set(id, bet); }
      else if (v.status === "unconfigured") alerts.push(alertForSingleRpc());
      else alerts.push(alertForTerminalUnconfirmed(contractId, id, v.status, v.detail));
    }
    out.set(contractId, kept);
  }
  if (alerts.length) await opts.raiser.raise(alerts);
  return out;
}
