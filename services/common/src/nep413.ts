// NEP-413 off-chain message signing (near.github.io/NEPs/nep-0413.md),
// built the same way NEAR Intents' own `intents.near` Verifier
// expects it (docs.near-intents.org/integration/verifier-contract/
// signing-intents): borsh-encode {tag, message, nonce, recipient,
// callback_url}, sha256 it, and that's the hash a Tier-1 signer
// (Privy raw_sign) signs -- same mechanism as a native tx, different
// payload shape.
import { createHash, randomBytes } from "node:crypto";

export const NEP413_TAG = 2 ** 31 + 413; // 2147484061, per the NEP

function borshString(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

function borshOptionString(s: string | undefined): Buffer {
  if (s === undefined) return Buffer.from([0]);
  return Buffer.concat([Buffer.from([1]), borshString(s)]);
}

export interface Nep413Payload {
  message: string;
  nonce: Buffer; // exactly 32 bytes
  recipient: string;
  callbackUrl?: string;
}

export function borshEncodeNep413(payload: Nep413Payload): Buffer {
  if (payload.nonce.length !== 32) throw new Error("nep413 nonce must be exactly 32 bytes");
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG, 0);
  return Buffer.concat([
    tag,
    borshString(payload.message),
    payload.nonce,
    borshString(payload.recipient),
    borshOptionString(payload.callbackUrl),
  ]);
}

export function hashNep413(payload: Nep413Payload): Buffer {
  return createHash("sha256").update(borshEncodeNep413(payload)).digest();
}

export function randomNonce(): Buffer {
  return randomBytes(32);
}

/** Builds the exact intents.near "Transfer-with-msg" style NEP-413
 * message body this task asks for: a signed `transfer` intent moving
 * a token to a receiver, carried in the standard
 * {signer_id, deadline, intents:[...]} JSON envelope that
 * intents.near's MultiPayload expects (docs.near-intents.org/
 * integration/verifier-contract/intent-types-and-execution). View-only
 * use via simulate_intents -- nothing is ever executed/spent. */
export function buildIntentsTransferMessage(opts: {
  signerId: string;
  receiverId: string;
  tokenId: string;
  amount: string;
  deadlineIso: string;
}): string {
  return JSON.stringify({
    signer_id: opts.signerId,
    deadline: opts.deadlineIso,
    intents: [
      {
        intent: "transfer",
        receiver_id: opts.receiverId,
        tokens: { [opts.tokenId]: opts.amount },
      },
    ],
  });
}
