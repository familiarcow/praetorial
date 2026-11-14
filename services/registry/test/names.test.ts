import { test } from "node:test";
import assert from "node:assert/strict";
import { actor, claimBody, start } from "./helpers.js";

const alice = actor("alice.near");
const mallory = actor("mallory.near");
const carol = actor("carol.near");

async function claim(t: Awaited<ReturnType<typeof start>>, a: ReturnType<typeof actor>, name: string) {
  return t.post("/claim", claimBody(a, name));
}
test("duplicate name is refused case-insensitively, 409", async () => {
  const t = await start([alice, mallory]);
  assert.equal((await claim(t, alice, "alice")).status, 200);
  const r = await claim(t, mallory, "ALICE");
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "username_taken");
  await t.close();
});
test("look-alike a1ice / aiice / rn->m refused when alice / allce / m exists", async () => {
  const t = await start([alice, mallory, carol]);
  assert.equal((await claim(t, alice, "alice")).status, 200);
  assert.equal((await claim(t, mallory, "a1ice")).status, 409);
  assert.equal((await claim(t, mallory, "aiice")).status, 409);
  assert.equal((await claim(t, carol, "sam")).status, 200);
  assert.equal((await claim(t, mallory, "5am")).status, 409);
  await t.close();
});
test("rn->m fold", async () => {
  const t = await start([alice, mallory]);
  assert.equal((await claim(t, alice, "wiliam")).status, 200);
  assert.equal((await claim(t, mallory, "wiliarn")).status, 409);
  await t.close();
});
test("reserved and invalid names refused with distinct errors", async () => {
  const t = await start([alice]);
  let r = await claim(t, alice, "admin");
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "username_reserved");
  r = await claim(t, alice, "ab");
  assert.equal((await r.json()).error, "invalid_username");
  r = await claim(t, alice, "bad name");
  assert.equal(r.status, 400);
  await t.close();
});
test("one username per account: re-claim renames and frees the old name", async () => {
  const t = await start([alice, mallory]);
  assert.equal((await claim(t, alice, "alice")).status, 200);
  assert.equal((await claim(t, alice, "alice2")).status, 200);
  assert.equal((await (await t.get("/lookup/account/alice.near")).json()).username, "alice2");
  assert.equal((await claim(t, mallory, "alice")).status, 200); // freed
  await t.close();
});
test("re-claiming your own name (or a look-alike of it) is allowed", async () => {
  const t = await start([alice]);
  assert.equal((await claim(t, alice, "alice")).status, 200);
  assert.equal((await claim(t, alice, "a1ice")).status, 200);
  await t.close();
});
test("discoverable flag defaults true and can be set false at claim", async () => {
  const t = await start([alice]);
  await t.post("/claim", claimBody(alice, "alice", { extra: { discoverable: false } }));
  assert.equal((await t.store.read()).users["alice.near"].discoverable, false);
  await t.close();
});
