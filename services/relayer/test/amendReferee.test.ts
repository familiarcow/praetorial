// RELAYREF1 / D-FE10B1: relayer allows escrow `amend_referee`
// (contracts/escrow/src/lib.rs `pub fn amend_referee(&mut self, bet_id: u64, new_referee_json: String)`, not #[payable]).
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
const call = (args: unknown, deposit = 0n) => () => assertAllowedCall(cfg, ESCROW, "amend_referee", enc(args), deposit);
const ok = { bet_id: 7, new_referee_json: JSON.stringify({ kind: "mutual", a: 1 }) };

test("amend_referee: exact {bet_id, new_referee_json} with zero deposit is allowed", () => {
  assert.doesNotThrow(call(ok));
  assert.doesNotThrow(call({ bet_id: 0, new_referee_json: "null" }));
  assert.doesNotThrow(call({ bet_id: 7, new_referee_json: "{}" }));
  assert.doesNotThrow(call({ bet_id: 7, new_referee_json: " null " }));
});

test("amend_referee: allowlisted, never payable", () => {
  assert.equal(ESCROW_DIRECT_METHODS.has("amend_referee"), true);
  assert.equal(ESCROW_PAYABLE_METHODS.has("amend_referee"), false);
});

test("amend_referee: any attached deposit is refused", () => {
  assert.throws(call(ok, 1n), PolicyViolation);
  assert.throws(call(ok, 10n ** 24n), PolicyViolation);
});

test("amend_referee: extra or missing arg keys are refused", () => {
  assert.throws(call({ ...ok, extra: 1 }), PolicyViolation);
  assert.throws(call({ bet_id: 7 }), PolicyViolation);
  assert.throws(call({ new_referee_json: "null" }), PolicyViolation);
  assert.throws(call({}), PolicyViolation);
});

test("amend_referee: bet_id must be a non-negative integer number", () => {
  for (const bad of [-1, 1.5, "7", null, true, [7], {}, 1e400]) {
    assert.throws(call({ bet_id: bad, new_referee_json: "null" }), PolicyViolation, JSON.stringify(bad));
  }
});

test("amend_referee: new_referee_json must be a string holding valid JSON null-or-object, <= 4096 bytes", () => {
  for (const bad of [{ a: 1 }, null, 5, true, ["x"], undefined]) {
    assert.throws(call({ bet_id: 1, new_referee_json: bad }), PolicyViolation, JSON.stringify(bad));
  }
  for (const bad of ["", "not json", "{bad", "[]", "[1]", "5", "true", '"str"']) {
    assert.throws(call({ bet_id: 1, new_referee_json: bad }), PolicyViolation, bad);
  }
  const mk = (n: number) => JSON.stringify({ p: "x".repeat(n - 8) }); // {"p":"..."} = n bytes
  assert.equal(Buffer.byteLength(mk(4096)), 4096);
  assert.doesNotThrow(call({ bet_id: 1, new_referee_json: mk(4096) }));
  assert.throws(call({ bet_id: 1, new_referee_json: mk(4097) }), PolicyViolation);
  // byte length, not char length: multibyte chars
  assert.throws(call({ bet_id: 1, new_referee_json: JSON.stringify({ p: "é".repeat(2050) }) }), PolicyViolation);
});

test("amend_referee: allowlist error text lists amend_referee", () => {
  try { assertAllowedCall(cfg, ESCROW, "nope", enc({}), 0n); assert.fail("should throw"); }
  catch (e) { assert.ok(e instanceof PolicyViolation); assert.match((e as Error).message, /amend_referee/); }
});

test("amend_referee: does not loosen other methods (cancel still bet_id-only, concede unchanged)", () => {
  assert.throws(() => assertAllowedCall(cfg, ESCROW, "concede", enc({ bet_id: 1, new_referee_json: "null" }), 0n), PolicyViolation);
  assert.doesNotThrow(() => assertAllowedCall(cfg, ESCROW, "concede", enc({ bet_id: 1 }), 0n));
});
