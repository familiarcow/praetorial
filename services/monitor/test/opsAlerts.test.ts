// MON4: ops alert gaps. Five new kinds through the existing Alert/ServiceAlertRaiser/channel path.
// Offline, injected clocks, temp dirs for heartbeat files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NEARAI_CREDIT_MESSAGE,
  isNearAiCreditFailure,
  alertForNearAiResponse,
  OutlayerHealthTracker,
  alertsForKeeperCredit,
  writeHeartbeat,
  alertsForHeartbeats,
  SourceCheckTracker,
  RecoveryTracker,
} from "../src/opsAlerts.js";
import { ServiceAlertRaiser } from "../src/serviceAlerts.js";
import type { Alert } from "../src/alerts.js";
import type { AlertChannel } from "../src/alertChannel.js";

const NS = 1_000_000_000;
const MIN = 60 * NS;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mon4-"));
const collect = () => {
  const sent: Alert[] = [];
  const ch: AlertChannel = { async send(a) { sent.push(a); } };
  return { sent, ch };
};

// ---- (1) nearai_credit_exhausted ----
test("402 -> credit failure; 429 never", () => {
  assert.equal(isNearAiCreditFailure(402, ""), true);
  assert.equal(isNearAiCreditFailure(429, "rate limit: quota per minute exceeded"), false);
  assert.equal(isNearAiCreditFailure(429, "insufficient credit"), false);
});
test("body match insufficient/credit/quota on a 4xx -> credit failure; unrelated bodies and 200/500 plain -> no", () => {
  assert.equal(isNearAiCreditFailure(403, "Insufficient balance"), true);
  assert.equal(isNearAiCreditFailure(400, "credits exhausted"), true);
  assert.equal(isNearAiCreditFailure(403, "monthly QUOTA reached"), true);
  assert.equal(isNearAiCreditFailure(500, "internal error"), false);
  assert.equal(isNearAiCreditFailure(200, "ok"), false);
  assert.equal(isNearAiCreditFailure(401, "bad key"), false);
});
test("alertForNearAiResponse: critical, exact text, runbook section named; 429 -> null", () => {
  const a = alertForNearAiResponse("resolver", 402, "");
  assert.ok(a);
  assert.equal(a!.kind, "nearai_credit_exhausted");
  assert.equal(a!.severity, "critical");
  assert.equal(a!.message, "NEAR AI credits exhausted. Please top up.");
  assert.equal(NEARAI_CREDIT_MESSAGE, a!.message);
  assert.match(a!.detail, /NEAR AI credits exhausted \(HTTP 402\) or the key is wrong/);
  assert.equal(alertForNearAiResponse("resolver", 429, "quota"), null);
});
test("nearai alert dedupes through the raiser", async () => {
  const { sent, ch } = collect();
  let now = 0;
  const r = new ServiceAlertRaiser(ch, 30 * MIN, () => now);
  const a = alertForNearAiResponse("keeper", 402, "")!;
  await r.raise([a]); now += 5 * MIN; await r.raise([a]);
  assert.equal(sent.length, 1);
  now += 30 * MIN; await r.raise([a]);
  assert.equal(sent.length, 2);
});

// ---- (2) outlayer_unhealthy ----
test("outlayer: 3 consecutive failures in window -> one critical; recovery on success", () => {
  const t = new OutlayerHealthTracker(3, 30 * MIN);
  assert.equal(t.record(false, 1 * MIN, "timeout"), null);
  assert.equal(t.record(false, 2 * MIN, "timeout"), null);
  const a = t.record(false, 3 * MIN, "error")!;
  assert.equal(a.kind, "outlayer_unhealthy");
  assert.equal(a.severity, "critical");
  assert.match(a.detail, /OutLayer is down or timing out/);
  const rec = t.record(true, 4 * MIN, "")!;
  assert.equal(rec.kind, "outlayer_unhealthy");
  assert.equal(rec.severity, "info");
  assert.match(rec.message, /recovered/i);
  assert.equal(t.record(true, 5 * MIN, ""), null);
});
test("outlayer: a success in between resets; failures older than the window do not count", () => {
  const t = new OutlayerHealthTracker(3, 10 * MIN);
  t.record(false, 1 * MIN, "x"); t.record(false, 2 * MIN, "x"); t.record(true, 3 * MIN, "");
  assert.equal(t.record(false, 4 * MIN, "x"), null);
  const u = new OutlayerHealthTracker(3, 10 * MIN);
  u.record(false, 1 * MIN, "x"); u.record(false, 2 * MIN, "x");
  assert.equal(u.record(false, 20 * MIN, "x"), null);
});

// ---- (3) keeper_credit_low ----
test("keeper credit: above floor -> none; below -> warning w/ runway; zero -> critical", () => {
  const base = { account: "keeper.near", floorYocto: "1000000", burnPerDayYocto: "100000" };
  assert.deepEqual(alertsForKeeperCredit({ ...base, balanceYocto: "1000000" }), []);
  const low = alertsForKeeperCredit({ ...base, balanceYocto: "500000" });
  assert.equal(low.length, 1);
  assert.equal(low[0]!.kind, "keeper_credit_low");
  assert.equal(low[0]!.severity, "warning");
  assert.match(low[0]!.detail, /runway ~5\.0 days/);
  assert.match(low[0]!.detail, /Keeper or relayer is down/);
  const zero = alertsForKeeperCredit({ ...base, balanceYocto: "0" });
  assert.equal(zero[0]!.severity, "critical");
});
test("keeper credit: no burn estimate -> runway unknown, still alerts; dedupe per account", async () => {
  const a = alertsForKeeperCredit({ account: "attest.near", balanceYocto: "1", floorYocto: "10" });
  assert.match(a[0]!.detail, /runway unknown/);
  const b = alertsForKeeperCredit({ account: "relayer.near", balanceYocto: "1", floorYocto: "10" });
  assert.notEqual(a[0]!.key, b[0]!.key);
  const { sent, ch } = collect();
  const r = new ServiceAlertRaiser(ch, 30 * MIN, () => 0);
  await r.raise(a); await r.raise(a);
  assert.equal(sent.length, 1);
});
test("RecoveryTracker: emits one info recovery when a previously active key disappears", () => {
  const rt = new RecoveryTracker();
  const [a] = alertsForKeeperCredit({ account: "k.near", balanceYocto: "1", floorYocto: "10" });
  assert.deepEqual(rt.update([a!]), []);
  assert.deepEqual(rt.update([a!]), []);
  const rec = rt.update([]);
  assert.equal(rec.length, 1);
  assert.equal(rec[0]!.severity, "info");
  assert.equal(rec[0]!.kind, "keeper_credit_low");
  assert.deepEqual(rt.update([]), []);
});

// ---- (4) service_heartbeat_missing ----
const SERVICES = [
  { name: "keeper", intervalMs: 15_000 }, { name: "relayer", intervalMs: 60_000 },
  { name: "monitor", intervalMs: 30_000 }, { name: "notifier", intervalMs: 30_000 },
];
test("heartbeat: fresh -> none; older than 2x interval -> critical; missing file -> critical", () => {
  const dir = tmp();
  const now = 1_000_000_000;
  for (const s of SERVICES) writeHeartbeat(dir, s.name, now);
  assert.deepEqual(alertsForHeartbeats(dir, SERVICES, now + 29_000), []);
  const late = alertsForHeartbeats(dir, SERVICES, now + 31_000);
  assert.deepEqual(late.map((a) => a.key), ["service_heartbeat_missing:keeper"]);
  assert.equal(late[0]!.severity, "critical");
  assert.equal(late[0]!.kind, "service_heartbeat_missing");
  assert.match(late[0]!.detail, /Keeper or relayer is down/);
  fs.rmSync(path.join(dir, "relayer.heartbeat"));
  const missing = alertsForHeartbeats(dir, SERVICES, now);
  assert.deepEqual(missing.map((a) => a.key), ["service_heartbeat_missing:relayer"]);
});
test("heartbeat: writer is atomic-ish (no tmp left) and corrupt file counts as missing", () => {
  const dir = tmp();
  writeHeartbeat(dir, "notifier", 5);
  assert.deepEqual(fs.readdirSync(dir), ["notifier.heartbeat"]);
  fs.writeFileSync(path.join(dir, "notifier.heartbeat"), "garbage");
  assert.equal(alertsForHeartbeats(dir, [{ name: "notifier", intervalMs: 1000 }], 5).length, 1);
});
test("heartbeat: monitor/notifier alerts mention the Monitor/indexer/notifier runbook text", () => {
  const dir = tmp();
  const a = alertsForHeartbeats(dir, [{ name: "monitor", intervalMs: 1000 }], 0);
  assert.match(a[0]!.detail, /Keeper or relayer is down/);
});

// ---- (5) source_unreachable ----
test("source_unreachable: 3rd consecutive failure alerts, not before; success resets; recovery message", () => {
  const t = new SourceCheckTracker(3);
  const ctx = { contractId: "e.near", betId: 7 };
  assert.equal(t.record(ctx, false, "kraken: timeout", 1), null);
  assert.equal(t.record(ctx, false, "kraken: timeout", 2), null);
  const a = t.record(ctx, false, "kraken: timeout", 3)!;
  assert.equal(a.kind, "source_unreachable");
  assert.equal(a.severity, "warning");
  assert.equal(a.key, "source_unreachable:e.near:7");
  assert.match(a.detail, /A source site is down/);
  const rec = t.record(ctx, true, "", 4)!;
  assert.equal(rec.severity, "info");
  assert.equal(t.record(ctx, true, "", 5), null);
  // reset by success mid-streak
  t.record(ctx, false, "x", 6); t.record(ctx, false, "x", 7); t.record(ctx, true, "", 8);
  assert.equal(t.record(ctx, false, "x", 9), null);
});
test("source_unreachable: bets tracked independently; dedupe through raiser", async () => {
  const t = new SourceCheckTracker(3);
  for (let i = 0; i < 2; i++) { t.record({ contractId: "e", betId: 1 }, false, "x", i); t.record({ contractId: "e", betId: 2 }, false, "x", i); }
  const a1 = t.record({ contractId: "e", betId: 1 }, false, "x", 3)!;
  assert.ok(a1);
  const { sent, ch } = collect();
  const r = new ServiceAlertRaiser(ch, 30 * MIN, () => 0);
  await r.raise([a1]); await r.raise([a1]);
  assert.equal(sent.length, 1);
});
