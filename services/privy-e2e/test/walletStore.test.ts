// RED -> GREEN tests for the SQLite-backed wallet store (lib/walletStore.ts).
// Covers: unique indexes (user id + NEAR account id), atomic
// create-if-absent under concurrency, WAL mode, one-shot JSON
// migration, and restart persistence.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  getDb,
  closeDb,
  findByUserId,
  findByEmail,
  findByAccountId,
  createIfAbsent,
  WalletRow,
} from "../lib/walletStore.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "praetorial-walletstore-test-"));
}

function makeRow(overrides: Partial<WalletRow> = {}): WalletRow {
  const n = Math.random().toString(36).slice(2);
  return {
    privyUserId: overrides.privyUserId ?? `did:privy:user-${n}`,
    email: overrides.email ?? `user-${n}@example.com`,
    walletId: overrides.walletId ?? `wallet-${n}`,
    publicKeyHex: overrides.publicKeyHex ?? n.padEnd(64, "0").slice(0, 64),
    implicitAccountId: overrides.implicitAccountId ?? (overrides.publicKeyHex ?? n.padEnd(64, "0").slice(0, 64)),
    createdAt: overrides.createdAt ?? new Date().toISOString(),
  };
}

describe("walletStore (SQLite)", () => {
  test("WAL mode is enabled on a file-backed db", () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "wal.db");
    try {
      const db = getDb(dbPath);
      const row = db.prepare("PRAGMA journal_mode").get() as any;
      assert.equal(String(row.journal_mode).toLowerCase(), "wal");
    } finally {
      closeDb(dbPath);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("createIfAbsent inserts a fresh row and returns created:true", () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "wallets.db");
    try {
      const row = makeRow();
      const result = createIfAbsent(row, dbPath);
      assert.equal(result.created, true);
      assert.equal(result.row.privyUserId, row.privyUserId);
      assert.deepEqual(findByUserId(row.privyUserId, dbPath), row);
      assert.deepEqual(findByEmail(row.email, dbPath), row);
      assert.deepEqual(findByAccountId(row.implicitAccountId, dbPath), row);
    } finally {
      closeDb(dbPath);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("createIfAbsent for the same privyUserId a second time is idempotent (no duplicate row)", () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "wallets.db");
    try {
      const first = makeRow({ privyUserId: "did:privy:dup-user" });
      const second = makeRow({ privyUserId: "did:privy:dup-user" }); // different wallet/account, same user id (simulated race)
      const r1 = createIfAbsent(first, dbPath);
      const r2 = createIfAbsent(second, dbPath);
      assert.equal(r1.created, true);
      assert.equal(r2.created, false);
      // both callers must see the SAME winning row
      assert.equal(r2.row.walletId, r1.row.walletId);
      assert.equal(r2.row.implicitAccountId, r1.row.implicitAccountId);

      const db = getDb(dbPath);
      const count = db.prepare("SELECT COUNT(*) as n FROM wallets WHERE privy_user_id = ?").get("did:privy:dup-user") as any;
      assert.equal(count.n, 1);
    } finally {
      closeDb(dbPath);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a genuine NEAR account id collision across two different privy user ids throws", () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "wallets.db");
    try {
      const sharedAccount = "a".repeat(64);
      const rowA = makeRow({ privyUserId: "did:privy:user-a", implicitAccountId: sharedAccount, publicKeyHex: sharedAccount });
      const rowB = makeRow({ privyUserId: "did:privy:user-b", implicitAccountId: sharedAccount, publicKeyHex: sharedAccount });
      createIfAbsent(rowA, dbPath);
      assert.throws(() => createIfAbsent(rowB, dbPath), /already claimed|UNIQUE/i);
    } finally {
      closeDb(dbPath);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("concurrency: many parallel create calls for the same user yield exactly one wallet", async () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "wallets.db");
    try {
      const userId = "did:privy:race-user";
      const N = 25;
      const contenders = Array.from({ length: N }, () => makeRow({ privyUserId: userId }));
      const results = await Promise.all(
        contenders.map(
          (row) =>
            new Promise<{ row: WalletRow; created: boolean }>((resolve) => {
              // setImmediate spreads the (synchronous) DB calls across
              // separate microtask/macrotask turns so this genuinely
              // exercises interleaving-safe logic rather than one
              // straight-line synchronous loop.
              setImmediate(() => resolve(createIfAbsent(row, dbPath)));
            })
        )
      );

      const createdCount = results.filter((r) => r.created).length;
      assert.equal(createdCount, 1, `expected exactly 1 created:true, got ${createdCount}`);

      const winningAccountIds = new Set(results.map((r) => r.row.implicitAccountId));
      assert.equal(winningAccountIds.size, 1, "all callers must be handed back the SAME account id");

      const db = getDb(dbPath);
      const count = db.prepare("SELECT COUNT(*) as n FROM wallets WHERE privy_user_id = ?").get(userId) as any;
      assert.equal(count.n, 1);
    } finally {
      closeDb(dbPath);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("one-shot migration imports an existing JSON file on first open", () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "wallets.db");
    const jsonPath = path.join(dir, "wallets.json");
    const legacyRows: WalletRow[] = [makeRow(), makeRow(), makeRow()];
    fs.writeFileSync(jsonPath, JSON.stringify(legacyRows, null, 2));
    try {
      getDb(dbPath, jsonPath); // first open -- should trigger migration
      for (const r of legacyRows) {
        assert.deepEqual(findByUserId(r.privyUserId, dbPath), r);
      }
      const db = getDb(dbPath, jsonPath);
      const count = db.prepare("SELECT COUNT(*) as n FROM wallets").get() as any;
      assert.equal(count.n, legacyRows.length);
    } finally {
      closeDb(dbPath);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("migration is one-shot: re-adding rows to the JSON file does not re-import on a later open", () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "wallets.db");
    const jsonPath = path.join(dir, "wallets.json");
    const legacyRows: WalletRow[] = [makeRow()];
    fs.writeFileSync(jsonPath, JSON.stringify(legacyRows, null, 2));
    try {
      getDb(dbPath, jsonPath); // migrates the one row
      closeDb(dbPath);

      // JSON file grows after the db already has data (e.g. a stray
      // leftover file); migration must NOT run again.
      fs.writeFileSync(jsonPath, JSON.stringify([...legacyRows, makeRow()], null, 2));
      getDb(dbPath, jsonPath); // second open -- must be a no-op for migration
      const db = getDb(dbPath, jsonPath);
      const count = db.prepare("SELECT COUNT(*) as n FROM wallets").get() as any;
      assert.equal(count.n, 1, "migration must not re-run once the db already has rows");
    } finally {
      closeDb(dbPath);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restart persistence: data written before close() is visible after reopening the same path", () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "wallets.db");
    const row = makeRow();
    try {
      createIfAbsent(row, dbPath);
      closeDb(dbPath); // simulate process restart: drop the in-memory handle

      // Reopen fresh -- this must read what's actually on disk, not any
      // cached in-process state.
      const reopened = findByUserId(row.privyUserId, dbPath);
      assert.deepEqual(reopened, row);
    } finally {
      closeDb(dbPath);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unique index rejects a raw duplicate privy_user_id insert even outside createIfAbsent", () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, "wallets.db");
    try {
      const row = makeRow();
      createIfAbsent(row, dbPath);
      const db = getDb(dbPath);
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO wallets (privy_user_id, email, wallet_id, public_key_hex, implicit_account_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
            )
            .run(row.privyUserId, "other@example.com", "other-wallet", "b".repeat(64), "b".repeat(64), new Date().toISOString()),
        /UNIQUE constraint failed/
      );
    } finally {
      closeDb(dbPath);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
