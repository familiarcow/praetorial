// MON1 stuck payouts RED: the monitor Worker (MonitorDO) reads the escrow's in-flight payout lines every tick, keeps the
// first-seen clock in DO SQLite (restarts change nothing) and raises ONE critical alert per line wedged in flight past
// ALERT_STUCK_PAYOUT_MS (default 10 min). Same rule as the node monitor (shared stuckPayouts core). Config: testnet and
// mainnet wrangler envs both set the threshold.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAlertTick, createAlertRunnerState, buildLiveProvider } from "../../../monitor/src/runner.js";
import { MonitorDO } from "../src/index.js";
import { loadMonitorConfig } from "../src/env.js";
import { ESC, INT, USDC, NS, T0, mkBet, world, viewClientOf, outboundFetch, norm, fakeDoStorage, asyncJson, RPC_URL, type World } from "./helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;
const env = (extra: Record<string, string> = {}) => ({
  NEAR_NETWORK_ID: "testnet", ESCROW_CONTRACT_ID: ESC, INTENTS_CONTRACT_ID: INT, USDC_TOKEN_ID: USDC, FEE_ACCOUNT_ID: "fee.testnet", KEEPER_ACCOUNT_ID: "keeper.testnet",
  MONITOR_RPC_PER_SEC: "100000", MONITOR_MIN_TICK_INTERVAL_MS: "0", MONITOR_BATCH_BETS: "20", ALERT_STALL_GRACE_MS: "60000", ALERT_COOLDOWN_MS: "1800000",
  ALERT_TELEGRAM_BOT_TOKEN: "123456:TESTTOKENTESTTOKENTESTTOKENTESTTOKEN", ALERT_TELEGRAM_CHAT_ID: "opschat", ...extra,
});
const tick = async (d: MonitorDO) => asyncJson(await d.fetch(new Request("https://monitor.do/tick", { method: "POST" })));
const withFetch = async <T>(w: World, f: () => Promise<T>): Promise<T> => { const real = globalThis.fetch; globalThis.fetch = outboundFetch(w) as any; try { return await f(); } finally { globalThis.fetch = real; } };
const mk = (st: ReturnType<typeof fakeDoStorage>, e: Record<string, string>, clock: { ms: number }) => new MonitorDO(st.ctx as any, e as any, () => clock.ms);

function wedgedWorld(): World {
  const w = world();
  w.bets.set(1, mkBet(1, { status: "Settled" as any }));
  w.bets.set(2, mkBet(2, { status: "Finalized" as any }));
  w.payouts = [
    { id: 1, bet_id: 1, token_id: USDC, receiver: "maker1.testnet", amount: "198", reason: "payout_winner", attempts: 1, done: true, in_flight: false },
    { id: 2, bet_id: 2, token_id: USDC, receiver: "taker2.testnet", amount: "198", reason: "payout_winner", attempts: 1, done: false, in_flight: true },
  ];
  w.balances[USDC] = "198";
  return w;
}
const stuck = (a: any[]) => a.filter((x) => x.kind === "payout_stuck_in_flight");

test("Worker: a line in flight 10 min -> exactly one CRITICAL alert (bet id, asset, amount) delivered to Telegram; a DO restart neither resets nor re-sends", async () => {
  const w = wedgedWorld();
  const st = fakeDoStorage(); const clock = { ms: T0 };
  let d = mk(st, env(), clock);
  const all: any[] = [];
  for (const m of [0, 3, 6, 9]) { clock.ms = T0 + m * MIN; all.push(...(await withFetch(w, async () => (await tick(d)).sent))); }
  assert.deepEqual(stuck(all), [], "not before 10 minutes");
  d = mk(st, env(), clock); // DO evicted/restarted: the first-seen clock comes from SQLite
  clock.ms = T0 + 10 * MIN;
  const at10 = stuck(await withFetch(w, async () => (await tick(d)).sent));
  assert.equal(at10.length, 1);
  assert.equal(at10[0].severity, "critical");
  for (const s of ["bet 2", USDC, "198"]) assert.ok(at10[0].message.includes(s), at10[0].message);
  assert.ok(w.telegram.some((t) => t.text.includes(at10[0].message)), "delivered to the ops chat");
  for (const m of [11, 45, 90, 200]) {
    d = mk(st, env(), clock); clock.ms = T0 + m * MIN;
    assert.deepEqual(stuck(await withFetch(w, async () => (await tick(d)).sent)), [], `no repeat at minute ${m}`);
  }
  st.close();
});

test("Worker: the payout line completes before the threshold -> no alert; ALERT_STUCK_PAYOUT_MS overrides the threshold", async () => {
  const w = wedgedWorld();
  const st = fakeDoStorage(); const clock = { ms: T0 }; const d = mk(st, env(), clock);
  await withFetch(w, () => tick(d));
  w.payouts[1] = { ...w.payouts[1], done: true, in_flight: false };
  clock.ms = T0 + 30 * MIN;
  assert.deepEqual(stuck(await withFetch(w, async () => (await tick(d)).sent)), []);
  st.close();

  const w2 = wedgedWorld();
  const st2 = fakeDoStorage(); const c2 = { ms: T0 }; const d2 = mk(st2, env({ ALERT_STUCK_PAYOUT_MS: String(2 * MIN) }), c2);
  await withFetch(w2, () => tick(d2));
  c2.ms = T0 + 2 * MIN;
  assert.equal(stuck(await withFetch(w2, async () => (await tick(d2)).sent)).length, 1);
  st2.close();
});

test("Worker: the in-flight read failing is the distinct 'cannot check' warning, and the rest of the tick still runs", async () => {
  const w = wedgedWorld();
  const realFetch = outboundFetch(w);
  const failing = async (i: any, init?: any) => {
    const b = JSON.parse(String(init?.body ?? "{}"));
    if (b.params?.method_name === "pending_payouts_view" && JSON.parse(atob(b.params.args_base64)).from > 0) return new Response("boom", { status: 500 });
    return realFetch(i, init);
  };
  const st = fakeDoStorage(); const clock = { ms: T0 }; const d = mk(st, env({ NEAR_RPC_FALLBACKS: "" }), clock);
  const real = globalThis.fetch; globalThis.fetch = failing as any;
  try {
    const r = await tick(d); // first scan starts at id 1 -> fails
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.sent.some((a: any) => a.kind === "payout_stuck_in_flight_unchecked" && a.severity === "warning"), JSON.stringify(r.sent.map((a: any) => a.kind)));
  } finally { globalThis.fetch = real; st.close(); }
});

test("parity: the node monitor's live provider raises the same stuck-payout alert as the Worker", async () => {
  const w = wedgedWorld();
  const nodeProvider = buildLiveProvider(viewClientOf(w) as any, ESC, INT, USDC, { feeAccount: "fee.testnet", keeper: "keeper.testnet" }, RPC_URL);
  assert.ok(nodeProvider.fetchUndonePayouts, "node provider wires the in-flight read");
  const state = createAlertRunnerState({ stallGraceNs: 60 * NS, cooldownNs: 1_800_000 * NS });
  const ch = { async send() {} };
  await withFetch(w, () => runAlertTick(nodeProvider, state, ch, T0 * 1e6));
  const n = stuck(await withFetch(w, () => runAlertTick(nodeProvider, state, ch, (T0 + 10 * MIN) * 1e6)));
  const st = fakeDoStorage(); const clock = { ms: T0 }; const d = mk(st, env(), clock);
  await withFetch(w, () => tick(d)); clock.ms = T0 + 10 * MIN;
  const k = stuck(await withFetch(w, async () => (await tick(d)).sent));
  assert.equal(n.length, 1); assert.deepEqual(norm(k), norm(n));
  st.close();
});

test("config: default 10 min; wrangler testnet AND mainnet set ALERT_STUCK_PAYOUT_MS = 600000", () => {
  assert.equal(loadMonitorConfig(env()).stuckPayoutThresholdMs, 10 * MIN);
  assert.equal(loadMonitorConfig(env({ ALERT_STUCK_PAYOUT_MS: "120000" })).stuckPayoutThresholdMs, 2 * MIN);
  const toml = fs.readFileSync(path.resolve(HERE, "../wrangler.toml"), "utf8");
  const [testnet, mainnet] = toml.split(/^\[env\.mainnet\]/m);
  assert.match(testnet!, /^ALERT_STUCK_PAYOUT_MS = "600000"/m);
  assert.match(mainnet!, /^ALERT_STUCK_PAYOUT_MS = "600000"/m);
});

test("Worker: every tick reports the payout scan (tick JSON + one log line) so a live poll is observable without an alert", async () => {
  const w = wedgedWorld();
  const st = fakeDoStorage(); const d = mk(st, env(), { ms: T0 });
  const logs: string[] = []; const orig = console.log; console.log = (...a: any[]) => { logs.push(a.map(String).join(" ")); };
  let r: any;
  try { r = await withFetch(w, () => tick(d)); } finally { console.log = orig; st.close(); }
  assert.deepEqual(r.payouts, { scanned_from: 1, next_from: 2, undone: 1, in_flight: 1, complete: true });
  const line = logs.find((l) => l.includes('"msg":"monitor payout scan"'));
  assert.ok(line, logs.join("\n"));
  assert.deepEqual(JSON.parse(line!).payouts, r.payouts);
});
