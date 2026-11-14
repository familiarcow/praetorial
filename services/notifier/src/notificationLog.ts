// Notification log: records that a notice fired, nothing about who it
// was delivered to. TASK A (PII minimisation) requires this log to
// carry only bet_id/event/timestamp -- the type below has no optional
// "extra fields" escape hatch, so a future call site cannot silently
// widen it to include contact info without a type error here first.
import fs from "node:fs";
import path from "node:path";

export interface NotificationLogEntry {
  bet_id: number;
  event: string;
  timestamp: string;
}

export function appendNotificationLog(logPath: string, entries: NotificationLogEntry[]): void {
  if (entries.length === 0) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  // Re-shape explicitly (rather than trusting the caller's object
  // literal) so even an accidentally-wider object passed in at runtime
  // (bypassing the type system, e.g. from untyped JS) can't leak an
  // extra field like a contact value into the file on disk.
  const lines = entries
    .map((e) => JSON.stringify({ bet_id: e.bet_id, event: e.event, timestamp: e.timestamp }))
    .join("\n") + "\n";
  fs.appendFileSync(logPath, lines);
}
