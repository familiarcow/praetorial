import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import nacl from "tweetnacl";
import { generateResolverKeypair, signOutcome, buildSubmitOutcomeMessage } from "../src/resolverSign.js";
import { BorshWriter } from "../src/borsh.js";
import type { SubmittedResult } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("signOutcome produces a signature the pubkey verifies (mirrors contract's env::ed25519_verify)", () => {
  const kp = generateResolverKeypair();
  const result: SubmittedResult = {
    bet_id: 42,
    terms_hash: "a".repeat(64),
    outcome: "YES",
    element_results_hash: "0".repeat(64),
    run_no: 0,
    checked_until: "1234",
  };
  const sigHex = signOutcome("escrow.praetorial-dev-1101.testnet", result, kp.secretKey);
  const message = buildSubmitOutcomeMessage("escrow.praetorial-dev-1101.testnet", result);
  const pubkey = Buffer.from(kp.publicKeyHex, "hex");
  const sig = Buffer.from(sigHex, "hex");
  assert.equal(sig.length, 64);
  assert.equal(pubkey.length, 32);
  assert.ok(nacl.sign.detached.verify(message, sig, pubkey));
});

test("signature does not verify against a different message (tamper detection)", () => {
  const kp = generateResolverKeypair();
  const result: SubmittedResult = {
    bet_id: 1, terms_hash: "x".repeat(64), outcome: "YES",
    element_results_hash: "0".repeat(64), run_no: 0, checked_until: "1",
  };
  const sigHex = signOutcome("escrow.testnet", result, kp.secretKey);
  const tamperedMessage = buildSubmitOutcomeMessage("escrow.testnet", { ...result, outcome: "NO" });
  const sig = Buffer.from(sigHex, "hex");
  const pubkey = Buffer.from(kp.publicKeyHex, "hex");
  assert.equal(nacl.sign.detached.verify(tamperedMessage, sig, pubkey), false);
});

// Pins the exact field order (escrow_account_id, bet_id, terms_hash,
// outcome, element_results_hash, run_no, checked_until) that
// contracts/escrow/src/lib.rs's submit_outcome borsh-decodes and
// ed25519_verify's against. A field-order swap here would silently
// break signature parity with the live contract (same length/types
// going in, different bytes out) without the determinism/tamper tests
// above ever catching it — caught by mutation testing (swapping
// terms_hash/outcome order left the other two resolverSign tests
// green), so this test exists specifically to close that gap.
test("buildSubmitOutcomeMessage matches the contract's exact borsh field order", () => {
  const result: SubmittedResult = {
    bet_id: 7,
    terms_hash: "h".repeat(64),
    outcome: "VOID",
    element_results_hash: "e".repeat(64),
    run_no: 2,
    checked_until: "99",
  };
  const expected = new BorshWriter()
    .string("escrow.testnet")
    .u64(result.bet_id)
    .string(result.terms_hash)
    .string(result.outcome)
    .string(result.element_results_hash)
    .u64(result.run_no)
    .u64(BigInt(result.checked_until))
    .u32(0) // JC1s: judge_pair_index (absent signs as 0)
    .toBuffer();
  const actual = buildSubmitOutcomeMessage("escrow.testnet", result);
  assert.deepEqual(actual, expected);
});

test("buildSubmitOutcomeMessage is deterministic for identical inputs", () => {
  const result: SubmittedResult = {
    bet_id: 7, terms_hash: "h", outcome: "VOID", element_results_hash: "e", run_no: 2, checked_until: "99",
  };
  const a = buildSubmitOutcomeMessage("escrow.testnet", result);
  const b = buildSubmitOutcomeMessage("escrow.testnet", result);
  assert.deepEqual(a, b);
});

// Root-cause regression (G4/G6 submit_outcome "bad signature" rejections):
// checked_until is a ns-since-epoch timestamp that routinely exceeds
// Number.MAX_SAFE_INTEGER. Carrying it as a JS `number` meant
// JSON.stringify's shortest round-trip decimal string for a double could
// differ from BigInt(thatDouble)'s EXACT integer value by tens-to-hundreds
// of ns -- the signer and the contract's serde_json would read two
// different "true" integers off the same double. This pins that a
// decimal-string checked_until survives a JSON.stringify/JSON.parse round
// trip (exactly what near-api-js does to build RPC args) byte-for-byte,
// unlike the number form.
test("checked_until as a decimal string survives JSON round-trip exactly; as a number it would not", () => {
  const unsafeNs = 1_793_605_204_551_000_123n; // > 2^53-1
  assert.ok(unsafeNs > BigInt(Number.MAX_SAFE_INTEGER), "fixture must exceed JS's safe-integer range");

  const asString = unsafeNs.toString();
  const roundTrippedString = JSON.parse(JSON.stringify({ checked_until: asString })).checked_until;
  assert.equal(roundTrippedString, asString, "string form: zero precision loss");

  const asNumber = Number(unsafeNs);
  const roundTrippedNumber = JSON.parse(JSON.stringify({ checked_until: asNumber })).checked_until;
  // The double's own exact integer value is what BigInt(n) would sign over;
  // it does not equal the original exact ns value we intended.
  assert.notEqual(BigInt(asNumber).toString(), unsafeNs.toString(), "number form: precision already lost before any JSON round-trip");

  const result: SubmittedResult = {
    bet_id: 1, terms_hash: "x".repeat(64), outcome: "YES",
    element_results_hash: "0".repeat(64), run_no: 0, checked_until: asString,
  };
  const msgBeforeWire = buildSubmitOutcomeMessage("escrow.testnet", result);
  const resultAfterWire: SubmittedResult = JSON.parse(JSON.stringify(result));
  const msgAfterWire = buildSubmitOutcomeMessage("escrow.testnet", resultAfterWire);
  assert.deepEqual(msgBeforeWire, msgAfterWire, "signed bytes must match the bytes rebuilt from the wire payload");
});

// DR-SVC-RETRY-1 (drift review 2026-11-04 21:53): contracts/escrow/src/lib.rs
// submit_outcome appends borsh(next_check_ns: u64) to the signed buffer
// when outcome == "RETRY" (D-RESOLVE1, item 7d). buildSubmitOutcomeMessage
// claims to build "the exact buffer" the contract verifies but never
// appends it, so any RETRY signed through this helper is rejected with
// "bad signature". RED until SubmittedResult carries next_check_ns and the
// builder appends it for RETRY only.
test("RETRY: buildSubmitOutcomeMessage appends next_check_ns like the contract (D-RESOLVE1)", () => {
  const result = {
    bet_id: 7,
    terms_hash: "h".repeat(64),
    outcome: "RETRY",
    element_results_hash: "e".repeat(64),
    run_no: 1,
    checked_until: "99",
    next_check_ns: "123456789",
  } as unknown as SubmittedResult;
  const expected = new BorshWriter()
    .string("escrow.testnet")
    .u64(7)
    .string("h".repeat(64))
    .string("RETRY")
    .string("e".repeat(64))
    .u64(1)
    .u64(99n)
    .u32(0) // JC1s: judge_pair_index
    .u64(123456789n)
    .toBuffer();
  assert.deepEqual(buildSubmitOutcomeMessage("escrow.testnet", result), expected);
});

// DR-SVC-RETRY-1 cross-check: contracts/escrow/tests/fixtures/resolver_crosscheck.json
// is the shared contract between contracts/escrow/src/tests.rs's
// `resolver_crosscheck_fixture_bytes` (the authority), resolver/wasm-bin/src/main.rs's
// `submitted_result_crosscheck_fixture_bytes`, and this test -- all three must build the
// identical borsh buffer from the same field values. This asserts buildSubmitOutcomeMessage
// matches the checked-in fixture hex for both its RETRY and VOID:unavailable cases.
test("buildSubmitOutcomeMessage matches the contract's resolver_crosscheck.json fixture (RETRY + VOID:unavailable)", () => {
  const fixturePath = join(__dirname, "..", "..", "..", "contracts", "escrow", "tests", "fixtures", "resolver_crosscheck.json");
  const fx = JSON.parse(readFileSync(fixturePath, "utf8"));

  const retry = {
    bet_id: fx.bet_id,
    terms_hash: fx.terms_hash,
    outcome: "RETRY",
    element_results_hash: fx.element_results_hash,
    run_no: fx.run_no,
    checked_until: String(fx.checked_until),
    next_check_ns: String(fx.next_check_ns),
  } as unknown as SubmittedResult;
  const retryBuf = buildSubmitOutcomeMessage(fx.contract_id, retry);
  assert.equal(retryBuf.toString("hex"), fx.retry_buf_hex, "RETRY buffer must match the contract's own fixture bytes");

  const voidUnavailable: SubmittedResult = {
    bet_id: fx.bet_id,
    terms_hash: fx.terms_hash,
    outcome: "VOID:unavailable" as unknown as SubmittedResult["outcome"],
    element_results_hash: fx.element_results_hash,
    run_no: fx.run_no,
    checked_until: String(fx.checked_until),
  };
  const voidBuf = buildSubmitOutcomeMessage(fx.contract_id, voidUnavailable);
  assert.equal(voidBuf.toString("hex"), fx.void_unavailable_buf_hex, "VOID:unavailable buffer must match the contract's own fixture bytes");
});
