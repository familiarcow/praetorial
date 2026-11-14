import { test } from "node:test";
import assert from "node:assert/strict";
import { sendTestAlert, runTestAlertCli } from "../src/testAlert.js";
import { SECRET_MARK, testnetEnv, tmpDir, writeEnvFile, capture } from "./helpers.js";

const NOW = new Date("2026-11-08T12:00:00.000Z");
type Call = { url: string; body: any };
function mockFetch(calls: Call[], status = 200): typeof fetch {
  return (async (url: any, init: any) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return new Response("{}", { status }); }) as any;
}

test("log-only when Telegram unset: one log line with the exact message, no fetch", async () => {
  const calls: Call[] = []; const logs: string[] = [];
  const r = await sendTestAlert({ env: testnetEnv(), now: NOW, fetchImpl: mockFetch(calls), log: (m) => logs.push(m) });
  assert.equal(r.text, "praetorial ops test 2026-11-08T12:00:00.000Z testnet");
  assert.equal(calls.length, 0);
  assert.equal(logs.length, 1); assert.match(logs[0], /praetorial ops test 2026-11-08T12:00:00.000Z testnet/);
  assert.deepEqual(r.channels, [{ name: "log", status: "sent" }]);
  assert.equal(r.ok, true);
});

test("Telegram configured: exactly ONE send via the mocked fetch, to the chat id, containing the message", async () => {
  const calls: Call[] = []; const logs: string[] = [];
  const env = { ...testnetEnv(), NEAR_NETWORK_ID: "mainnet", ALERT_TELEGRAM_BOT_TOKEN: "123:tok", ALERT_TELEGRAM_CHAT_ID: "-100123" };
  const r = await sendTestAlert({ env, now: NOW, fetchImpl: mockFetch(calls), log: (m) => logs.push(m) });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/bot123:tok\/sendMessage$/);
  assert.equal(calls[0].body.chat_id, "-100123");
  assert.match(calls[0].body.text, /praetorial ops test 2026-11-08T12:00:00.000Z mainnet/);
  assert.deepEqual(r.channels.map((c) => c.status), ["sent", "sent"]);
  assert.ok(!logs.join("\n").includes("123:tok"));
});

test("Telegram rejection is reported as failed (not hidden), ok=false", async () => {
  const calls: Call[] = [];
  const env = { ...testnetEnv(), ALERT_TELEGRAM_BOT_TOKEN: "123:tok", ALERT_TELEGRAM_CHAT_ID: "1" };
  const r = await sendTestAlert({ env, now: NOW, fetchImpl: mockFetch(calls, 401), log: () => {}, sleepImpl: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.channels.find((c) => c.name === "telegram")?.status, "failed");
  assert.equal(r.channels.find((c) => c.name === "log")?.status, "sent");
});

test("dry-run: no fetch, no log send, lists channels that would fire", async () => {
  const calls: Call[] = []; const logs: string[] = [];
  const env = { ...testnetEnv(), ALERT_TELEGRAM_BOT_TOKEN: "123:tok", ALERT_TELEGRAM_CHAT_ID: "1" };
  const r = await sendTestAlert({ env, now: NOW, fetchImpl: mockFetch(calls), log: (m) => logs.push(m), dryRun: true });
  assert.equal(calls.length, 0); assert.equal(logs.length, 0);
  assert.deepEqual(r.channels, [{ name: "log", status: "would-fire" }, { name: "telegram", status: "would-fire" }]);
});

test("only one of the two Telegram vars set: telegram reported not-configured", async () => {
  const r = await sendTestAlert({ env: { ...testnetEnv(), ALERT_TELEGRAM_BOT_TOKEN: "123:tok" }, now: NOW, fetchImpl: mockFetch([]), log: () => {}, dryRun: true });
  assert.deepEqual(r.channels, [{ name: "log", status: "would-fire" }]);
});

test("CLI: --dry-run exit 0 prints channels, no secrets; usage errors exit 2; missing file exit 1", async () => {
  const d = tmpDir();
  const f = writeEnvFile(d, { ...testnetEnv(), ALERT_TELEGRAM_BOT_TOKEN: SECRET_MARK, ALERT_TELEGRAM_CHAT_ID: "-100123" });
  const c = capture();
  const calls: Call[] = [];
  assert.equal(await runTestAlertCli(["--env-file", f, "--dry-run"], c.io, { fetchImpl: mockFetch(calls), now: NOW }), 0);
  assert.match(c.text(), /telegram/); assert.ok(!c.text().includes(SECRET_MARK)); assert.equal(calls.length, 0);
  assert.equal(await runTestAlertCli([], capture().io, { fetchImpl: mockFetch(calls) }), 2);
  assert.equal(await runTestAlertCli(["--env-file", f, "--nope"], capture().io, { fetchImpl: mockFetch(calls) }), 2);
  assert.equal(await runTestAlertCli(["--env-file", d + "/none"], capture().io, { fetchImpl: mockFetch(calls) }), 1);
});

test("CLI: real-send path uses the injected fetch only (one call) and exits 0; 1 on failure", async () => {
  const d = tmpDir();
  const f = writeEnvFile(d, { ...testnetEnv(), ALERT_TELEGRAM_BOT_TOKEN: "123:tok", ALERT_TELEGRAM_CHAT_ID: "1" });
  const calls: Call[] = [];
  assert.equal(await runTestAlertCli(["--env-file", f], capture().io, { fetchImpl: mockFetch(calls), now: NOW }), 0);
  assert.equal(calls.length, 1);
  assert.equal(await runTestAlertCli(["--env-file", f], capture().io, { fetchImpl: mockFetch([], 400), now: NOW, sleepImpl: async () => {} }), 1);
});
