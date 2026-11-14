// Client-side NEP-366 SignedDelegateAction builder. Mirrors
// services/relayer/src/delegate.ts's decode path in reverse: builds a
// DelegateAction for one FunctionCall, hashes it (NEP-461 prefix +
// sha256, same as the relayer verifies), and the caller gets back the
// raw hash to sign via Privy's signRawHash (D-PRIVY1) -- this module
// never touches a private key itself.
import { actionCreators, buildDelegateAction, SCHEMA, encodeDelegateAction, type DelegateAction } from "@near-js/transactions";
import { PublicKey } from "@near-js/crypto";
import * as borsh from "borsh";
import { sha256 } from "js-sha256";

export interface BuildDelegateParams {
  senderId: string; // the user's own NEAR account id (implicit account from Privy)
  receiverId: string; // escrow or intents contract
  methodName: string;
  args: Record<string, unknown>;
  gasTgas: number;
  depositYocto?: string; // "0" for calls that move no NEAR (all value moves via NEP-141)
  publicKeyHexEd25519: string; // the user's own ed25519 public key, hex, 32 bytes. For a NEAR implicit account this IS the account id itself (Privy's nearWallet.address).
  nonce: bigint; // caller must fetch the account's current access-key nonce + 1
  maxBlockHeight: bigint; // current block height + a short window (relayer enforces RELAYER_MAX_BLOCK_HEIGHT_FUTURE)
}

export interface PreparedDelegate {
  delegateAction: DelegateAction;
  hashHex: string; // NEP-461-prefixed sha256 hash of the borsh-encoded DelegateAction, hex, no 0x -- what the wallet must sign
}

/** Builds the unsigned DelegateAction + the exact hash Privy's
 * signRawHash must sign over it. Does not sign or broadcast. */
export function prepareDelegate(p: BuildDelegateParams): PreparedDelegate {
  const publicKey = PublicKey.fromString("ed25519:" + base58FromHex(p.publicKeyHexEd25519));
  const action = actionCreators.functionCall(
    p.methodName,
    Buffer.from(JSON.stringify(p.args)),
    BigInt(p.gasTgas) * 1_000_000_000_000n,
    BigInt(p.depositYocto ?? "0"),
  );
  const delegateAction = buildDelegateAction({
    actions: [action],
    senderId: p.senderId,
    receiverId: p.receiverId,
    publicKey,
    nonce: p.nonce,
    maxBlockHeight: p.maxBlockHeight,
  });
  const encoded = encodeDelegateAction(delegateAction);
  const hashHex = sha256(Buffer.from(encoded));
  return { delegateAction, hashHex };
}

// NEAR public keys are base58 in ed25519:<base58> form. A NEAR implicit
// account id IS the hex-encoded raw ed25519 public key (32 bytes, 64 hex
// chars) -- exactly what Privy's nearWallet.address already is, so no
// separate "get the public key" call is needed. Converts hex -> base58
// without pulling in bs58 as a separate dep (same alphabet near-api-js
// itself uses).
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58FromHex(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = Uint8Array.from(Buffer.from(clean, "hex"));
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte === 0) leadingZeros++;
    else break;
  }
  const str = digits.reverse().map((d) => B58_ALPHABET[d]).join("");
  return "1".repeat(leadingZeros) + str;
}

/** Combines the DelegateAction + its wallet-produced ed25519 signature
 * into the base64 borsh SignedDelegateAction the relayer's POST /relay
 * expects (exact inverse of services/relayer/src/delegate.ts::decodeSignedDelegate). */
export function encodeSignedDelegate(delegateAction: DelegateAction, signatureHex: string): string {
  const sigHex = signatureHex.startsWith("0x") ? signatureHex.slice(2) : signatureHex;
  const sigBytes = Uint8Array.from(Buffer.from(sigHex, "hex"));
  if (sigBytes.length !== 64) throw new Error(`expected 64-byte ed25519 signature, got ${sigBytes.length}`);
  const signed = {
    delegateAction,
    signature: { ed25519Signature: { data: Array.from(sigBytes) } },
  };
  const bytes = borsh.serialize(SCHEMA.SignedDelegate, signed as any);
  return Buffer.from(bytes).toString("base64");
}
