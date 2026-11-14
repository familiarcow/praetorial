// Direct tests of the persistent SQLite guard store: survives a process
// restart (reopen the same file, state must still be there) and is safe
// against a concurrent double-submit race (two "simultaneous" calls for
// the same (sender, key, nonce) must not both succeed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuardStore, GuardViolation } from "../src/guardStore.js";

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "relayer-guardstore-test-"));
  return join(dir, "guards.sqlite3");
}

test("persistence: a nonce marked seen survives closing and reopening the store (simulated restart)", () => {
  const dbPath = tmpDbPath();
  const cfg = { maxRequestsPerWindow: 100, windowMs: 60_000, dailyBudgetYocto: 10_000_000_000_000_000_000_000n };

  const store1 = new GuardStore(dbPath, cfg);
  store1.checkAndMarkReplay("alice.testnet", "pubkey-a", 1n);
  store1.close(); // simulates the relayer process exiting

  // Reopen against the SAME file -- a fresh process would do exactly this.
  const store2 = new GuardStore(dbPath, cfg);
  assert.throws(() => store2.checkAndMarkReplay("alice.testnet", "pubkey-a", 1n), GuardViolation);
  // A different nonce for the same sender/key must still be fine.
  assert.doesNotThrow(() => store2.checkAndMarkReplay("alice.testnet", "pubkey-a", 2n));
  store2.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

test("persistence: a settled budget survives closing and reopening the store", () => {
  const dbPath = tmpDbPath();
  const cfg = { maxRequestsPerWindow: 100, windowMs: 60_000, dailyBudgetYocto: 10_000_000_000_000_000_000_000n };

  const store1 = new GuardStore(dbPath, cfg);
  const { reservationId } = store1.reserveBudget("bob.testnet", 4_000_000_000_000_000_000_000n);
  store1.settleBudget("bob.testnet", reservationId, 3_000_000_000_000_000_000_000n);
  assert.equal(store1.spentYoctoToday("bob.testnet"), 3_000_000_000_000_000_000_000n);
  store1.close();

  const store2 = new GuardStore(dbPath, cfg);
  assert.equal(store2.spentYoctoToday("bob.testnet"), 3_000_000_000_000_000_000_000n);
  // Budget cap is 0.01 NEAR; 0.003 already spent + a 0.008 reservation
  // would exceed it (0.011 > 0.01) -- must still be enforced post-restart.
  assert.throws(
    () => store2.reserveBudget("bob.testnet", 8_000_000_000_000_000_000_000n),
    GuardViolation,
  );
  store2.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

test("persistence: rate-limit timestamps survive closing and reopening the store", () => {
  const dbPath = tmpDbPath();
  const cfg = { maxRequestsPerWindow: 1, windowMs: 60_000, dailyBudgetYocto: 10_000_000_000_000_000_000_000n };

  const store1 = new GuardStore(dbPath, cfg);
  store1.checkRateLimit("carol.testnet"); // uses up the only slot in the window
  store1.close();

  const store2 = new GuardStore(dbPath, cfg);
  assert.throws(() => store2.checkRateLimit("carol.testnet"), GuardViolation);
  store2.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

test("race: concurrent double-submit of the same (sender, key, nonce) -- exactly one wins", async () => {
  const dbPath = tmpDbPath();
  const cfg = { maxRequestsPerWindow: 100, windowMs: 60_000, dailyBudgetYocto: 10_000_000_000_000_000_000_000n };
  const store = new GuardStore(dbPath, cfg);

  // node:sqlite's DatabaseSync is synchronous, so true parallel threads
  // aren't in play within one process -- the race that matters here is
  // "two requests interleaved on the event loop, each trying to mark the
  // same nonce seen inside its own transaction". Model that directly:
  // fire N "concurrent" attempts and confirm exactly one of N succeeds,
  // never zero and never more than one.
  const N = 20;
  const attempts = Array.from({ length: N }, (_, i) =>
    Promise.resolve().then(() => {
      try {
        store.checkAndMarkReplay("racer.testnet", "pubkey-r", 7n);
        return "ok" as const;
      } catch (err) {
        if (err instanceof GuardViolation) return "rejected" as const;
        throw err;
      }
    }),
  );
  const results = await Promise.all(attempts);
  const okCount = results.filter((r) => r === "ok").length;
  const rejectedCount = results.filter((r) => r === "rejected").length;
  assert.equal(okCount, 1, "exactly one of the N concurrent double-submits must succeed");
  assert.equal(rejectedCount, N - 1, "every other concurrent double-submit must be rejected as a replay");

  store.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});

test("race: concurrent reservations against a tight budget never let total reserved exceed the cap", async () => {
  const dbPath = tmpDbPath();
  const perReservation = 1_000_000_000_000_000_000_000n; // 0.001 NEAR
  const cap = 5n * perReservation; // room for exactly 5
  const cfg = { maxRequestsPerWindow: 1000, windowMs: 60_000, dailyBudgetYocto: cap };
  const store = new GuardStore(dbPath, cfg);

  const N = 20; // far more attempts than the budget allows
  const attempts = Array.from({ length: N }, () =>
    Promise.resolve().then(() => {
      try {
        const { reservationId } = store.reserveBudget("tightbudget.testnet", perReservation);
        return { ok: true as const, reservationId };
      } catch (err) {
        if (err instanceof GuardViolation) return { ok: false as const };
        throw err;
      }
    }),
  );
  const results = await Promise.all(attempts);
  const successes = results.filter((r) => r.ok);
  assert.equal(successes.length, 5, "exactly cap/perReservation reservations should succeed, no more");

  store.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
});
