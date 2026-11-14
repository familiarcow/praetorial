// LH5 RED-first (D-HORIZON2, Findings R6): keeper liveness. (a) close-at-T request window +
// restart + idempotency, (b) alarms at half the window, (c) the alarm is log + webhook config only.
// Fake clock, mocked chain, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tickMulti } from "../src/runner.js";
import { nextActionForBet } from "../src/policy.js";
import { livenessAlarms, buildAlarmChannel } from "../src/liveness.js";
import { ServiceAlertRaiser } from "../../monitor/src/serviceAlerts.js";
import { WebhookAlertChannel } from "../../monitor/src/alertChannel.js";
import { TxLogger } from "@praetorial/common/logger.js";
import type { Bet, Envelope } from "@praetorial/common/types.js";

const NS = 1_000_000_000;
const MIN = 60 * NS;
const HOUR = 3600 * NS;
const DAY = 24 * HOUR;
const T_MS = Date.UTC(2026, 10, 20, 12, 0, 0);
const T_NS = T_MS * 1_000_000;
const CONTRACT = "escrow.testnet";

const closeAtTTerms = JSON.stringify({ template: { id: "btc_close_at_t", version: 1 }, fields: { t_utc: new Date(T_MS).toISOString(), op: ">", x_usd: "100000" } });
const DAY_END_NS = T_NS; // weather day end
const weatherTerms = JSON.stringify({ template: { id: "nws_daily_high", version: 1 }, fields: { station: "KNYC", date: "2026-11-19", op: ">", x_f: 50 } });

function envelope(o: Partial<Envelope> = {}): Envelope {
  return {
    bet_id: 1, version: 1, maker: "maker.testnet", taker_allow: { Any: {} }, terms_hash: "a".repeat(64),
    maker_asset: "usdc.fakes.testnet", taker_asset: "usdc.fakes.testnet", models_snapshot_hash: "d",
    outcomes: ["YES", "NO"], maker_side: "YES", stake_maker: "100", stake_taker: "100", fee_bps: 100,
    storage_charge_per_side: "1", keep_terms: true, terms: closeAtTTerms, max_paid_runs: 3, tier: 1, arbiter: null,
    funding_deadline: T_NS, early_settle_outcome: null, finality_delay: 0, settlement_period: 48 * HOUR,
    resolve_deadline: T_NS + 7 * DAY, consent_party_controlled: false, ...o,
  } as Envelope;
}
function bet(o: Partial<Omit<Bet, "envelope">> & { envelope?: Partial<Envelope> } = {}): Bet {
  const { envelope: e, ...rest } = o;
  return {
    envelope: envelope(e), status: "Taken", taker: "taker.testnet", created_at: 0, taken_at: 0, proposed_at: null,
    outcome: null, used_run_nos: [], runs_used: 0, bonds: [], pre_challenge_outcome: null, challenged_by: null,
    exhibits: [], rebuttals: [], objection_deposits: [], arbiter_submissions: [], amend_count: 0,
    pending_resolution_request: null, last_resolution_raw: null, pruned: false, next_expected_run_no: 1,
    all_results: [], window_extended: false, window_extension_ns: "0", ...rest,
  } as Bet;
}
function mockClient(b: Bet) {
  const calls: { method: string; betId?: number }[] = [];
  const client: any = {
    async view(_c: string, method: string, args: any) {
      if (method === "get_bet") return args.bet_id === 1 ? b : null;
      if (method === "pending_payouts_view") return [];
      if (method === "is_shutdown") return false;
      throw new Error(`unexpected view ${method}`);
    },
    async call(_c: string, method: string, args: any) { calls.push({ method, betId: args?.bet_id }); return {}; },
    async callPayable(_c: string, method: string, args: any) { calls.push({ method, betId: args?.bet_id }); return {}; },
  };
  return { client, calls };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lh5-"));
async function tickAt(client: any, statePath: string, nowMs: number, extra: any = {}) {
  return tickMulti({ client, contracts: [{ id: CONTRACT, version: "v1" }], logger: new TxLogger(path.join(tmp(), "l.jsonl")), statePath, nowMs: () => nowMs, ...extra });
}

test("LH5(a): close-at-T bet is not requested before T+5min", () => {
  assert.equal(nextActionForBet(bet(), 1, T_NS + 4 * MIN), null);
  assert.equal(nextActionForBet(bet(), 1, T_NS + 5 * MIN)?.kind, "request_resolution");
});

test("LH5(a): keeper restarted at T+1h (fresh state) still requests exactly once", async () => {
  const { client, calls } = mockClient(bet());
  const state = path.join(tmp(), "state.json");
  await tickAt(client, state, T_MS + 3600_000);
  assert.deepEqual(calls.map((c) => c.method), ["request_resolution"]);
  // second keeper process / same state, next poll: rate-limited, no double request
  await tickAt(client, state, T_MS + 3600_000 + 15_000);
  assert.equal(calls.filter((c) => c.method === "request_resolution").length, 1);
});

test("LH5(a): before T+5min nothing is sent; no request when a request is pending or max_paid_runs is used up", async () => {
  for (const [b, nowMs] of [
    [bet(), T_MS + 4 * 60_000],
    [bet({ pending_resolution_request: 7 }), T_MS + 3600_000],
    [bet({ runs_used: 3 }), T_MS + 3600_000],
  ] as [Bet, number][]) {
    const { client, calls } = mockClient(b);
    await tickAt(client, path.join(tmp(), "s.json"), nowMs);
    assert.equal(calls.filter((c) => c.method === "request_resolution").length, 0);
  }
});

test("LH5(b): alarm for close-at-T bet with no outcome at T+3h, not before", () => {
  const bets = new Map([[`${CONTRACT}:1`, { contractId: CONTRACT, betId: 1, bet: bet() }]]);
  assert.equal(livenessAlarms(bets, T_NS + 3 * HOUR - MIN).length, 0);
  const a = livenessAlarms(bets, T_NS + 3 * HOUR);
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, "critical");
  assert.match(a[0].message, /bet #1/);
  assert.match(a[0].message, new RegExp(CONTRACT));
  // outcome present or terminal: no alarm
  const done = new Map([[`${CONTRACT}:1`, { contractId: CONTRACT, betId: 1, bet: bet({ outcome: "YES", status: "Proposed" }) }]]);
  assert.equal(livenessAlarms(done, T_NS + 5 * HOUR).length, 0);
  const settled = new Map([[`${CONTRACT}:1`, { contractId: CONTRACT, betId: 1, bet: bet({ status: "Settled" }) }]]);
  assert.equal(livenessAlarms(settled, T_NS + 5 * HOUR).length, 0);
});

test("LH5(b): alarm for weather bet 4 days past day-end, not at 3 days", () => {
  const w = bet({ envelope: { terms: weatherTerms, funding_deadline: DAY_END_NS - DAY, resolve_deadline: DAY_END_NS + 7 * DAY } });
  const bets = new Map([[`${CONTRACT}:1`, { contractId: CONTRACT, betId: 1, bet: w }]]);
  assert.equal(livenessAlarms(bets, DAY_END_NS + 3 * DAY).length, 0);
  assert.equal(livenessAlarms(bets, DAY_END_NS + 4 * DAY).length, 1);
});

test("LH5(b): tickMulti raises the alarm through the injected raiser, deduped across ticks", async () => {
  const sent: any[] = [];
  const raiser = new ServiceAlertRaiser({ async send(a) { sent.push(a); } }, 15 * 60 * NS, () => (T_MS + 4 * 3600_000) * 1_000_000);
  const b = bet({ pending_resolution_request: 7 }); // request out, no outcome
  const { client } = mockClient(b);
  const state = path.join(tmp(), "s.json");
  await tickAt(client, state, T_MS + 4 * 3600_000, { alarm: raiser });
  await tickAt(client, state, T_MS + 4 * 3600_000 + 15_000, { alarm: raiser });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "keeper_liveness");
});

test("LH5(c): alarm channel is log line + optional webhook from env, no new service", async () => {
  const logs: string[] = [];
  const posts: { url: string; body: any }[] = [];
  const fetchImpl: any = async (url: string, init: any) => { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
  const alert = { key: "k", kind: "keeper_liveness", severity: "critical", message: "m", detail: "d" } as any;

  const off = buildAlarmChannel({}, { log: (m) => logs.push(m), fetch: fetchImpl });
  await off.send(alert);
  assert.equal(logs.length, 1);
  assert.equal(posts.length, 0);

  const on = buildAlarmChannel({ KEEPER_ALARM_WEBHOOK_URL: "https://hooks.example/x" }, { log: (m) => logs.push(m), fetch: fetchImpl });
  await on.send(alert);
  assert.equal(logs.length, 2);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "https://hooks.example/x");
  assert.match(JSON.stringify(posts[0].body), /keeper_liveness/);

  // a failing webhook never throws out of the channel
  const bad = buildAlarmChannel({ KEEPER_ALARM_WEBHOOK_URL: "https://hooks.example/x" }, { log: () => {}, fetch: (async () => { throw new Error("down"); }) as any });
  await bad.send(alert);

  const direct = new WebhookAlertChannel("https://h/y", fetchImpl);
  await direct.send(alert);
  assert.equal(posts.length, 2);
  assert.ok(!fs.existsSync(path.join(import.meta.dirname, "..", "..", "liveness")), "no new service directory");
});
