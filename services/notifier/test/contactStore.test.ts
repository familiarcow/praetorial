// RED-first tests for PII minimisation (TASK A). Contact info (email /
// telegram handle) must be encrypted at rest (AES-256-GCM, node:crypto),
// keyed by NEAR account id, with a user-deletion path that removes
// everything for that account. Nothing else personal is ever stored.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContactStore } from "../src/contactStore.js";

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "notifier-contactstore-test-"));
  return join(dir, "contacts.sqlite3");
}

const KEY_A = "a".repeat(64); // 32 bytes hex
const KEY_B = "b".repeat(64); // a different 32-byte hex key

function cleanup(dbPath: string) {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
}

test("refuses to start without a contact key", () => {
  const dbPath = tmpDbPath();
  assert.throws(() => new ContactStore(dbPath, undefined));
  assert.throws(() => new ContactStore(dbPath, ""));
  cleanup(dbPath);
});

test("refuses a malformed (wrong-length) key", () => {
  const dbPath = tmpDbPath();
  assert.throws(() => new ContactStore(dbPath, "not-32-bytes-hex"));
  cleanup(dbPath);
});

test("ciphertext on disk contains no plaintext contact info", () => {
  const dbPath = tmpDbPath();
  const store = new ContactStore(dbPath, KEY_A);
  const plaintextEmail = "alice.secret.address@example.com";
  const plaintextHandle = "@alice_super_secret_handle";
  store.setContact("alice.testnet", "email", plaintextEmail);
  store.setContact("bob.testnet", "telegram", plaintextHandle);
  store.close();

  const raw = readFileSync(dbPath).toString("latin1");
  assert.ok(!raw.includes(plaintextEmail), "raw db file must not contain the plaintext email");
  assert.ok(!raw.includes(plaintextHandle), "raw db file must not contain the plaintext telegram handle");
  assert.ok(!raw.includes("alice.secret.address"), "no fragment of the plaintext may leak either");
  cleanup(dbPath);
});

test("the stored account id round-trips and decrypts with the right key", () => {
  const dbPath = tmpDbPath();
  const store = new ContactStore(dbPath, KEY_A);
  store.setContact("alice.testnet", "email", "alice@example.com");
  const got = store.getContact("alice.testnet");
  assert.deepEqual(got, { kind: "email", value: "alice@example.com" });
  store.close();
  cleanup(dbPath);
});

test("wrong key fails to decrypt (never returns plaintext)", () => {
  const dbPath = tmpDbPath();
  const store1 = new ContactStore(dbPath, KEY_A);
  store1.setContact("alice.testnet", "email", "alice@example.com");
  store1.close();

  const store2 = new ContactStore(dbPath, KEY_B);
  assert.throws(() => store2.getContact("alice.testnet"));
  store2.close();
  cleanup(dbPath);
});

test("deleteContact removes all rows for that account and nothing else", () => {
  const dbPath = tmpDbPath();
  const store = new ContactStore(dbPath, KEY_A);
  store.setContact("alice.testnet", "email", "alice@example.com");
  store.setContact("alice.testnet", "telegram", "@alice");
  store.setContact("bob.testnet", "email", "bob@example.com");

  store.deleteContact("alice.testnet");

  assert.equal(store.getContact("alice.testnet"), null);
  assert.equal(store.rowCountForAccount("alice.testnet"), 0);
  // bob's contact is untouched.
  assert.deepEqual(store.getContact("bob.testnet"), { kind: "email", value: "bob@example.com" });
  store.close();
  cleanup(dbPath);
});

test("getContact returns null for an account with no stored contact", () => {
  const dbPath = tmpDbPath();
  const store = new ContactStore(dbPath, KEY_A);
  assert.equal(store.getContact("nobody.testnet"), null);
  store.close();
  cleanup(dbPath);
});
