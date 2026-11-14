// LIFE1 (SM1 CON-2 / CON-3 / LIFE-9): the monitor Worker alerts on a bet stuck in Resolving (CRITICAL with a ruling set, WARNING
// without), on a long-running Resolving with no applicable result, and on an AI bet whose paid runs are used up. Dedupe/cooldown as
// every other alert; the first-seen clock survives a DO restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MonitorDO } from "../src/index.js";
import { alertsForStuckResolving, observeBet } from "../../../monitor/src/stuckResolving.js";
import { ESC, INT, USDC, NS, T0, mkBet, world, outboundFetch, fakeDoStorage, asyncJson, type World } from "./helpers.js";

const env = { NEAR_NETWORK_ID: "testnet", ESCROW_CONTRACT_ID: ESC, INTENTS_CONTRACT_ID: INT, USDC_TOKEN_ID: USDC, FEE_ACCOUNT_ID: "fee.testnet", KEEPER_ACCOUNT_ID: "keeper.testnet",
  MONITOR_RPC_PER_SEC: "100000", MONITOR_MIN_TICK_INTERVAL_MS: "0", MONITOR_BATCH_BETS: "20", ALERT_STALL_GRACE_MS: "600000", ALERT_COOLDOWN_MS: "7200000" };
const tick = async (d: MonitorDO) => asyncJson(await d.fetch(new Request("https://monitor.do/tick", { method: "POST" })));
const withFetch = async <T>(w: World, f: () => Promise<T>): Promise<T> => { const real = globalThis.fetch; globalThis.fetch = outboundFetch(w) as any; try { return await f(); } finally { globalThis.fetch = real; } };
const NOKEY = JSON.stringify({ error: "no_live_judge_key", reason: "NEAR_AI_API_KEY missing", judge: { judge_ran: false } });
const RD = (T0 / 1000 + 30 * 86400) * NS;
const H = 3600 * NS;

test("CON-2: a re-judge round stuck in Resolving with a ruling set raises a CRITICAL alert on the first sweep", async () => {
  const w = world();
  w.bets.set(1, mkBet(1, { status: "Resolving", outcome: "YES", proposed_at: 1, runs_used: 2, pending_run_no: 2, pending_resolution_request: 7, last_resolution_raw: NOKEY, bonds: [{}] }, { resolve_deadline: RD, max_paid_runs: 3 }));
  const st = fakeDoStorage(); const d = new MonitorDO(st.ctx as any, env as any, () => T0);
  const sent: any[] = await withFetch(w, async () => (await tick(d)).sent);
  const a = sent.find((x) => x.kind === "bet_stuck_resolving");
  assert.ok(a, sent.map((x) => x.kind).join(","));
  assert.equal(a.severity, "critical");
  assert.match(a.message, /bet #1 .*ruling \(YES\)/);
  assert.match(a.detail, /no_live_judge_key/);
  assert.match(a.detail, /RUNBOOK-stuck-resolving\.md/);
  st.close();
});

test("LIFE-9/CON-3: first-run stuck output warns; an in-flight run only alerts after the threshold, and the clock survives a restart", async () => {
  const w = world();
  w.bets.set(1, mkBet(1, { status: "Resolving", pending_run_no: 1, last_resolution_raw: NOKEY }, { resolve_deadline: RD }));
  w.bets.set(2, mkBet(2, { status: "Resolving", pending_run_no: 1, last_resolution_raw: null }, { resolve_deadline: RD }));
  const st = fakeDoStorage(); const clock = { ms: T0 };
  const sent1: any[] = await withFetch(w, async () => (await tick(new MonitorDO(st.ctx as any, env as any, () => clock.ms))).sent);
  const s1 = sent1.filter((x) => x.kind === "bet_stuck_resolving");
  assert.deepEqual(s1.map((x) => [x.key, x.severity]), [[`bet_stuck_resolving:${ESC}:1`, "warning"]]);
  assert.match(s1[0].detail, /void_after_deadline/);
  clock.ms = T0 + 61 * 60_000; // new DO instance = restart
  const sent2: any[] = await withFetch(w, async () => (await tick(new MonitorDO(st.ctx as any, env as any, () => clock.ms))).sent);
  const s2 = sent2.filter((x) => x.kind === "bet_stuck_resolving").map((x) => x.key);
  assert.deepEqual(s2, [`bet_stuck_resolving:${ESC}:2`], "bet 1 deduped by cooldown; bet 2 now past 1h in Resolving");
  st.close();
});

test("CON-3: an AI bet with every paid run used and no result is flagged until the keeper can void it", () => {
  const nowNs = T0 * 1e6;
  const b = mkBet(5, { status: "Taken", runs_used: 1, next_check_ns: String(nowNs - H) }, { resolve_deadline: RD, max_paid_runs: 1 });
  const watch = observeBet(ESC, 5, b, nowNs);
  assert.equal(watch?.kind, "exhausted");
  const alerts = alertsForStuckResolving(ESC, { 5: watch! }, nowNs);
  assert.equal(alerts[0].kind, "resolution_exhausted");
  assert.equal(alerts[0].severity, "warning");
  // a live bet with runs left, a referee bet and a Proposed bet are not watched
  assert.equal(observeBet(ESC, 6, mkBet(6, { status: "Taken", runs_used: 0 }, { max_paid_runs: 1, resolve_deadline: RD }), nowNs), null);
  assert.equal(observeBet(ESC, 7, mkBet(7, { status: "Taken", runs_used: 1 }, { max_paid_runs: 1, referee: { account: "r", mode: "Human" }, resolve_deadline: RD }), nowNs), null);
  assert.equal(observeBet(ESC, 8, mkBet(8, { status: "Proposed", outcome: "YES", proposed_at: 1 }), nowNs), null);
});
