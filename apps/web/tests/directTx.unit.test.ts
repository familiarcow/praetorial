// RELAYDEP1 / D-RELAYDEP1: NEP-366 charges every deposit inside a relayed delegate to the RELAYER. So the web signs and
// pays deposit-bearing calls itself (direct transaction); only gas-only calls and the 1-yocto security deposit are relayed.
import test from "node:test";
import assert from "node:assert/strict";
import { decodeSignedTransaction } from "@near-js/transactions";
import { needsUserSignedTx, buildDirectTx, encodeSignedTx } from "../lib/directTx";
import { buildMoveSteps } from "../lib/moveToBetting";

const ME = "03c105e3c8dc8eccd940900a70fe34350a17fd72974289642e39c70e7168a5b5";
const NEAR = 10n ** 24n;

test("routing: any deposit above 1 yocto is user-signed; near_deposit, request_resolution and storage_deposit too; gas-only and 1-yocto stay relayed", () => {
  assert.equal(needsUserSignedTx("near_deposit", NEAR / 20n), true);
  assert.equal(needsUserSignedTx("request_resolution", 10n ** 22n), true);
  assert.equal(needsUserSignedTx("anything_else", 2n), true);
  assert.equal(needsUserSignedTx("ft_transfer_call", 1n), false);
  assert.equal(needsUserSignedTx("ft_withdraw", 1n), false);
  assert.equal(needsUserSignedTx("cancel", 0n), false);
  // SEC1/MON-1: NEP-145 registration refunds to the sender, so the relayer never pays it: user-signed for any deposit.
  assert.equal(needsUserSignedTx("storage_deposit", 1_250_000_000_000_000_000_000n), true);
  assert.equal(needsUserSignedTx("storage_deposit", 1n), true);
});

test("the Move steps: wrapping NEAR is user-paid, the 1-yocto transfer into Intents stays relayed", () => {
  const steps = buildMoveSteps({ symbol: "NEAR", account: ME, amountUnits: (3n * NEAR).toString(), source: "native", network: "testnet" });
  const byMethod = Object.fromEntries(steps.map((s) => [s.methodName, needsUserSignedTx(s.methodName, BigInt(s.depositYocto))]));
  assert.deepEqual(byMethod, { near_deposit: true, ft_transfer_call: false });
});

test("buildDirectTx: the signer is the user, the deposit rides the user's own transaction, the hash is the borsh tx sha256", () => {
  const blockHash = "FDM3JkqRhGKqxqDqJm7cnzT1LgzDn3dHjkh8gCgV2tHB";
  const { transaction, hashHex } = buildDirectTx({ senderId: ME, publicKeyHexEd25519: ME, receiverId: "wrap.testnet", methodName: "near_deposit", args: {}, gasTgas: 30, depositYocto: (NEAR / 20n).toString(), nonce: 5n, blockHashB58: blockHash });
  assert.match(hashHex, /^[0-9a-f]{64}$/);
  const b64 = encodeSignedTx(transaction, "22".repeat(64));
  const st = decodeSignedTransaction(Buffer.from(b64, "base64"));
  assert.equal(st.transaction.signerId, ME);
  assert.equal(st.transaction.receiverId, "wrap.testnet");
  assert.equal(st.transaction.nonce, 5n);
  const fc = st.transaction.actions[0].functionCall!;
  assert.equal(fc.methodName, "near_deposit");
  assert.equal(fc.deposit, NEAR / 20n);
  assert.equal(fc.gas, 30n * 10n ** 12n);
});

test("defence in depth: the relay hook itself refuses a deposit-bearing delegate before anything is built or sent", async () => {
  const { assertRelayable } = await import("../lib/useRelayAction");
  assert.throws(() => assertRelayable("near_deposit", "50000000000000000000000"), /user-signed/);
  assert.throws(() => assertRelayable("request_resolution", "10000000000000000000000"), /user-signed/);
  assert.doesNotThrow(() => assertRelayable("ft_transfer_call", "1"));
  assert.doesNotThrow(() => assertRelayable("cancel", undefined));
});
