// Host-neutral NEP-413 digest (CF1f): no node builtins. Byte-identical to @praetorial/common/nep413.ts hashNep413 (a test pins it),
// so the node server and the Cloudflare Worker verify the very same signed payload. sha256 is js-sha256 (pure JS, runs in workerd).
import { sha256 } from "js-sha256";

export const NEP413_TAG = 2 ** 31 + 413;
const enc = new TextEncoder();

function borshString(s: string): Uint8Array {
  const b = enc.encode(s); const out = new Uint8Array(4 + b.length);
  new DataView(out.buffer).setUint32(0, b.length, true); out.set(b, 4); return out;
}
export interface Nep413Input { message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string }
export function nep413Digest(p: Nep413Input): Uint8Array {
  if (p.nonce.length !== 32) throw new Error("nep413 nonce must be exactly 32 bytes");
  const tag = new Uint8Array(4); new DataView(tag.buffer).setUint32(0, NEP413_TAG, true);
  const cb = p.callbackUrl === undefined ? new Uint8Array([0]) : new Uint8Array([1, ...borshString(p.callbackUrl)]);
  const parts = [tag, borshString(p.message), p.nonce, borshString(p.recipient), cb];
  const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let o = 0;
  for (const x of parts) { all.set(x, o); o += x.length; }
  return new Uint8Array(sha256.arrayBuffer(all));
}
