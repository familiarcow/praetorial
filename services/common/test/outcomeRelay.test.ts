// KEEPSUBMIT1 RED: pure decision "should the keeper relay this bet's stored resolver output to submit_outcome, and with what args".
import { test } from "node:test";
import assert from "node:assert/strict";
import { planOutcomeRelay } from "../src/outcomeRelay.js";
import { generateResolverKeypair } from "../src/resolverSign.js";
import { makeRaw, makeBet } from "../../keeper/test/helpers/signedRaw.js";

const C = "escrow.testnet";
const kp = generateResolverKeypair();
const raw = (o: any = {}) => makeRaw({ contract: C, betId: 1, runNo: 1, kp, ...o });

test("relays exactly the stored result + signature (checked_until as a decimal string)", () => {
  const r = raw();
  const p = planOutcomeRelay(C, 1, makeBet("Resolving", r));
  assert.equal(p.ok, true);
  if (!p.ok) return;
  const o = JSON.parse(r);
  assert.deepEqual(p.args.result, { ...o.result, checked_until: "0" });
  assert.equal(p.args.signature_hex, o.signing.signature_hex);
});

test("a ns checked_until above 2^53 keeps its exact digits (no float round trip)", () => {
  const p = planOutcomeRelay(C, 1, makeBet("Resolving", raw({ checkedUntil: "1762790000123456789" })));
  assert.equal(p.ok && p.args.result.checked_until, "1762790000123456789");
});

for (const s of ["Taken", "Resolving", "Challenged", "Evidence"] as const) {
  test(`status ${s} is relayable`, () => assert.equal(planOutcomeRelay(C, 1, makeBet(s, raw())).ok, true));
}
for (const s of ["Open", "Proposed", "Settled", "Voided", "Cancelled", "Expired"] as const) {
  test(`status ${s} is never relayed`, () => assert.equal(planOutcomeRelay(C, 1, makeBet(s as any, raw())).ok, false));
}

const NEVER: [string, () => any][] = [
  ["unsigned NOKEY1 error output", () => makeBet("Resolving", raw({ signed: false }))],
  ["null raw", () => makeBet("Resolving", null)],
  ["malformed raw", () => makeBet("Resolving", "{not json")],
  ["truncated raw", () => makeBet("Resolving", raw().slice(0, 80))],
  ["outlayer_call_failed marker", () => makeBet("Resolving", '{"error":"outlayer_call_failed"}')],
  ["run_no already used", () => makeBet("Resolving", raw(), { used: [1] })],
  ["run_no != pending_run_no", () => makeBet("Resolving", raw({ runNo: 2 }), { pending: 1 })],
  ["no pending_run_no", () => makeBet("Resolving", raw(), { pending: null })],
  ["wrong bet_id in result", () => makeBet("Resolving", raw({ betId: 2 }))],
  ["contract field != escrow id", () => makeBet("Resolving", raw({ contractField: "other.testnet" }))],
  ["terms_hash differs from the bet's", () => makeBet("Resolving", raw({ termsHash: "c".repeat(64) }))],
];

test("a re-judge round (prior outcome set, used [1], pending 2) is relayed: the contract gates on run order, not on bet.outcome", () => {
  const b = { ...makeBet("Resolving", raw({ runNo: 2 }), { pending: 2, used: [1] }), outcome: "NO" };
  assert.equal(planOutcomeRelay(C, 1, b as any).ok, true);
});
for (const [name, mk] of NEVER) test(`never relays: ${name}`, () => {
  const p = planOutcomeRelay(C, 1, mk());
  assert.equal(p.ok, false);
  if (!p.ok) assert.ok(p.reason.length > 0);
});
