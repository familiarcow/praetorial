// MON4b: feeds MON4's SourceCheckTracker from LH3b archive-run results (one check per archive run per bet:
// signed snapshot stored and nothing failed = ok; failed / unsigned / signing_error / thrown run = failure;
// a 429-only result is a rate limit and counts as neither), raised through the existing ServiceAlertRaiser.
// Also raises nearai_credit_exhausted when the run result carries a 402 (or credit/quota) run_diagnostics entry.
import type { Alert } from "../../monitor/src/alerts.js";
import { SourceCheckTracker, alertForRunResult } from "../../monitor/src/opsAlerts.js";
import type { ServiceAlertRaiser } from "../../monitor/src/serviceAlerts.js";

export interface ArchiveRunOutcome {
  stored: unknown[];
  failed: Array<{ id: string; reason: string }>;
  /** Raw OutLayer output of the run, when the client has it (for run_diagnostics). */
  raw?: unknown;
}

const is429 = (s: string) => /\b429\b/.test(s);

export class SourceCheckFeed {
  private raised = new Set<string>();
  constructor(private readonly tracker: SourceCheckTracker, private readonly alarm: ServiceAlertRaiser) {}

  /** Never throws: alerting must not break the keeper tick. */
  async observeRun(ctx: { contractId: string; betId: number }, outcome: ArchiveRunOutcome | Error, nowNs: number): Promise<void> {
    try {
      const alerts: Alert[] = [];
      let check: { ok: boolean; detail: string } | null;
      if (outcome instanceof Error) {
        check = is429(outcome.message) ? null : { ok: false, detail: `archive run failed: ${outcome.message}` };
      } else {
        const real = outcome.failed.filter((f) => !is429(f.reason));
        if (real.length > 0) check = { ok: false, detail: real.map((f) => `${f.id}: ${f.reason}`).join("; ") };
        else if (outcome.stored.length > 0) check = { ok: true, detail: "" };
        else check = null;
        const n = alertForRunResult("keeper archive", outcome.raw);
        if (n) alerts.push(n);
      }
      if (check) {
        const a = this.tracker.record(ctx, check.ok, check.detail, nowNs);
        if (a) {
          if (a.severity === "info") { this.raised.delete(a.key.replace(/:recovered$/, "")); alerts.push(a); }
          else if (!this.raised.has(a.key)) { this.raised.add(a.key); alerts.push(a); }
        }
      }
      if (alerts.length) await this.alarm.raise(alerts);
    } catch { /* alerts never break the tick */ }
  }
}
