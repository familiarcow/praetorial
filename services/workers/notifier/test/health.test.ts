// STACK1 RED: notifier GET /health (private Worker, reached over its service binding); no contact key / token in the body.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { NotifierDO } from "../src/index.js";
import { fakeDoStorage, ESC } from "../../monitor/test/helpers.js";
import { assertHealth, nsOf } from "../../common/test/healthAssert.js";

const KEY = "ab".repeat(32), TOKEN = "123456:NOTIFIERTELEGRAMTOKENSECRETVALUE";
test("notifier /health: identity fields only; contact key and bot token never appear", async () => {
  const st = fakeDoStorage();
  const env: any = { NEAR_NETWORK_ID: "testnet", ESCROW_CONTRACT_ID: ESC, INTENTS_CONTRACT_ID: "intents.testnet", NOTIFIER_CONTACT_KEY: KEY, TELEGRAM_BOT_TOKEN: TOKEN, GIT_SHA: "ccc3333" };
  env.NOTIFIER = nsOf(new NotifierDO(st.ctx as any, env));
  await assertHealth(await worker.fetch(new Request("https://notifier.svc/health"), env), { service: "notifier", network: "testnet", escrow: ESC, sha: "ccc3333", secrets: [KEY, TOKEN], tick: "absent" });
  st.close();
});
