import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import nacl from "tweetnacl";
import {
  buildSourceCheckMessage,
  verifySourceCheckAttestation,
  verifySourceCheckAttestationPinned,
  isSourceCheckFresh,
  SOURCECHECK_FRESHNESS_WINDOW_NS,
  requestSourceCheckBeforeOpen,
  SourceCheckRequiredError,
  type SourceCheckAttestation,
  type SourceCheckChainClient,
} from "../src/sourceCheck.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

import { createHash } from "node:crypto";
const RAW = JSON.stringify({ claim: "x", sources_allowed: [{ id: "S1", url: "https://a.example/page" }] });
const hashOf = (raw: string) => createHash("sha256").update(raw, "utf8").digest("hex");

test("buildSourceCheckMessage matches the D-FETCH2 message format", () => {
  assert.equal(
    buildSourceCheckMessage("abc123", "42"),
    "praetorial:sourcecheck:v1:abc123:42",
  );
});

test("buildSourceCheckMessage rejects a non-integer checkedAt", () => {
  assert.throws(() => buildSourceCheckMessage("abc", "not-a-number"));
});

// Shared byte cross-check: contracts/escrow/tests/fixtures/sourcecheck_crosscheck.json
// is the one shared contract between contracts/escrow, resolver/core's
// sourcecheck_message_matches_crosscheck_fixture_bytes, and this test.
test("buildSourceCheckMessage matches the sourcecheck_crosscheck.json fixture bytes", () => {
  const fixturePath = join(__dirname, "..", "..", "..", "contracts", "escrow", "tests", "fixtures", "sourcecheck_crosscheck.json");
  const fx = JSON.parse(readFileSync(fixturePath, "utf8"));
  const msg = buildSourceCheckMessage(fx.spec_hash, fx.checked_at);
  assert.equal(msg, fx.message);
  assert.equal(Buffer.from(msg, "utf8").toString("hex"), fx.message_hex);
});

test("verifySourceCheckAttestation accepts a real signature, rejects a tampered one", () => {
  const kp = nacl.sign.keyPair();
  const specHash = "h".repeat(64);
  const checkedAt = "1000";
  const message = Buffer.from(buildSourceCheckMessage(specHash, checkedAt), "utf8");
  const sig = nacl.sign.detached(message, kp.secretKey);
  const att: SourceCheckAttestation = {
    specHash,
    checkedAt,
    resolverPubkeyHex: Buffer.from(kp.publicKey).toString("hex"),
    signatureHex: Buffer.from(sig).toString("hex"),
  };
  assert.equal(verifySourceCheckAttestation(att), true);

  assert.equal(verifySourceCheckAttestation({ ...att, specHash: "i".repeat(64) }), false);
  assert.equal(verifySourceCheckAttestation({ ...att, checkedAt: "1001" }), false);
  assert.equal(verifySourceCheckAttestation({ ...att, signatureHex: "00".repeat(64) }), false);

  const otherKp = nacl.sign.keyPair();
  assert.equal(
    verifySourceCheckAttestation({ ...att, resolverPubkeyHex: Buffer.from(otherKp.publicKey).toString("hex") }),
    false,
  );
});

test("verifySourceCheckAttestation never throws on malformed hex/length", () => {
  assert.equal(
    verifySourceCheckAttestation({ specHash: "x", checkedAt: "1", resolverPubkeyHex: "zz", signatureHex: "zz" }),
    false,
  );
  assert.equal(
    verifySourceCheckAttestation({ specHash: "x", checkedAt: "1", resolverPubkeyHex: "aa", signatureHex: "bb" }),
    false,
  );
});

// Freshness window: documented rule is INCLUSIVE at exactly 1h -- a
// sourcecheck exactly 1h old at the moment `open` lands is still valid;
// 1h + 1ns is not. A future checked_at is always refused regardless.
test("isSourceCheckFresh: within window true, exactly at the 1h boundary true (inclusive)", () => {
  const checkedAt = 1_000_000_000n;
  const now = checkedAt + SOURCECHECK_FRESHNESS_WINDOW_NS;
  assert.equal(isSourceCheckFresh(checkedAt, now), true);
});

test("isSourceCheckFresh: 1h + 1ns old is refused", () => {
  const checkedAt = 1_000_000_000n;
  const now = checkedAt + SOURCECHECK_FRESHNESS_WINDOW_NS + 1n;
  assert.equal(isSourceCheckFresh(checkedAt, now), false);
});

test("isSourceCheckFresh: future checked_at is always refused, even if 'within window'", () => {
  const now = 1_000_000_000n;
  const checkedAtInFuture = now + 1n;
  assert.equal(isSourceCheckFresh(checkedAtInFuture, now), false);
});

// Keeper/job-builder policy: sourcecheck must run and succeed BEFORE an
// Open transfer_with_msg is ever built, sponsored like round 0
// (keeper_credit, D-ECON5) -- mocked chain client, no real OutLayer call.
test("requestSourceCheckBeforeOpen returns the attestation when every source is reachable", async () => {
  const specHash = hashOf(RAW);
  const expected: SourceCheckAttestation = {
    specHash,
    checkedAt: "500",
    resolverPubkeyHex: "a".repeat(64),
    signatureHex: "b".repeat(128),
  };
  const client: SourceCheckChainClient = {
    async runSourceCheck(gotRaw) {
      assert.equal(gotRaw, RAW);
      return expected;
    },
  };
  const att = await requestSourceCheckBeforeOpen(client, specHash, RAW);
  assert.deepEqual(att, expected);
});

test("requestSourceCheckBeforeOpen throws and never returns an attestation when a source is unreachable (creation must fail, D-FETCH2)", async () => {
  const client: SourceCheckChainClient = {
    async runSourceCheck() {
      return null; // resolver found an unreachable source
    },
  };
  await assert.rejects(
    requestSourceCheckBeforeOpen(client, hashOf(RAW), RAW),
    SourceCheckRequiredError,
  );
});

test("requestSourceCheckBeforeOpen throws if the attestation's spec_hash doesn't match the term sheet being opened", async () => {
  const client: SourceCheckChainClient = {
    async runSourceCheck() {
      return {
        specHash: hashOf(RAW) + "-tampered",
        checkedAt: "500",
        resolverPubkeyHex: "a".repeat(64),
        signatureHex: "b".repeat(128),
      };
    },
  };
  await assert.rejects(
    requestSourceCheckBeforeOpen(client, hashOf(RAW), RAW),
    SourceCheckRequiredError,
  );
});

// D-KEY1 (7g2): the trusted signer for a sourcecheck attestation is the
// contract's own pinned `attest_pubkey` (resolver_keys() view), never a
// bet/envelope field, and never whatever key the attestation itself
// happens to self-declare. `verifySourceCheckAttestation` alone only
// checks internal self-consistency (signature matches the embedded
// pubkey) -- an attacker who signs with their OWN keypair produces an
// attestation that passes it, even though it was never produced by the
// real attest key. `verifySourceCheckAttestationPinned` must refuse any
// attestation whose embedded key isn't the pinned attest key, even if
// otherwise perfectly self-consistent.
test("verifySourceCheckAttestationPinned rejects a self-consistent attestation signed by a non-pinned key", () => {
  const attackerKp = nacl.sign.keyPair();
  const pinnedAttestKp = nacl.sign.keyPair();
  const pinnedAttestPubkeyHex = Buffer.from(pinnedAttestKp.publicKey).toString("hex");

  const specHash = "spec-hash-abc".padEnd(64, "0");
  const checkedAt = "1000";
  const attackerMessage = Buffer.from(buildSourceCheckMessage(specHash, checkedAt), "utf8");
  const attackerSig = nacl.sign.detached(attackerMessage, attackerKp.secretKey);
  const attackerAttestation: SourceCheckAttestation = {
    specHash,
    checkedAt,
    resolverPubkeyHex: Buffer.from(attackerKp.publicKey).toString("hex"),
    signatureHex: Buffer.from(attackerSig).toString("hex"),
  };

  // Self-consistent (attacker validly signed with their own key) --
  // this alone is NOT enough to trust it.
  assert.equal(verifySourceCheckAttestation(attackerAttestation), true);
  // Pinned check must reject it: the embedded key isn't the contract's
  // pinned attest_pubkey.
  assert.equal(verifySourceCheckAttestationPinned(attackerAttestation, pinnedAttestPubkeyHex), false);

  // And must accept the real thing: signed by, and declaring, the
  // pinned attest key.
  const realMessage = Buffer.from(buildSourceCheckMessage(specHash, checkedAt), "utf8");
  const realSig = nacl.sign.detached(realMessage, pinnedAttestKp.secretKey);
  const realAttestation: SourceCheckAttestation = {
    specHash,
    checkedAt,
    resolverPubkeyHex: pinnedAttestPubkeyHex,
    signatureHex: Buffer.from(realSig).toString("hex"),
  };
  assert.equal(verifySourceCheckAttestationPinned(realAttestation, pinnedAttestPubkeyHex), true);

  // Tampered pubkey field (claims the pin but isn't signed by it) must
  // also be rejected.
  assert.equal(
    verifySourceCheckAttestationPinned({ ...realAttestation, resolverPubkeyHex: "f".repeat(64) }, pinnedAttestPubkeyHex),
    false,
  );
});

test("requestSourceCheckBeforeOpen refuses a spec_hash that is not sha256(raw term sheet) (D-ATTEST1)", async () => {
  const client: SourceCheckChainClient = {
    async runSourceCheck() {
      throw new Error("must not run");
    },
  };
  await assert.rejects(requestSourceCheckBeforeOpen(client, "s".repeat(64), RAW), SourceCheckRequiredError);
});
