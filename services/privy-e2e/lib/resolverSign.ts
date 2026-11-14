// Copied (not imported) from services/common/src/resolverSign.ts --
// same testnet-only OutLayer-TEE stand-in, scoped into this folder.
import nacl from "tweetnacl";
import { BorshWriter } from "./borsh.js";

export interface SubmittedResult {
  bet_id: number;
  terms_hash: string;
  outcome: string;
  element_results_hash: string;
  run_no: number;
  checked_until: string;
  judge_pair_index?: number; // JC1s
  model_not_found?: { model: string; observed_ns: string }[]; // JC1x (ignored by this e2e signer: it never signs observations)
}

export interface ResolverKeypair {
  publicKeyHex: string;
  secretKey: Uint8Array;
}

export function generateResolverKeypair(): ResolverKeypair {
  const kp = nacl.sign.keyPair();
  return { publicKeyHex: Buffer.from(kp.publicKey).toString("hex"), secretKey: kp.secretKey };
}

export function buildSubmitOutcomeMessage(escrowAccountId: string, result: SubmittedResult): Buffer {
  return new BorshWriter()
    .string(escrowAccountId)
    .u64(result.bet_id)
    .string(result.terms_hash)
    .string(result.outcome)
    .string(result.element_results_hash)
    .u64(result.run_no)
    .u64(BigInt(result.checked_until))
    .u32(result.judge_pair_index ?? 0) // JC1s
    .toBuffer();
}

export function signOutcome(escrowAccountId: string, result: SubmittedResult, secretKey: Uint8Array): string {
  const message = buildSubmitOutcomeMessage(escrowAccountId, result);
  const sig = nacl.sign.detached(message, secretKey);
  return Buffer.from(sig).toString("hex");
}
