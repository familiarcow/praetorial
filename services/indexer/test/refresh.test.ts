// RED-first (theme: desync). Indexer cache vs redeploy / lag / lying RPC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshBets } from "../src/refresh.js";
import { buildOpenOffersBoardMulti, buildHistoryMulti } from "../src/board.js";

function bet(over: any = {}): any {
  return { envelope: { maker: "m.testnet", terms_hash: "h1", stake_maker: "1", stake_taker: "1", maker_side: "YES", funding_deadline: 1, taker_allow: { Any: {} } }, created_at: 5, status: "Open", taker: null, outcome: null, ...over };
}
const chainClient = (chain: Record<string, Record<number, any> | "dead">): any => ({
  async view(c: string, _m: string, a: any) {
    const t = chain[c];
    if (t === "dead") throw new Error("rpc down");
    return t?.[a.bet_id] ?? null;
  },
});
const C = (id: string, version = "v1") => ({ id, version });

test("redeploy to same account (state reset): ghost bets from the old deployment must vanish from board/history", async () => {
  const oldChain = { "e.testnet": { 1: bet({ envelope: { ...bet().envelope, maker: "oldmaker.testnet" } }), 2: bet(), 3: bet() } };
  const r1 = await refreshBets(chainClient(oldChain), [C("e.testnet")], new Map(), {});
  assert.equal(buildOpenOffersBoardMulti(r1.bets).length, 3);
  const newChain = { "e.testnet": { 1: bet({ created_at: 99, envelope: { ...bet().envelope, maker: "newmaker.testnet", terms_hash: "h9" } }) } };
  const r2 = await refreshBets(chainClient(newChain), [C("e.testnet")], r1.bets, r1.maxIds);
  assert.deepEqual(buildOpenOffersBoardMulti(r2.bets).map((o) => o.bet_id), [1]);
  assert.equal(buildHistoryMulti(r2.bets, "oldmaker.testnet").length, 0); // also protects relayer bettor lookup
});

test("one contract's RPC failure keeps ITS previous entries and still refreshes the others", async () => {
  const r1 = await refreshBets(chainClient({ "a.testnet": { 1: bet() }, "b.testnet": { 1: bet() } }), [C("a.testnet"), C("b.testnet", "v2")], new Map(), {});
  const r2 = await refreshBets(
    chainClient({ "a.testnet": "dead", "b.testnet": { 1: bet({ status: "Taken", taker: "t.testnet" }), 2: bet() } }),
    [C("a.testnet"), C("b.testnet", "v2")], r1.bets, r1.maxIds,
  );
  assert.deepEqual(r2.failed.map((f) => f.contractId), ["a.testnet"]);
  assert.ok(r2.bets.has("a.testnet:1"));
  assert.equal(r2.bets.get("b.testnet:1")!.bet.status, "Taken");
  assert.ok(r2.bets.has("b.testnet:2"));
});

test("lagging/lying RPC cannot regress a terminal bet or flip its outcome (same bet identity)", async () => {
  const settled = bet({ status: "Settled", taker: "t.testnet", outcome: "YES" });
  const r1 = await refreshBets(chainClient({ "e.testnet": { 1: settled } }), [C("e.testnet")], new Map(), {});
  const lagging = bet({ status: "Taken", taker: "t.testnet" });
  const r2 = await refreshBets(chainClient({ "e.testnet": { 1: lagging } }), [C("e.testnet")], r1.bets, r1.maxIds);
  assert.equal(r2.bets.get("e.testnet:1")!.bet.status, "Settled");
  const lying = bet({ status: "Settled", taker: "t.testnet", outcome: "NO" });
  const r3 = await refreshBets(chainClient({ "e.testnet": { 1: lying } }), [C("e.testnet")], r2.bets, r2.maxIds);
  assert.equal(r3.bets.get("e.testnet:1")!.bet.outcome, "YES");
});

test("a bet that transiently disappears (lagging node returns null) is kept, not deleted, while the contract still has higher ids", async () => {
  const r1 = await refreshBets(chainClient({ "e.testnet": { 1: bet(), 2: bet(), 3: bet() } }), [C("e.testnet")], new Map(), {});
  const r2 = await refreshBets(chainClient({ "e.testnet": { 1: bet(), 3: bet() } }), [C("e.testnet")], r1.bets, r1.maxIds);
  assert.ok(r2.bets.has("e.testnet:2"));
});

// BLOCKED-by-design regression: a merely shorter read (lagging node that has not
// seen the newest bets) is NOT treated as a redeploy, so cached newer bets survive.
test("lagging node returning a shorter list does not drop cached newest bets", async () => {
  const r1 = await refreshBets(chainClient({ "e.testnet": { 1: bet(), 2: bet(), 3: bet() } }), [C("e.testnet")], new Map(), {});
  const r2 = await refreshBets(chainClient({ "e.testnet": { 1: bet() } }), [C("e.testnet")], r1.bets, r1.maxIds);
  assert.ok(r2.bets.has("e.testnet:3"));
});
