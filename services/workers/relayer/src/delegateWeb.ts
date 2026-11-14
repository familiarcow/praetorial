// WebCrypto / no-Buffer twin of relayer/src/delegate.ts for the Worker: strict borsh decode of a
// SignedDelegateAction (canonical base64, every byte consumed, same class of rejections) and NEP-461 ed25519
// verification via crypto.subtle. Decoded actions use the same shape the node decoder (near-js borsh) yields,
// e.g. { functionCall: { methodName, args, gas, deposit } }, so the shared policy/core code is host-agnostic.
import { BadSignedDelegate } from "../../../relayer/src/relayerErrors.js";

export { BadSignedDelegate };

export interface DecodedWeb {
  delegateAction: { senderId: string; receiverId: string; actions: any[]; nonce: bigint; maxBlockHeight: bigint; publicKey: { ed25519Key: { data: Uint8Array } } };
  signatureBytes: Uint8Array;
  publicKeyBytes: Uint8Array;
  /** The exact input bytes (borsh SignedDelegateAction) -- embedded verbatim as the outer tx's signedDelegate action. */
  signedBytes: Uint8Array;
  /** The borsh DelegateAction slice of signedBytes (what NEP-461 hashes after the prefix). */
  delegateBytes: Uint8Array;
}

class Reader {
  private o = 0;
  private dv: DataView;
  constructor(private b: Uint8Array) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  get pos() { return this.o; }
  get done() { return this.o === this.b.length; }
  private need(n: number) { if (n < 0 || this.o + n > this.b.length) throw new Error("unexpected end of input"); }
  u8(): number { this.need(1); return this.b[this.o++]; }
  u32(): number { this.need(4); const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  u64(): bigint { this.need(8); const v = this.dv.getBigUint64(this.o, true); this.o += 8; return v; }
  u128(): bigint { const lo = this.u64(); return lo | (this.u64() << 64n); }
  fixed(n: number): Uint8Array { this.need(n); const v = this.b.slice(this.o, this.o + n); this.o += n; return v; }
  bytes(): Uint8Array { return this.fixed(this.u32()); }
  string(): string { return new TextDecoder("utf-8", { fatal: true }).decode(this.bytes()); }
  slice(from: number): Uint8Array { return this.b.subarray(from, this.o); }
}

function publicKey(r: Reader): { ed25519Key: { data: Uint8Array } } | { secp256k1Key: { data: Uint8Array } } {
  const t = r.u8();
  if (t === 0) return { ed25519Key: { data: r.fixed(32) } };
  if (t === 1) return { secp256k1Key: { data: r.fixed(64) } };
  throw new Error("bad public key type");
}

function action(r: Reader): any {
  switch (r.u8()) {
    case 0: return { createAccount: {} };
    case 1: return { deployContract: { code: r.bytes() } };
    case 2: { const methodName = r.string(); const args = r.bytes(); const gas = r.u64(); const deposit = r.u128(); return { functionCall: { methodName, args, gas, deposit } }; }
    case 3: return { transfer: { deposit: r.u128() } };
    case 4: { const stake = r.u128(); return { stake: { stake, publicKey: publicKey(r) } }; }
    case 5: {
      const pk = publicKey(r); const nonce = r.u64(); const perm = r.u8();
      if (perm === 1) return { addKey: { publicKey: pk, accessKey: { nonce, permission: { fullAccess: {} } } } };
      if (perm !== 0) throw new Error("bad access key permission");
      const hasAllowance = r.u8(); if (hasAllowance > 1) throw new Error("bad option tag");
      const allowance = hasAllowance ? r.u128() : null; const receiverId = r.string();
      const n = r.u32(); const methodNames: string[] = []; for (let i = 0; i < n; i++) methodNames.push(r.string());
      return { addKey: { publicKey: pk, accessKey: { nonce, permission: { functionCall: { allowance, receiverId, methodNames } } } } };
    }
    case 6: return { deleteKey: { publicKey: publicKey(r) } };
    case 7: return { deleteAccount: { beneficiaryId: r.string() } };
    default: throw new Error("unknown action type");
  }
}

export function decodeSignedDelegateWeb(base64: string): DecodedWeb {
  if (typeof base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) throw new BadSignedDelegate("payload is not canonical base64");
  let bin: string;
  try { bin = atob(base64); } catch { throw new BadSignedDelegate("payload is not canonical base64"); }
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (btoa(bin) !== base64) throw new BadSignedDelegate("payload is not canonical base64");
  if (bytes.length === 0) throw new BadSignedDelegate("empty payload");

  const r = new Reader(bytes);
  let out: DecodedWeb;
  try {
    const senderId = r.string(), receiverId = r.string();
    const n = r.u32(); if (n > bytes.length) throw new Error("action count exceeds input");
    const actions: any[] = []; for (let i = 0; i < n; i++) actions.push(action(r));
    const nonce = r.u64(), maxBlockHeight = r.u64();
    const pk: any = publicKey(r);
    const delegateBytes = r.slice(0);
    const sigType = r.u8();
    if (sigType !== 0 && sigType !== 1) throw new Error("bad signature type");
    const sigData = r.fixed(sigType === 0 ? 64 : 65);
    if (!r.done) throw new Error("trailing bytes");
    if (sigType !== 0) throw new BadSignedDelegate("only ed25519 signatures are supported by this relayer");
    if (!pk.ed25519Key) throw new BadSignedDelegate("publicKey must be an ed25519 key");
    out = { delegateAction: { senderId, receiverId, actions, nonce, maxBlockHeight, publicKey: pk }, signatureBytes: sigData, publicKeyBytes: pk.ed25519Key.data, signedBytes: bytes, delegateBytes };
  } catch (err: any) {
    if (err instanceof BadSignedDelegate) throw err;
    throw new BadSignedDelegate(`borsh decode failed: ${String(err?.message ?? err)}`);
  }
  return out;
}

/** True iff the signature verifies over sha256(NEP-461 prefix || borsh DelegateAction) under the delegate's own key. */
export async function verifySignedDelegateWeb(d: DecodedWeb): Promise<boolean> {
  const msg = new Uint8Array(4 + d.delegateBytes.length);
  new DataView(msg.buffer).setUint32(0, (1 << 30) + 366, true); // NEP-461: 2^30 + 366 for NEP-366
  msg.set(d.delegateBytes, 4);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", msg));
  try {
    const key = await crypto.subtle.importKey("raw", d.publicKeyBytes as Uint8Array<ArrayBuffer>, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, d.signatureBytes as Uint8Array<ArrayBuffer>, hash);
  } catch { return false; }
}
