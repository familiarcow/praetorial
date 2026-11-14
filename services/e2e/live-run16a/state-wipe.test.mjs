// Sandbox tests for the throwaway state-wipe wasm (D-E2E1a). Run: node --test state-wipe.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setupSandbox } from "../../../chaos/harness.mjs";

const WIPE = new URL("state-wipe/target/wasm32-unknown-unknown/release/state_wipe.wasm", import.meta.url).pathname;

async function viewState(ctx, id) {
  const r = await ctx.near.connection.provider.query({ request_type: "view_state", finality: "optimistic", account_id: id, prefix_base64: "" });
  return r.values;
}
async function withEscrowState() {
  const ctx = await setupSandbox();
  const before = await viewState(ctx, ctx.escrow.accountId);
  assert.ok(before.length > 0, "escrow has real state to wipe");
  await ctx.escrow.inner.deployContract(fs.readFileSync(WIPE)); // keeps state
  return { ctx, before };
}

test("non-self caller is rejected and nothing is removed", async () => {
  const { ctx, before } = await withEscrowState();
  try {
    await assert.rejects(() => ctx.maker.call(ctx.escrow.accountId, "wipe", { keys: before.map((v) => v.key) }), /unreachable|panicked|only the account/i /* the guard panics; sandbox surfaces it as a wasm trap. Same call from self succeeds in the next test */);
    assert.equal((await viewState(ctx, ctx.escrow.accountId)).length, before.length);
  } finally { await ctx.teardown(); }
});

test("self call removes all given keys (view_state returns 0)", async () => {
  const { ctx, before } = await withEscrowState();
  try {
    await ctx.escrow.call(ctx.escrow.accountId, "wipe", { keys: before.map((v) => v.key) }, { gas: 200_000_000_000_000n });
    assert.equal((await viewState(ctx, ctx.escrow.accountId)).length, 0);
  } finally { await ctx.teardown(); }
});
