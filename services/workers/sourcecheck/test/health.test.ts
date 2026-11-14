// STACK1 RED: sourcecheck GET /health (answered before any config/limiter work), no attest key / token in the body.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { assertHealth } from "../../common/test/healthAssert.js";

test("sourcecheck /health: identity fields only; attest key, Telegram token and chat id never appear", async () => {
  const secrets = ["ed25519:ATTESTSECRETKEYMATERIAL0123456789", "888888:SOURCECHECKTELEGRAMTOKENSECRET", "-100555666"];
  const env: any = {
    NEAR_NETWORK_ID: "testnet", NEAR_RPC_URL: "https://test.rpc.fastnear.com", ESCROW_CONTRACT_ID: "escrow-s.testnet", OUTLAYER_CONTRACT_ID: "outlayer.testnet", ATTEST_ACCOUNT_ID: "attest.testnet",
    SOURCECHECK_ATTEST_PRIVATE_KEY: secrets[0], TELEGRAM_BOT_TOKEN: secrets[1], SOURCECHECK_ALERT_TELEGRAM_CHAT_ID: secrets[2], GIT_SHA: "bbb2222",
    LIMITER: { idFromName() { throw new Error("limiter must not be touched by /health"); } },
  };
  await assertHealth(await worker.fetch(new Request("https://sc.test/health"), env), { service: "sourcecheck", network: "testnet", escrow: "escrow-s.testnet", sha: "bbb2222", secrets, tick: "absent" });
});

test("sourcecheck: only GET /health is the health route (a POST still reaches the source-check path)", async () => {
  const env: any = { NEAR_NETWORK_ID: "testnet", LIMITER: {} }; // misconfigured on purpose: existing behaviour is a 500, not a health body
  const r = await worker.fetch(new Request("https://sc.test/health", { method: "POST", body: "{}" }), env);
  assert.equal(r.status, 500);
});
