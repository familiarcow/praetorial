// Tier-1 NEAR tx building/broadcast, adapted from
// services/privy-e2e/lib/nearRaw.ts. The server builds the unsigned
// tx and hash; the browser's own Privy session signs it; the server
// verifies the signature itself before ever broadcasting.
import { transactions as T, utils } from "near-api-js";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import { testnetProvider, withRetry, viewAccessKeyNonce, latestBlockHashBytes } from "./rpc.js";

export function implicitAccountIdFromPublicKeyHex(pubkeyHex: string): string {
  const hex = pubkeyHex.replace(/^0x/, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a 32-byte hex pubkey: ${pubkeyHex}`);
  return hex;
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

export function attachSignature(
  tx: InstanceType<typeof T.Transaction>,
  signatureHex: string,
): InstanceType<typeof T.SignedTransaction> {
  const sigBytes = Buffer.from(signatureHex.replace(/^0x/, ""), "hex");
  if (sigBytes.length !== 64) throw new Error(`expected 64-byte ed25519 signature, got ${sigBytes.length}`);
  const signature = new T.Signature({ keyType: 0, data: sigBytes });
  return new T.SignedTransaction({ transaction: tx, signature });
}

export async function broadcast(signed: InstanceType<typeof T.SignedTransaction>): Promise<any> {
  const p = testnetProvider();
  return withRetry(() => p.sendTransaction(signed), "sendTransaction");
}

/** Polls tx_status until the execution outcome and ALL receipts are
 * FINAL, not just included. Returns the final status payload. */
export async function waitForFinal(txHash: string, senderId: string, attempts = 20): Promise<any> {
  const p = testnetProvider();
  for (let i = 0; i < attempts; i++) {
    try {
      const res: any = await (p as any).txStatus(txHash, senderId, "FINAL");
      if (res?.final_execution_status === "FINAL" || res?.status) return res;
    } catch (err) {
      // not yet indexed -- keep polling
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`waitForFinal: tx ${txHash} did not reach FINAL after ${attempts} polls`);
}
