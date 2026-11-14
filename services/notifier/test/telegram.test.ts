// RED-first: Telegram 2nd channel (launch checklist: "Notifier: 2nd
// channel (Telegram) for bets >= $500"). Mocked fetch only -- no real
// network call, no real bot token, testnet-only / no spend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramChannel } from "../src/telegram.js";

const FAKE_TOKEN = "123456:FAKE-NOT-A-REAL-TOKEN-abcDEF";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

test("sends the message once on a 200 OK response", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return jsonResponse(200, { ok: true });
  }) as unknown as typeof fetch;
  const channel = new TelegramChannel({ fetchImpl, botToken: FAKE_TOKEN, sleepImpl: async () => {} });
  const ok = await channel.send("987654321", "Bet #1: settled\nhttps://example.test/bet/1");
  assert.equal(ok, true);
  assert.equal(calls, 1);
});

test("retries on 429 and succeeds on the next attempt", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return jsonResponse(429, { ok: false, error_code: 429 });
    return jsonResponse(200, { ok: true });
  }) as unknown as typeof fetch;
  const channel = new TelegramChannel({ fetchImpl, botToken: FAKE_TOKEN, sleepImpl: async () => {} });
  const ok = await channel.send("987654321", "Bet #1: settled\nhttps://example.test/bet/1");
  assert.equal(ok, true);
  assert.equal(calls, 2);
});

test("retries on 5xx then gives up after maxAttempts and logs without the token or chat id", async () => {
  let calls = 0;
  const logs: string[] = [];
  const fetchImpl = (async () => {
    calls++;
    return jsonResponse(500, { ok: false });
  }) as unknown as typeof fetch;
  const channel = new TelegramChannel({
    fetchImpl,
    botToken: FAKE_TOKEN,
    maxAttempts: 3,
    sleepImpl: async () => {},
    log: (msg: string) => logs.push(msg),
  });
  const ok = await channel.send("987654321", "Bet #1: settled\nhttps://example.test/bet/1");
  assert.equal(ok, false);
  assert.equal(calls, 3);
  assert.equal(logs.length, 1);
  for (const line of logs) {
    assert.ok(!line.includes(FAKE_TOKEN), "log must never contain the bot token");
    assert.ok(!line.includes("987654321"), "log must never contain the chat id");
  }
});

test("a non-retryable 4xx fails fast without retrying", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return jsonResponse(400, { ok: false, description: "chat not found" });
  }) as unknown as typeof fetch;
  const channel = new TelegramChannel({ fetchImpl, botToken: FAKE_TOKEN, maxAttempts: 5, sleepImpl: async () => {} });
  const ok = await channel.send("987654321", "Bet #1: settled\nhttps://example.test/bet/1");
  assert.equal(ok, false);
  assert.equal(calls, 1);
});

test("the request URL carries the token but logs never do, across every path", async () => {
  const seenUrls: string[] = [];
  const logs: string[] = [];
  const fetchImpl = (async (url: any) => {
    seenUrls.push(String(url));
    return jsonResponse(403, { ok: false });
  }) as unknown as typeof fetch;
  const channel = new TelegramChannel({
    fetchImpl,
    botToken: FAKE_TOKEN,
    sleepImpl: async () => {},
    log: (msg: string) => logs.push(msg),
  });
  await channel.send("987654321", "text");
  assert.ok(seenUrls.some((u) => u.includes(FAKE_TOKEN)), "the bot API call must be authenticated with the token");
  for (const line of logs) assert.ok(!line.includes(FAKE_TOKEN));
});
