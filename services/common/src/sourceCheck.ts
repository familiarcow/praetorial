// D-FETCH2 / queue item 7f2: mandatory sources-reachable attestation at
// bet creation (tightens D-FETCH1). Mirrors
// `resolver/core/src/lib.rs::sourcecheck_message` byte-for-byte and
// `judge-proto/evidence.py::sourcecheck_message` (Python parity) -- all
// three, plus the contract's own verification, must build/check the
// identical message string:
//
//   praetorial:sourcecheck:v1:{spec_hash}:{checked_at}
//
// `spec_hash` is the term sheet's existing hash field (contracts/escrow's
// `Envelope.terms_hash` -- no new hash scheme invented here). `checked_at`
// is nanoseconds since epoch, carried as a decimal string end-to-end
// (same convention as `SubmittedResult.checked_until`, see resolverSign.ts)
// so a real on-chain nanosecond timestamp never round-trips through a
// lossy JS `number`.
import { createHash } from "node:crypto";
import nacl from "tweetnacl";

/** Builds the exact message a resolver signs (and the contract verifies)
 * to attest every listed source was reachable at `checkedAtNs` for the
 * term sheet identified by `specHash`. */
export function buildSourceCheckMessage(specHash: string, checkedAtNs: string | bigint): string {
  const checkedAt = typeof checkedAtNs === "bigint" ? checkedAtNs.toString() : checkedAtNs;
  if (!/^\d+$/.test(checkedAt)) {
    throw new Error(`buildSourceCheckMessage: checkedAtNs must be a non-negative integer, got ${checkedAtNs}`);
  }
  return `praetorial:sourcecheck:v1:${specHash}:${checkedAt}`;
}

export interface SourceCheckAttestation {
  specHash: string;
  /** Nanoseconds since epoch, decimal string. */
  checkedAt: string;
  /** hex, 64 chars. Self-declared by the attestation -- NEVER trust
   * this field alone (see `verifySourceCheckAttestationPinned`). */
  resolverPubkeyHex: string;
  /** hex, 128 chars (64 bytes). */
  signatureHex: string;
}

/** Verifies a `SourceCheckAttestation` was really signed by its OWN
 * declared `resolverPubkeyHex` over the exact D-FETCH2 message for
 * `specHash`/`checkedAt`. Never throws on malformed hex/length --
 * returns `false`.
 *
 * SECURITY NOTE (D-KEY1, queue item 7g2): this only checks internal
 * self-consistency -- it does NOT check that `resolverPubkeyHex` is a
 * key anyone should trust. A caller deciding whether to accept a
 * sourcecheck attestation MUST use `verifySourceCheckAttestationPinned`
 * with the contract's own pinned `attest_pubkey` (from the escrow
 * contract's `resolver_keys()` view), never a bet/envelope field and
 * never this function alone. */
export function verifySourceCheckAttestation(att: SourceCheckAttestation): boolean {
  try {
    const message = Buffer.from(buildSourceCheckMessage(att.specHash, att.checkedAt), "utf8");
    const sig = Buffer.from(att.signatureHex, "hex");
    const pubkey = Buffer.from(att.resolverPubkeyHex, "hex");
    if (sig.length !== 64 || pubkey.length !== 32) return false;
    return nacl.sign.detached.verify(message, sig, pubkey);
  } catch {
    return false;
  }
}

/** D-KEY1 (7g2): the ONLY verification a caller should actually trust.
 * Requires the attestation's declared `resolverPubkeyHex` to equal
 * `pinnedAttestPubkeyHex` -- the contract's own pinned `attest_pubkey`
 * from its `resolver_keys()` view -- AND the signature to verify.
 * Rejects an otherwise-valid attestation signed by any other key,
 * including a self-consistent one signed by an attacker's own
 * keypair. */
export function verifySourceCheckAttestationPinned(att: SourceCheckAttestation, pinnedAttestPubkeyHex: string): boolean {
  if (att.resolverPubkeyHex !== pinnedAttestPubkeyHex) return false;
  return verifySourceCheckAttestation(att);
}

/** One hour in nanoseconds -- the D-FETCH2 freshness window. Boundary
 * rule (documented, matches the contract side): `now - checkedAt <=
 * ONE_HOUR_NS` is ACCEPTED (inclusive) -- a sourcecheck exactly 1h old at
 * the moment `open` lands is still valid; 1h + 1ns is not. A future
 * `checkedAt` (checkedAt > now) is always refused regardless of this
 * window. */
export const SOURCECHECK_FRESHNESS_WINDOW_NS = 3600n * 1_000_000_000n;

export function isSourceCheckFresh(checkedAtNs: string | bigint, nowNs: string | bigint): boolean {
  const checkedAt = BigInt(checkedAtNs);
  const now = BigInt(nowNs);
  if (checkedAt > now) return false; // future checked_at always refused
  return now - checkedAt <= SOURCECHECK_FRESHNESS_WINDOW_NS;
}

// ---------------------------------------------------------------------
// Keeper / job-builder policy: a sourcecheck run must complete (and
// produce a fresh, valid attestation) BEFORE an `Open` transfer_with_msg
// is ever submitted. Sponsored like round 0 (D-ECON5's keeper_credit
// zero-deposit mode) -- never charged to the maker's own deposit.
// ---------------------------------------------------------------------

export interface SourceCheckChainClient {
  /** Runs the resolver's sourcecheck job (OutLayer in production; a test
   * double here) and returns the resulting attestation, or `null` if any
   * source was unreachable. D-ATTEST1 (7g4): the job carries ONLY the raw
   * term sheet -- the wasm derives spec_hash (sha256 of it), the source
   * list and checked_at itself. Billed against
   * `keeper_credit`, same sponsorship as a round-0 resolution run -- the
   * caller never attaches a deposit for this call. */
  runSourceCheck(rawTerms: string): Promise<SourceCheckAttestation | null>;
}

export class SourceCheckRequiredError extends Error {
  constructor(reason: string) {
    super(`sourcecheck required before open, and did not succeed: ${reason}`);
  }
}

/** Queue item 7f2 (D-FETCH2): called by the keeper/job-builder before
 * building an `Open` transfer_with_msg. Requests a sourcecheck run
 * (sponsored from keeper credit, like round 0) and returns the resulting
 * attestation to attach to the open message; throws
 * `SourceCheckRequiredError` if any listed source couldn't be checked --
 * creation must never proceed without one (D-FETCH2: "if any can't be
 * fetched, creation fails"). D-ATTEST1: `specHash` must be
 * sha256(rawTerms) (the envelope's terms_hash) and the attestation must
 * come back for exactly that hash. */
export async function requestSourceCheckBeforeOpen(
  client: SourceCheckChainClient,
  specHash: string,
  rawTerms: string,
): Promise<SourceCheckAttestation> {
  if (createHash("sha256").update(rawTerms, "utf8").digest("hex") !== specHash) {
    throw new SourceCheckRequiredError("spec_hash is not sha256 of the raw term sheet being opened");
  }
  const attestation = await client.runSourceCheck(rawTerms);
  if (attestation === null) {
    throw new SourceCheckRequiredError("resolver reported one or more unreachable sources");
  }
  if (attestation.specHash !== specHash) {
    throw new SourceCheckRequiredError("attestation spec_hash does not match the term sheet being opened");
  }
  return attestation;
}
