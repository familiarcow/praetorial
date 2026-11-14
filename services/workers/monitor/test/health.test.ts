// STACK1 RED: monitor GET /health (private Worker, over its service binding): last_tick_at = the DO state's lastTickMs (null before the first tick).
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { MonitorDO } from "../src/index.js";
import { SqlKv } from "../../common/src/tickKit.js";
import { fakeDoStorage, ESC } from "./helpers.js";
import { assertHealth, nsOf } from "../../common/test/healthAssert.js";

const TOKEN = "777777:MONITORTELEGRAMTOKENSECRETVALUE", CHAT = "-100999111";
const mk = () => {
  const st = fakeDoStorage();
  const env: any = { NEAR_NETWORK_ID: "testnet", ESCROW_CONTRACT_ID: ESC, INTENTS_CONTRACT_ID: "intents.testnet", ALERT_TELEGRAM_BOT_TOKEN: TOKEN, ALERT_TELEGRAM_CHAT_ID: CHAT, GIT_SHA: "ddd4444" };
  env.MONITOR = nsOf(new MonitorDO(st.ctx as any, env));
  return { st, env };
};
const expect = (tick: null | number) => ({ service: "monitor", network: "testnet", escrow: ESC, sha: "ddd4444", secrets: [TOKEN, CHAT], tick });

test("monitor /health: last_tick_at null before the first tick; no token / chat id leak", async () => {
  const { st, env } = mk();
  await assertHealth(await worker.fetch(new Request("https://monitor.svc/health"), env), expect(null));
  st.close();
});

test("monitor /health: last_tick_at is the last tick run time already stored in the DO state", async () => {
  const { st, env } = mk(); const T = 1_700_000_456_000;
  new SqlKv(st.ctx.storage.sql, "monitor_state").set("state", { lastTickMs: T });
  await assertHealth(await worker.fetch(new Request("https://monitor.svc/health"), env), expect(T));
  st.close();
});
