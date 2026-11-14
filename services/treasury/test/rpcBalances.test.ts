// RED -> GREEN: real balance readers for D-ECON2 follow-up (1).
// Reads the treasury/fee account's native NEAR balance (view_account)
// and its NEAR Intents multi-token balances (mt_batch_balance_of on
// the intents contract), via the SHARED services/common/src/rpc.ts
// PacedRpcClient. Every test here mocks fetchImpl on a real
// PacedRpcClient -- no network call is ever made, and no testnet or
// mainnet RPC endpoint is contacted.
//
// Method shapes verified against the public docs:
// https://docs.near-intents.org/integration/verifier-contract/deposits-and-withdrawals/balances
// (mt_batch_balance_of request/response shape, NEP-245) and NEAR's
// own JSON-RPC `query`/`view_account` (https://docs.near.org/api/rpc/contracts#view-account).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PacedRpcClient } from "@praetorial/common/rpc.js";
import {
  getNearBalanceYocto,
  getIntentsMultiTokenBalances,
  RpcFeeBalanceReader,
  RpcFloatBalanceReader,
} from "../src/rpcBalances.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function mockClient(handler: (method: string, params: any) => unknown): PacedRpcClient {
  const fetchImpl = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    const result = handler(body.method, body.params);
    return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result });
  }) as unknown as typeof fetch;
  return new PacedRpcClient({ urls: ["https://mock.example.com"], fetchImpl, sleepImpl: async () => {} });
}

test("getNearBalanceYocto parses amount from view_account", async () => {
  const client = mockClient((method, params) => {
    assert.equal(method, "query");
    assert.equal(params.request_type, "view_account");
    assert.equal(params.account_id, "fees.praetorial-dev-1101.near");
    return { amount: "123456789000000000000000", block_height: 1, block_hash: "x" };
  });
  const balance = await getNearBalanceYocto(client, "fees.praetorial-dev-1101.near");
  assert.equal(balance, 123456789000000000000000n);
});

test("getNearBalanceYocto surfaces a clear error on RPC error field", async () => {
  const fetchImpl = (async () =>
    jsonResponse(200, { jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } })) as unknown as typeof fetch;
  const client = new PacedRpcClient({ urls: ["https://mock.example.com"], fetchImpl, sleepImpl: async () => {} });
  await assert.rejects(
    () => getNearBalanceYocto(client, "nobody.near"),
    (err: any) => {
      assert.match(err.message, /nobody\.near/);
      assert.match(err.message, /UNKNOWN_ACCOUNT/);
      return true;
    },
  );
});

test("getIntentsMultiTokenBalances sends mt_batch_balance_of with base64 args and parses the byte-array response", async () => {
  const tokenIds = ["nep141:wrap.near", "nep141:usdc.near"];
  const client = mockClient((method, params) => {
    assert.equal(params.request_type, "call_function");
    assert.equal(params.account_id, "intents.near");
    assert.equal(params.method_name, "mt_batch_balance_of");
    const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
    assert.deepEqual(args, { account_id: "fees.praetorial-dev-1101.near", token_ids: tokenIds });
    const payload = JSON.stringify(["3000004000004000006", "10"]);
    return { result: Array.from(Buffer.from(payload, "utf8")), logs: [] };
  });
  const balances = await getIntentsMultiTokenBalances(client, "intents.near", "fees.praetorial-dev-1101.near", tokenIds);
  assert.deepEqual(balances, [3000004000004000006n, 10n]);
});

test("getIntentsMultiTokenBalances returns [] for an empty token list without calling the RPC", async () => {
  let called = false;
  const client = mockClient(() => {
    called = true;
    return { result: [], logs: [] };
  });
  const balances = await getIntentsMultiTokenBalances(client, "intents.near", "fees.praetorial-dev-1101.near", []);
  assert.deepEqual(balances, []);
  assert.equal(called, false);
});

test("getIntentsMultiTokenBalances throws if the response length doesn't match the requested token ids", async () => {
  const client = mockClient(() => ({ result: Array.from(Buffer.from(JSON.stringify(["1"]), "utf8")), logs: [] }));
  await assert.rejects(
    () => getIntentsMultiTokenBalances(client, "intents.near", "fees.praetorial-dev-1101.near", ["nep141:a.near", "nep141:b.near"]),
    /2 requested token ids/,
  );
});

test("RpcFeeBalanceReader zips token ids with their mt_batch_balance_of amounts into AssetBalance[]", async () => {
  const tokenIds = ["nep141:usdc.near", "nep141:usdt.near"];
  const client = mockClient(() => ({ result: Array.from(Buffer.from(JSON.stringify(["500", "0"]), "utf8")), logs: [] }));
  const reader = new RpcFeeBalanceReader(client, "intents.near", "fees.praetorial-dev-1101.near", tokenIds);
  const balances = await reader.getFeeBalances();
  assert.deepEqual(balances, [
    { assetId: "nep141:usdc.near", amount: 500n },
    { assetId: "nep141:usdt.near", amount: 0n },
  ]);
});

test("RpcFloatBalanceReader reads both relayer and keeper native NEAR balances via view_account", async () => {
  const seen: string[] = [];
  const client = mockClient((_method, params) => {
    seen.push(params.account_id);
    const amounts: Record<string, string> = {
      "relayer.praetorial-dev-1101.near": "1000000000000000000000000",
      "keeper.praetorial-dev-1101.near": "2000000000000000000000000",
    };
    return { amount: amounts[params.account_id] };
  });
  const reader = new RpcFloatBalanceReader(client, "relayer.praetorial-dev-1101.near", "keeper.praetorial-dev-1101.near");
  const floats = await reader.getFloatBalances();
  assert.deepEqual(floats, { relayer: 1000000000000000000000000n, keeper: 2000000000000000000000000n });
  assert.deepEqual(new Set(seen), new Set(["relayer.praetorial-dev-1101.near", "keeper.praetorial-dev-1101.near"]));
});
