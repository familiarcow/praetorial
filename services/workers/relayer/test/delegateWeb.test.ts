// CF1b RED: WebCrypto/no-Buffer SignedDelegateAction decode+verify must agree with the node relayer's delegate.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { KeyPair } from "near-api-js";
import { actionCreators } from "@near-js/transactions";
import { decodeSignedDelegate, verifySignedDelegate, BadSignedDelegate } from "../../../relayer/src/delegate.js";
import { decodeSignedDelegateWeb, verifySignedDelegateWeb } from "../src/delegateWeb.js";
import { buildDelegate } from "./helpers.js";

test("decode agrees with node on a valid delegate; signature verifies via WebCrypto", async () => {
  const b = buildDelegate({ methodName: "cancel", args: { bet_id: 7 }, nonce: 12345678901234567890n, maxBlockHeight: 99n });
  const n = decodeSignedDelegate(b.base64), w = decodeSignedDelegateWeb(b.base64);
  assert.equal(w.delegateAction.senderId, n.delegateAction.senderId);
  assert.equal(w.delegateAction.receiverId, n.delegateAction.receiverId);
  assert.equal(w.delegateAction.nonce, 12345678901234567890n);
  assert.equal(w.delegateAction.maxBlockHeight, 99n);
  assert.deepEqual([...w.publicKeyBytes], [...n.publicKeyBytes]);
  assert.deepEqual([...w.signatureBytes], [...n.signatureBytes]);
  const fc = (w.delegateAction.actions[0] as any).functionCall;
  assert.equal(fc.methodName, "cancel");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(fc.args)), { bet_id: 7 });
  assert.equal(await verifySignedDelegateWeb(w), true);
  assert.equal(verifySignedDelegate(n), true);
});

test("wrong-key signature fails verification (both)", async () => {
  const b = buildDelegate({ signWith: KeyPair.fromRandom("ed25519") });
  assert.equal(verifySignedDelegate(decodeSignedDelegate(b.base64)), false);
  assert.equal(await verifySignedDelegateWeb(decodeSignedDelegateWeb(b.base64)), false);
});

test("malformed payloads are BadSignedDelegate, same classes of input as node", () => {
  const good = buildDelegate({}).base64;
  const raw = Uint8Array.from(atob(good), (c) => c.charCodeAt(0));
  const trailing = btoa(String.fromCharCode(...raw, 0));
  for (const bad of ["", "not base64!!", good.slice(0, -4), trailing, good.replace(/=+$/, ""), btoa("\u0001\u0002\u0003")]) {
    assert.throws(() => decodeSignedDelegate(bad), BadSignedDelegate, `node accepted ${bad}`);
    assert.throws(() => decodeSignedDelegateWeb(bad), BadSignedDelegate, `web accepted ${bad}`);
  }
});

test("non-FunctionCall and multi-action delegates decode (policy rejects them later), kinds preserved", () => {
  const b = buildDelegate({ actions: [actionCreators.transfer(1n)] });
  const w = decodeSignedDelegateWeb(b.base64);
  assert.deepEqual(Object.keys(w.delegateAction.actions[0]), ["transfer"]); // same { variant: {...} } shape as the node decoder
  assert.equal((w.delegateAction.actions[0] as any).transfer.deposit, 1n);
  const m = buildDelegate({ actions: [actionCreators.functionCall("cancel", { bet_id: 1 }, 1n, 0n), actionCreators.functionCall("cancel", { bet_id: 2 }, 1n, 0n)] });
  assert.equal(decodeSignedDelegateWeb(m.base64).delegateAction.actions.length, 2);
  const d = buildDelegate({ actions: [actionCreators.deleteAccount("x.testnet")] });
  assert.equal((decodeSignedDelegateWeb(d.base64).delegateAction.actions[0] as any).deleteAccount.beneficiaryId, "x.testnet");
});
