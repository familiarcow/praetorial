// FE2 / S1b: username validator parity with REG1 (services/registry/src/rules.ts), message mapping, availability check.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeUsername, foldUsername, validateUsername, usernameErrorMessage, claimErrorMessage, suggestUsername, checkAvailability, USERNAME_RULES } from "../lib/username";
import * as server from "../../../services/registry/src/rules";

// SAME fixture list as REG1's server tests (services/registry/test/rules.test.ts + names.test.ts), plus edge cases.
const FIXTURES: string[] = [
  "@Alice_9", "ab", "a".repeat(21), "a".repeat(20), "abc", "al ice", "al-ice", "älice", "@@alice", "",
  "praetorial", "admin", "support", "referee", "ai", "guardian", "Admin", "adm1n", "guard1an", "pra3torial",
  "a1ice", "aiice", "allce", "b0b", "5am", "wiliarn", "wiliam", "alice", "alicia", "  bob_9  ", "A_B", "___", "9lives",
];

test("validateUsername matches REG1's server validator on every fixture", () => {
  for (const f of FIXTURES) {
    assert.equal(validateUsername(f), server.validateUsername(f), `validate ${JSON.stringify(f)}`);
    assert.equal(normalizeUsername(f), server.normalizeUsername(f), `normalize ${JSON.stringify(f)}`);
    assert.equal(foldUsername(f), server.foldUsername(f), `fold ${JSON.stringify(f)}`);
  }
});

test("fold pairs from REG1's tests: a1ice~alice, aiice~allce, b0b~bob, 5am~sam, wiliarn~wiliam; alice !~ alicia", () => {
  assert.equal(foldUsername("a1ice"), foldUsername("alice"));
  assert.equal(foldUsername("aiice"), foldUsername("allce"));
  assert.equal(foldUsername("b0b"), foldUsername("bob"));
  assert.equal(foldUsername("5am"), foldUsername("sam"));
  assert.equal(foldUsername("wiliarn"), foldUsername("wiliam"));
  assert.notEqual(foldUsername("alice"), foldUsername("alicia"));
});

test("rules are listed in plain words (no regex, no jargon)", () => {
  const text = USERNAME_RULES.join(" ");
  assert.match(text, /3 to 20/);
  assert.match(text, /letters, digits/i);
  assert.match(text, /underscore/i);
  assert.doesNotMatch(text, /[\[\]\\^$]/);
});

test("local validation errors map to plain messages", () => {
  assert.match(usernameErrorMessage("too_short"), /at least 3/);
  assert.match(usernameErrorMessage("too_long"), /20/);
  assert.match(usernameErrorMessage("bad_chars"), /letters, digits/i);
  assert.match(usernameErrorMessage("reserved"), /can't be used|not available|reserved/i);
});

test("server claim errors map to messages: taken (with suggestion), look-alike, reserved, invalid, rate limit, down", () => {
  const taken = claimErrorMessage({ ok: false, error: "username_taken", status: 409 }, "alice");
  assert.match(taken.message, /That name is taken\. Try /);
  assert.equal(taken.kind, "taken");
  assert.ok(taken.suggestion && validateUsername(taken.suggestion) === null);
  assert.equal(claimErrorMessage({ ok: false, error: "username_reserved", status: 400 }, "admin").kind, "reserved");
  assert.equal(claimErrorMessage({ ok: false, error: "invalid_username", status: 400 }, "ab").kind, "invalid");
  assert.equal(claimErrorMessage({ ok: false, error: "rate_limited", status: 429 }, "x").kind, "rate_limited");
  const down = claimErrorMessage({ ok: false, error: "network: Failed to fetch" }, "alice");
  assert.equal(down.kind, "down");
  assert.equal(down.message, "We can't reach usernames right now. You can look around; betting needs a username, so try again in a moment.");
  assert.equal(claimErrorMessage({ ok: false, error: "internal", status: 500 }, "alice").kind, "down");
  assert.match(claimErrorMessage({ ok: false, error: "signature_failed: user rejected" }, "alice").message, /approve|sign/i);
});

test("suggestUsername returns a valid name different from the input, within 20 chars", () => {
  for (const n of ["alice", "a".repeat(20), "bob_9"]) {
    const s = suggestUsername(n);
    assert.notEqual(s, n);
    assert.equal(validateUsername(s), null);
    assert.ok(s.length <= 20);
  }
});

function searchFetch(rows: { username: string; account_tail: string }[], status = 200) {
  const calls: string[] = [];
  const f = (async (u: string) => { calls.push(u); return new Response(JSON.stringify(rows), { status }); }) as unknown as typeof fetch;
  return { f, calls };
}

test("checkAvailability: free / taken / look-alike / own name / unknown", async () => {
  let r = await checkAvailability("https://reg.example", "alice", { fetchImpl: searchFetch([]).f });
  assert.deepEqual(r, { state: "free" });
  r = await checkAvailability("https://reg.example", "Alice", { fetchImpl: searchFetch([{ username: "alice", account_tail: "bob.near" }]).f });
  assert.equal(r.state, "taken");
  r = await checkAvailability("https://reg.example", "a1ice", { fetchImpl: searchFetch([{ username: "alice", account_tail: "bob.near" }]).f });
  assert.deepEqual(r, { state: "lookalike", of: "alice" });
  r = await checkAvailability("https://reg.example", "alice", { myAccount: "me.near", fetchImpl: searchFetch([{ username: "alice", account_tail: "me.near" }]).f });
  assert.equal(r.state, "free");
  r = await checkAvailability("https://reg.example", "alice", { fetchImpl: searchFetch([], 500).f });
  assert.equal(r.state, "unknown");
  r = await checkAvailability("https://reg.example", "ab", { fetchImpl: searchFetch([]).f });
  assert.equal(r.state, "invalid");
  const { f, calls } = searchFetch([]);
  await checkAvailability("https://reg.example/", "@Alice", { fetchImpl: f });
  assert.equal(calls[0], "https://reg.example/search?q=alice");
});
