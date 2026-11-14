// Unit tests for monitoring-alert pure logic (RED-first): invariant ->
// alert mapping, keeper-stall grace-period tracking, sustained RPC
// error-rate tracking, paused/shutdown alerts, and the dedupe/cooldown
// filter. No RPC, no I/O, no real clock -- every test drives its own
// fabricated nowNs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  alertsForInvariantResults,
  alertsForContractState,
  StallTracker,
  RpcErrorRateTracker,
  AlertDedupe,
  loadDedupeState,
  saveDedupeState,
  type DueAction,
} from "../src/alerts.js";
import type { MonitorResult } from "../src/invariants.js";

const NS = 1_000_000_000; // 1s in ns, for readability

function ok(): MonitorResult {
  return { ok: true, violations: [] };
}
function bad(invariant: "I-1" | "I-2"): MonitorResult {
  return { ok: false, violations: [{ invariant, detail: `fake ${invariant} violation` }] };
}

// ---------------------------- (1) invariant violation alerts ----------------------------
test("alertsForInvariantResults: a clean bet produces no alerts", () => {
  const results = new Map([[1, ok()]]);
  assert.deepEqual(alertsForInvariantResults("escrow.testnet", results), []);
});

test("alertsForInvariantResults: a violating bet produces one critical alert per violation", () => {
  const results = new Map([[42, bad("I-1")]]);
  const alerts = alertsForInvariantResults("escrow.testnet", results);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "invariant_violation");
  assert.equal(alerts[0].severity, "critical");
  assert.match(alerts[0].message, /I-1/);
  assert.match(alerts[0].message, /42/);
  assert.match(alerts[0].detail, /fake I-1 violation/);
});

test("alertsForInvariantResults: same bet/invariant always produces the same dedupe key", () => {
  const a = alertsForInvariantResults("escrow.testnet", new Map([[42, bad("I-1")]]))[0];
  const b = alertsForInvariantResults("escrow.testnet", new Map([[42, bad("I-1")]]))[0];
  assert.equal(a.key, b.key);
});

test("alertsForInvariantResults: different invariants on the same bet get different keys", () => {
  const a = alertsForInvariantResults("escrow.testnet", new Map([[42, bad("I-1")]]))[0];
  const b = alertsForInvariantResults("escrow.testnet", new Map([[42, bad("I-2")]]))[0];
  assert.notEqual(a.key, b.key);
});

// ---------------------------- (2) keeper stall ----------------------------
test("StallTracker: a freshly-due action does not alert immediately", () => {
  const tracker = new StallTracker(60 * NS); // 60s grace
  const due: DueAction[] = [{ contractId: "escrow.testnet", betId: 1, kind: "finalize" }];
  assert.deepEqual(tracker.tick(due, 0), []);
});

test("StallTracker: still due but inside the grace window does not alert", () => {
  const tracker = new StallTracker(60 * NS);
  const due: DueAction[] = [{ contractId: "escrow.testnet", betId: 1, kind: "finalize" }];
  tracker.tick(due, 0);
  assert.deepEqual(tracker.tick(due, 30 * NS), []);
});

test("StallTracker: still due past the grace window alerts", () => {
  const tracker = new StallTracker(60 * NS);
  const due: DueAction[] = [{ contractId: "escrow.testnet", betId: 1, kind: "finalize" }];
  tracker.tick(due, 0);
  const alerts = tracker.tick(due, 61 * NS);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "keeper_stall");
  assert.equal(alerts[0].severity, "warning");
  assert.match(alerts[0].message, /finalize/);
  assert.match(alerts[0].message, /#1/);
});

test("StallTracker: an action that stops being due clears its tracked age (times fresh on recurrence)", () => {
  const tracker = new StallTracker(60 * NS);
  const due: DueAction[] = [{ contractId: "escrow.testnet", betId: 1, kind: "finalize" }];
  tracker.tick(due, 0);
  tracker.tick([], 10 * NS); // keeper acted, no longer due
  // Same key reappears later (e.g. a new round) -- must be timed from
  // THIS reappearance, not the original ns=0.
  tracker.tick(due, 1000 * NS);
  assert.deepEqual(tracker.tick(due, 1000 * NS + 30 * NS), []);
});

test("StallTracker: keeps alerting every tick it remains stalled (dedupe is a separate concern)", () => {
  const tracker = new StallTracker(60 * NS);
  const due: DueAction[] = [{ contractId: "escrow.testnet", betId: 1, kind: "finalize" }];
  tracker.tick(due, 0);
  assert.equal(tracker.tick(due, 61 * NS).length, 1);
  assert.equal(tracker.tick(due, 90 * NS).length, 1);
});

// ---------------------------- (3) RPC error rate ----------------------------
test("RpcErrorRateTracker: a single bad tick never alerts alone", () => {
  const tracker = new RpcErrorRateTracker(0.5, 3);
  assert.equal(tracker.tick({ total: 10, errors: 9 }, 0), null);
});

test("RpcErrorRateTracker: alerts once the error rate is sustained for minConsecutiveTicks", () => {
  const tracker = new RpcErrorRateTracker(0.5, 3);
  assert.equal(tracker.tick({ total: 10, errors: 9 }, 0), null);
  assert.equal(tracker.tick({ total: 10, errors: 9 }, 1), null);
  const alert = tracker.tick({ total: 10, errors: 9 }, 2);
  assert.notEqual(alert, null);
  assert.equal(alert!.kind, "rpc_error_rate");
  assert.equal(alert!.severity, "critical");
});

test("RpcErrorRateTracker: a healthy tick resets the consecutive-bad-tick counter", () => {
  const tracker = new RpcErrorRateTracker(0.5, 3);
  tracker.tick({ total: 10, errors: 9 }, 0);
  tracker.tick({ total: 10, errors: 9 }, 1);
  tracker.tick({ total: 10, errors: 0 }, 2); // healthy, resets
  assert.equal(tracker.tick({ total: 10, errors: 9 }, 3), null);
});

test("RpcErrorRateTracker: zero samples never counts as an error tick", () => {
  const tracker = new RpcErrorRateTracker(0.5, 1);
  assert.equal(tracker.tick({ total: 0, errors: 0 }, 0), null);
});

// ---------------------------- (4) paused / shutdown ----------------------------
test("alertsForContractState: live and unpaused produces nothing", () => {
  assert.deepEqual(alertsForContractState("escrow.testnet", false, false), []);
});

test("alertsForContractState: paused produces a warning alert", () => {
  const alerts = alertsForContractState("escrow.testnet", true, false);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, "warning");
  assert.match(alerts[0].message, /paused/);
});

test("alertsForContractState: shut down produces a critical alert", () => {
  const alerts = alertsForContractState("escrow.testnet", false, true);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, "critical");
  assert.match(alerts[0].message, /shut down/);
});

test("alertsForContractState: paused AND shut down produces both", () => {
  const alerts = alertsForContractState("escrow.testnet", true, true);
  assert.equal(alerts.length, 2);
});

// ---------------------------- dedupe / cooldown ----------------------------
test("AlertDedupe: a brand-new key is always sent", () => {
  const dedupe = new AlertDedupe(60 * NS);
  const state = new Map<string, number>();
  const sent = dedupe.filter([{ key: "k1", kind: "invariant_violation", severity: "critical", message: "m", detail: "d" }], state, 0);
  assert.equal(sent.length, 1);
});

test("AlertDedupe: the same key within the cooldown window is suppressed", () => {
  const dedupe = new AlertDedupe(60 * NS);
  const state = new Map<string, number>();
  const alert = { key: "k1", kind: "invariant_violation" as const, severity: "critical" as const, message: "m", detail: "d" };
  dedupe.filter([alert], state, 0);
  const sent = dedupe.filter([alert], state, 30 * NS);
  assert.equal(sent.length, 0);
});

test("AlertDedupe: the same key resends once the cooldown elapses", () => {
  const dedupe = new AlertDedupe(60 * NS);
  const state = new Map<string, number>();
  const alert = { key: "k1", kind: "invariant_violation" as const, severity: "critical" as const, message: "m", detail: "d" };
  dedupe.filter([alert], state, 0);
  const sent = dedupe.filter([alert], state, 61 * NS);
  assert.equal(sent.length, 1);
});

test("AlertDedupe: different keys are independent", () => {
  const dedupe = new AlertDedupe(60 * NS);
  const state = new Map<string, number>();
  const a = { key: "k1", kind: "invariant_violation" as const, severity: "critical" as const, message: "m", detail: "d" };
  const b = { key: "k2", kind: "invariant_violation" as const, severity: "critical" as const, message: "m", detail: "d" };
  dedupe.filter([a], state, 0);
  const sent = dedupe.filter([a, b], state, 1);
  assert.deepEqual(sent.map((s) => s.key), ["k2"]);
});

test("loadDedupeState/saveDedupeState: round-trips through disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alert-dedupe-"));
  const file = path.join(dir, "state.json");
  assert.deepEqual(loadDedupeState(file), new Map());
  const state = new Map([["k1", 123], ["k2", 456]]);
  saveDedupeState(file, state);
  const loaded = loadDedupeState(file);
  assert.deepEqual(
    [...loaded.entries()].sort((a: [string, number], b: [string, number]) => (a[0] < b[0] ? -1 : 1)),
    [["k1", 123], ["k2", 456]],
  );
  fs.rmSync(dir, { recursive: true, force: true });
});
