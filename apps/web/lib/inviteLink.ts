// IN1: maker-side invite links for TakerAllow::InvitePubkey (contracts/escrow/src/lib.rs).
// - Pubkey encoding in the envelope: the contract's `InvitePubkey(String)` is parsed by `verify_sig` -> `hex_decode`,
//   so it is the raw 32-byte ed25519 public key as 64 hex chars (no "ed25519:" prefix, no base58).
// - handle_take verifies a 64-byte hex `invite_sig` over the UTF-8 bytes of `praetorial:invite:v1:{bet_id}:{sender_id}`.
// - The secret key is ephemeral per offer and lives ONLY in the maker's localStorage (key below, indexed by the PUBLIC key
//   so it can be found again from the opened bet's taker_allow). It is never logged, sent, or put in an envelope/URL.
import nacl from "tweetnacl";

export interface InviteKey { pubkeyHex: string; secretHex: string }
/** The slice of localStorage this module needs (injectable for tests). */
export interface KVStore { getItem(k: string): string | null; setItem(k: string, v: string): void }

const toHex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string, n: number): Uint8Array | null =>
  /^[0-9a-fA-F]*$/.test(h) && h.length === n * 2 ? Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16)) : null;

export function generateInviteKey(): InviteKey {
  const kp = nacl.sign.keyPair();
  return { pubkeyHex: toHex(kp.publicKey), secretHex: toHex(kp.secretKey) };
}

export const inviteKeyStorageKey = (pubkeyHex: string) => `praetorial:invite-key:v1:${pubkeyHex.toLowerCase()}`;

export function saveInviteKey(store: KVStore, k: InviteKey): void {
  store.setItem(inviteKeyStorageKey(k.pubkeyHex), k.secretHex);
}

export function loadInviteSecret(store: KVStore, pubkeyHex: string): string | null {
  return store.getItem(inviteKeyStorageKey(pubkeyHex));
}

/** Finds the stored secret for an opened bet from its `taker_allow` (object or JSON string); null if not an invite bet / not ours. */
export function inviteSecretForBet(store: KVStore, takerAllow: unknown): string | null {
  let al: any = takerAllow;
  if (typeof al === "string" && (al.startsWith("{") || al.startsWith('"'))) { try { al = JSON.parse(al); } catch { return null; } }
  if (al && typeof al === "object" && typeof al.InvitePubkey === "string") return loadInviteSecret(store, al.InvitePubkey);
  return null;
}

/** Signs the contract's invite message for one invitee account on one bet; returns the 128-hex signature. */
export function signInvite(a: { secretHex: string; betId: number; invitee: string }): string {
  const invitee = a.invitee.trim();
  if (!invitee) throw new Error("signInvite: invitee account is required");
  if (!Number.isInteger(a.betId) || a.betId < 0) throw new Error("signInvite: bet id must be a non-negative integer");
  const sk = fromHex(a.secretHex, 64);
  if (!sk) throw new Error("signInvite: bad secret key");
  const msg = new TextEncoder().encode(`praetorial:invite:v1:${a.betId}:${invitee}`);
  return toHex(nacl.sign.detached(msg, sk));
}

/** `base` + `?bet=<id>&invite=<sig>`; BetPage reads `invite` via parseInviteLink. */
export function buildInviteUrl(base: string, betId: number, sigHex: string): string {
  return `${base.split(/[?#]/)[0]}?bet=${betId}&invite=${sigHex}`;
}
