// FE2: browser-side NEP-413 (near.github.io/NEPs/nep-0413.md) hashing, byte-identical to services/common/src/nep413.ts
// (test-enforced), and a signMessage built on the app's existing wallet path (signRawHash over the hash).
import { sha256 } from "js-sha256";

export const NEP413_TAG = 2 ** 31 + 413;

export interface Nep413Payload { message: string; nonce: Uint8Array; recipient: string }

function borshString(s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

export function hashNep413(p: Nep413Payload): Uint8Array {
  if (p.nonce.length !== 32) throw new Error("nep413 nonce must be exactly 32 bytes");
  const tag = new Uint8Array(4);
  new DataView(tag.buffer).setUint32(0, NEP413_TAG, true);
  const parts = [tag, borshString(p.message), p.nonce, borshString(p.recipient), new Uint8Array([0])];
  const buf = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) { buf.set(x, o); o += x.length; }
  return new Uint8Array(sha256.arrayBuffer(buf));
}

const toHex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => {
  const s = h.replace(/^0x/, "");
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
};

/** signMessage for claimUsername: signs the NEP-413 hash through the wallet's signRawHash (hex in, hex out). */
export function makeSignMessage(address: string, signRawHash: (address: string, hashHex: string) => Promise<string>) {
  return async (p: Nep413Payload): Promise<{ signature: Uint8Array }> => {
    const sig = await signRawHash(address, toHex(hashNep413(p)));
    return { signature: fromHex(sig) };
  };
}
