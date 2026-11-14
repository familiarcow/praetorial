// CF1c RED: the notifier Worker (NotifierDO). Parity with the node notifier pipeline (discover -> second-RPC terminal confirm ->
// computeNoticesMulti -> high-stake Telegram) on mocked chain; seen keys / outbox / log / contacts in DO SQLite (restart);
// AES-GCM contact encryption via WebCrypto (compatible with the node ContactStore rows); bounded batch per tick.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discoverAllBets } from "@praetorial/common/discovery.js";
import { computeNoticesMulti } from "../../../notifier/src/notifier.js";
import { filterConfirmedTerminals } from "../../../notifier/src/confirm.js";
import { ContactStore } from "../../../notifier/src/contactStore.js";
import { ServiceAlertRaiser } from "../../../monitor/src/serviceAlerts.js";
import { createSecondRpcClient } from "@praetorial/common/terminalConfirm.js";
import { NotifierDO } from "../src/index.js";
import { ESC, USDC, NS, T0, mkBet, world, viewClientOf, outboundFetch, fakeDoStorage, asyncJson, RPC2_URL, type World } from "../../monitor/test/helpers.js";

const KEY = "ab".repeat(32);
const env = (extra: Record<string, string> = {}) => ({
  NEAR_NETWORK_ID: "testnet", ESCROW_CONTRACT_ID: ESC, INTENTS_CONTRACT_ID: "intents.testnet", USDC_TOKEN_ID: USDC, NEAR_RPC_FALLBACKS: RPC2_URL,
  NOTIFIER_CONTACT_KEY: KEY, NOTIFIER_RPC_PER_SEC: "100000", NOTIFIER_MIN_TICK_INTERVAL_MS: "0", NOTIFIER_BATCH_BETS: "12",
  TELEGRAM_BOT_TOKEN: "123456:TESTTOKENTESTTOKENTESTTOKENTESTTOKEN", NOTIFIER_ASSET_PRICES: JSON.stringify({ [USDC]: { decimals: 6, usdPerToken: 1 } }),
  NOTIFIER_HIGH_STAKE_USD: "500", NOTIFIER_BET_LINK_BASE: "https://app.test/bet", ...extra,
});
const tick = async (d: NotifierDO) => asyncJson(await d.fetch(new Request("https://notifier.do/tick", { method: "POST" })));
const withFetch = async <T>(w: World, f: () => Promise<T>): Promise<T> => { const real = globalThis.fetch; globalThis.fetch = outboundFetch(w) as any; try { return await f(); } finally { globalThis.fetch = real; } };
const mk = (st: ReturnType<typeof fakeDoStorage>, e: Record<string, string>, clock: { ms: number }) => new NotifierDO(st.ctx as any, e as any, () => clock.ms);
const shape = (ns: any[]) => ns.map((n) => ({ bet_id: n.bet_id, kind: n.kind, to: n.to_accounts, detail: n.detail, contract: n.contract_id })).sort((a, b) => (a.kind + a.bet_id < b.kind + b.bet_id ? -1 : 1));

const FAR = { settlement_period: 1e15 }; // challenge window ends far in the future: no "closing soon" notice
const prop = (id: number, envOver: Record<string, unknown> = {}) => mkBet(id, { status: "Proposed", proposed_at: 0, outcome: "YES" }, { ...FAR, ...envOver });

function lifeWorld(): World {
  const w = world();
  w.bets.set(1, prop(1));
  w.bets.set(2, mkBet(2, { status: "Settled", outcome: "NO" }));
  w.bets.set(3, mkBet(3, { status: "Voided", outcome: "VOID" }));
  w.bets.set(4, mkBet(4, { status: "Open", taker: null }));
  return w;
}

test("parity: Worker notices == node pipeline (second-RPC confirmed terminals) on the same chain", async () => {
  const w = lifeWorld(); const nowMs = 5 * 1000;
  w.bets.set(5, mkBet(5, { status: "Proposed", proposed_at: 0, outcome: "YES" })); // 10 s window, now = 5 s: closing soon
  // node reference
  const client = viewClientOf(w) as any;
  const { bets } = await discoverAllBets(client, ESC, 0);
  const second = { view: async (c: string, m: string, a: any) => client.view(c, m, a) };
  const raiser = new ServiceAlertRaiser({ async send() {} });
  const confirmed = await filterConfirmedTerminals(new Map([[ESC, bets]]), { second, raiser, cache: new Set() });
  const want = computeNoticesMulti(confirmed, nowMs * 1_000_000, new Set());
  assert.deepEqual(want.map((n) => n.kind).sort(), ["challenge_window_closing", "proposed", "proposed", "settled", "voided"], "self-check");
  const st = fakeDoStorage(); const d = mk(st, env(), { ms: nowMs });
  const r = await withFetch(w, () => tick(d));
  assert.deepEqual(shape(r.notices), shape(want));
  st.close();
});

test("terminal outcomes are announced only after the second RPC agrees; disagreement/unavailable/single-RPC raise the D-DSY1 alerts and announce nothing", async () => {
  for (const [mode, kind] of [["secondDisagree", "terminal_unconfirmed"], ["secondDown", "terminal_unconfirmed"], ["single", "terminal_single_rpc"]] as const) {
    const w = lifeWorld(); if (mode !== "single") (w as any)[mode] = true;
    const e = env(mode === "single" ? { NEAR_RPC_FALLBACKS: "" } : {});
    const st = fakeDoStorage(); const d = mk(st, e, { ms: 5000 });
    const r: any = await withFetch(w, () => tick(d));
    assert.deepEqual(r.notices.map((n: any) => n.kind), ["proposed"], mode);
    assert.ok(r.alerts.some((a: any) => a.kind === kind), `${mode}: ${JSON.stringify(r.alerts.map((a: any) => a.kind))}`);
    st.close();
  }
});

test("contract_version mismatch raises the version alert (ESCROW_CONTRACTS label vs contract_version)", async () => {
  const w = lifeWorld(); w.version = "2.0.0";
  const st = fakeDoStorage(); const d = mk(st, env({ ESCROW_CONTRACTS: `${ESC}@v1` }), { ms: 5000 });
  const r: any = await withFetch(w, () => tick(d));
  assert.ok(r.alerts.some((a: any) => a.kind === "contract_version_mismatch"));
  st.close();
});

test("seen keys live in the DO SQLite: restart does not re-announce; fresh-storage control does; each notice is also in the PII-free log and the outbox", async () => {
  const w = lifeWorld(); const st = fakeDoStorage(); const clock = { ms: 5000 };
  const first: any = await withFetch(w, async () => tick(mk(st, env(), clock)));
  assert.equal(first.notices.length, 3);
  clock.ms += 60_000;
  const again: any = await withFetch(w, async () => tick(mk(st, env(), clock)));
  assert.equal(again.notices.length, 0, "no duplicate after restart");
  const control: any = await withFetch(w, async () => tick(mk(fakeDoStorage(), env(), { ms: 5000 })));
  assert.equal(control.notices.length, 3, "control: lost state would re-announce");
  // a bet moving on is announced once
  w.bets.set(4, mkBet(4, { status: "Settled", outcome: "YES" }));
  const moved: any = await withFetch(w, async () => tick(mk(st, env(), clock)));
  assert.deepEqual(moved.notices.map((n: any) => n.kind), ["settled"]);
  const logRows = st.ctx.storage.sql.exec("SELECT * FROM notification_log ORDER BY rowid").toArray();
  assert.equal(logRows.length, 4);
  for (const row of logRows) assert.deepEqual(Object.keys(row).sort(), ["bet_id", "event", "timestamp"], "log carries only bet_id/event/timestamp");
  assert.equal(st.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM notifier_outbox").toArray()[0].n, 4);
  st.close();
});

test("contacts: WebCrypto AES-GCM at rest (no plaintext in any table), roundtrip, delete idempotent, survives restart, wrong key throws, refuses to start without a valid key", async () => {
  const st = fakeDoStorage(); const d = mk(st, env(), { ms: T0 });
  await d.setContact("maker1.testnet", "telegram", "@secret_handle_123");
  assert.deepEqual(await d.getContact("maker1.testnet"), { kind: "telegram", value: "@secret_handle_123" });
  const dump = JSON.stringify(st.ctx.storage.sql.exec("SELECT * FROM contacts").toArray().map((r: any) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v]))));
  assert.ok(!dump.includes("secret_handle"), "plaintext on disk");
  assert.deepEqual(await mk(st, env(), { ms: T0 }).getContact("maker1.testnet"), { kind: "telegram", value: "@secret_handle_123" }, "survives restart");
  await assert.rejects(() => mk(st, env({ NOTIFIER_CONTACT_KEY: "cd".repeat(32) }), { ms: T0 }).getContact("maker1.testnet"));
  assert.equal(await d.getContact("nobody.testnet"), null);
  await d.deleteContact("maker1.testnet"); await d.deleteContact("maker1.testnet");
  assert.equal(await d.getContact("maker1.testnet"), null); assert.equal(await d.rowCountForAccount("maker1.testnet"), 0);
  for (const bad of [undefined, "", "xyz", "ab".repeat(31)]) {
    const e: any = env(); if (bad === undefined) delete e.NOTIFIER_CONTACT_KEY; else e.NOTIFIER_CONTACT_KEY = bad;
    const r = await mk(st, e, { ms: T0 }).fetch(new Request("https://notifier.do/tick", { method: "POST" }));
    assert.equal(r.status, 500); assert.match(((await r.json()) as any).error, /NOTIFIER_CONTACT_KEY/);
  }
  st.close();
});

test("contacts: rows written by the node ContactStore decrypt in the Worker store (same schema + AES-256-GCM)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf1c-contacts-")); const file = path.join(dir, "c.sqlite3");
  const node = new ContactStore(file, KEY); node.setContact("maker1.testnet", "telegram", "@from_node"); node.close();
  const raw = new DatabaseSync(file); raw.exec("PRAGMA wal_checkpoint(TRUNCATE)"); raw.close();
  const st = fakeDoStorage(file); const d = mk(st, env(), { ms: T0 });
  assert.deepEqual(await d.getContact("maker1.testnet"), { kind: "telegram", value: "@from_node" });
  await d.setContact("taker2.testnet", "email", "a@b.test"); st.close();
  const back = new ContactStore(file, KEY); assert.deepEqual(back.getContact("taker2.testnet"), { kind: "email", value: "a@b.test" }); back.close();
});

test("high-stake Telegram: >= $500 side with a telegram contact gets 'Bet #N: kind\\nlink'; below threshold / other kinds / no contact get nothing; token never in output", async () => {
  const w = world();
  w.bets.set(1, prop(1, { stake_maker: "600000000", stake_taker: "100" }));
  w.bets.set(2, prop(2));
  const st = fakeDoStorage(); const d = mk(st, env(), { ms: 5000 });
  await d.setContact("maker1.testnet", "telegram", "chat-maker1"); await d.setContact("taker1.testnet", "telegram", "chat-taker1");
  await d.setContact("maker2.testnet", "telegram", "chat-maker2"); await d.setContact("maker1x.testnet", "email", "x@y.z");
  const logs: string[] = []; const o = console.error; console.error = (...a: any[]) => logs.push(a.join(" "));
  let r: any; try { r = await withFetch(w, () => tick(d)); } finally { console.error = o; }
  assert.deepEqual(w.telegram, [{ chat: "chat-maker1", text: "Bet #1: proposed\nhttps://app.test/bet/1" }]);
  assert.ok(!JSON.stringify(r).includes("TESTTOKEN") && !logs.join("").includes("TESTTOKEN"));
  st.close();
});

test("Telegram sends are bounded per tick and queued in SQLite: the remainder goes out next tick, a restart keeps the queue, failures retry", async () => {
  const w = world();
  for (let i = 1; i <= 6; i++) w.bets.set(i, prop(i, { stake_maker: "900000000", stake_taker: "100" }));
  const st = fakeDoStorage(); const clock = { ms: 5000 }; const e = env({ NOTIFIER_MAX_SENDS_PER_TICK: "4" });
  const d0 = mk(st, e, clock); for (let i = 1; i <= 6; i++) await d0.setContact(`maker${i}.testnet`, "telegram", `chat${i}`);
  await withFetch(w, () => tick(mk(st, e, clock)));
  assert.equal(w.telegram.length, 4); clock.ms += 60_000;
  await withFetch(w, () => tick(mk(st, e, clock)));
  assert.equal(w.telegram.length, 6, "queued remainder delivered after a restart");
  assert.deepEqual([...new Set(w.telegram.map((t) => t.chat))].sort(), [1, 2, 3, 4, 5, 6].map((i) => `chat${i}`));
  clock.ms += 60_000; await withFetch(w, () => tick(mk(st, e, clock)));
  assert.equal(w.telegram.length, 6, "no re-send");
  st.close();
});

test("bounded batch: 60 bets, 12 per tick -> <= 44 outbound calls per tick, every bet read within a sweep, every notice produced exactly once", async () => {
  const w = world(); for (let i = 1; i <= 60; i++) w.bets.set(i, i % 3 === 0 ? mkBet(i, { status: "Settled", outcome: "YES" }) : prop(i));
  const st = fakeDoStorage(); const clock = { ms: 5000 }; const d = mk(st, env(), clock);
  const all: any[] = [];
  for (let i = 0; i < 8; i++) { const b = w.outbound; const r: any = await withFetch(w, () => tick(d)); clock.ms += 60_000; assert.ok(w.outbound - b <= 44, `tick ${i}: ${w.outbound - b}`); all.push(...r.notices); }
  assert.equal(new Set(w.views.filter((v) => v >= 1 && v <= 60)).size, 60);
  const keys = all.map((n) => `${n.kind}:${n.bet_id}`);
  assert.equal(new Set(keys).size, keys.length, "no duplicate notice");
  assert.equal(all.filter((n) => n.kind === "proposed").length, 40); assert.equal(all.filter((n) => n.kind === "settled").length, 20);
  st.close();
});

test("a primary RPC failure is a loud 500 and leaves the persisted cursor/seen state untouched (retry next tick loses nothing)", async () => {
  const w = lifeWorld(); w.rpcFail = true; const st = fakeDoStorage(); const clock = { ms: 5000 };
  const bad = await withFetch(w, async () => mk(st, env(), clock).fetch(new Request("https://notifier.do/tick", { method: "POST" })));
  assert.equal(bad.status, 500);
  w.rpcFail = false;
  assert.equal((await withFetch(w, async () => tick(mk(st, env(), clock)))).notices.length, 3);
  st.close();
});

test("other paths 404; a second /tick inside NOTIFIER_MIN_TICK_INTERVAL_MS is skipped", async () => {
  const w = lifeWorld(); const st = fakeDoStorage(); const clock = { ms: 5000 }; const d = mk(st, env({ NOTIFIER_MIN_TICK_INTERVAL_MS: "30000" }), clock);
  assert.equal((await d.fetch(new Request("https://notifier.do/x"))).status, 404);
  await withFetch(w, () => tick(d)); clock.ms += 1000; const b = w.outbound;
  assert.equal((await withFetch(w, () => tick(d))).skipped, true); assert.equal(w.outbound, b);
  st.close();
});

test("a failed Telegram send stays queued (no PII, no loss) and is retried next tick; the bot token never appears in output or logs", async () => {
  const w = world(); w.bets.set(1, prop(1, { stake_maker: "900000000" }));
  const st = fakeDoStorage(); const clock = { ms: 5000 }; const d = mk(st, env(), clock); await d.setContact("maker1.testnet", "telegram", "chat1");
  const real = globalThis.fetch; const base = outboundFetch(w); let fails = 1; const logs: string[] = []; const oe = console.error, ol = console.log;
  console.error = (...a: any[]) => logs.push(a.join(" ")); console.log = (...a: any[]) => logs.push(a.join(" "));
  globalThis.fetch = (async (i: any, init?: any) => { if (new URL(typeof i === "string" ? i : i.url).hostname === "api.telegram.org" && fails-- > 0) return new Response("boom", { status: 500 }); return base(i, init); }) as any;
  try {
    const r1 = await tick(d); assert.equal(w.telegram.length, 0); assert.equal(r1.sent, 0);
    const q = st.ctx.storage.sql.exec("SELECT * FROM notifier_tg_queue").toArray();
    assert.equal(q.length, 1); assert.ok(!JSON.stringify(q).includes("chat1"), "queue carries no contact value (resolved at send time)");
    clock.ms += 60_000; await tick(d); assert.equal(w.telegram.length, 1);
    assert.equal(st.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM notifier_tg_queue").toArray()[0].n, 0, "queue drained");
  } finally { globalThis.fetch = real; console.error = oe; console.log = ol; }
  assert.ok(!logs.join("\n").includes("TESTTOKEN"));
  st.close();
});

test("a Telegram entry whose contact was deleted (or is not telegram) is dropped from the queue without sending", async () => {
  const w = world(); w.bets.set(1, prop(1, { stake_maker: "900000000" }));
  const st = fakeDoStorage(); const clock = { ms: 5000 }; const d = mk(st, env(), clock); await d.setContact("maker1.testnet", "telegram", "chat1"); await d.deleteContact("maker1.testnet");
  await withFetch(w, () => tick(d)); assert.equal(w.telegram.length, 0);
  assert.equal(st.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM notifier_tg_queue").toArray()[0].n, 0);
  st.close();
});

test("multiple contracts: ESCROW_CONTRACTS is honoured (per-contract cursor, notices tagged with contract_id, same bet id on two contracts both announced)", async () => {
  const w = world(); w.bets.set(1, mkBet(1, { status: "Settled", outcome: "YES" }));
  const st = fakeDoStorage(); const d = mk(st, env({ ESCROW_CONTRACTS: `${ESC}@v1,${ESC}2@v2` }), { ms: 5000 });
  const real = globalThis.fetch; const base = outboundFetch(w);
  globalThis.fetch = (async (i: any, init?: any) => { const b: any = JSON.parse(String(init?.body ?? "{}")); if (b?.params?.account_id === `${ESC}2`) b.params.account_id = ESC; return base(i, { ...init, body: JSON.stringify(b) }); }) as any;
  try { const r: any = await tick(d); assert.deepEqual(r.notices.map((n: any) => n.contract_id).sort(), [ESC, `${ESC}2`]); } finally { globalThis.fetch = real; }
  st.close();
});

test("the outbox and notification log are pruned to a bounded size (DO storage stays small)", async () => {
  const w = world(); for (let i = 1; i <= 30; i++) w.bets.set(i, prop(i));
  const st = fakeDoStorage(); const clock = { ms: 5000 }; const d = mk(st, env({ NOTIFIER_BATCH_BETS: "30", NOTIFIER_LOG_KEEP: "10" }), clock);
  await withFetch(w, () => tick(d));
  assert.equal(st.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM notifier_outbox").toArray()[0].n, 10);
  assert.equal(st.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM notification_log").toArray()[0].n, 10);
  st.close();
});
