// TESTNET-ONLY stand-in for OutLayer's TEE-bound signing key.
//
// Real OutLayer: the resolver's wasm runs inside a TEE; the signing key is
// bound to (wasm_hash, caller=escrow) and never leaves the enclave. No
// Praetorial service ever holds that key (master map §0, "none of them
// hold a key that can sign an outcome").
//
// This module exists only because contracts/mock-outlayer deliberately
// does NOT sign anything on-chain (see its doc comment: "the mock does
// not sign here ... the signature is produced off-chain by the harness").
// On testnet, something has to play the resolver's role end-to-end so the
// escrow contract's signature-verification code path is exercised for
// real. That "something" is this file — explicitly out-of-band, loaded
// only by the keeper's test-harness mode (PRAETORIAL_RESOLVER_SECRET_KEY
// env var), never by production keeper code against a real OutLayer
// deployment, and never persisted anywhere but a local env var / key file.
import nacl from "tweetnacl";
import { BorshWriter } from "./borsh.js";
import type { SubmittedResult } from "./types.js";

export interface ResolverKeypair {
  publicKeyHex: string;
  secretKey: Uint8Array; // 64-byte nacl secret key (seed+pub)
}

export function generateResolverKeypair(): ResolverKeypair {
  const kp = nacl.sign.keyPair();
  return { publicKeyHex: Buffer.from(kp.publicKey).toString("hex"), secretKey: kp.secretKey };
}

export function resolverKeypairFromSeedHex(seedHex: string): ResolverKeypair {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32) throw new Error("seed must be 32 bytes hex");
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return { publicKeyHex: Buffer.from(kp.publicKey).toString("hex"), secretKey: kp.secretKey };
}

/** True for both RETRY forms: contracts/escrow appends borsh(next_check_ns: u64) for each (JC1s: "RETRY:no_live_judge"). */
export function isRetryOutcome(outcome: string): boolean {
  return outcome === "RETRY" || outcome === "RETRY:no_live_judge";
}

function legacyWriter(escrowAccountId: string, result: SubmittedResult): BorshWriter {
  return new BorshWriter()
    .string(escrowAccountId)
    .u64(result.bet_id)
    .string(result.terms_hash)
    .string(result.outcome)
    .string(result.element_results_hash)
    .u64(result.run_no)
    // checked_until is carried as a decimal string end-to-end (see
    // types.ts doc) specifically so BigInt() here parses the exact
    // same integer that travels over JSON to the contract -- no
    // float round-trip through a JS `number` anywhere in between.
    .u64(BigInt(result.checked_until));
}

function appendNextCheck(writer: BorshWriter, result: SubmittedResult): Buffer {
  // DR-SVC-RETRY-1: submit_outcome appends borsh(next_check_ns: u64) ONLY for the RETRY forms.
  if (isRetryOutcome(result.outcome as string)) {
    if (result.next_check_ns === undefined) {
      throw new Error("buildSubmitOutcomeMessage: RETRY requires next_check_ns");
    }
    writer.u64(BigInt(result.next_check_ns));
  }
  // JC1x (D-JUDGECHAIN1a #1): signed not-found observations go LAST, as borsh(Vec<(String, u64)>), ONLY when present;
  // absent/empty = the JC1s buffer byte-for-byte (older evidence still verifies).
  const obs = result.model_not_found ?? [];
  if (obs.length > 0) {
    writer.u32(obs.length);
    for (const o of obs) writer.string(o.model).u64(BigInt(o.observed_ns));
  }
  return writer.toBuffer();
}

/** Builds the exact buffer contracts/escrow/src/lib.rs `submit_outcome`
 * verifies against: borsh(escrow_account_id) ++ borsh(bet_id) ++
 * borsh(terms_hash) ++ borsh(outcome) ++ borsh(element_results_hash) ++
 * borsh(run_no) ++ borsh(checked_until) ++ borsh(judge_pair_index: u32)
 * [++ borsh(next_check_ns: u64) for the RETRY forms].
 * JC1s (D-JUDGECHAIN1): the index names the judge pair that decided; a missing one signs as 0. */
export function buildSubmitOutcomeMessage(escrowAccountId: string, result: SubmittedResult): Buffer {
  const writer = legacyWriter(escrowAccountId, result).u32(result.judge_pair_index ?? 0);
  return appendNextCheck(writer, result);
}

/** The PRE-JC1s buffer (no judge_pair_index). Only for verifying records signed before JC1s (versioned verification);
 * a current contract never accepts it. */
export function buildLegacySubmitOutcomeMessage(escrowAccountId: string, result: SubmittedResult): Buffer {
  return appendNextCheck(legacyWriter(escrowAccountId, result), result);
}

export function signOutcome(
  escrowAccountId: string,
  result: SubmittedResult,
  secretKey: Uint8Array,
): string {
  const message = buildSubmitOutcomeMessage(escrowAccountId, result);
  const sig = nacl.sign.detached(message, secretKey);
  return Buffer.from(sig).toString("hex");
}
