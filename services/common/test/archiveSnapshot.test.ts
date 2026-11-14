import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import nacl from "tweetnacl";
import {
  buildArchiveMessage,
  sha256Hex,
  verifyArchiveSnapshot,
  verifyArchiveSnapshotPinned,
  isArchiveSubmittedInWindow,
  type ArchiveSnapshot,
} from "../src/archiveSnapshot.js";

const TH = "7e57".repeat(16);
const __dirname = dirname(fileURLToPath(import.meta.url));

test("buildArchiveMessage matches the D-FETCH1 part 3 message format", () => {
  assert.equal(
    buildArchiveMessage("bet-1", "coinbase", "2028-06-15T14:32:00Z", "th00", "deadbeef"),
    "praetorial:archive:v2:bet-1:coinbase:2028-06-15T14:32:00Z:th00:deadbeef",
  );
});

// Shared byte cross-check: resolver/core/tests/fixtures/archive_crosscheck.json
// is the one shared contract between resolver/core's
// archive_message_matches_crosscheck_fixture_bytes, judge-proto's Python
// parity, and this test.
test("buildArchiveMessage matches the archive_crosscheck.json fixture bytes", () => {
  const fixturePath = join(__dirname, "..", "..", "..", "resolver", "core", "tests", "fixtures", "archive_crosscheck.json");
  const fx = JSON.parse(readFileSync(fixturePath, "utf8"));
  const bodyHash = sha256Hex(fx.body);
  assert.equal(bodyHash, fx.body_sha256);
  const msg = buildArchiveMessage(fx.bet_id, fx.source_id, fx.captured_at, fx.terms_hash, bodyHash);
  assert.equal(msg, fx.message);
  assert.equal(Buffer.from(msg, "utf8").toString("hex"), fx.message_hex);
});

test("verifyArchiveSnapshot accepts a real resolver signature, rejects tampering", () => {
  const kp = nacl.sign.keyPair();
  const betId = "jason-bet-1";
  const sourceId = "coinbase";
  const capturedAt = "2028-06-15T14:32:00Z";
  const body = "candle high=118500.00";
  const bodyHash = sha256Hex(body);
  const message = Buffer.from(buildArchiveMessage(betId, sourceId, capturedAt, TH, bodyHash), "utf8");
  const sig = nacl.sign.detached(message, kp.secretKey);
  const snap: ArchiveSnapshot = {
    betId,
    sourceId,
    capturedAt,
    termsHash: TH,
    body,
    resolverPubkeyHex: Buffer.from(kp.publicKey).toString("hex"),
    signatureHex: Buffer.from(sig).toString("hex"),
  };
  assert.equal(verifyArchiveSnapshot(snap), true);

  // Tampering the body (hash mismatch), bet_id, or signature all fail.
  assert.equal(verifyArchiveSnapshot({ ...snap, body: "tampered" }), false);
  assert.equal(verifyArchiveSnapshot({ ...snap, betId: "other-bet" }), false);
  assert.equal(verifyArchiveSnapshot({ ...snap, signatureHex: "00".repeat(64) }), false);
});

test("verifyArchiveSnapshot rejects a signature from a different (e.g. old keeper) key", () => {
  // D-FETCH1 part 3 policy flip: a snapshot signed by any key other than
  // the resolver's -- including the old, now-superseded keeper key -- is
  // rejected exactly like any other wrong-key signature.
  const resolverKp = nacl.sign.keyPair();
  const keeperKp = nacl.sign.keyPair(); // stands in for the old keeper key
  const betId = "jason-bet-1";
  const sourceId = "coinbase";
  const capturedAt = "2028-06-15T14:32:00Z";
  const body = "candle high=118500.00";
  const bodyHash = sha256Hex(body);
  const message = Buffer.from(buildArchiveMessage(betId, sourceId, capturedAt, TH, bodyHash), "utf8");
  const keeperSig = nacl.sign.detached(message, keeperKp.secretKey);
  const snap: ArchiveSnapshot = {
    betId,
    sourceId,
    capturedAt,
    termsHash: TH,
    body,
    resolverPubkeyHex: Buffer.from(resolverKp.publicKey).toString("hex"),
    signatureHex: Buffer.from(keeperSig).toString("hex"),
  };
  assert.equal(verifyArchiveSnapshot(snap), false, "a keeper-signed snapshot must be rejected against the resolver pubkey");
});

test("verifyArchiveSnapshotPinned requires the snapshot terms_hash to equal the bet's terms_hash (D-ATTEST1)", () => {
  const kp = nacl.sign.keyPair();
  const pk = Buffer.from(kp.publicKey).toString("hex");
  const body = "candle high=118500.00";
  const capturedAt = "2028-06-15T14:32:00Z";
  const msg = Buffer.from(buildArchiveMessage("b1", "coinbase", capturedAt, TH, sha256Hex(body)), "utf8");
  const snap: ArchiveSnapshot = {
    betId: "b1", sourceId: "coinbase", capturedAt, termsHash: TH, body,
    resolverPubkeyHex: pk, signatureHex: Buffer.from(nacl.sign.detached(msg, kp.secretKey)).toString("hex"),
  };
  assert.equal(verifyArchiveSnapshotPinned(snap, pk, TH), true);
  assert.equal(verifyArchiveSnapshotPinned(snap, pk, `sha256:${TH}`), true);
  assert.equal(verifyArchiveSnapshotPinned(snap, pk, "f".repeat(64)), false, "snapshot for other terms must be refused");
  assert.equal(verifyArchiveSnapshotPinned({ ...snap, termsHash: "f".repeat(64) }, pk, "f".repeat(64)), false, "swapped terms_hash breaks the signature");
});

test("isArchiveSubmittedInWindow: [captured_at, +15min] inclusive; backdated and late are rejected", () => {
  const c = "2028-06-15T14:32:00Z";
  assert.equal(isArchiveSubmittedInWindow(c, "2028-06-15T14:32:00Z"), true);
  assert.equal(isArchiveSubmittedInWindow(c, "2028-06-15T14:47:00Z"), true);
  assert.equal(isArchiveSubmittedInWindow(c, "2028-06-15T14:31:59Z"), false, "backdated");
  assert.equal(isArchiveSubmittedInWindow(c, "2028-06-15T14:47:01Z"), false, "late-posted");
  assert.equal(isArchiveSubmittedInWindow(c, "garbage"), false);
});
