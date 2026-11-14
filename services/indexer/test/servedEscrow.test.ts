// IDX1 RED (node host): the indexer serves and ingests ONLY the configured escrow (ESCROW_CONTRACT_ID); other contracts' cached
// bets are never served on any read endpoint. Same rule as the Worker host (workers/indexer/test/servedEscrow.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { TaggedBet } from "@praetorial/common/discovery.js";
import { createServer } from "../src/server.js";
import { servedContracts, onlyServed } from "../src/served.js";

const OLD = "old.testnet", CUR = "cur.testnet";
const mk = (contractId: string, betId: number, over: any = {}, env: any = {}): [string, TaggedBet] => [`${contractId}:${betId}`, {
  contractId, betId, version: "v1",
  bet: { envelope: { maker: "m.testnet", terms_hash: "h", stake_maker: "1", stake_taker: "1", maker_side: "YES", funding_deadline: 1, taker_allow: { Any: {} }, ...env }, created_at: 1, status: "Open", taker: null, outcome: null, ...over } as any,
}];
const bets = new Map<string, TaggedBet>([
  mk(CUR, 1), mk(CUR, 2, { status: "Taken", taker: "t.testnet" }, { referee: { account: "x.testnet", mode: "Human" } }),
  mk(OLD, 1), mk(OLD, 2, { status: "Taken", taker: "t.testnet" }, { referee: { account: "x.testnet", mode: "Human" } }), mk(OLD, 7, {}, { maker: "olduser.testnet" }),
]);
const gov = new Map<string, any[]>([[OLD, [{ contract_id: OLD, kind: "guardian" }]], [CUR, [{ contract_id: CUR, kind: "guardian" }]]]);

test("servedContracts: ESCROW_CONTRACT_ID wins over ESCROW_CONTRACTS (version label kept); unset -> unchanged", () => {
  assert.deepEqual(servedContracts([{ id: OLD, version: "v1" }, { id: CUR, version: "v2" }], CUR), [{ id: CUR, version: "v2" }]);
  assert.deepEqual(servedContracts([{ id: OLD, version: "v1" }], CUR), [{ id: CUR, version: "v1" }]);
  assert.deepEqual(servedContracts([{ id: OLD, version: "v1" }, { id: CUR, version: "v2" }], undefined), [{ id: OLD, version: "v1" }, { id: CUR, version: "v2" }]);
  assert.deepEqual(servedContracts([{ id: OLD, version: "v1" }], ""), [{ id: OLD, version: "v1" }]);
  assert.deepEqual([...onlyServed(bets, [CUR]).keys()], [`${CUR}:1`, `${CUR}:2`]);
});

test("node server: every read endpoint hides other-contract rows and still serves the current escrow", async () => {
  const srv = createServer(() => bets, () => gov, [CUR]); await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const j = async (p: string) => (await fetch(base + p)).json() as Promise<any>;
  const keys = (rows: any[]) => rows.map((e) => `${e.contract_id}:${e.bet_id}`);
  try {
    assert.deepEqual(keys(await j("/offers")), [`${CUR}:1`]);
    assert.deepEqual(keys(await j("/history")), [`${CUR}:1`, `${CUR}:2`]);
    assert.deepEqual(keys(await j("/history?account=t.testnet")), [`${CUR}:2`]);
    assert.deepEqual(keys(await j("/history?account=olduser.testnet")), []);
    assert.deepEqual(keys(await j("/history?referee=x.testnet")), [`${CUR}:2`]);
    assert.equal(await j("/bet?bet_id=7"), null);
    assert.equal(await j(`/bet?bet_id=1&contract_id=${OLD}`), null);
    assert.equal((await j("/bet?bet_id=1")).contractId, CUR);
    assert.deepEqual((await j("/governance")).map((e: any) => e.contract_id), [CUR]);
    assert.equal((await j("/health")).bets_cached, 2);
  } finally { await new Promise<void>((r) => srv.close(() => r())); }
});
