// Tier-1 NEAR support per docs.privy.io/recipes/tier-2-wallet-integration's
// NEAR worked example: build an unsigned Transaction with near-api-js,
// borsh-serialize it, sha256 the bytes, hand that 32-byte hash to
// Privy's raw_sign, then reassemble + broadcast a SignedTransaction.
// Privy never sees transaction semantics -- it signs a hash. Any
// transaction-content safety rail (allowlists, amount caps) MUST live
// here, before signHash() is ever called (see lib/signerPolicy.ts).
import { transactions as T, utils, providers } from "near-api-js";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { provider, withRetry, viewAccessKeyNonce, latestBlockHashBytes } from "./rpc.js";

export function implicitAccountIdFromPublicKeyHex(pubkeyHex: string): string {
  const hex = pubkeyHex.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a 32-byte hex pubkey: ${pubkeyHex}`);
  return hex; // NEAR implicit account id == hex(ed25519 pubkey)
}

export function publicKeyFromHex(pubkeyHex: string): utils.PublicKey {
  const hex = pubkeyHex.replace(/^0x/, "");
  const bytes = Buffer.from(hex, "hex");
  return utils.PublicKey.fromString("ed25519:" + bs58.encode(bytes));
}

export interface UnsignedTxBuild {
  tx: InstanceType<typeof T.Transaction>;
  hash32: Uint8Array;
}

/** Builds an unsigned Transaction for `accountId` (whose implicit
 * account id is derived from `publicKeyHex`) calling `actions` against
 * `receiverId`, and returns the exact sha256(borsh(tx)) hash a Tier-1
 * signer (Privy raw_sign) must sign. */
export async function buildUnsignedTx(
  accountId: string,
  publicKeyHex: string,
  receiverId: string,
  actions: T.Action[],
): Promise<UnsignedTxBuild> {
  const pubKey = publicKeyFromHex(publicKeyHex);
  const nonce = await viewAccessKeyNonce(accountId, pubKey.toString());
  const blockHash = await latestBlockHashBytes();
  const tx = T.createTransaction(accountId, pubKey, receiverId, nonce, actions, blockHash);
  const serialized = T.encodeTransaction(tx);
  const hash32 = createHash("sha256").update(serialized).digest();
  return { tx, hash32 };
}

/** Attaches a raw ed25519 signature (64 bytes hex, no 0x) to an
 * unsigned Transaction, producing a broadcastable SignedTransaction. */
export function attachSignature(tx: InstanceType<typeof T.Transaction>, signatureHex: string): InstanceType<typeof T.SignedTransaction> {
  const sigBytes = Buffer.from(signatureHex.replace(/^0x/, ""), "hex");
  if (sigBytes.length !== 64) throw new Error(`expected 64-byte ed25519 signature, got ${sigBytes.length}`);
  const signature = new T.Signature({ keyType: 0, data: sigBytes }); // 0 = ED25519
  return new T.SignedTransaction({ transaction: tx, signature });
}

export async function broadcast(signed: InstanceType<typeof T.SignedTransaction>): Promise<any> {
  const p = provider();
  return withRetry(() => p.sendTransaction(signed), "sendTransaction");
}

/** signHash: the one function that must go through Privy's raw_sign
 * (or, for the funder/taker's own plain near-api-js key, a local sign)
 * -- see lib/signerPolicy.ts for the allowlist gate that wraps this
 * for anything acting on behalf of a Privy wallet. */
export type SignHashFn = (hash32: Uint8Array) => Promise<string>; // returns hex signature, no 0x

export async function buildSignBroadcast(
  accountId: string,
  publicKeyHex: string,
  receiverId: string,
  actions: T.Action[],
  signHash: SignHashFn,
): Promise<{ txHash: string; result: any }> {
  const { tx, hash32 } = await buildUnsignedTx(accountId, publicKeyHex, receiverId, actions);
  const sigHex = await signHash(hash32);
  const signed = attachSignature(tx, sigHex);
  const result = await broadcast(signed);
  return { txHash: result?.transaction?.hash ?? result?.transaction_outcome?.id, result };
}
