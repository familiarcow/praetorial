// Runtime-neutral byte helpers (no Buffer, no node:*): base58, base64, borsh writers.
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(s: string): Uint8Array {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const out: number[] = [];
  for (let i = zeros; i < s.length; i++) {
    let carry = B58.indexOf(s[i]);
    if (carry < 0) throw new Error("invalid base58");
    for (let j = 0; j < out.length; j++) { carry += out[j] * 58; out[j] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { out.push(carry & 0xff); carry >>= 8; }
  }
  return new Uint8Array([...new Array(zeros).fill(0), ...out.reverse()]);
}

export function base64Encode(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function utf8(s: string): Uint8Array { return new TextEncoder().encode(s); }

/** Minimal borsh writer: just the integer/string/bytes shapes a NEAR transaction needs. */
export class BorshWriter {
  private parts: Uint8Array[] = [];
  u8(n: number): this { this.parts.push(new Uint8Array([n])); return this; }
  u32(n: number): this { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); this.parts.push(b); return this; }
  u64(n: bigint): this { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); this.parts.push(b); return this; }
  u128(n: bigint): this { const b = new Uint8Array(16); const dv = new DataView(b.buffer); dv.setBigUint64(0, n & 0xffffffffffffffffn, true); dv.setBigUint64(8, n >> 64n, true); this.parts.push(b); return this; }
  fixed(b: Uint8Array): this { this.parts.push(b); return this; }
  bytes(b: Uint8Array): this { this.u32(b.length); this.parts.push(b); return this; }
  string(s: string): this { return this.bytes(utf8(s)); }
  finish(): Uint8Array {
    const n = this.parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}
