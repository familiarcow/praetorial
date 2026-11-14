// CF1c RED: the monitor Worker (MonitorDO). MON4/MON4b alert-kind parity vs the node monitor (runAlertTick over
// buildLiveProvider) on the same mocked chain/feeds; dedupe state persisted in DO SQLite (restart, cooldown); bounded batch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAlertTick, createAlertRunnerState, buildLiveProvider } from "../../../monitor/src/runner.js";
import { alertsForKeeperCredit } from "../../../monitor/src/opsAlerts.js";
import { MonitorDO } from "../src/index.js";
import { ESC, INT, USDC, NS, T0, mkBet, world, viewClientOf, outboundFetch, norm, fakeDoStorage, asyncJson, RPC_URL, type World } from "./helpers.js";

const env = (extra: Record<string, string> = {}) => ({
  NEAR_NETWORK_ID: "testnet", ESCROW_CONTRACT_ID: ESC, INTENTS_CONTRACT_ID: INT, USDC_TOKEN_ID: USDC, FEE_ACCOUNT_ID: "fee.testnet", KEEPER_ACCOUNT_ID: "keeper.testnet",
  MONITOR_RPC_PER_SEC: "100000", MONITOR_MIN_TICK_INTERVAL_MS: "0", MONITOR_BATCH_BETS: "20", ALERT_STALL_GRACE_MS: "60000", ALERT_COOLDOWN_MS: "1800000",
  ALERT_TELEGRAM_BOT_TOKEN: "123456:TESTTOKENTESTTOKENTESTTOKENTESTTOKEN", ALERT_TELEGRAM_CHAT_ID: "opschat", RELAYER_BUDGET_URL: "https://relayer.test/budget/global", ...extra,
});
const tick = async (d: MonitorDO) => asyncJson(await d.fetch(new Request("https://monitor.do/tick", { method: "POST" })));
const withFetch = async <T>(w: World, f: () => Promise<T>): Promise<T> => { const real = globalThis.fetch; globalThis.fetch = outboundFetch(w) as any; try { return await f(); } finally { globalThis.fetch = real; } };
const mk = (st: ReturnType<typeof fakeDoStorage>, e: Record<string, string>, clock: { ms: number }) => new MonitorDO(st.ctx as any, e as any, () => clock.ms);

/** A world that trips every MON-family alert: invariant (I-1 stranger payout + contract-wide I-2), a due keeper action, paused+shutdown,
 * low storage headroom, relayer budget 85%. */
function badWorld(): World {
  const w = world();
  w.bets.set(1, mkBet(1, { status: "Proposed", proposed_at: 0, outcome: "YES" })); // past its settlement window => keeper finalize due
  w.bets.set(2, mkBet(2));
  w.payouts = [{ id: 1, bet_id: 2, token_id: USDC, receiver: "stranger.testnet", amount: "5", reason: "winner", attempts: 0, done: false, in_flight: false }];
  w.paused = true; w.shutdown = true; w.balances[USDC] = "999999999";
  w.account = { amount: "1000000000000000000000000", storage_usage: 99_000 }; // headroom ~ 0.01 NEAR < 0.5 NEAR
  w.relayerBudget = { capYocto: "1000", usedYocto: "850" };
  return w;
}

test("parity: the Worker raises the same alert set as the node monitor over two ticks (invariants, stall, paused/shutdown, storage headroom, relayer budget)", async () => {
  const w = badWorld();
  const ne = env();
  const stallNs = 60 * NS, coolNs = 1_800_000 * NS;
  const nodeProvider = buildLiveProvider(viewClientOf(w) as any, ESC, INT, USDC, { feeAccount: "fee.testnet", keeper: "keeper.testnet" }, RPC_URL, "https://relayer.test/budget/global");
  const state = createAlertRunnerState({ stallGraceNs: stallNs, cooldownNs: coolNs });
  const nodeSent: any[] = []; const channel = { async send(a: any) { nodeSent.push(a); } };
  const n1 = await withFetch(w, () => runAlertTick(nodeProvider, state, channel, T0 * 1e6));
  const n2 = await withFetch(w, () => runAlertTick(nodeProvider, state, channel, (T0 + 90_000) * 1e6));
  const kinds = new Set([...n1, ...n2].map((a) => a.kind));
  for (const k of ["invariant_violation", "keeper_stall", "contract_shutdown", "storage_headroom", "relayer_global_budget"]) assert.ok(kinds.has(k), `self-check: node must raise ${k}, got ${[...kinds]}`);

  const wk = badWorld();
  const st = fakeDoStorage(); const clock = { ms: T0 }; const d = mk(st, ne, clock);
  const w1 = await withFetch(wk, async () => (await tick(d)).sent);
  clock.ms = T0 + 90_000;
  const w2 = await withFetch(wk, async () => (await tick(d)).sent);
  assert.deepEqual(norm(w1), norm(n1)); assert.deepEqual(norm(w2), norm(n2));
  assert.ok(wk.telegram.length >= 1 && wk.telegram.length <= 4, `telegram posts: ${wk.telegram.length}`);
  const all = wk.telegram.map((t) => t.text).join("\n");
  for (const a of [...n1, ...n2]) assert.ok(all.includes(a.message), `telegram missing: ${a.message}`);
  assert.ok(!all.includes("TESTTOKEN"));
  st.close();
});

test("parity: relayer budget unreadable and storage unreadable are the distinct 'cannot check' alerts, never OK", async () => {
  const w = world(); w.bets.set(1, mkBet(1)); w.relayerBudget = null;
  const realFetch = outboundFetch(w);
  const failingRpcFetch = async (i: any, init?: any) => { const u = new URL(typeof i === "string" ? i : i.url); if (u.hostname === "test.rpc.fastnear.com" && JSON.parse(String(init?.body)).method === "EXPERIMENTAL_protocol_config") return new Response("boom", { status: 500 }); return realFetch(i, init); };
  const real = globalThis.fetch; globalThis.fetch = failingRpcFetch as any;
  try {
    const st = fakeDoStorage(); const d = mk(st, env(), { ms: T0 });
    const sent: any[] = (await tick(d)).sent;
    const kinds = sent.map((a) => a.kind);
    assert.ok(kinds.includes("relayer_global_budget_unchecked") && kinds.includes("storage_headroom_unchecked"), kinds.join(","));
    st.close();
  } finally { globalThis.fetch = real; }
});

test("MON4: keeper_credit_low via CREDIT_WATCH equals the node rule; recovery sent once when it clears", async () => {
  const w = world(); w.accounts["keeper.testnet"] = "1000";
  const st = fakeDoStorage(); const clock = { ms: T0 }; const d = mk(st, env({ CREDIT_WATCH: "keeper.testnet:5000:2000" }), clock);
  const first: any[] = await withFetch(w, async () => (await tick(d)).sent);
  const want = alertsForKeeperCredit({ account: "keeper.testnet", balanceYocto: "1000", floorYocto: "5000", burnPerDayYocto: "2000" });
  assert.deepEqual(norm(first.filter((a) => a.kind === "keeper_credit_low")), norm(want));
  w.accounts["keeper.testnet"] = "9000"; clock.ms += 60_000;
  const second: any[] = await withFetch(w, async () => (await tick(d)).sent);
  const rec = second.filter((a) => a.severity === "info");
  assert.equal(rec.length, 1); assert.equal(rec[0].key, "keeper_credit_low:keeper.testnet:recovered");
  clock.ms += 60_000;
  assert.equal((await withFetch(w, async () => (await tick(d)).sent)).filter((a: any) => a.severity === "info").length, 0, "recovery only once");
  st.close();
});

test("dedupe state lives in the DO SQLite: a restarted DO does not re-send inside the cooldown; fresh-storage control re-sends; sends again after the cooldown", async () => {
  const w = badWorld(); const ne = env(); const clock = { ms: T0 };
  const st = fakeDoStorage();
  const first: any[] = await withFetch(w, async () => (await tick(mk(st, ne, clock))).sent);
  assert.ok(first.length >= 4);
  clock.ms += 120_000; // new DO instance on the SAME storage == restart
  const again: any[] = await withFetch(w, async () => (await tick(mk(st, ne, clock))).sent);
  assert.deepEqual(again.filter((a) => a.kind !== "keeper_stall").map((a) => a.key), [], "no re-send within cooldown after restart");
  const control: any[] = await withFetch(w, async () => (await tick(mk(fakeDoStorage(), ne, { ms: clock.ms }))).sent);
  assert.ok(control.length >= 4, "control: lost state would re-send everything");
  clock.ms += 31 * 60_000;
  const later: any[] = await withFetch(w, async () => (await tick(mk(st, ne, clock))).sent);
  assert.ok(later.some((a) => a.kind === "invariant_violation"), "re-sent after cooldown");
  assert.ok(later.some((a) => a.kind === "keeper_stall"), "stall tracker also survives restart");
  st.close();
});

test("bounded batch: <= 44 outbound calls per tick, 20 bets per tick; a full sweep over 100 bets covers every bet; contract-wide I-2 judged only when the sweep completes", async () => {
  const w = world(); for (let i = 1; i <= 100; i++) w.bets.set(i, mkBet(i, i % 2 ? { status: "Cancelled" } : {}));
  w.balances[USDC] = "1"; // tracked funds >> 1 => contract-wide I-2 violation
  const st = fakeDoStorage(); const clock = { ms: T0 }; const d = mk(st, env(), clock);
  const seenAlerts: any[] = [];
  for (let i = 0; i < 7; i++) {
    const before = w.outbound; const views = w.views.length;
    const r = await withFetch(w, () => tick(d)); clock.ms += 60_000;
    assert.ok(w.outbound - before <= 44, `tick ${i} used ${w.outbound - before} outbound calls`);
    assert.ok(w.views.slice(views).filter((v) => v >= 1).length <= 24, "bet views per tick bounded");
    seenAlerts.push(...r.sent);
    if (i < 4) assert.ok(!seenAlerts.some((a: any) => /contract-wide/.test(a.message)), `contract-wide I-2 judged before the sweep ended (tick ${i})`);
  }
  assert.equal(new Set(w.views.filter((v) => v >= 1 && v <= 100)).size, 100, "every bet id 1..100 was read");
  assert.ok(seenAlerts.some((a: any) => a.kind === "invariant_violation" && /contract-wide/.test(a.message)), "contract-wide I-2 raised after the sweep");
  st.close();
});

test("missing required binding is a loud 500, never a silent default; other paths 404", async () => {
  const st = fakeDoStorage(); const d = mk(st, { NEAR_NETWORK_ID: "testnet" }, { ms: T0 });
  const r = await d.fetch(new Request("https://monitor.do/tick", { method: "POST" })); assert.equal(r.status, 500); assert.match(((await r.json()) as any).error, /INTENTS_CONTRACT_ID|ESCROW_CONTRACT_ID/);
  assert.equal((await d.fetch(new Request("https://monitor.do/anything"))).status, 404);
  st.close();
});

test("minimum tick interval: a second /tick inside MONITOR_MIN_TICK_INTERVAL_MS is skipped (a public route cannot burn the subrequest budget)", async () => {
  const w = world(); w.bets.set(1, mkBet(1));
  const st = fakeDoStorage(); const clock = { ms: T0 }; const d = mk(st, env({ MONITOR_MIN_TICK_INTERVAL_MS: "30000" }), clock);
  const a = await withFetch(w, () => tick(d)); clock.ms += 1000; const before = w.outbound;
  const b = await withFetch(w, () => tick(d));
  assert.equal(a.skipped, undefined); assert.equal(b.skipped, true); assert.equal(w.outbound, before);
  st.close();
});
