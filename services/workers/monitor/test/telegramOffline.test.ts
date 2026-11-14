// ALRT1a RED: monitor Telegram delivery offline. Mocked fetch only: no network, no secrets, no deploy.
// Pins: chunking (<=3500 chars, max 3 posts, chat id passthrough); unset token/chat id => zero Telegram fetches, exactly one
// structured `telegram not configured` warning per tick (kind + alert count, never the token) and a `telegram_unconfigured`
// flag in the tick JSON; Telegram non-ok => logged error, tick still completes, other alert work (log lines, dedupe state) kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MonitorDO } from "../src/index.js";
import { ESC, INT, USDC, T0, mkBet, world, outboundFetch, fakeDoStorage, asyncJson, type World } from "./helpers.js";

const TOKEN = "123456:TESTTOKENTESTTOKENTESTTOKENTESTTOKEN";
const env = (extra: Record<string, string | undefined> = {}) => {
  const e: Record<string, string | undefined> = {
    NEAR_NETWORK_ID: "testnet", ESCROW_CONTRACT_ID: ESC, INTENTS_CONTRACT_ID: INT, USDC_TOKEN_ID: USDC, FEE_ACCOUNT_ID: "fee.testnet", KEEPER_ACCOUNT_ID: "keeper.testnet",
    MONITOR_RPC_PER_SEC: "100000", MONITOR_MIN_TICK_INTERVAL_MS: "0", MONITOR_BATCH_BETS: "200", ALERT_STALL_GRACE_MS: "60000", ALERT_COOLDOWN_MS: "1800000",
    ALERT_TELEGRAM_BOT_TOKEN: TOKEN, ALERT_TELEGRAM_CHAT_ID: "opschat", ...extra,
  };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e as Record<string, string>;
};
const tick = async (d: MonitorDO) => asyncJson(await d.fetch(new Request("https://monitor.do/tick", { method: "POST" })));

/** n bets, each with `perBet` payouts to strangers => one I-1 invariant alert per bet (a digest big enough to chunk).
 * n stays <= ~30: a tick has a hard ~45-subrequest budget (one view per bet), so volume comes from perBet instead. */
function strangerWorld(n: number, perBet = 1): World {
  const w = world();
  for (let i = 1; i <= n; i++) {
    w.bets.set(i, mkBet(i));
    for (let k = 0; k < perBet; k++) w.payouts.push({ id: i * 1000 + k, bet_id: i, token_id: USDC, receiver: `${"s".repeat(60)}${i}x${k}.testnet`, amount: "5", reason: "winner", attempts: 0, done: false, in_flight: false });
  }
  return w;
}

interface Log { level: string; text: string }
interface Run { tickJson: any; all: any[]; tg: { url: string; body: any }[]; logs: Log[] }
/** Runs `ticks` ticks of a fresh MonitorDO with globalThis.fetch + console captured. `tgRespond` overrides the Telegram answer. */
async function run(w: World, e: Record<string, string>, opts: { ticks?: number; tgRespond?: () => Response } = {}): Promise<Run> {
  const tg: Run["tg"] = []; const logs: Log[] = [];
  const base = outboundFetch(w);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    if (new URL(url).hostname === "api.telegram.org") { tg.push({ url, body: JSON.parse(String(init?.body)) }); if (opts.tgRespond) return opts.tgRespond(); }
    return base(input, init);
  }) as any;
  const orig: Record<string, any> = {};
  for (const lv of ["log", "info", "warn", "error"] as const) { orig[lv] = console[lv]; console[lv] = (...a: any[]) => { logs.push({ level: lv, text: a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") }); }; }
  const st = fakeDoStorage(); const clock = { ms: T0 };
  try {
    const d = new MonitorDO(st.ctx as any, e as any, () => clock.ms);
    const all: any[] = [];
    for (let i = 0; i < (opts.ticks ?? 1); i++) { all.push(await tick(d)); clock.ms += 60_000; }
    return { tickJson: all[all.length - 1], all, tg, logs };
  } finally { globalThis.fetch = realFetch; for (const lv of Object.keys(orig)) (console as any)[lv] = orig[lv]; st.close(); }
}
const warnsAbout = (logs: Log[], msg: string) => logs.filter((l) => (l.level === "warn" || l.level === "error") && l.text.includes(msg));

test("ALRT1a: token + chat id set => one sendMessage per <=3500-char chunk, chat id passed through", async () => {
  const r = await run(strangerWorld(25, 2), env());
  assert.equal(r.tickJson.ok, true);
  assert.ok(r.tickJson.sent.length >= 25);
  assert.ok(r.tg.length >= 2 && r.tg.length <= 3, `posts=${r.tg.length}`);
  for (const p of r.tg) { assert.ok(p.url.endsWith("/sendMessage")); assert.equal(String(p.body.chat_id), "opschat"); assert.ok(p.body.text.length <= 3500, `chunk ${p.body.text.length}`); }
  assert.ok(!r.tickJson.telegram_unconfigured);
  assert.equal(warnsAbout(r.logs, "telegram not configured").length, 0);
});

test("ALRT1a: a huge digest is capped at 3 posts (<=3500 chars each, truncation note on the last)", async () => {
  const r = await run(strangerWorld(30, 40), env());
  assert.equal(r.tg.length, 3);
  for (const p of r.tg.slice(0, 2)) assert.ok(p.body.text.length <= 3500);
  assert.ok(r.tg[2]!.body.text.includes("truncated"));
});

test("ALRT1a: small digest => exactly one post", async () => {
  const r = await run(strangerWorld(1), env());
  assert.equal(r.tg.length, 1); assert.equal(String(r.tg[0]!.body.chat_id), "opschat");
});

for (const [label, over] of [["token unset", { ALERT_TELEGRAM_BOT_TOKEN: undefined }], ["chat id unset", { ALERT_TELEGRAM_CHAT_ID: undefined }], ["both unset", { ALERT_TELEGRAM_BOT_TOKEN: undefined, ALERT_TELEGRAM_CHAT_ID: undefined }]] as const) {
  test(`ALRT1a: ${label} => zero Telegram fetches, exactly one structured 'telegram not configured' warning, telegram_unconfigured flag`, async () => {
    const r = await run(strangerWorld(3), env(over));
    assert.equal(r.tickJson.ok, true);
    assert.equal(r.tg.length, 0, "no fetch to api.telegram.org");
    assert.equal(r.tickJson.telegram_unconfigured, true);
    assert.ok(r.tickJson.sent.length >= 3, "alert work is still done");
    const w = warnsAbout(r.logs, "telegram not configured");
    assert.equal(w.length, 1, `warnings: ${w.length}`);
    assert.equal(w[0]!.level, "warn");
    const rec = JSON.parse(w[0]!.text);
    assert.equal(rec.msg, "telegram not configured");
    assert.equal(rec.alert_count, r.tickJson.sent.length);
    assert.ok(Array.isArray(rec.kinds) && rec.kinds.includes("invariant_violation"), JSON.stringify(rec.kinds));
    for (const l of r.logs) assert.ok(!l.text.includes("TESTTOKEN"), "token never logged");
  });
}

test("ALRT1a: unconfigured => one warning PER TICK, and none on a tick with no alerts (flag stays)", async () => {
  const r = await run(strangerWorld(2), env({ ALERT_TELEGRAM_BOT_TOKEN: undefined, ALERT_COOLDOWN_MS: "0" }), { ticks: 2 });
  assert.equal(warnsAbout(r.logs, "telegram not configured").length, 2);
  const q = await run(world(), env({ ALERT_TELEGRAM_BOT_TOKEN: undefined }));
  assert.equal(q.tickJson.telegram_unconfigured, true);
  assert.equal(warnsAbout(q.logs, "telegram not configured").length, 0);
  assert.equal(q.tg.length, 0);
});

test("ALRT1a: Telegram non-ok => logged error, tick completes ok, other alert work kept (ALERT log lines, dedupe state persisted)", async () => {
  const r = await run(strangerWorld(3), env(), { ticks: 2, tgRespond: () => new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 }) });
  assert.deepEqual(r.all.map((t) => t.ok), [true, true]);
  assert.ok(r.all[0].sent.length >= 3);
  assert.deepEqual(r.all[1].sent.filter((a: any) => a.kind === "invariant_violation"), [], "state persisted despite the delivery failure: cooldown dedupes the second tick");
  assert.ok(r.logs.filter((l) => l.text.includes("[ALERT:")).length >= 3, "alerts still logged");
  const errs = warnsAbout(r.logs, "telegram delivery failed");
  assert.ok(errs.length >= 1, "structured delivery error logged");
  assert.equal(errs[0]!.level, "error");
  assert.equal(JSON.parse(errs[0]!.text).msg, "telegram delivery failed");
  assert.equal(r.all[0].telegram_failed, true);
  for (const l of r.logs) assert.ok(!l.text.includes("TESTTOKEN"), "token never logged");
});

test("ALRT1a: Telegram fetch throwing does not fail the tick either", async () => {
  const r = await run(strangerWorld(2), env(), { tgRespond: () => { throw new Error("socket closed"); } });
  assert.equal(r.tickJson.ok, true);
  assert.ok(warnsAbout(r.logs, "telegram delivery failed").length >= 1);
});
