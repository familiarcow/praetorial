// JC1s (D-JUDGECHAIN1): judge_pair_index is part of the signed buffer; no-live-judge is a RETRY form.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSubmitOutcomeMessage, buildLegacySubmitOutcomeMessage } from "../src/resolverSign.js";
import { BorshWriter } from "../src/borsh.js";
import type { SubmittedResult } from "../src/types.js";

const base: SubmittedResult = { bet_id: 5, terms_hash: "t".repeat(64), outcome: "YES", element_results_hash: "e".repeat(64), run_no: 2, checked_until: "77" };

test("buffer = legacy fields ++ u32 LE judge_pair_index (before next_check_ns)", () => {
  const r = { ...base, judge_pair_index: 0x01020304 };
  const expect = new BorshWriter().string("escrow.testnet").u64(5).string(r.terms_hash).string("YES").string(r.element_results_hash).u64(2).u64(77).toBuffer();
  const got = buildSubmitOutcomeMessage("escrow.testnet", r);
  assert.equal(got.length, expect.length + 4);
  assert.deepEqual(got.subarray(0, expect.length), expect);
  assert.deepEqual(got.subarray(expect.length), Buffer.from([4, 3, 2, 1]));
});

test("a missing judge_pair_index signs as pair 0", () => {
  assert.deepEqual(buildSubmitOutcomeMessage("e.testnet", base), buildSubmitOutcomeMessage("e.testnet", { ...base, judge_pair_index: 0 }));
});

test("a different index is a different message (tamper detection)", () => {
  assert.notDeepEqual(buildSubmitOutcomeMessage("e.testnet", { ...base, judge_pair_index: 0 }), buildSubmitOutcomeMessage("e.testnet", { ...base, judge_pair_index: 1 }));
});

test("both RETRY forms append next_check_ns after the index", () => {
  for (const outcome of ["RETRY", "RETRY:no_live_judge"]) {
    const r = { ...base, outcome, judge_pair_index: 2, next_check_ns: "99" } as unknown as SubmittedResult;
    const m = buildSubmitOutcomeMessage("e.testnet", r);
    const tail = m.subarray(m.length - 12);
    assert.deepEqual(tail.subarray(0, 4), Buffer.from([2, 0, 0, 0]), outcome);
    assert.equal(tail.readBigUInt64LE(4), 99n, outcome);
    assert.throws(() => buildSubmitOutcomeMessage("e.testnet", { ...r, next_check_ns: undefined } as any), /requires next_check_ns/);
  }
});

test("legacy (pre-JC1s) layout has no index: recorded evidence still verifies under it", () => {
  const legacy = buildLegacySubmitOutcomeMessage("escrow.testnet", base);
  const expect = new BorshWriter().string("escrow.testnet").u64(5).string(base.terms_hash).string("YES").string(base.element_results_hash).u64(2).u64(77).toBuffer();
  assert.deepEqual(legacy, expect);
});

// ---- JC1x: observations are the very last signed bytes, only when present
test("JC1x: no observations = JC1s buffer; with observations = ++ borsh(Vec<(String,u64)>)", () => {
  const r = { ...base, judge_pair_index: 1 };
  const plain = buildSubmitOutcomeMessage("e.testnet", r);
  assert.deepEqual(buildSubmitOutcomeMessage("e.testnet", { ...r, model_not_found: [] }), plain);
  const withObs = buildSubmitOutcomeMessage("e.testnet", { ...r, model_not_found: [{ model: "a/b", observed_ns: "123" }] });
  const tail = new BorshWriter().u32(1).string("a/b").u64(123).toBuffer();
  assert.deepEqual(withObs.subarray(0, plain.length), plain);
  assert.deepEqual(withObs.subarray(plain.length), tail);
});
