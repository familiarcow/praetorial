// FE2b / S11: the take review keeps its choices (tip, pay-with asset) when the user detours to /add-money and comes back.
import test from "node:test";
import assert from "node:assert/strict";
import { saveTakeReview, loadTakeReview, clearTakeReview } from "../lib/takeReviewState";

function mem(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, get length() { return m.size; } } as Storage;
}
test("round-trips per bet id", () => {
  const s = mem();
  saveTakeReview(s, 7, { tip: true, asset: "nep141:usdc.testnet" });
  saveTakeReview(s, 8, { tip: false, asset: null });
  assert.deepEqual(loadTakeReview(s, 7), { tip: true, asset: "nep141:usdc.testnet" });
  assert.deepEqual(loadTakeReview(s, 8), { tip: false, asset: null });
});
test("nothing saved, corrupt JSON, or wrong shape -> defaults", () => {
  const s = mem();
  const dflt = { tip: false, asset: null };
  assert.deepEqual(loadTakeReview(s, 1), dflt);
  s.setItem("praetorial:take-review:1", "{not json");
  assert.deepEqual(loadTakeReview(s, 1), dflt);
  s.setItem("praetorial:take-review:1", JSON.stringify({ tip: "yes", asset: 5 }));
  assert.deepEqual(loadTakeReview(s, 1), dflt);
});
test("clearTakeReview forgets the bet", () => {
  const s = mem();
  saveTakeReview(s, 7, { tip: true, asset: null });
  clearTakeReview(s, 7);
  assert.deepEqual(loadTakeReview(s, 7), { tip: false, asset: null });
});
