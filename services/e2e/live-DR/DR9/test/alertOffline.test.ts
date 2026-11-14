// DR9 drill 2, OFFLINE half only (no network, fake token): a failing NEAR AI run result from a fake/revoked TEST key produces the MON4 alert, and the Telegram
// channel formats + posts it to the operator chat with the injected fetch. This proves alert GENERATION and request shape. It does NOT prove delivery: the real
// drill is NOT-DRILLED until ALERT_TELEGRAM_BOT_TOKEN exists in $PRAETORIAL_SECRETS_DIR/praetorial-alerts.env (ALRT1, familiarcow step).
import { test } from "node:test";
import assert from "node:assert/strict";
import { alertForRunResult } from "../../../../monitor/src/opsAlertsCore.js";
import { TelegramAlertChannel } from "../../../../monitor/src/alertChannel.js";
import { TelegramChannel } from "../../../../notifier/src/telegram.js";

const run = (status: number, body: string) => ({ output: { run_diagnostics: [{ http_status: status, error: body }] } });

test("fake TEST key rejected with HTTP 402 / credit body -> MON4 alert generated and sent to the operator chat via the Bot API (mock fetch, fake token)", async () => {
  const a = alertForRunResult("drill9-fake-test-key", run(402, "insufficient credits"));
  assert.ok(a, "alert generated");
  assert.equal(a!.kind, "nearai_credit_exhausted"); assert.equal(a!.severity, "critical");
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init: any) => { calls.push({ url, body: String(init?.body ?? "") }); return new Response("{\"ok\":true}", { status: 200 }); }) as unknown as typeof fetch;
  await new TelegramAlertChannel(new TelegramChannel({ fetchImpl, botToken: "FAKE:TOKEN", sleepImpl: async () => {}, log: () => {} }), "123456").send(a!);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/botFAKE:TOKEN/sendMessage");
  assert.match(calls[0].body, /NEAR AI credits exhausted/); assert.match(calls[0].body, /123456/);
});

test("429 never alerts (rate limit is not a credit failure)", () => {
  assert.equal(alertForRunResult("drill9", run(429, "insufficient credits")), null);
});

// FINDING (DR9): a REVOKED/invalid key is normally an HTTP 401 with a body like "invalid api key"; the current MON4 rule (402, or a 4xx whose body names
// insufficient/credit/quota) does NOT alert on that. This test pins today's behavior so a rule change is a conscious edit; see README finding F-DR9-1.
test("FINDING F-DR9-1: HTTP 401 'invalid api key' (revoked key) currently produces NO MON4 alert", () => {
  assert.equal(alertForRunResult("drill9-revoked-key", run(401, "invalid api key")), null);
});
