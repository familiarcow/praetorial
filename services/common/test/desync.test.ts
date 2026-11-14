// RED-first (theme: indexer/keeper desync after redeploy).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { discoverAllBetsMultiTolerant } from "../src/discovery.js";
import { parseEscrowContracts } from "../src/config.js";
import { NearClient } from "../src/nearClient.js";

const bet = (maker: string) => ({ envelope: { maker }, status: "Open", taker: null }) as any;

test("one dead/erroring contract must not blind discovery of the others", async () => {
  const client: any = {
    async view(contractId: string, _m: string, args: any) {
      if (contractId === "old.testnet") throw new Error("account does not exist");
      return args.bet_id === 1 ? bet("m.testnet") : null;
    },
  };
  const r = await discoverAllBetsMultiTolerant(client, [{ id: "old.testnet", version: "v1" }, { id: "new.testnet", version: "v2" }], {});
  assert.deepEqual([...r.bets.keys()], ["new.testnet:1"]);
  assert.deepEqual(r.failed.map((f) => f.contractId), ["old.testnet"]);
  assert.equal(r.newMaxIds["new.testnet"], 1);
});

test("duplicate contract ids in ESCROW_CONTRACTS are rejected (silent version relabel)", () => {
  const prev = process.env.ESCROW_CONTRACTS;
  process.env.ESCROW_CONTRACTS = "a.testnet@v1,a.testnet@v2";
  try {
    assert.throws(() => parseEscrowContracts(), /duplicate/i);
  } finally {
    if (prev === undefined) delete process.env.ESCROW_CONTRACTS; else process.env.ESCROW_CONTRACTS = prev;
  }
});

test("view calls read at finality=final by default (no optimistic state that may reorg away)", async () => {
  const seen: any[] = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const j = JSON.parse(body);
      seen.push(j.params);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: { result: Array.from(Buffer.from("null")), logs: [] } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const c = new NearClient({ networkId: "testnet", nodeUrl: url, rpcUrls: [url] } as any, { accountId: "v.testnet", privateKey: "" });
    await c.view("e.testnet", "get_bet", { bet_id: 1 });
    assert.equal(seen[0].finality, "final");
  } finally {
    srv.close();
  }
});
