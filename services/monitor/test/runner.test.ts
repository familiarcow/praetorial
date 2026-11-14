// RED-first: the alert-runner tick orchestrates (1) invariant
// violations, (2) keeper stall, (3) sustained RPC error rate, (4)
// paused/shutdown into Alert[], dedupes via cooldown, and delivers
// through an injected AlertChannel. Every dependency here is mocked
// (fake chain snapshot provider, fake clock, fake channel) -- no RPC,
// no real Telegram call, no real timers.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runAlertTick,
  createAlertRunnerState,
  type AlertSnapshotProvider,
} from "../src/runner.js";
import type { AlertChannel } from "../src/alertChannel.js";
import type { Alert } from "../src/alerts.js";
import type { MonitorResult } from "../src/invariants.js";

const NS = 1_000_000_000;

function cleanProvider(overrides: Partial<AlertSnapshotProvider> = {}): AlertSnapshotProvider {
  return {
    contractId: "escrow.testnet",
    async fetchInvariantResults() {
      return new Map<number, MonitorResult>();
    },
    async fetchDueActions() {
      return [];
    },
    async fetchRpcStats() {
      return { total: 10, errors: 0 };
    },
    async fetchContractState() {
      return { paused: false, shutdown: false };
    },
    ...overrides,
  };
}

function recordingChannel(): { channel: AlertChannel; sent: Alert[] } {
  const sent: Alert[] = [];
  return {
    sent,
    channel: {
      async send(alert: Alert) {
        sent.push(alert);
      },
    },
  };
}

test("runAlertTick: a fully healthy snapshot sends nothing", async () => {
  const state = createAlertRunnerState({ stallGraceNs: 60 * NS, cooldownNs: 60 * NS });
  const { channel, sent } = recordingChannel();
  const result = await runAlertTick(cleanProvider(), state, channel, 0);
  assert.deepEqual(result, []);
  assert.deepEqual(sent, []);
});

test("runAlertTick: an invariant violation is delivered once immediately", async () => {
  const provider = cleanProvider({
    async fetchInvariantResults() {
      return new Map([[42, { ok: false, violations: [{ invariant: "I-1" as const, detail: "bad payout" }] }]]);
    },
  });
  const state = createAlertRunnerState({ stallGraceNs: 60 * NS, cooldownNs: 60 * NS });
  const { channel, sent } = recordingChannel();
  const result = await runAlertTick(provider, state, channel, 0);
  assert.equal(result.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "invariant_violation");
});

test("runAlertTick: the same invariant alert is suppressed within the cooldown, resent after", async () => {
  const provider = cleanProvider({
    async fetchInvariantResults() {
      return new Map([[42, { ok: false, violations: [{ invariant: "I-1" as const, detail: "bad payout" }] }]]);
    },
  });
  const state = createAlertRunnerState({ stallGraceNs: 60 * NS, cooldownNs: 60 * NS });
  const { channel, sent } = recordingChannel();
  await runAlertTick(provider, state, channel, 0);
  await runAlertTick(provider, state, channel, 30 * NS); // within cooldown
  assert.equal(sent.length, 1);
  await runAlertTick(provider, state, channel, 61 * NS); // cooldown elapsed
  assert.equal(sent.length, 2);
});

test("runAlertTick: a stalled keeper action alerts only after the grace period, across ticks", async () => {
  const provider = cleanProvider({
    async fetchDueActions() {
      return [{ contractId: "escrow.testnet", betId: 7, kind: "finalize" }];
    },
  });
  const state = createAlertRunnerState({ stallGraceNs: 60 * NS, cooldownNs: 60 * NS });
  const { channel, sent } = recordingChannel();
  await runAlertTick(provider, state, channel, 0); // first seen due, no alert yet
  assert.equal(sent.length, 0);
  await runAlertTick(provider, state, channel, 61 * NS); // past grace
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "keeper_stall");
});

test("runAlertTick: sustained RPC errors alert once the error rate holds for enough ticks", async () => {
  let callCount = 0;
  const provider = cleanProvider({
    async fetchRpcStats() {
      callCount++;
      return { total: 10, errors: 9 };
    },
  });
  const state = createAlertRunnerState({ stallGraceNs: 60 * NS, cooldownNs: 60 * NS, rpcMinConsecutiveTicks: 2 });
  const { channel, sent } = recordingChannel();
  await runAlertTick(provider, state, channel, 0);
  assert.equal(sent.length, 0);
  await runAlertTick(provider, state, channel, 1 * NS);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "rpc_error_rate");
  assert.equal(callCount, 2);
});

test("runAlertTick: a paused contract alerts; unpausing stops new alerts next tick", async () => {
  let paused = true;
  const provider = cleanProvider({
    async fetchContractState() {
      return { paused, shutdown: false };
    },
  });
  const state = createAlertRunnerState({ stallGraceNs: 60 * NS, cooldownNs: 5 * NS });
  const { channel, sent } = recordingChannel();
  await runAlertTick(provider, state, channel, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "contract_shutdown");
  paused = false;
  await runAlertTick(provider, state, channel, 10 * NS);
  assert.equal(sent.length, 1); // no new alert once resolved
});

test("runAlertTick: a shut-down contract fires a critical alert", async () => {
  const provider = cleanProvider({
    async fetchContractState() {
      return { paused: false, shutdown: true };
    },
  });
  const state = createAlertRunnerState({ stallGraceNs: 60 * NS, cooldownNs: 60 * NS });
  const { channel, sent } = recordingChannel();
  await runAlertTick(provider, state, channel, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].severity, "critical");
});

test("runAlertTick: multiple simultaneous alert categories are all delivered in one tick", async () => {
  const provider = cleanProvider({
    async fetchInvariantResults() {
      return new Map([[1, { ok: false, violations: [{ invariant: "I-2" as const, detail: "overpay" }] }]]);
    },
    async fetchContractState() {
      return { paused: true, shutdown: false };
    },
  });
  const state = createAlertRunnerState({ stallGraceNs: 60 * NS, cooldownNs: 60 * NS });
  const { channel, sent } = recordingChannel();
  await runAlertTick(provider, state, channel, 0);
  assert.equal(sent.length, 2);
  const kinds = sent.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ["contract_shutdown", "invariant_violation"]);
});

// ---- DR-MON-2: rpc stats must be a per-tick delta, not lifetime ----
import { makeRpcStatsDelta, buildLiveProvider } from "../src/runner.js";
import { alertsForInvariantResults } from "../src/alerts.js";

test("makeRpcStatsDelta: healthy history then a 429 storm reports only the window", () => {
  let attempts = 0;
  let r429 = 0;
  const next = makeRpcStatsDelta(() => attempts, () => r429);
  attempts = 1000;
  assert.deepEqual(next(), { total: 1000, errors: 0 });
  attempts += 10;
  r429 += 8;
  assert.deepEqual(next(), { total: 10, errors: 8 });
  assert.deepEqual(next(), { total: 0, errors: 0 });
});

// ---- DR-MON-1: contract-wide I-2 must be checked for every asset ----
function bet2(): any {
  return {
    envelope: {
      bet_id: 1, maker: "m.near", maker_asset: "nep141:aaa.near", taker_asset: "nep141:bbb.near",
      stake_maker: "100", stake_taker: "50", storage_charge_per_side: "0", arbiter: null,
    },
    status: "Taken", taker: "t.near", bonds: [], objection_deposits: [],
    used_run_nos: [], next_expected_run_no: 1, all_results: [],
  };
}

test("live provider: I-2 contract-wide is checked per asset (one short asset => one alert naming it)", async () => {
  const balances: Record<string, string> = {
    "nep141:aaa.near": "100",
    "nep141:bbb.near": "40", // short by 10
  };
  const client: any = {
    async view(contract: string, method: string, args: any) {
      if (method === "get_bet") return args.bet_id === 1 ? bet2() : null;
      if (method === "pending_payouts_view") return [];
      if (method === "is_paused") return false;
      if (method === "mt_balance_of") return balances[args.token_id] ?? "0";
      throw new Error(`unexpected view ${method}`);
    },
  };
  const provider = buildLiveProvider(client, "escrow.testnet", "intents.testnet", "usdc.fakes.testnet", {
    feeAccount: "fee.near", keeper: "keeper.near",
  });
  const results = await provider.fetchInvariantResults();
  const i2 = alertsForInvariantResults("escrow.testnet", results).filter((a) => a.message.includes("I-2"));
  assert.equal(i2.length, 1);
  assert.match(i2[0].detail ?? "", /nep141:bbb\.near/);
});
