import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { buildArchiveMessage, sha256Hex, type ArchiveSnapshot } from "@praetorial/common/archiveSnapshot.js";
import {
  isBetLive,
  isArchiveJobDue,
  ArchiveStore,
  runScheduledArchive,
  ARCHIVE_PERIOD_NS,
  type ArchiveJobClient,
} from "../src/archiveJob.js";
import type { Bet } from "@praetorial/common/types.js";

function fakeBet(status: Bet["status"]): Bet {
  return {
    envelope: {} as any,
    status,
    taker: "taker.near",
    created_at: 0,
  } as unknown as Bet;
}

test("isBetLive is true only for Taken/Resolving/Challenged/Evidence", () => {
  assert.equal(isBetLive(fakeBet("Taken")), true);
  assert.equal(isBetLive(fakeBet("Resolving")), true);
  assert.equal(isBetLive(fakeBet("Challenged")), true);
  assert.equal(isBetLive(fakeBet("Evidence")), true);
  assert.equal(isBetLive(fakeBet("Open")), false);
  assert.equal(isBetLive(fakeBet("Settled")), false);
});

test("isArchiveJobDue: always due on trigger, never for a non-live bet", () => {
  const bet = fakeBet("Taken");
  assert.equal(isArchiveJobDue(bet, { lastArchivedAtNs: 1000n }, 1001n, true), true);
  assert.equal(isArchiveJobDue(fakeBet("Open"), { lastArchivedAtNs: null }, 1000n, true), false);
});

test("isArchiveJobDue: periodic cadence while live, not before ARCHIVE_PERIOD_NS elapses", () => {
  const bet = fakeBet("Challenged");
  assert.equal(isArchiveJobDue(bet, { lastArchivedAtNs: null }, 1000n), true, "never archived yet -> due immediately");
  assert.equal(isArchiveJobDue(bet, { lastArchivedAtNs: 1000n }, 1000n + ARCHIVE_PERIOD_NS - 1n), false);
  assert.equal(isArchiveJobDue(bet, { lastArchivedAtNs: 1000n }, 1000n + ARCHIVE_PERIOD_NS), true);
});

const RAW_TERMS = JSON.stringify({ claim: "x", sources_allowed: [{ id: "coinbase", url: "https://a.example" }] });
const TERMS_HASH = sha256Hex(RAW_TERMS);

function signedSnapshot(betId: string, sourceId: string, capturedAt: string, body: string, kp: nacl.SignKeyPair): ArchiveSnapshot {
  const bodyHash = sha256Hex(body);
  const message = Buffer.from(buildArchiveMessage(betId, sourceId, capturedAt, TERMS_HASH, bodyHash), "utf8");
  const sig = nacl.sign.detached(message, kp.secretKey);
  return {
    betId,
    sourceId,
    capturedAt,
    termsHash: TERMS_HASH,
    body,
    resolverPubkeyHex: Buffer.from(kp.publicKey).toString("hex"),
    signatureHex: Buffer.from(sig).toString("hex"),
  };
}

test("runScheduledArchive stores only snapshots that verify against the bet's resolver_pubkey", async () => {
  const resolverKp = nacl.sign.keyPair();
  const keeperKp = nacl.sign.keyPair(); // old, now-superseded key -- must never be stored
  const betId = "jason-bet-1";
  const resolverPubkeyHex = Buffer.from(resolverKp.publicKey).toString("hex");
  const goodSnap = signedSnapshot(betId, "coinbase", "2028-06-15T14:32:00Z", "candle body A", resolverKp);
  const keeperSignedSnap = signedSnapshot(betId, "bitstamp", "2028-06-15T14:32:00Z", "candle body B", keeperKp);

  // Mocked OutLayer: never a real network/TEE call in this test.
  const mockClient: ArchiveJobClient = {
    async runArchiveJob(_betId, rawTerms) {
      assert.equal(rawTerms, RAW_TERMS);
      return {
        snapshots: [goodSnap, keeperSignedSnap],
        failed: [{ id: "blocked-source", reason: "COULDNT_CHECK: 403 Forbidden" }],
      };
    },
  };

  const store = new ArchiveStore();
  const { stored, failed } = await runScheduledArchive(
    mockClient,
    store,
    betId,
    resolverPubkeyHex,
    TERMS_HASH,
    RAW_TERMS,
  );

  assert.equal(stored.length, 1, "only the resolver-signed snapshot must be stored");
  assert.equal(stored[0].sourceId, "coinbase");
  assert.deepEqual(failed, [{ id: "blocked-source", reason: "COULDNT_CHECK: 403 Forbidden" }]);
  assert.equal(store.get(betId).length, 1);
  assert.equal(store.get(betId)[0].sourceId, "coinbase");
});

test("runScheduledArchive refuses a term sheet that is not the bet's, and drops snapshots for other terms (D-ATTEST1)", async () => {
  const kp = nacl.sign.keyPair();
  const pk = Buffer.from(kp.publicKey).toString("hex");
  const good = signedSnapshot("b1", "coinbase", "2028-06-15T14:32:00Z", "body", kp);
  const otherTerms = { ...good, termsHash: "f".repeat(64) }; // signature no longer matches either
  const client: ArchiveJobClient = {
    async runArchiveJob() {
      return { snapshots: [good, otherTerms], failed: [] };
    },
  };
  const store = new ArchiveStore();
  const { stored } = await runScheduledArchive(client, store, "b1", pk, TERMS_HASH, RAW_TERMS);
  assert.equal(stored.length, 1);
  assert.equal(store.store("b1", pk, "e".repeat(64), [good]).length, 0, "snapshot bound to different terms must not be stored");
  await assert.rejects(runScheduledArchive(client, store, "b1", pk, TERMS_HASH, RAW_TERMS + " "), /terms_hash/);
});
