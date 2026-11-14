// DOCSREV: `verify-bet --network mainnet --bet <id>` for a bet that doesn't exist (bet_count was 0 at launch) crashed with
// "Cannot read properties of null (reading 'envelope')". It must say plainly that the bet was not found.
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectLive } from "../src/live.js";

/** A JSON-RPC stub: every call_function view answers from VIEWS (get_bet -> null, as the mainnet escrow does for a missing id). */
const VIEWS: Record<string, unknown> = { resolver_keys: ["aa", "bb", "cc"], get_bet: null, outlayer_config: {}, is_shutdown: false };
const fetchStub = (async (_url: string, init: { body: string }) => {
  const req = JSON.parse(init.body);
  const p = req.params ?? {};
  const result = p.request_type === "call_function"
    ? { result: [...Buffer.from(JSON.stringify(VIEWS[p.method_name] ?? null))] }
    : { code_hash: "11111111111111111111111111111111" };
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { status: 200, headers: { "content-type": "application/json" } });
}) as unknown as typeof fetch;

test("DOCSREV: live collect of a bet id that doesn't exist fails with 'bet N not found', not a TypeError", async () => {
  await assert.rejects(
    collectLive("mainnet", "bets.praetorial.near", 1, { fetch: fetchStub, sleep: async () => {} }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.doesNotMatch(e.message, /Cannot read properties/);
      assert.match(e.message, /bet 1 not found on bets\.praetorial\.near/);
      return true;
    },
  );
});
