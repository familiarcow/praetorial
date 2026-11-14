import { test } from "node:test";
import assert from "node:assert/strict";
import { actor, claimBody, start } from "./helpers.js";

const HEX = "ab".repeat(24) + "0123456789abcdef"; // 64 hex
async function seeded() {
  const names: Array<[string, string, boolean?]> = [
    ["alice", "alice.near"], ["alicia_k", "alicia-k.testnet"], ["malice", "malice.near"],
    ["bob", HEX], ["ghost", "ghost.near", false],
  ];
  const actors = names.map(([, acct]) => actor(acct));
  const t = await start(actors);
  for (let i = 0; i < names.length; i++) {
    const r = await t.post("/claim", claimBody(actors[i], names[i][0], names[i][2] === false ? { extra: { discoverable: false } } : {}));
    assert.equal(r.status, 200, names[i][0]);
  }
  return t;
}
test("search returns only {username, account_tail}; named account = full id, implicit = last 8", async () => {
  const t = await seeded();
  const rows = await (await t.get("/search?q=bob")).json();
  assert.deepEqual(rows, [{ username: "bob", account_tail: HEX.slice(-8) }]);
  const a = await (await t.get("/search?q=alice")).json();
  for (const row of a) assert.deepEqual(Object.keys(row).sort(), ["account_tail", "username"]);
  assert.ok(a.some((r: any) => r.username === "alice" && r.account_tail === "alice.near"));
  await t.close();
});
test("prefix matches rank before substring matches; substring works", async () => {
  const t = await seeded();
  const rows = await (await t.get("/search?q=alic")).json();
  assert.deepEqual(rows.map((r: any) => r.username), ["alice", "alicia_k", "malice"]);
  await t.close();
});
test("search folds look-alikes and case, strips @", async () => {
  const t = await seeded();
  assert.ok((await (await t.get("/search?q=%40A1ICE")).json()).some((r: any) => r.username === "alice"));
  await t.close();
});
test("discoverable=false excluded from search but resolvable by exact lookup", async () => {
  const t = await seeded();
  assert.deepEqual(await (await t.get("/search?q=ghost")).json(), []);
  const l = await t.get("/lookup/account/ghost.near");
  assert.equal(l.status, 200);
  assert.equal((await l.json()).username, "ghost");
  await t.close();
});
test("search caps at 10 results; empty q returns []", async () => {
  const actors = Array.from({ length: 15 }, (_, i) => actor(`u${i}.near`));
  const t = await start(actors);
  for (let i = 0; i < 15; i++) assert.equal((await t.post("/claim", claimBody(actors[i], `user_${String.fromCharCode(97 + i)}${i}`))).status, 200);
  assert.equal((await (await t.get("/search?q=user")).json()).length, 10);
  assert.deepEqual(await (await t.get("/search?q=")).json(), []);
  await t.close();
});
test("lookup: unknown account 404; response never leaks key or extra fields", async () => {
  const t = await seeded();
  assert.equal((await t.get("/lookup/account/nobody.near")).status, 404);
  const body = await (await t.get("/lookup/account/alice.near")).json();
  assert.deepEqual(Object.keys(body), ["username"]);
  const raw = JSON.stringify(await (await t.get("/search?q=a")).json());
  assert.ok(!raw.includes("ed25519"));
  await t.close();
});
test("unknown route 404; /health ok", async () => {
  const t = await seeded();
  assert.equal((await t.get("/nope")).status, 404);
  assert.equal((await t.get("/health")).status, 200);
  await t.close();
});
