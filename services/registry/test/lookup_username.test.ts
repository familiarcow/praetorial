import { test } from "node:test";
import assert from "node:assert/strict";
import { actor, claimBody, start } from "./helpers.js";

const HEX = "ab".repeat(24) + "0123456789abcdef"; // 64 hex
async function seeded(over = {}) {
  const names: Array<[string, string, boolean?]> = [["alice", "alice.near"], ["bob_ref", HEX], ["ghost", "ghost.near", false]];
  const actors = names.map(([, a]) => actor(a));
  const t = await start(actors, over);
  for (let i = 0; i < names.length; i++) {
    const r = await t.post("/claim", claimBody(actors[i], names[i][0], names[i][2] === false ? { extra: { discoverable: false } } : {}));
    assert.equal(r.status, 200);
  }
  return t;
}
test("exact username -> {username, account_id}; implicit id returned in FULL", async () => {
  const t = await seeded();
  const a = await t.get("/lookup/username/alice");
  assert.equal(a.status, 200);
  assert.deepEqual(await a.json(), { username: "alice", account_id: "alice.near" });
  const b = await t.get("/lookup/username/bob_ref");
  assert.deepEqual(await b.json(), { username: "bob_ref", account_id: HEX });
  await t.close();
});
test("case-insensitive, @ stripped, look-alike folded", async () => {
  const t = await seeded();
  for (const q of ["ALICE", "%40Alice", "a1ice", "aliCe"]) {
    const r = await t.get("/lookup/username/" + q);
    assert.equal(r.status, 200, q);
    assert.deepEqual(await r.json(), { username: "alice", account_id: "alice.near" });
  }
  await t.close();
});
test("non-exact, prefix, partial, empty, junk -> 404 not_found", async () => {
  const t = await seeded();
  for (const q of ["ali", "alic", "alice2", "lice", "bob", "nobody", "", "al%2Fice", "alice%20", "a.b"]) {
    const r = await t.get("/lookup/username/" + q);
    assert.equal(r.status, 404, q);
    assert.deepEqual(await r.json(), { error: "not_found" });
  }
  await t.close();
});
test("undiscoverable user still resolvable by exact name", async () => {
  const t = await seeded();
  assert.deepEqual(await (await t.get("/lookup/username/ghost")).json(), { username: "ghost", account_id: "ghost.near" });
  await t.close();
});
test("rate limit shared with /search (429 + retry-after)", async () => {
  const u = actor("alice.near");
  const s = await start([u], { rate: { capacity: 2, refillPerSec: 0.001 } });
  assert.equal((await s.get("/search?q=a")).status, 200);
  assert.equal((await s.get("/lookup/username/alice")).status, 404);
  const r = await s.get("/lookup/username/alice");
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get("retry-after")) >= 1);
  assert.equal((await s.get("/search?q=a")).status, 429);
  await s.close();
});
test("/search output unchanged: still only username + account_tail", async () => {
  const t = await seeded();
  const rows = await (await t.get("/search?q=bob")).json();
  assert.deepEqual(rows, [{ username: "bob_ref", account_tail: HEX.slice(-8) }]);
  await t.close();
});
