// Pure monitoring-alert logic lives in alertsCore.ts (host-neutral, shared with the CF1c monitor Worker); this file
// re-exports it and keeps the node-only JSON-file dedupe persistence (same posture as notifier.ts load/saveSeenKeys).
import fs from "node:fs";
import path from "node:path";
export * from "./alertsCore.js";

export function loadDedupeState(statePath: string): Map<string, number> {
  if (!fs.existsSync(statePath)) return new Map();
  const raw = JSON.parse(fs.readFileSync(statePath, "utf8")) as [string, number][];
  return new Map(raw);
}

export function saveDedupeState(statePath: string, state: Map<string, number>): void {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify([...state.entries()]));
}
