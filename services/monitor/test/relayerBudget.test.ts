// RLY1 / D-RLY1: monitor alert when the relayer's GLOBAL daily gas spend
// reaches 80% of the cap. Fixture mirrors the relayer's GET /budget/global.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  RELAYER_BUDGET_ALERT_RATIO,
  alertsForRelayerGlobalBudget,
  alertForRelayerBudgetUnchecked,
  fetchRelayerBudget,
  type RelayerBudgetSnapshot,
} from "../src/relayerBudget.js";
import { createAlertRunnerState, runAlertTick, type AlertSnapshotProvider } from "../src/runner.js";
import type { Alert } from "../src/alerts.js";
import type { AlertChannel } from "../src/alertChannel.js";

const fx: RelayerBudgetSnapshot = JSON.parse(fs.readFileSync(new URL("./fixtures/relayer_global_budget.json", import.meta.url), "utf8"));
const withUsed = (pct: number): RelayerBudgetSnapshot => ({ ...fx, usedYocto: ((BigInt(fx.capYocto) * BigInt(pct)) / 1000n).toString() });
const NS = 1_000_000_000;

test("threshold is 80%", () => assert.equal(RELAYER_BUDGET_ALERT_RATIO, 0.8));

test("fixture (82% used) -> warning alert with spend vs cap", () => {
  const a = alertsForRelayerGlobalBudget("relayer", fx);
  assert.equal(a.length, 1);
  assert.equal(a[0]!.kind, "relayer_global_budget");
  assert.equal(a[0]!.severity, "warning");
  assert.match(a[0]!.message, /82\.0%/);
  assert.match(a[0]!.detail, /205000000000000000000000000/);
  assert.match(a[0]!.detail, /250000000000000000000000000/);
});

test("79.9% -> none; exactly 80% -> alert; 100% -> critical", () => {
  assert.deepEqual(alertsForRelayerGlobalBudget("relayer", withUsed(799)), []);
  assert.equal(alertsForRelayerGlobalBudget("relayer", withUsed(800)).length, 1);
  const full = alertsForRelayerGlobalBudget("relayer", withUsed(1000));
  assert.equal(full.length, 1);
  assert.equal(full[0]!.severity, "critical");
});

test("zero/absent cap never divides by zero or alerts silently OK", () => {
  assert.deepEqual(alertsForRelayerGlobalBudget("relayer", { ...fx, capYocto: "0", usedYocto: "0" }), []);
});

test("fetchRelayerBudget parses the endpoint; HTTP error / bad body throw", async () => {
  const ok = (async () => ({ ok: true, status: 200, json: async () => fx }) as Response) as unknown as typeof fetch;
  const s = await fetchRelayerBudget("http://relayer.invalid/budget/global", ok);
  assert.equal(s.usedYocto, fx.usedYocto);
  const bad = (async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response) as unknown as typeof fetch;
  await assert.rejects(fetchRelayerBudget("u", bad), /503/);
  const junk = (async () => ({ ok: true, status: 200, json: async () => ({ capYocto: 5 }) }) as Response) as unknown as typeof fetch;
  await assert.rejects(fetchRelayerBudget("u", junk), /capYocto|usedYocto/);
});

function provider(over: Partial<AlertSnapshotProvider>): AlertSnapshotProvider {
  return {
    contractId: "escrow.testnet",
    async fetchInvariantResults() { return new Map(); },
    async fetchDueActions() { return []; },
    async fetchRpcStats() { return { total: 10, errors: 0 }; },
    async fetchContractState() { return { paused: false, shutdown: false }; },
    ...over,
  };
}
function rec(): { channel: AlertChannel; sent: Alert[] } {
  const sent: Alert[] = [];
  return { sent, channel: { async send(a) { sent.push(a); } } };
}

test("runAlertTick: 82% fixture is delivered; 50% is not; provider without the hook unchanged", async () => {
  const st = createAlertRunnerState({ stallGraceNs: 60 * NS, cooldownNs: 60 * NS });
  const { channel, sent } = rec();
  await runAlertTick(provider({ fetchRelayerBudget: async () => withUsed(500) }), st, channel, 0);
  assert.equal(sent.length, 0);
  await runAlertTick(provider({}), st, channel, 1);
  assert.equal(sent.length, 0);
  await runAlertTick(provider({ fetchRelayerBudget: async () => fx }), st, channel, 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.kind, "relayer_global_budget");
});

test("runAlertTick: relayer status unreadable -> distinct 'cannot check' alert, never silent OK", async () => {
  const st = createAlertRunnerState({ stallGraceNs: 60 * NS, cooldownNs: 60 * NS });
  const { channel, sent } = rec();
  await runAlertTick(provider({ fetchRelayerBudget: async () => { throw new Error("relayer 503"); } }), st, channel, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.kind, "relayer_global_budget_unchecked");
  assert.match(sent[0]!.detail, /relayer 503/);
  assert.equal(alertForRelayerBudgetUnchecked("relayer", new Error("e")).kind, "relayer_global_budget_unchecked");
});
