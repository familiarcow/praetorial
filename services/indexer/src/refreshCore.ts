// Host-neutral pieces of the indexer refresh (shared by the node indexer's refreshBets and the CF1d indexer Worker's bounded
// tick): the terminal lock / redeploy identity rule and the D-DSY1 second-RPC terminal confirmation. No node:* / Buffer / process.
import type { TaggedBet } from "@praetorial/common/discovery.js";
import type { Bet } from "@praetorial/common/types.js";
import { confirmTerminalBet, isConfirmableTerminal } from "@praetorial/common/terminalConfirmCore.js";
import type { ViewClient } from "@praetorial/common/versionCheck.js";
import { alertForSingleRpc, alertForTerminalUnconfirmed, type AlertRaiser } from "../../monitor/src/serviceAlerts.js";
import type { Alert } from "../../monitor/src/alertsCore.js";

// D-DSY1: a Settled/Voided bet is only displayed after `second` (rpcUrls[1])
// returns the same terminal state; until then tb.confirmed === false and the
// board/history/bet views show "settling, confirming". Once confirmed the
// entry is cached with confirmed === true (and the terminal lock above keeps
// it). `second` null/absent => always unconfirmed + a single-RPC alert.
// With `raiser` supplied, contract_version() is also checked on every refresh.
export interface RefreshOptions {
  second?: ViewClient | null;
  raiser?: AlertRaiser;
  /** Worker: cap on second-RPC confirmations per call; the rest stay unconfirmed (redacted) until a later tick. */
  maxConfirms?: number;
}

export const TERMINAL = new Set(["Settled", "Voided", "Cancelled", "Expired"]);

export function sameBet(a: Bet, b: Bet): boolean {
  return a.envelope.maker === b.envelope.maker && a.envelope.terms_hash === b.envelope.terms_hash && a.created_at === b.created_at;
}

export async function confirmTerminals(bets: Map<string, TaggedBet>, opts: RefreshOptions): Promise<void> {
  const alerts: Alert[] = [];
  let budget = opts.maxConfirms ?? Infinity;
  for (const [k, tb] of [...bets]) {
    if (!isConfirmableTerminal(tb.bet) || tb.confirmed === true) continue;
    if (budget <= 0) { if (tb.confirmed !== false) bets.set(k, { ...tb, confirmed: false }); continue; } // over budget: stays redacted, retried next tick
    budget--;
    const v = await confirmTerminalBet(opts.second ?? null, tb.contractId, tb.betId, tb.bet);
    if (v.status === "confirmed") {
      bets.set(k, { ...tb, confirmed: true });
      continue;
    }
    bets.set(k, { ...tb, confirmed: false });
    if (v.status === "unconfigured") alerts.push(alertForSingleRpc());
    else alerts.push(alertForTerminalUnconfirmed(tb.contractId, tb.betId, v.status, v.detail));
  }
  if (alerts.length && opts.raiser) await opts.raiser.raise(alerts);
}

