// Notifier: see notifierCore.ts for the notice logic (host-neutral, shared with the CF1c2 notifier Worker). This file
// re-exports it and keeps the node-only local outbox / seen-keys file I/O.
import fs from "node:fs";
import path from "node:path";
export * from "./notifierCore.js";
import type { Notice } from "./notifierCore.js";

export function appendOutbox(outboxPath: string, notices: Notice[]): void {
  if (notices.length === 0) return;
  fs.mkdirSync(path.dirname(outboxPath), { recursive: true });
  const lines = notices.map((n) => JSON.stringify(n)).join("\n") + "\n";
  fs.appendFileSync(outboxPath, lines);
}

export function loadSeenKeys(seenPath: string): Set<string> {
  if (!fs.existsSync(seenPath)) return new Set();
  return new Set(JSON.parse(fs.readFileSync(seenPath, "utf8")));
}

export function saveSeenKeys(seenPath: string, seen: Set<string>): void {
  fs.mkdirSync(path.dirname(seenPath), { recursive: true });
  fs.writeFileSync(seenPath, JSON.stringify([...seen]));
}
