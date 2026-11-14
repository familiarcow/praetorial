// Step (b): the single signer-service entry point. Every check below
// runs BEFORE Privy's raw_sign is ever called -- a rejected tx_intent
// never reaches Privy's API at all. After Privy returns a signature,
// we verify it ourselves against the account's known public key
// (defense in depth: don't trust a vendor response blindly, broadcast
// only a signature we can independently confirm is valid over the
// exact hash we asked it to sign) before broadcasting.
import nacl from "tweetnacl";
import { transactions as T } from "near-api-js";
import { rawSign } from "./privy.js";
import { buildUnsignedTx, attachSignature, broadcast, implicitAccountIdFromPublicKeyHex } from "./nearRaw.js";
import { assertAllowed, PolicyConfig, PolicyViolation } from "./signerPolicy.js";
import { findByUserId, WalletRow } from "./walletStore.js";

export { PolicyViolation };

export interface TxIntent {
  // Which user/wallet is asking to transact -- MUST match the wallet
  // store row for userId, or sign_and_send refuses before anything else.
  userId: string;
  accountId: string; // claimed implicit account id (defense-in-depth re-check)
  receiverId: string;
  methodName: string;
  args: Record<string, unknown>;
  gasTgas?: number;
}

export interface SignAndSendResult {
  ok: boolean;
  txHash?: string;
  error?: string;
  rejectedBeforePrivy?: boolean;
  result?: any;
}

/** Throws PolicyViolation (ownership or allowlist) without calling
 * Privy. Returns the confirmed broadcast result on success. */
export async function signAndSend(policy: PolicyConfig, intent: TxIntent): Promise<SignAndSendResult> {
  // 1. Ownership check: the caller must own the wallet it's asking us
  // to sign with. This is purely a local lookup -- no network call.
  const row = findByUserId(intent.userId);
  if (!row) {
    return { ok: false, rejectedBeforePrivy: true, error: `sign_and_send: no wallet on record for user ${intent.userId}` };
  }
  if (row.implicitAccountId !== intent.accountId) {
    return {
      ok: false,
      rejectedBeforePrivy: true,
      error: `sign_and_send: caller claims account ${intent.accountId} but user ${intent.userId} owns ${row.implicitAccountId} -- refusing`,
    };
  }

  // 2. Allowlist + amount-cap check (lib/signerPolicy.ts). Throws
  // PolicyViolation on any violation; caller catches/propagates.
  try {
    assertAllowed(policy, intent.receiverId, intent.methodName, intent.args);
  } catch (err) {
    if (err instanceof PolicyViolation) {
      return { ok: false, rejectedBeforePrivy: true, error: err.message };
    }
    throw err;
  }

  // 3. Build the tx with the correct nonce + recent block hash.
  const action = T.functionCall(intent.methodName, intent.args, BigInt(intent.gasTgas ?? 80) * 1_000_000_000_000n, 0n);
  const { tx, hash32 } = await buildUnsignedTx(row.implicitAccountId, row.publicKeyHex, intent.receiverId, [action]);

  // 4. Privy raw_sign -- the only network call to Privy in this whole
  // function, and only reached after both checks above passed.
  const sig = await rawSign(row.walletId, hash32);
  const sigBytes = Buffer.from(sig.signatureHex, "hex");

  // 5. Verify the signature ourselves against the account's known
  // public key before ever broadcasting. If this fails, we stop --
  // never send a tx we can't independently confirm is validly signed.
  const pubKeyBytes = Buffer.from(row.publicKeyHex, "hex");
  const valid = nacl.sign.detached.verify(hash32, sigBytes, pubKeyBytes);
  if (!valid) {
    return { ok: false, error: `sign_and_send: Privy's returned signature did NOT verify against ${row.implicitAccountId}'s public key -- refusing to broadcast`, rejectedBeforePrivy: false };
  }

  // 6. Broadcast and confirm.
  const signed = attachSignature(tx, sig.signatureHex);
  const result = await broadcast(signed);
  const txHash = result?.transaction?.hash;
  const succeeded = result?.status?.SuccessValue !== undefined || result?.status?.SuccessReceiptId !== undefined;
  return { ok: succeeded, txHash, result };
}
