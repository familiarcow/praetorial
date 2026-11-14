// CF1a RED: WebCrypto NEAR client. The signed FunctionCall transaction bytes must equal
// what near-api-js (the node keeper's signer) produces for the same inputs (Ed25519 is
// deterministic), so the Worker signs exactly what the node keeper would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { transactions, utils, KeyPair } from "near-api-js";
import bs58 from "bs58";
import { createHash } from "node:crypto";
import { buildSignedFunctionCallTx, WorkerNearClient } from "../src/nearWebClient.js";

const kp = KeyPair.fromRandom("ed25519") as any;
const secret = kp.toString() as string; // ed25519:<base58(seed||pub)>
const pubB58 = kp.getPublicKey().toString().split(":")[1];
const blockHash = bs58.encode(new Uint8Array(32).map((_, i) => i + 1));

test("signed FunctionCall tx bytes equal near-api-js's", async () => {
  const args = new TextEncoder().encode(JSON.stringify({ bet_id: 7 }));
  const mine = await buildSignedFunctionCallTx({
    signerId: "keeper.testnet", secretKey: secret, nonce: 42n, receiverId: "escrow.testnet",
    blockHash, methodName: "finalize", args, gas: 300_000_000_000_000n, deposit: 0n,
  });
  const tx = transactions.createTransaction(
    "keeper.testnet", utils.PublicKey.from(`ed25519:${pubB58}`), "escrow.testnet", 42,
    [transactions.functionCall("finalize", args, 300_000_000_000_000n as any, 0n as any)],
    utils.serialize.base_decode(blockHash),
  );
  const hash = createHash("sha256").update(transactions.encodeTransaction(tx)).digest();
  const signed = new transactions.SignedTransaction({ transaction: tx, signature: new transactions.Signature({ keyType: 0, data: kp.sign(hash).signature }) });
  assert.deepEqual(Buffer.from(mine.signedTx), Buffer.from(transactions.encodeTransaction(signed)));
});

test("client enforces the per-call attached cap and a hard subrequest budget", async () => {
  let n = 0;
  const rpc = { sendJsonRpc: async () => { n++; return { result: { result: Array.from(new TextEncoder().encode("1")) } }; } };
  const c = new WorkerNearClient({ rpc, accountId: "k.testnet", privateKey: secret, maxAttachedYocto: 10n, maxSubrequests: 3 });
  await assert.rejects(c.callPayable("e.testnet", "m", {}, 11n), /exceeds per-call max/);
  assert.equal(await c.view("e.testnet", "v", {}), 1);
  await c.view("e.testnet", "v", {}); await c.view("e.testnet", "v", {});
  await assert.rejects(c.view("e.testnet", "v", {}), /subrequest budget/);
  assert.equal(n, 3);
});
