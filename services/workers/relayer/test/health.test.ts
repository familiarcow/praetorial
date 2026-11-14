// STACK1 RED: relayer GET /health is answered by the Worker itself (no DO call, no signing), no secret in the body.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { workerBindings, ESCROW, RELAYER_KEY } from "./helpers.js";
import { assertHealth } from "../../common/test/healthAssert.js";

test("relayer /health: identity fields only; relayer key and Telegram token never appear", async () => {
  const secrets = [RELAYER_KEY.toString(), "999999:RELAYERTELEGRAMTOKENSECRETVALUE", "-100777888"];
  const env: any = { ...workerBindings({ GIT_SHA: "aaa1111", TELEGRAM_BOT_TOKEN: secrets[1]!, RELAYER_ALERT_TELEGRAM_CHAT_ID: secrets[2]! }), RELAYER: { idFromName() { throw new Error("DO must not be touched by /health"); } } };
  await assertHealth(await worker.fetch(new Request("https://relayer.test/health"), env), { service: "relayer", network: "testnet", escrow: ESCROW, sha: "aaa1111", secrets, tick: "absent" });
});
