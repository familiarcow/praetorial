// F1 (FUND4 SPEC §5.3, §7.2): per-chain recipient address checks for Cash out (1Click `recipientType: DESTINATION_CHAIN`).
// Keys are 1Click `/v0/tokens` `blockchain` codes. Checksums are verified where the format has one (EIP-55 mixed case, bech32/
// bech32m, base58check, Stellar strkey CRC16, TON user-friendly CRC16). Chains not listed fall back to "non-empty, no spaces" and
// rely on 1Click's own "recipient is not valid" (verified in FUND4 evidence). Shared by the funding Worker and the web.
// Pure + dependency-free (own keccak256 / sha256d via js-sha256 / base58 / bech32), host-neutral.
import { sha256 } from "js-sha256";

export type AddressReason = "empty" | "format" | "checksum" | "refused";
export type AddressCheck = { ok: true } | { ok: false; reason: AddressReason; detail: string };

export const EVM_CHAINS = ["eth", "base", "arb", "op", "pol", "avax", "bsc", "gnosis", "scroll", "xlayer", "monad", "bera", "plasma", "abs", "hood"] as const;
/** Chains whose exchange deposits often need a tag/memo, which 1Click cannot add on a withdrawal (SPEC §5.1 step 3). */
export const MEMO_CHAINS = ["xrp", "stellar", "ton"] as const;
export const isMemoChain = (blockchain: string) => (MEMO_CHAINS as readonly string[]).includes(blockchain);

const ok: AddressCheck = { ok: true };
const bad = (reason: AddressReason, detail: string): AddressCheck => ({ ok: false, reason, detail });

// ---------------------------------------------------------------- hashing / encodings
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n,
  0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M64 = (1n << 64n) - 1n;
const rotl = (v: bigint, n: number) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64);
/** Keccak-256 (Ethereum's, pad 0x01), for EIP-55 only. */
export function keccak256(data: Uint8Array): Uint8Array {
  const rate = 136, A = new Array<bigint>(25).fill(0n);
  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data); padded[data.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) { let lane = 0n; for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]!); A[i] = A[i]! ^ lane; }
    for (let round = 0; round < 24; round++) {
      const C = [0, 1, 2, 3, 4].map((x) => A[x]! ^ A[x + 5]! ^ A[x + 10]! ^ A[x + 15]! ^ A[x + 20]!);
      for (let x = 0; x < 5; x++) { const D = C[(x + 4) % 5]! ^ rotl(C[(x + 1) % 5]!, 1); for (let y = 0; y < 25; y += 5) A[x + y] = A[x + y]! ^ D; }
      const B = new Array<bigint>(25).fill(0n);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y]!, ROT[x + 5 * y]!);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) A[x + y] = B[x + y]! ^ (~B[((x + 1) % 5) + y]! & M64 & B[((x + 2) % 5) + y]!);
      A[0] = A[0]! ^ RC[round]!;
    }
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) for (let b = 0; b < 8; b++) out[i * 8 + b] = Number((A[i]! >> BigInt(8 * b)) & 0xffn);
  return out;
}

const BTC58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const XRP58 = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
export function base58Decode(s: string, alphabet = BTC58): Uint8Array | null {
  if (!s) return null;
  let n = 0n;
  for (const c of s) { const i = alphabet.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== alphabet[0]) break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
const sha256d = (b: Uint8Array) => new Uint8Array(sha256.arrayBuffer(new Uint8Array(sha256.arrayBuffer(b))));
/** base58check payload (version + data, checksum stripped) or null when the checksum is wrong / undecodable. */
export function base58Check(s: string, alphabet = BTC58): Uint8Array | null {
  const raw = base58Decode(s, alphabet);
  if (!raw || raw.length < 5) return null;
  const body = raw.slice(0, -4), sum = sha256d(body);
  for (let i = 0; i < 4; i++) if (sum[i] !== raw[raw.length - 4 + i]) return null;
  return body;
}

const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) { const top = chk >>> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i]!; }
  return chk >>> 0;
}
/** Segwit address decode (BIP-173 / BIP-350). null if the checksum/variant/program is wrong. */
export function segwitDecode(hrp: string, addr: string): { version: number; program: Uint8Array } | null {
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return null;
  const a = addr.toLowerCase(), pos = a.lastIndexOf("1");
  if (pos < 1 || a.slice(0, pos) !== hrp || a.length > 90 || a.length - pos - 1 < 7) return null;
  const data: number[] = [];
  for (const c of a.slice(pos + 1)) { const d = B32.indexOf(c); if (d < 0) return null; data.push(d); }
  const hrpExp = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const pm = bech32Polymod([...hrpExp, ...data]);
  const version = data[0]!;
  if (version > 16) return null;
  if (pm !== (version === 0 ? 1 : 0x2bc830a3)) return null;
  let acc = 0, bits = 0; const prog: number[] = [];
  for (const v of data.slice(1, -6)) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; prog.push((acc >> bits) & 0xff); } }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) return null;
  if (prog.length < 2 || prog.length > 40) return null;
  if (version === 0 && prog.length !== 20 && prog.length !== 32) return null;
  return { version, program: Uint8Array.from(prog) };
}

function crc16xmodem(b: Uint8Array): number {
  let crc = 0;
  for (const x of b) { crc ^= x << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  return crc;
}
function base32Decode(s: string): Uint8Array | null {
  const AL = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let acc = 0, bits = 0; const out: number[] = [];
  for (const c of s) { const v = AL.indexOf(c); if (v < 0) return null; acc = (acc << 5) | v; bits += 5; if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } }
  return Uint8Array.from(out);
}
function base64AnyDecode(s: string): Uint8Array | null {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return null;
  try { return Uint8Array.from(atob(t), (c) => c.charCodeAt(0)); } catch { return null; }
}

// ---------------------------------------------------------------- per-chain rules
const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const isNearAccountId = (s: string) => s.length >= 2 && s.length <= 64 && NEAR_ACCOUNT.test(s);
export const isImplicitAccount = (s: string) => /^[0-9a-f]{64}$/.test(s);

export function evmCheck(a: string): AddressCheck {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return bad("format", "an EVM address is 0x followed by 40 hex characters");
  const hex = a.slice(2);
  if (/^0{40}$/.test(hex) || hex.toLowerCase() === "000000000000000000000000000000000000dead") return bad("refused", "burn address");
  if (hex !== hex.toLowerCase() && hex !== hex.toUpperCase()) {
    const h = keccak256(new TextEncoder().encode(hex.toLowerCase()));
    for (let i = 0; i < 40; i++) {
      const nib = (h[i >> 1]! >> (i % 2 ? 0 : 4)) & 0xf, c = hex[i]!;
      if (/[a-f]/.test(c) && nib >= 8) return bad("checksum", "EIP-55 checksum mismatch");
      if (/[A-F]/.test(c) && nib < 8) return bad("checksum", "EIP-55 checksum mismatch");
    }
  }
  return ok;
}
function b58v(a: string, versions: number[], len = 21, alphabet = BTC58): AddressCheck {
  const body = base58Check(a, alphabet);
  if (!body) return base58Decode(a, alphabet) ? bad("checksum", "base58check checksum mismatch") : bad("format", "not a base58 address");
  if (body.length !== len || !versions.includes(body[0]!)) return bad("format", "wrong address type for this network");
  return ok;
}
function segwitOr(hrp: string, a: string, legacy: () => AddressCheck): AddressCheck {
  if (a.toLowerCase().startsWith(`${hrp}1`)) return segwitDecode(hrp, a) ? ok : bad("checksum", "bech32 checksum mismatch");
  return legacy();
}
const SOLANA_PROGRAMS = new Set(["11111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"]);

const RULES: Record<string, (a: string) => AddressCheck> = {
  btc: (a) => segwitOr("bc", a, () => b58v(a, [0x00, 0x05])),
  ltc: (a) => segwitOr("ltc", a, () => b58v(a, [0x30, 0x32, 0x05])),
  doge: (a) => b58v(a, [0x1e, 0x16]),
  dash: (a) => b58v(a, [0x4c, 0x10]),
  bch: (a) => (/^(bitcoincash:)?[qp][02-9ac-hj-np-z]{41}$/.test(a) ? ok : b58v(a, [0x00, 0x05])), // cashaddr: format only (1Click checks it)
  tron: (a) => (a.startsWith("T") ? b58v(a, [0x41]) : bad("format", "a Tron address starts with T")),
  zec: (a) => {
    if (/^u1/.test(a)) return bad("format", "use a transparent t-address (t1... or t3...)");
    const body = base58Check(a);
    if (!body) return bad(base58Decode(a) ? "checksum" : "format", "not a Zcash t-address");
    const v = (body[0]! << 8) | body[1]!;
    return body.length === 22 && (v === 0x1cb8 || v === 0x1cbd) ? ok : bad("format", "not a Zcash t-address");
  },
  xrp: (a) => (a.startsWith("r") ? b58v(a, [0x00], 21, XRP58) : bad("format", "an XRP address starts with r")),
  sol: (a) => {
    const b = base58Decode(a);
    if (!b || b.length !== 32 || a.length < 32 || a.length > 44) return bad("format", "not a Solana address");
    return SOLANA_PROGRAMS.has(a) ? bad("refused", "a program address cannot receive funds") : ok;
  },
  near: (a) => (isNearAccountId(a) ? ok : bad("format", "not a NEAR account id")),
  stellar: (a) => {
    if (!/^G[A-Z2-7]{55}$/.test(a)) return bad("format", "a Stellar address is G followed by 55 characters");
    const b = base32Decode(a);
    if (!b || b.length !== 35 || b[0] !== 6 << 3) return bad("format", "not a Stellar account address");
    const crc = crc16xmodem(b.slice(0, 33));
    return (b[33]! | (b[34]! << 8)) === crc ? ok : bad("checksum", "Stellar checksum mismatch");
  },
  ton: (a) => {
    if (/^-?\d+:[0-9a-fA-F]{64}$/.test(a)) return ok;
    if (a.length !== 48) return bad("format", "not a TON address");
    const b = base64AnyDecode(a);
    if (!b || b.length !== 36) return bad("format", "not a TON address");
    if (b[0]! & 0x80) return bad("refused", "testnet-only TON address");
    if ((b[0]! & 0x7f) !== 0x11 && (b[0]! & 0x7f) !== 0x51) return bad("format", "not a TON address");
    return ((b[34]! << 8) | b[35]!) === crc16xmodem(b.slice(0, 34)) ? ok : bad("checksum", "TON checksum mismatch");
  },
  sui: (a) => (/^0x[0-9a-fA-F]{64}$/.test(a) ? ok : bad("format", "a Sui address is 0x followed by 64 hex characters")),
  aptos: (a) => (/^0x[0-9a-fA-F]{64}$/.test(a) ? ok : bad("format", "an Aptos address is 0x followed by 64 hex characters")),
};
for (const c of EVM_CHAINS) RULES[c] = evmCheck;

/** NEAR accounts no user withdrawal may target: the intents verifier, bridge token contracts, our own contracts. */
export function refusedNearAccount(a: string): boolean {
  return a === "intents.near" || /\.(omft|omdep)\.near$/.test(a) || a === "praetorial.near" || a.endsWith(".praetorial.near");
}

export interface RecipientContext {
  /** the user's own intents account: never a valid address on another chain */
  account?: string;
  /** extra refused addresses (e.g. the deposit addresses of the user's own open 1Click records) */
  refused?: readonly string[];
}

export function validateRecipient(blockchain: string, address: unknown, ctx: RecipientContext = {}): AddressCheck {
  if (typeof address !== "string" || address.trim() === "") return bad("empty", "enter an address");
  const a = address;
  if (a !== a.trim() || /\s/.test(a)) return bad("format", "the address has spaces");
  if (a.length > 128) return bad("format", "the address is too long");
  if (ctx.refused?.some((r) => r.toLowerCase() === a.toLowerCase())) return bad("refused", "this is one of your own deposit addresses");
  if (blockchain === "near") {
    if (refusedNearAccount(a)) return bad("refused", "this NEAR account cannot receive a withdrawal");
  } else if (ctx.account && a.toLowerCase().replace(/^0x/, "") === ctx.account.toLowerCase()) {
    return bad("refused", "this is your NEAR account id, not an address on this network");
  }
  const rule = RULES[blockchain];
  return rule ? rule(a) : ok;
}
