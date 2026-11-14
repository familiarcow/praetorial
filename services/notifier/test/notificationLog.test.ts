// RED-first: the notification log must only ever carry bet_id/event/
// timestamp -- never contact info (email/telegram handle/account id's
// contact data). This is enforced both by the TS type and by scanning
// the actual file written for anything that looks like contact data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendNotificationLog, type NotificationLogEntry } from "../src/notificationLog.js";

function tmpLogPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "notifier-notiflog-test-"));
  return join(dir, "notifications.jsonl");
}

test("notification log entries contain only bet_id, event, timestamp", () => {
  const logPath = tmpLogPath();
  const entries: NotificationLogEntry[] = [
    { bet_id: 1, event: "proposed", timestamp: "2026-01-01T00:00:00.000Z" },
    { bet_id: 2, event: "settled", timestamp: "2026-01-01T00:05:00.000Z" },
  ];
  appendNotificationLog(logPath, entries);

  const lines = readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.deepEqual(Object.keys(parsed).sort(), ["bet_id", "event", "timestamp"]);
  }
});

test("notification log file never contains contact-looking data (emails, @handles)", () => {
  const logPath = tmpLogPath();
  appendNotificationLog(logPath, [{ bet_id: 7, event: "challenge_window_closing", timestamp: "2026-01-01T00:00:00.000Z" }]);
  const raw = readFileSync(logPath, "utf8");
  assert.ok(!/[^\s"]+@[^\s"]+\.[a-z]{2,}/i.test(raw), "log must not contain anything that looks like an email");
  assert.ok(!raw.includes("@") || raw.indexOf("@") === -1, "log must not contain @handle-style contact data");
});
