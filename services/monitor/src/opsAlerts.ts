// Heartbeat files (node-only). Everything else is in opsAlertsCore.ts, shared with the CF1c monitor Worker.
import fs from "node:fs";
import path from "node:path";
import type { Alert } from "./alerts.js";
import { RUNBOOK_SERVICE } from "./opsAlertsCore.js";
export * from "./opsAlertsCore.js";

// ---- (4) heartbeats ----
export interface HeartbeatService { name: string; intervalMs: number }

export function writeHeartbeat(dir: string, service: string, nowMs: number): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${service}.heartbeat`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ service, ts: nowMs }));
  fs.renameSync(tmp, file);
}

function readHeartbeat(dir: string, service: string): number | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, `${service}.heartbeat`), "utf8"));
    return typeof j?.ts === "number" ? j.ts : null;
  } catch { return null; }
}

/** Critical when a service's heartbeat is older than 2x its interval, missing or unreadable. */
export function alertsForHeartbeats(dir: string, services: HeartbeatService[], nowMs: number): Alert[] {
  const out: Alert[] = [];
  for (const s of services) {
    const ts = readHeartbeat(dir, s.name);
    const age = ts === null ? null : nowMs - ts;
    if (age !== null && age <= 2 * s.intervalMs) continue;
    out.push({
      key: `service_heartbeat_missing:${s.name}`,
      kind: "service_heartbeat_missing",
      severity: "critical",
      message: `${s.name} heartbeat ${age === null ? "missing" : `${Math.round(age / 1000)}s old`} (limit 2x ${s.intervalMs / 1000}s): ${s.name} may be down`,
      detail: `heartbeat file ${path.join(dir, `${s.name}.heartbeat`)}. See ${RUNBOOK_SERVICE}.`,
    });
  }
  return out;
}

