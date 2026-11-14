// MON4 wiring: monitor tick consumes ops alerts (heartbeats, keeper credit) with recovery; keeper main writes a heartbeat.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAlertRunnerState, runAlertTick, type AlertSnapshotProvider } from "../src/runner.js";
import { alertsForHeartbeats, writeHeartbeat } from "../src/opsAlerts.js";
import type { Alert } from "../src/alerts.js";
import { main as keeperMain } from "../../keeper/src/runner.js";

const NS = 1_000_000_000;
const provider = (over: Partial<AlertSnapshotProvider>): AlertSnapshotProvider => ({
  contractId: "escrow.testnet",
  async fetchInvariantResults() { return new Map(); },
  async fetchDueActions() { return []; },
  async fetchRpcStats() { return { total: 10, errors: 0 }; },
  async fetchContractState() { return { paused: false, shutdown: false }; },
  ...over,
});

test("runAlertTick: ops alerts delivered, deduped, then one recovery when cleared", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mon4w-"));
  const svc = [{ name: "keeper", intervalMs: 1000 }];
  let nowMs = 100_000;
  const p = provider({ async fetchOpsAlerts() { return alertsForHeartbeats(dir, svc, nowMs); } });
  const state = createAlertRunnerState({ stallGraceNs: 60 * NS, cooldownNs: 600 * NS });
  const sent: Alert[] = [];
  const ch = { async send(a: Alert) { sent.push(a); } };
  await runAlertTick(p, state, ch, nowMs * 1e6);          // missing -> alert
  nowMs += 1000;
  await runAlertTick(p, state, ch, nowMs * 1e6);          // still missing, deduped
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.kind, "service_heartbeat_missing");
  writeHeartbeat(dir, "keeper", nowMs);
  await runAlertTick(p, state, ch, nowMs * 1e6);          // healthy -> recovery
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.severity, "info");
  await runAlertTick(p, state, ch, nowMs * 1e6);
  assert.equal(sent.length, 2);
});

test("a failing fetchOpsAlerts does not break the tick", async () => {
  const state = createAlertRunnerState({ stallGraceNs: 60 * NS, cooldownNs: 600 * NS });
  const p = provider({ async fetchOpsAlerts() { throw new Error("boom"); } });
  assert.deepEqual(await runAlertTick(p, state, { async send() {} }, 0), []);
});

test("keeper main(): writes keeper.heartbeat into HEARTBEAT_DIR each loop", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mon4k-"));
  const keyFile = path.join(dir, "k.json");
  fs.writeFileSync(keyFile, JSON.stringify({ account_id: "keeper.testnet", public_key: "ed25519:x", private_key: "ed25519:y" }));
  await keeperMain({
    env: { ESCROW_CONTRACT_ID: "escrow.testnet", INTENTS_CONTRACT_ID: "i.testnet", KEEPER_KEY_FILE: keyFile, KEEPER_RUN_ONCE: "1",
      KEEPER_LOG_FILE: path.join(dir, "log.jsonl"), KEEPER_STATE_FILE: path.join(dir, "s.json"), KEEPER_ARCHIVE_ENABLED: "0",
      HEARTBEAT_DIR: path.join(dir, "hb") },
    makeNearClient: async () => ({ async view() { return "v1"; } }) as any,
    tickMulti: async () => [],
  } as any);
  assert.ok(fs.existsSync(path.join(dir, "hb", "keeper.heartbeat")));
});
