// Host-neutral half of opsAlerts.ts (CF1c); opsAlerts.ts re-exports it and adds the node-only file heartbeats.
// MON4: ops alert gaps. Pure logic (clock and files injected) for five alert kinds that go through the
// existing Alert / ServiceAlertRaiser (cooldown dedupe) / AlertChannel path. Each alert's detail names the
// section of the operations runbook to open. Recovery = a severity "info" alert with key
// `<key>:recovered`, sent once when the condition clears.
import type { Alert } from "./alertsCore.js";

const RB = "Operations runbook";
export const RUNBOOK_NEARAI = `${RB} section "NEAR AI credits exhausted (HTTP 402) or the key is wrong"`;
export const RUNBOOK_OUTLAYER = `${RB} section "OutLayer is down or timing out"`;
export const RUNBOOK_SOURCE = `${RB} section "A source site is down"`;
export const RUNBOOK_SERVICE = `${RB} section "Keeper or relayer is down"`;

export function recoveryOf(a: Alert, message: string): Alert {
  return { key: `${a.key}:recovered`, kind: a.kind, severity: "info", message, detail: `recovered: ${a.key}` };
}

/** Emits one recovery alert when a key that was active in the previous update is gone. */
export class RecoveryTracker {
  private active = new Map<string, Alert>();
  /** CF1c: persisted by the Worker so a restart still emits the recovery message. */
  exportState(): Alert[] { return [...this.active.values()]; }
  importState(a: Alert[]): void { this.active = new Map(a.map((x) => [x.key, x])); }
  update(current: Alert[]): Alert[] {
    const now = new Map(current.map((a) => [a.key, a]));
    const out: Alert[] = [];
    for (const [k, a] of this.active) if (!now.has(k)) out.push(recoveryOf(a, `recovered: ${a.message}`));
    this.active = now;
    return out;
  }
}

// ---- (1) NEAR AI credits ----
export const NEARAI_CREDIT_MESSAGE = "NEAR AI credits exhausted. Please top up.";

/** 402, or a 4xx whose body names insufficient/credit/quota. 429 (rate limit) is never a credit failure. */
export function isNearAiCreditFailure(status: number, body: string): boolean {
  if (status === 429) return false;
  if (status === 402) return true;
  return status >= 400 && status < 500 && /insufficient|credit|quota/i.test(body ?? "");
}

export function alertForNearAiResponse(source: string, status: number, body: string): Alert | null {
  if (!isNearAiCreditFailure(status, body)) return null;
  return {
    key: "nearai_credit_exhausted",
    kind: "nearai_credit_exhausted",
    severity: "critical",
    message: NEARAI_CREDIT_MESSAGE,
    detail: `${source} got HTTP ${status} from NEAR AI. See ${RUNBOOK_NEARAI}.`,
  };
}

/** From a free-text failure (tx error): pulls a 402/429 and reuses the status+body rule. */
export function alertForNearAiError(source: string, text: string): Alert | null {
  if (/\b429\b/.test(text)) return null;
  const status = /\b402\b/.test(text) ? 402 : /\b40[0-4]\b/.test(text) ? Number(/\b(40[0-4])\b/.exec(text)![1]) : 400;
  return alertForNearAiResponse(source, status, text);
}

// ---- (2) OutLayer health ----
export class OutlayerHealthTracker {
  private fails: number[] = [];
  private alerting = false;
  constructor(private readonly threshold = 3, private readonly windowNs = 30 * 60 * 1_000_000_000) {}

  /** One request_resolution run outcome. Returns a critical alert while unhealthy, one info recovery on the first success after. */
  record(ok: boolean, nowNs: number, detail: string): Alert | null {
    if (ok) {
      this.fails = [];
      if (!this.alerting) return null;
      this.alerting = false;
      return { key: "outlayer_unhealthy:recovered", kind: "outlayer_unhealthy", severity: "info", message: "OutLayer recovered: request_resolution runs are succeeding again", detail: `see ${RUNBOOK_OUTLAYER}` };
    }
    this.fails.push(nowNs);
    this.fails = this.fails.filter((t) => nowNs - t <= this.windowNs);
    if (this.fails.length < this.threshold) return null;
    this.alerting = true;
    return {
      key: "outlayer_unhealthy",
      kind: "outlayer_unhealthy",
      severity: "critical",
      message: `OutLayer unhealthy: ${this.fails.length} consecutive request_resolution runs timed out or errored`,
      detail: `last: ${detail}. See ${RUNBOOK_OUTLAYER}.`,
    };
  }
}

// ---- (3) keeper / attest / relayer account balance ----
export interface CreditInput {
  account: string;
  balanceYocto: string;
  floorYocto: string;
  /** Estimated spend per day, for the runway line. */
  burnPerDayYocto?: string;
}

export function alertsForKeeperCredit(i: CreditInput): Alert[] {
  const bal = BigInt(i.balanceYocto);
  const floor = BigInt(i.floorYocto);
  if (bal >= floor) return [];
  const burn = i.burnPerDayYocto ? BigInt(i.burnPerDayYocto) : 0n;
  const runway = burn > 0n ? `runway ~${(Number((bal * 1000n) / burn) / 1000).toFixed(1)} days at ${burn} yocto/day` : "runway unknown (no burn estimate)";
  return [{
    key: `keeper_credit_low:${i.account}`,
    kind: "keeper_credit_low",
    severity: bal === 0n ? "critical" : "warning",
    message: `balance of ${i.account} is below its floor (${bal} < ${floor} yocto)`,
    detail: `${runway}. Top it up: see ${RUNBOOK_SERVICE}.`,
  }];
}

// ---- (5) source_unreachable ----
export class SourceCheckTracker {
  private streak = new Map<string, number>();
  private alerting = new Set<string>();
  constructor(private readonly threshold = 3) {}

  record(ctx: { contractId: string; betId: number }, ok: boolean, detail: string, _nowNs: number): Alert | null {
    const key = `source_unreachable:${ctx.contractId}:${ctx.betId}`;
    if (ok) {
      this.streak.delete(key);
      if (!this.alerting.delete(key)) return null;
      return { key: `${key}:recovered`, kind: "source_unreachable", severity: "info", message: `sources of bet #${ctx.betId} (${ctx.contractId}) reachable again`, detail: `see ${RUNBOOK_SOURCE}` };
    }
    const n = (this.streak.get(key) ?? 0) + 1;
    this.streak.set(key, n);
    if (n < this.threshold) return null;
    this.alerting.add(key);
    return {
      key,
      kind: "source_unreachable",
      severity: "warning",
      message: `locked sources of live bet #${ctx.betId} (${ctx.contractId}) unreachable ${n} checks in a row`,
      detail: `${detail}. See ${RUNBOOK_SOURCE}.`,
    };
  }
}

// ---- MON4b: NEAR AI credit alert from a recorded OutLayer run result ----
/** Scans a run result's `run_diagnostics` (top level, or under `output`) for NEAR AI http_status entries and applies
 * the same 402 / credit-quota-body rule as isNearAiCreditFailure. 429 never alerts; no diagnostics -> null. */
export function alertForRunResult(source: string, result: unknown): Alert | null {
  const r = result as any;
  const diags = r?.run_diagnostics ?? r?.output?.run_diagnostics;
  for (const d of Array.isArray(diags) ? diags : diags && typeof diags === "object" ? [diags] : []) {
    const status = Number(d?.http_status);
    if (!Number.isFinite(status)) continue;
    const a = alertForNearAiResponse(source, status, String(d?.error ?? d?.body ?? ""));
    if (a) return a;
  }
  return null;
}
