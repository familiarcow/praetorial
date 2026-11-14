// RLYDEP1: pure helpers of the live proof script (scripts/relayref1_proof.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAllowedCall, PolicyViolation, type RelayerPolicyConfig } from "../src/policy.js";
import { amendRefereeArgs, badAmendRefereeArgs, checkRefundSettled } from "../src/relayref1Proof.js";

const ESCROW = "escrow.test.testnet";
const cfg = { escrowContract: ESCROW, intentsContract: "intents.test.testnet", usdcTokenId: "u.testnet", maxTransferAmount: 1n } as RelayerPolicyConfig;
const run = (a: unknown) => () => assertAllowedCall(cfg, ESCROW, "amend_referee", new TextEncoder().encode(JSON.stringify(a)), 0n);
const ref = { account: "ref.testnet", mode: "Human" as const };

test("amendRefereeArgs: exact policy-accepted shape, referee JSON round-trips", () => {
  const a = amendRefereeArgs(12, ref);
  assert.deepEqual(Object.keys(a).sort(), ["bet_id", "new_referee_json"]);
  assert.equal(a.bet_id, 12);
  assert.deepEqual(JSON.parse(a.new_referee_json), ref);
  assert.doesNotThrow(run(a));
});

test("badAmendRefereeArgs: carries an extra key and is refused by the relayer policy", () => {
  const b = badAmendRefereeArgs(12, ref);
  assert.ok(Object.keys(b).length === 3);
  assert.throws(run(b), PolicyViolation);
});

test("checkRefundSettled: refund must equal the deposit and escrow must hold 0 for the bet", () => {
  assert.equal(checkRefundSettled({ before: "5", after: "15", deposit: "10", escrowLeft: "0" }), null);
  assert.match(checkRefundSettled({ before: "5", after: "10", deposit: "10", escrowLeft: "0" })!, /refund/);
  assert.match(checkRefundSettled({ before: "5", after: "15", deposit: "10", escrowLeft: "1" })!, /escrow/);
});
