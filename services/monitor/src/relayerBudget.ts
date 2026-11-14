// RLY1 / D-RLY1: alert when the relayer's GLOBAL daily gas spend (all
// senders) reaches 80% of its cap. Source: the relayer's read-only
// GET /budget/global (aggregate numbers only). Same posture as MON1: if the
// relayer can't be read, that is a distinct "cannot check" alert, never OK.
import type { Alert } from "./alertsCore.js";

/** Alert at or above this fraction of the global cap. */
export const RELAYER_BUDGET_ALERT_RATIO = 0.8;

export interface RelayerBudgetSnapshot {
  capYocto: string;
  usedYocto: string;
  openCapYocto?: string;
  reservedCapYocto?: string;
  openUsedYocto?: string;
  reservedUsedYocto?: string;
  windowStartMs?: number;
  windowEndsMs?: number;
}

export function alertsForRelayerGlobalBudget(relayerId: string, s: RelayerBudgetSnapshot): Alert[] {
  const cap = BigInt(s.capYocto);
  const used = BigInt(s.usedYocto);
  if (cap <= 0n) return [];
  // basis points, integer math: used*10000/cap >= 8000
  const bps = Number((used * 10_000n) / cap);
  if (bps < RELAYER_BUDGET_ALERT_RATIO * 10_000) return [];
  const critical = used >= cap;
  const pct = (bps / 100).toFixed(1);
  return [
    {
      key: `relayer_global_budget:${relayerId}:${critical ? "full" : "high"}`,
      kind: "relayer_global_budget",
      severity: critical ? "critical" : "warning",
      message: critical
        ? `relayer ${relayerId} global daily gas cap exhausted (${pct}%)`
        : `relayer ${relayerId} global daily gas spend at ${pct}% of cap`,
      detail: `used=${used} cap=${cap} yocto (open ${s.openUsedYocto ?? "?"}/${s.openCapYocto ?? "?"}, reserved ${s.reservedUsedYocto ?? "?"}/${s.reservedCapYocto ?? "?"}); window ends ms=${s.windowEndsMs ?? "?"}. New senders get 429 once the open share is spent; existing bettors draw from the reserve.`,
    },
  ];
}

export function alertForRelayerBudgetUnchecked(relayerId: string, err: unknown): Alert {
  return {
    key: `relayer_global_budget_unchecked:${relayerId}`,
    kind: "relayer_global_budget_unchecked",
    severity: "warning",
    message: `cannot check relayer ${relayerId} global gas budget`,
    detail: `relayer budget check failed (NOT assumed OK): ${err instanceof Error ? err.message : String(err)}`,
  };
}

export async function fetchRelayerBudget(url: string, fetchImpl: typeof fetch = fetch): Promise<RelayerBudgetSnapshot> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`relayer budget: HTTP ${res.status}`);
  const j: any = await res.json();
  if (typeof j?.capYocto !== "string" || typeof j?.usedYocto !== "string" || !/^\d+$/.test(j.capYocto) || !/^\d+$/.test(j.usedYocto)) {
    throw new Error("relayer budget: bad response (capYocto/usedYocto missing)");
  }
  return j as RelayerBudgetSnapshot;
}
