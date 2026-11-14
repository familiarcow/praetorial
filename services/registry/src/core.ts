// Host-neutral registry core (CF1f, D-REGW1): the claim / search / lookup / rate-limit RULES, shared by the node server (server.ts, JSON/memory
// store) and the Cloudflare Worker (workers/registry, D1). No node builtins, no storage, no HTTP framework: each host supplies those.
import { base58Decode } from "../../workers/common/src/bytes.js";
import { normalizeUsername, foldUsername, validateUsername, accountTail } from "./rules.js";
import { nep413Digest } from "./nep413Core.js";
import type { AccessKeyInfo } from "./rpc.js";

export const NONCE_MAX_AGE_MS = 10 * 60_000;
export const NONCE_MAX_SKEW_MS = 60_000;
export const DEFAULT_MAX_BODY_BYTES = 2048;
export const SEARCH_LIMIT = 10;

export class HttpErr extends Error { constructor(public status: number, public code: string) { super(code); } }

export interface ParsedClaim {
  username: string; accountId: string; publicKey: string; discoverable: boolean;
  nonce: Uint8Array; nonceKey: string; ts: number; pk: Uint8Array; sig: Uint8Array; now: number;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function b64(s: string): Uint8Array { try { const bin = atob(s); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); } catch { return new Uint8Array(0); } }

/** Every pre-signature rule of POST /claim, in the node server's original order. Throws HttpErr. */
export function parseClaim(raw: string, now: number): ParsedClaim {
  let b: any;
  try { b = JSON.parse(raw); } catch { throw new HttpErr(400, "bad_json"); }
  if (!b || typeof b !== "object") throw new HttpErr(400, "bad_request");
  for (const k of ["username", "account_id", "public_key", "nonce", "signature"]) if (typeof b[k] !== "string" || !b[k]) throw new HttpErr(400, "bad_request");
  const nonce = b64(b.nonce);
  if (nonce.length !== 32) throw new HttpErr(400, "bad_nonce");
  const username = normalizeUsername(b.username);
  const bad = validateUsername(username);
  if (bad === "reserved") throw new HttpErr(400, "username_reserved");
  if (bad) throw new HttpErr(400, "invalid_username");
  const ts = Number(new DataView(nonce.buffer, nonce.byteOffset, 8).getBigUint64(0, false));
  if (ts < now - NONCE_MAX_AGE_MS || ts > now + NONCE_MAX_SKEW_MS) throw new HttpErr(400, "nonce_expired");
  let pk: Uint8Array, sig: Uint8Array;
  try {
    if (!b.public_key.startsWith("ed25519:")) throw new Error();
    pk = base58Decode(b.public_key.slice(8));
    sig = b.signature.startsWith("ed25519:") ? base58Decode(b.signature.slice(8)) : b64(b.signature);
    if (pk.length !== 32 || sig.length !== 64) throw new Error();
  } catch { throw new HttpErr(400, "bad_key_or_signature"); }
  return { username, accountId: b.account_id, publicKey: b.public_key, discoverable: b.discoverable !== false, nonce, nonceKey: hex(nonce), ts, pk, sig, now };
}

export type VerifyEd25519 = (digest: Uint8Array, sig: Uint8Array, pk: Uint8Array) => boolean | Promise<boolean>;
export async function verifyClaimSignature(c: ParsedClaim, registryId: string, verify: VerifyEd25519): Promise<void> {
  const digest = nep413Digest({ message: `praetorial-username:${c.username}`, nonce: c.nonce, recipient: registryId });
  if (!(await verify(digest, c.sig, c.pk))) throw new HttpErr(401, "bad_signature");
}
/** WALLET1: true iff `accountId` is a NEAR implicit account id (exactly 64 lowercase hex) equal to the hex of the 32-byte ed25519 key `pk`. */
export function implicitAccountKeyMatches(accountId: string, pk: Uint8Array): boolean {
  if (!/^[0-9a-f]{64}$/.test(accountId) || pk.length !== 32) return false;
  let h = ""; for (const b of pk) h += b.toString(16).padStart(2, "0");
  return h === accountId;
}
/**
 * Fail closed: the signing key must be a FULL-ACCESS key of the claimed account on chain right now.
 * WALLET1 exception: an implicit account that does NOT exist on chain yet (a new, unfunded wallet) is accepted when the signing key's hex
 * IS the account id - only the holder of that key can ever control it. Needs `exists`; any RPC doubt fails closed (502).
 */
export async function requireFullAccessKey(c: ParsedClaim, view: (accountId: string) => Promise<AccessKeyInfo[]>, exists?: (accountId: string) => Promise<boolean>): Promise<void> {
  let keys: AccessKeyInfo[];
  try { keys = await view(c.accountId); } catch { throw new HttpErr(502, "rpc_unavailable"); }
  if (keys.some((k) => k.public_key === c.publicKey && k.access_key.permission === "FullAccess")) return;
  if (exists && implicitAccountKeyMatches(c.accountId, c.pk)) {
    let onChain: boolean;
    try { onChain = await exists(c.accountId); } catch { throw new HttpErr(502, "rpc_unavailable"); }
    if (!onChain) return;
  }
  throw new HttpErr(403, "key_not_full_access");
}

export interface SearchUser { username: string; account_id: string; discoverable: boolean }
/** Prefix matches first, then substring matches, each by username; at most SEARCH_LIMIT rows. `users` may be pre-filtered by the host. */
export function searchUsers(users: SearchUser[], qRaw: string): { username: string; account_tail: string }[] {
  const q = foldUsername(qRaw);
  if (!q) return [];
  const pre: SearchUser[] = [], sub: SearchUser[] = [];
  for (const u of [...users].sort((a, b) => a.username.localeCompare(b.username))) {
    if (!u.discoverable) continue;
    const f = foldUsername(u.username);
    if (!f.includes(q)) continue;
    (f.startsWith(q) ? pre : sub).push(u);
  }
  return [...pre, ...sub].slice(0, SEARCH_LIMIT).map((u) => ({ username: u.username, account_tail: accountTail(u.account_id) }));
}
export const searchFold = (qRaw: string): string => foldUsername(qRaw);

/** The folded key to look a username up by, or null when the raw name can never match (padding, invalid). */
export function lookupFold(raw: string): string | null {
  if (raw !== raw.trim()) return null; // exact: no padding tolerated
  const n = normalizeUsername(raw);
  const bad = validateUsername(n);
  if (bad && bad !== "reserved") return null;
  return foldUsername(n);
}
export const foldOf = (username: string): string => foldUsername(username);

export interface Bucket { tokens: number; at: number }
/** Token bucket step. Returns the new bucket and retry-after seconds when limited (the bucket is still advanced, as the node server did). */
export function bucketStep(prev: Bucket | undefined, now: number, rate: { capacity: number; refillPerSec: number }): { bucket: Bucket; retryAfter: number | null } {
  const b = { ...(prev ?? { tokens: rate.capacity, at: now }) };
  b.tokens = Math.min(rate.capacity, b.tokens + ((now - b.at) / 1000) * rate.refillPerSec);
  b.at = now;
  if (b.tokens < 1) return { bucket: b, retryAfter: Math.max(1, Math.ceil((1 - b.tokens) / Math.max(rate.refillPerSec, 1e-9))) };
  b.tokens -= 1;
  return { bucket: b, retryAfter: null };
}
export const isRateLimitedRoute = (method: string, pathname: string): boolean =>
  (method === "POST" && pathname === "/claim") || (method === "GET" && (pathname === "/search" || pathname.startsWith("/lookup/username/") || pathname === "/lookup/username"));

export const corsAllowed = (origin: string | null | undefined, allowed: string[]): boolean => typeof origin === "string" && allowed.includes(origin);
export const decodeParam = (s: string): string => { try { return decodeURIComponent(s); } catch { return ""; } };
