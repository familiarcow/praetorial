// SECREV1 SR-7: the relayer must not pay for a delegate whose signing key is not an access key of the sender account (throwaway
// implicit ids + fresh keys drained the open share of the global gas budget: the outer tx is paid, the delegate fails on chain).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as borsh from "borsh";
import { KeyPair } from "near-api-js";
import { SCHEMA, actionCreators, buildDelegateAction, encodeDelegateAction, Signature } from "@near-js/transactions";
import { Relayer, PolicyViolation, type RelayerConfig } from "../src/relayer.js";

const ESCROW = "escrow3.praetorial-dev-1101.testnet";
const cfg = (): RelayerConfig => ({
  escrowContract: ESCROW, intentsContract: "intents-mock.praetorial-dev-1101.testnet", usdcTokenId: "usdc.fakes.testnet", maxTransferAmount: 1_000_000_000n,
  maxBlockHeightFuture: 1200n, perCallSponsorshipYocto: 5_000_000_000_000_000_000_000n, maxRequestsPerWindow: 20, windowMs: 60_000,
  dailyBudgetYocto: 100_000_000_000_000_000_000_000n,
});
function delegate(senderId: string, nonce = 1n) {
  const kp = KeyPair.fromRandom("ed25519");
  const da = buildDelegateAction({ senderId, receiverId: ESCROW, actions: [actionCreators.functionCall("cancel", { bet_id: 1 }, 30_000_000_000_000n, 0n)], nonce, maxBlockHeight: 5000n, publicKey: kp.getPublicKey() as any });
  const sig = kp.sign(createHash("sha256").update(Buffer.from(encodeDelegateAction(da))).digest());
  return Buffer.from(borsh.serialize(SCHEMA.SignedDelegate, { delegateAction: da, signature: new Signature({ keyType: 0, data: sig.signature }) })).toString("base64");
}
function chain(known: boolean | "rpc-down") {
  const c: any = {
    calls: 0, keyReads: 0,
    async currentBlockHeight() { return 4000n; },
    async accessKeyExists() { c.keyReads++; if (known === "rpc-down") throw new Error("rpc down"); return known; },
    async broadcastSignedDelegate() { c.calls++; return { transactionHash: "H", actualCostYocto: 1n, raw: {} }; },
  };
  return c;
}

test("SECREV1 SR-7: a delegate signed by a key the sender account does not have is refused, never broadcast, and charges nothing", async () => {
  const c = chain(false);
  const r = new Relayer(c, cfg());
  await assert.rejects(() => r.relay(delegate("a".repeat(64))), PolicyViolation);
  assert.equal(c.calls, 0);
  assert.equal(c.keyReads, 1);
  assert.equal(r.globalBudgetStatus().usedYocto, 0n, "nothing held or charged");
  // the same sender with a real key (and a fresh nonce) still relays: the refused attempt did not burn the slot
  const ok = new Relayer(chain(true), cfg());
  assert.equal((await ok.relay(delegate("b".repeat(64)))).txHash, "H");
});

test("SECREV1 SR-7: an RPC failure on the key check fails open (users are not blocked by a flaky RPC)", async () => {
  const c = chain("rpc-down");
  assert.equal((await new Relayer(c, cfg()).relay(delegate("c".repeat(64)))).txHash, "H");
});
