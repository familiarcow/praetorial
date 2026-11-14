// RED-first: alert delivery channels. Default posture is log-only/
// dry-run (no network, ever, unless explicitly configured) -- mirrors
// the rest of this repo ("alerts are a convenience, never load-bearing").
// Telegram delivery reuses notifier/src/telegram.ts's TelegramChannel
// verbatim against a mocked fetch -- no real network call here either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LogOnlyAlertChannel, TelegramAlertChannel, MultiAlertChannel, type AlertChannel } from "../src/alertChannel.js";
import { TelegramChannel } from "../../notifier/src/telegram.js";
import type { Alert } from "../src/alerts.js";

const SAMPLE_ALERT: Alert = {
  key: "k1",
  kind: "invariant_violation",
  severity: "critical",
  message: "I-1 violation on bet #42 (escrow.testnet)",
  detail: "payout id=5 receiver=attacker.testnet not allowed",
};

test("LogOnlyAlertChannel: never calls any network, just logs via the injected logger", async () => {
  const logs: string[] = [];
  const channel = new LogOnlyAlertChannel((msg: string) => logs.push(msg));
  await channel.send(SAMPLE_ALERT);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /critical/);
  assert.match(logs[0], /I-1 violation on bet #42/);
  assert.match(logs[0], /payout id=5/);
});

test("LogOnlyAlertChannel: defaults to console.log when no logger is injected", async () => {
  const channel = new LogOnlyAlertChannel();
  // Just assert it doesn't throw -- default logger path.
  await assert.doesNotReject(() => channel.send(SAMPLE_ALERT));
});

test("TelegramAlertChannel: forwards to the operator chat id via TelegramChannel.send", async () => {
  const calls: { chatId: string; text: string }[] = [];
  const fetchImpl = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
  const telegram = new TelegramChannel({ fetchImpl, botToken: "FAKE:TOKEN", sleepImpl: async () => {} });
  const originalSend = telegram.send.bind(telegram);
  telegram.send = async (chatId: string, text: string) => {
    calls.push({ chatId, text });
    return originalSend(chatId, text);
  };
  const channel = new TelegramAlertChannel(telegram, "operator-chat-id");
  await channel.send(SAMPLE_ALERT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chatId, "operator-chat-id");
  assert.match(calls[0].text, /CRITICAL/);
  assert.match(calls[0].text, /I-1 violation on bet #42/);
});

test("MultiAlertChannel: fans one alert out to every configured channel", async () => {
  const received: string[] = [];
  const makeChannel = (name: string): AlertChannel => ({
    async send() {
      received.push(name);
    },
  });
  const channel = new MultiAlertChannel([makeChannel("a"), makeChannel("b")]);
  await channel.send(SAMPLE_ALERT);
  assert.deepEqual(received, ["a", "b"]);
});

test("MultiAlertChannel: one channel throwing never blocks the others", async () => {
  const received: string[] = [];
  const failing: AlertChannel = {
    async send() {
      throw new Error("boom");
    },
  };
  const ok: AlertChannel = {
    async send() {
      received.push("ok");
    },
  };
  const channel = new MultiAlertChannel([failing, ok]);
  await assert.doesNotReject(() => channel.send(SAMPLE_ALERT));
  assert.deepEqual(received, ["ok"]);
});
