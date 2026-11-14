// STACK1 RED: indexer GET /health = {service, network, escrow_contract_id, git_sha, last_tick_at} (+ the existing ok/bets_cached), no secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { fakeD1, baseEnv } from "./helpers.js";
import { assertHealth } from "../../common/test/healthAssert.js";

const RPC_SECRET = "https://rpc.example/?apikey=SUPERSECRETRPCKEY123";
const env = (d1: unknown, extra: Record<string, any> = {}) => baseEnv(d1, { ESCROW_CONTRACTS: "", ESCROW_CONTRACT_ID: "escrow-x.testnet", NEAR_RPC_URL: RPC_SECRET, GIT_SHA: "abc1234", ...extra });
const get = (e: any) => worker.fetch(new Request("https://indexer.test/health"), e);

test("indexer /health: identity fields, last_tick_at null before first tick, existing ok/bets_cached kept, no env leak", async () => {
  const f = fakeD1();
  const body = await assertHealth(await get(env(f.d1)), { service: "indexer", network: "testnet", escrow: "escrow-x.testnet", sha: "abc1234", secrets: [RPC_SECRET, "SUPERSECRETRPCKEY123"], tick: null });
  assert.equal(body.ok, true); assert.equal(body.bets_cached, 0);
});

test("indexer /health: last_tick_at is the last tick run time from the existing D1 indexer_lock row", async () => {
  const f = fakeD1(); const T = 1_700_000_123_000;
  await f.d1.prepare("UPDATE indexer_lock SET last_ms = ? WHERE name = ?").bind(T, "tick").run();
  await assertHealth(await get(env(f.d1)), { service: "indexer", network: "testnet", escrow: "escrow-x.testnet", sha: "abc1234", secrets: [RPC_SECRET], tick: T });
});

test("indexer /health: git_sha is 'unknown' when no GIT_SHA var is injected", async () => {
  const f = fakeD1(); const b: any = await (await get(env(f.d1, { GIT_SHA: undefined }))).json();
  assert.equal(b.git_sha, "unknown");
});
