import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUsername, foldUsername, validateUsername, RESERVED } from "../src/rules.js";

test("normalize lowercases and strips one leading @", () => {
  assert.equal(normalizeUsername("@Alice_9"), "alice_9");
});
test("length 3-20 and charset [a-z0-9_]", () => {
  assert.equal(validateUsername("ab"), "too_short");
  assert.equal(validateUsername("a".repeat(21)), "too_long");
  assert.equal(validateUsername("a".repeat(20)), null);
  assert.equal(validateUsername("abc"), null);
  assert.equal(validateUsername("al ice"), "bad_chars");
  assert.equal(validateUsername("al-ice"), "bad_chars");
  assert.equal(validateUsername("älice"), "bad_chars");
  assert.equal(validateUsername("@@alice"), "bad_chars");
});
test("reserved names refused", () => {
  for (const r of ["praetorial", "admin", "support", "referee", "ai", "guardian"]) assert.ok(RESERVED.includes(r));
  for (const r of ["praetorial", "admin", "support", "referee", "guardian"]) assert.equal(validateUsername(r), "reserved");
  assert.equal(validateUsername("Admin"), "reserved");
});
test("reserved check is look-alike aware (adm1n, ra1etorial)", () => {
  assert.equal(validateUsername("adm1n"), "reserved");
  assert.equal(validateUsername("guard1an"), "reserved");
});
test("fold: 0->o 1->l i->l 5->s rn->m", () => {
  assert.equal(foldUsername("a1ice"), foldUsername("alice"));
  assert.equal(foldUsername("aiice"), foldUsername("allce"));
  assert.equal(foldUsername("b0b"), foldUsername("bob"));
  assert.equal(foldUsername("5am"), foldUsername("sam"));
  assert.equal(foldUsername("wiliarn"), foldUsername("wiliam"));
  assert.notEqual(foldUsername("alice"), foldUsername("alicia"));
});
