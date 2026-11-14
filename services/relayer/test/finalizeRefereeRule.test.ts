// RLYFIN1 / D-FINREL1 + RLYREF2 / D-REFREL1: relayer allows escrow `finalize` and `referee_rule`
// (contracts/escrow/src/lib.rs `pub fn finalize(&mut self, bet_id: u64)`, `pub fn referee_rule(&mut self, bet_id: u64, outcome: String)`; neither #[payable]).
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAllowedCall, PolicyViolation, ESCROW_DIRECT_METHODS, ESCROW_PAYABLE_METHODS, type RelayerPolicyConfig } from "../src/policy.js";

const ESCROW = "escrow3.praetorial-dev-1101.testnet";
const cfg: RelayerPolicyConfig = {
  escrowContract: ESCROW,
  intentsContract: "intents-mock.praetorial-dev-1101.testnet",
  usdcTokenId: "usdc.fakes.testnet",
  maxTransferAmount: 1_000_000_000n,
} as RelayerPolicyConfig;
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const call = (method: string, args: unknown, deposit = 0n) => () => assertAllowedCall(cfg, ESCROW, method, enc(args), deposit);

const badIds = [-1, 1.5, "7", null, true, [7], {}];

test("finalize: {bet_id} with zero deposit is accepted; allowlisted, not payable", () => {
  assert.doesNotThrow(call("finalize", { bet_id: 7 }));
  assert.doesNotThrow(call("finalize", { bet_id: 0 }));
  assert.equal(ESCROW_DIRECT_METHODS.has("finalize"), true);
  assert.equal(ESCROW_PAYABLE_METHODS.has("finalize"), false);
});

test("finalize: refusals", () => {
  assert.throws(call("finalize", { bet_id: 7, x: 1 }), PolicyViolation);
  assert.throws(call("finalize", {}), PolicyViolation);
  for (const bad of badIds) assert.throws(call("finalize", { bet_id: bad }), PolicyViolation, JSON.stringify(bad));
  assert.throws(call("finalize", { bet_id: 7 }, 1n), PolicyViolation);
});

test("referee_rule: YES/NO/VOID with zero deposit accepted; allowlisted, not payable", () => {
  for (const outcome of ["YES", "NO", "VOID"]) assert.doesNotThrow(call("referee_rule", { bet_id: 7, outcome }), outcome);
  assert.equal(ESCROW_DIRECT_METHODS.has("referee_rule"), true);
  assert.equal(ESCROW_PAYABLE_METHODS.has("referee_rule"), false);
});

test("referee_rule: refusals", () => {
  for (const outcome of ["yes", "Yes", "MAYBE", "", " YES", "YES ", null, 1, true, ["YES"]]) {
    assert.throws(call("referee_rule", { bet_id: 7, outcome }), PolicyViolation, JSON.stringify(outcome));
  }
  assert.throws(call("referee_rule", { bet_id: 7 }), PolicyViolation);
  assert.throws(call("referee_rule", { bet_id: 7, outcome: "YES", x: 1 }), PolicyViolation);
  assert.throws(call("referee_rule", { outcome: "YES" }), PolicyViolation);
  assert.throws(call("referee_rule", {}), PolicyViolation);
  for (const bad of badIds) assert.throws(call("referee_rule", { bet_id: bad, outcome: "YES" }), PolicyViolation, JSON.stringify(bad));
  assert.throws(call("referee_rule", { bet_id: 7, outcome: "YES" }, 1n), PolicyViolation);
});
