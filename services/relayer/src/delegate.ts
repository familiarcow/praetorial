// NEP-366 SignedDelegateAction decode + signature verification. No NEAR
// SDK call is required for verification itself -- it's a plain ed25519
// check over the borsh-encoded, NEP-461-prefixed DelegateAction hash,
// done entirely offchain before we ever spend relayer gas broadcasting.
import { createHash } from "node:crypto";
import nacl from "tweetnacl";
import * as borsh from "borsh";
import { SCHEMA, encodeDelegateAction, type DelegateAction } from "@near-js/transactions";

import { BadSignedDelegate } from "./relayerErrors.js";
export { BadSignedDelegate };

export interface DecodedSignedDelegate {
  delegateAction: DelegateAction;
  signatureBytes: Uint8Array;
  publicKeyBytes: Uint8Array; // raw 32-byte ed25519 key taken from delegateAction.publicKey
}

/** Decodes a base64 borsh-encoded SignedDelegateAction. Throws
 * BadSignedDelegate on any malformed input (never partially trusts it). */
export function decodeSignedDelegate(base64: string): DecodedSignedDelegate {
  // Buffer.from(x, "base64") silently skips junk characters, which would give
  // one delegate many string spellings. Require canonical padded base64.
  if (typeof base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new BadSignedDelegate("payload is not canonical base64");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) throw new BadSignedDelegate("payload is not canonical base64");
  if (bytes.length === 0) throw new BadSignedDelegate("empty payload");

  let decoded: any;
  try {
    decoded = borsh.deserialize(SCHEMA.SignedDelegate, bytes);
  } catch (err: any) {
    throw new BadSignedDelegate(`borsh decode failed: ${String(err?.message ?? err)}`);
  }

  // borsh 1.0 ignores unread trailing bytes. Insist that re-encoding the
  // decoded value reproduces the input exactly (no trailing/ignored data).
  try {
    if (!Buffer.from(borsh.serialize(SCHEMA.SignedDelegate, decoded)).equals(bytes)) {
      throw new Error("non-canonical");
    }
  } catch {
    throw new BadSignedDelegate("payload is not a canonical SignedDelegateAction (trailing or ignored bytes)");
  }

  const delegateAction: DelegateAction = decoded.delegateAction;
  const signature = decoded.signature;
  if (!delegateAction || !signature) throw new BadSignedDelegate("missing delegateAction/signature");

  // Borsh-deserialized Enum fields come back as plain `{ variantName: {...} }`
  // objects (no class instance / getters), per @near-js/transactions'
  // Signature/PublicKey Enum shape -- not `{ keyType, data }` directly.
  if (!signature.ed25519Signature) {
    throw new BadSignedDelegate("only ed25519 signatures are supported by this relayer");
  }
  // Borsh fixed-size byte arrays deserialize as plain number[], not a
  // real Uint8Array -- normalize explicitly before any crypto call.
  const signatureBytes: Uint8Array = Uint8Array.from(signature.ed25519Signature.data ?? []);
  if (signatureBytes.length !== 64) {
    throw new BadSignedDelegate("signature must be 64 bytes");
  }

  const pk = delegateAction.publicKey as any;
  if (!pk.ed25519Key) {
    throw new BadSignedDelegate("publicKey must be an ed25519 key");
  }
  const publicKeyBytes: Uint8Array = Uint8Array.from(pk.ed25519Key.data ?? []);
  if (publicKeyBytes.length !== 32) {
    throw new BadSignedDelegate("publicKey must be an ed25519 (32-byte) key");
  }

  return { delegateAction, signatureBytes, publicKeyBytes };
}

/** True iff the signature verifies over the NEP-461-prefixed borsh hash
 * of the delegate action, under the delegate's own claimed public key. */
export function verifySignedDelegate(d: DecodedSignedDelegate): boolean {
  const encoded = encodeDelegateAction(d.delegateAction);
  const hash = createHash("sha256").update(Buffer.from(encoded)).digest();
  return nacl.sign.detached.verify(hash, d.signatureBytes, d.publicKeyBytes);
}
