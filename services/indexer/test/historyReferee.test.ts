// IDXREF1 RED: GET /history?referee=<acct> -- exactly the bets whose CURRENT referee account == acct (D-FE14a).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildHistoryMulti } from "../src/board.js";
import { createServer } from "../src/server.js";
import type { TaggedBet } from "@praetorial/common/discovery.js";

const env = (o: any = {}) => ({ maker: "m.testnet", terms_hash: "h", stake_maker: "1", stake_taker: "1", maker_side: "YES", funding_deadline: 1, taker_allow: { Any: {} }, ...o });
const tb = (betId: number, over: any = {}, e: any = {}, confirmed?: boolean): TaggedBet =>
  ({ betId, contractId: "e.testnet", version: "v1", ...(confirmed === undefined ? {} : { confirmed }), bet: { envelope: env(e), created_at: 5, status: "Open", taker: null, outcome: null, ...over } } as any);
const ref = (a: string) => ({ referee: { account: a, mode: "Human" } });

// 1 AI-mode (no referee, and explicit null), 2 amended X->Y (current envelope.referee is Y), 3 referee is also maker,
// 4 open untaken human-mode bet for X, 5 taken human-mode for Y.
function fixture(): Map<string, TaggedBet> {
  return new Map([
    ["e.testnet:1", tb(1)],
    ["e.testnet:6", tb(6, {}, { referee: null })],
    ["e.testnet:2", tb(2, { status: "Taken", taker: "t.testnet", amend_count: 1 }, ref("y.testnet"))], // was x.testnet, amended to y.testnet
    ["e.testnet:3", tb(3, { status: "Taken", taker: "t.testnet" }, { maker: "x.testnet", ...ref("x.testnet") })],
    ["e.testnet:4", tb(4, {}, ref("x.testnet"))],
    ["e.testnet:5", tb(5, { status: "Taken", taker: "t.testnet" }, ref("y.testnet"))],
  ]);
}
const ids = (h: any[]) => h.map((e) => e.bet_id);

test("buildHistoryMulti(refereeId): exactly the bets whose current referee is that account", () => {
  assert.deepEqual(ids(buildHistoryMulti(fixture(), undefined, "x.testnet")), [3, 4]);
  assert.deepEqual(ids(buildHistoryMulti(fixture(), undefined, "y.testnet")), [2, 5]);
  assert.deepEqual(ids(buildHistoryMulti(fixture(), undefined, "nobody.testnet")), []);
});

test("amended referee X->Y: listed for Y, not for X (current referee counts)", () => {
  assert.ok(ids(buildHistoryMulti(fixture(), undefined, "y.testnet")).includes(2));
  assert.ok(!ids(buildHistoryMulti(fixture(), undefined, "x.testnet")).includes(2));
});

test("AI-mode bets (no / null referee) are never returned for any referee", () => {
  for (const a of ["x.testnet", "y.testnet", "m.testnet", "t.testnet"]) assert.ok(!ids(buildHistoryMulti(fixture(), undefined, a)).some((i) => i === 1 || i === 6));
});

test("referee who is also the maker is still listed; open untaken human-mode bet is included", () => {
  const h = buildHistoryMulti(fixture(), undefined, "x.testnet");
  assert.equal(h.find((e) => e.bet_id === 3)!.maker, "x.testnet");
  assert.equal(h.find((e) => e.bet_id === 4)!.status, "Open");
});

test("same entry shape as ?account= and redactUnconfirmed applies", () => {
  const bets = new Map([["e.testnet:7", tb(7, { status: "Settled", taker: "t.testnet", outcome: "YES" }, ref("x.testnet"), false)], ["e.testnet:8", tb(8, { status: "Settled", taker: "t.testnet", outcome: "NO" }, ref("x.testnet"), true)]]);
  const h = buildHistoryMulti(bets, undefined, "x.testnet");
  assert.equal(h[0].display_status, "settling, confirming"); assert.equal(h[0].outcome, null);
  assert.equal(h[1].display_status, "Settled"); assert.equal(h[1].outcome, "NO");
  assert.deepEqual(Object.keys(h[1]).sort(), Object.keys(buildHistoryMulti(bets, "t.testnet")[1]).sort());
  assert.deepEqual(h, buildHistoryMulti(bets, "t.testnet")); // same bets, identical entries
});

async function get(p: string) {
  const srv = createServer(fixture); await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try { const r = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}${p}`); return { status: r.status, ctype: r.headers.get("content-type"), json: await r.json() as any }; }
  finally { await new Promise<void>((r) => srv.close(() => r())); }
}

test("HTTP /history?referee= serves the filter; json content-type", async () => {
  const r = await get("/history?referee=y.testnet");
  assert.equal(r.status, 200); assert.equal(r.ctype, "application/json"); assert.deepEqual(ids(r.json), [2, 5]);
  assert.deepEqual(ids((await get("/history?referee=x.testnet")).json), [3, 4]);
});

test("HTTP: ?account= and ?referee= together -> 400", async () => {
  const r = await get("/history?account=m.testnet&referee=x.testnet");
  assert.equal(r.status, 400); assert.equal(typeof r.json.error, "string");
});

test("HTTP: invalid referee account id -> 400 (NEAR account id rules); empty referee -> 400", async () => {
  for (const bad of ["", "A.testnet", "x", "x..testnet", ".x.testnet", "x.testnet.", "x y.testnet", "a".repeat(65), "x%00.testnet"]) {
    assert.equal((await get(`/history?referee=${encodeURIComponent(bad)}`)).status, 400, `referee=${JSON.stringify(bad)}`);
  }
  assert.equal((await get("/history?referee=")).status, 400);
});

test("HTTP: unchanged ?account= and unfiltered /history behaviour", async () => {
  assert.deepEqual(ids((await get("/history?account=t.testnet")).json), [2, 3, 5]);
  assert.deepEqual(ids((await get("/history?account=m.testnet")).json), [1, 2, 4, 5, 6]);
  assert.equal((await get("/history")).json.length, 6);
});
