// STACK1 RED: registry GET /health = {service, network, registry_id, git_sha}; existing {ok:true} caller keeps working; no env leak.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { assertHealth } from "../../common/test/healthAssert.js";

const RPC_SECRET = "https://rpc.example/?apikey=SUPERSECRETRPCKEY456";
const env = (extra: Record<string, unknown> = {}): any => ({ REGISTRY_DB: { prepare() { throw new Error("health must not touch D1"); } }, NEAR_NETWORK_ID: "testnet", REGISTRY_ID: "registry.test.testnet", REGISTRY_CORS_ORIGINS: "https://app.example", NEAR_RPC_URL: RPC_SECRET, GIT_SHA: "def5678", ...extra });

test("registry /health: service/network/registry_id/git_sha, ok kept, no escrow id, no env leak", async () => {
  const body = await assertHealth(await handle(new Request("https://registry.test/health"), env()), { service: "registry", network: "testnet", registryId: "registry.test.testnet", sha: "def5678", secrets: [RPC_SECRET, "SUPERSECRETRPCKEY456", "https://app.example"], tick: "absent" });
  assert.equal(body.ok, true);
});
