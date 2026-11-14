import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, JsonFileStore, type RegistryState } from "../src/store.js";

const sample = (): RegistryState => ({ users: { "alice.near": { username: "alice", account_id: "alice.near", public_key: "ed25519:x", discoverable: true, claimed_at: 1 } }, nonces: { abc: 5 } });

test("MemoryStore round-trips and isolates copies", async () => {
  const s = new MemoryStore();
  assert.deepEqual(await s.read(), { users: {}, nonces: {} });
  await s.write(sample());
  const r = await s.read();
  r.users["alice.near"].username = "mutated";
  assert.equal((await s.read()).users["alice.near"].username, "alice");
});
test("JsonFileStore persists across instances and writes atomically (temp + rename, no stray temp)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reg-"));
  const p = join(dir, "reg.json");
  const s = new JsonFileStore(p);
  assert.deepEqual(await s.read(), { users: {}, nonces: {} });
  await s.write(sample());
  assert.deepEqual(await new JsonFileStore(p).read(), sample());
  assert.deepEqual(readdirSync(dir), ["reg.json"]);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), sample());
});
test("JsonFileStore refuses a corrupt file instead of silently resetting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reg-"));
  const p = join(dir, "reg.json");
  writeFileSync(p, "{not json");
  await assert.rejects(() => new JsonFileStore(p).read());
});
