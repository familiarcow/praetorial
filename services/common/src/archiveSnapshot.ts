// D-FETCH1 part 3 / queue item 7f3 (2026-11-05): archive snapshots are
// enclave-signed by the RESOLVER key (OutLayer short run), never
// keeper-signed. Mirrors `resolver/core/src/lib.rs::archive_message`
// byte-for-byte and `judge-proto/evidence.py::archive_message` (Python
// parity) -- all three, plus the resolver's own `is_resolver_archive`
// check, must build/check the identical message string:
//
//   praetorial:archive:v2:{bet_id}:{source_id}:{captured_at}:{terms_hash}:{sha256(body)}
//
// D-ATTEST1 (7g4): v2 commits `terms_hash` (derived by the wasm from the raw
// term sheet in the job); a verifier MUST check it equals the bet's own
// on-chain `Envelope.terms_hash` (`verifyArchiveSnapshotPinned`) and that the
// exhibit's on-chain submit time is within [captured_at, captured_at + 15min]
// (`isArchiveSubmittedInWindow`).
//
// Renamed/superseded from the old keeper-signed design -- see Decision
// register D-FETCH1 part 3.
import { createHash } from "node:crypto";
import nacl from "tweetnacl";

/** Builds the exact message the resolver signs (and any verifier checks)
 * over one archive snapshot. */
export function buildArchiveMessage(
  betId: string,
  sourceId: string,
  capturedAt: string,
  termsHash: string,
  bodySha256Hex: string,
): string {
  return `praetorial:archive:v2:${betId}:${sourceId}:${capturedAt}:${termsHash}:${bodySha256Hex}`;
}

/** D-ATTEST1: an archive snapshot is admissible only if its authoritative
 * on-chain `submitted_at` lies in [capturedAt, capturedAt + 15min]
 * (inclusive both ends). Mirrors resolver/core `ARCHIVE_SUBMIT_WINDOW_SECS`
 * and judge-proto/evidence.py `ARCHIVE_SUBMIT_WINDOW`. Both ISO8601 UTC. */
export const ARCHIVE_SUBMIT_WINDOW_MS = 15 * 60 * 1000;
export function isArchiveSubmittedInWindow(capturedAtIso: string, submittedAtIso: string): boolean {
  const c = Date.parse(capturedAtIso);
  const s = Date.parse(submittedAtIso);
  if (Number.isNaN(c) || Number.isNaN(s)) return false;
  return s >= c && s <= c + ARCHIVE_SUBMIT_WINDOW_MS;
}

export function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

export interface ArchiveSnapshot {
  betId: string;
  sourceId: string;
  /** ISO8601 UTC. */
  capturedAt: string;
  /** D-ATTEST1: sha256(raw term sheet) the wasm derived and signed over. */
  termsHash: string;
  body: string;
  /** hex, 64 chars. Self-declared by the snapshot -- NEVER trust this
   * field alone (see `verifyArchiveSnapshotPinned`). */
  resolverPubkeyHex: string;
  /** hex, 128 chars (64 bytes). */
  signatureHex: string;
}

/** Verifies an `ArchiveSnapshot` was really signed by its OWN declared
 * `resolverPubkeyHex` over the exact D-FETCH1 part 3 message for this
 * snapshot's bound fields. Never throws on malformed hex/length --
 * returns `false`.
 *
 * SECURITY NOTE (D-KEY1, queue item 7g2): this only checks internal
 * self-consistency -- it does NOT check that `resolverPubkeyHex` is a
 * key anyone should trust. A caller deciding whether to store an
 * archive snapshot as evidence MUST use `verifyArchiveSnapshotPinned`
 * with the contract's own pinned `attest_pubkey` (from the escrow
 * contract's `resolver_keys()` view), never a bet/envelope field and
 * never this function alone. */
export function verifyArchiveSnapshot(snap: ArchiveSnapshot): boolean {
  try {
    const bodyHash = sha256Hex(snap.body);
    const message = Buffer.from(buildArchiveMessage(snap.betId, snap.sourceId, snap.capturedAt, snap.termsHash, bodyHash), "utf8");
    const sig = Buffer.from(snap.signatureHex, "hex");
    const pubkey = Buffer.from(snap.resolverPubkeyHex, "hex");
    if (sig.length !== 64 || pubkey.length !== 32) return false;
    return nacl.sign.detached.verify(message, sig, pubkey);
  } catch {
    return false;
  }
}

/** D-KEY1 (7g2): the ONLY verification a caller should actually trust.
 * Requires the snapshot's declared `resolverPubkeyHex` to equal
 * `pinnedAttestPubkeyHex` -- the contract's own pinned `attest_pubkey`
 * from its `resolver_keys()` view -- AND the signature to verify.
 * **Policy note:** this is the ONLY trusted signer now -- a
 * keeper-signed snapshot (the pre-2026-11-05 design) or any
 * self-consistent-but-wrong-key snapshot is rejected exactly like any
 * other non-pinned signature. */
export function verifyArchiveSnapshotPinned(
  snap: ArchiveSnapshot,
  pinnedAttestPubkeyHex: string,
  betTermsHash: string,
): boolean {
  if (snap.resolverPubkeyHex !== pinnedAttestPubkeyHex) return false;
  // D-ATTEST1: the snapshot must be for THIS bet's term sheet.
  const want = betTermsHash.startsWith("sha256:") ? betTermsHash.slice(7) : betTermsHash;
  if (!want || snap.termsHash !== want) return false;
  return verifyArchiveSnapshot(snap);
}
