// WT1b (c) / D-REFUI1: referee picker model. Registered users only; username search; AI | Person picker;
// one Human mode; the referee is shown on the review card. There is NO referee-acceptance step by design (D-RFW1,
// UX-18): the taker agrees to the named referee by taking the bet. The registry is D-REG1/REG1: an injected
// interface (MockUserRegistry in tests/dev, HttpUserRegistry against services/registry).
import type { RefereeChoice } from "./referee";
import { MAINNET_ONLY_BUILD } from "./networkSelect";

export interface RegisteredUser { username: string; account: string }

export interface UserRegistry {
  /** Case-insensitive prefix/substring search over registered usernames. */
  search(query: string): Promise<RegisteredUser[]>;
  /** Exact lookup by NEAR account; null when not registered. */
  byAccount(account: string): Promise<RegisteredUser | null>;
  /** FE4b: like search() but throws on network/HTTP errors so the picker can say "can't search right now". */
  searchStrict?(query: string): Promise<RegisteredUser[]>;
  /** REG2/FE4b: exact username -> FULL account id (implicit ids allowed); null when not found, throws on 429/5xx. */
  lookupUsername?(name: string): Promise<RegisteredUser | null>;
}

/** FE4b: short display tail of an account: the last 8 chars of a 64-hex implicit id, a named account as is. */
export function accountTail(account: string): string {
  const a = account.trim();
  return /^[0-9a-f]{64}$/.test(a) ? a.slice(-8) : a;
}

export class MockUserRegistry implements UserRegistry {
  constructor(private users: RegisteredUser[]) {}
  async search(query: string) {
    const q = query.trim().toLowerCase().replace(/^@/, "");
    if (!q) return [];
    return this.users.filter((u) => u.username.toLowerCase().includes(q)).slice(0, 8);
  }
  async searchStrict(query: string) { return this.search(query); }
  async byAccount(account: string) {
    return this.users.find((u) => u.account === account) ?? null;
  }
  /** REG2: exact (case-insensitive) username -> full account; null for any partial/prefix. */
  async lookupUsername(name: string): Promise<RegisteredUser | null> {
    const q = name.trim().replace(/^@/, "").trim().toLowerCase();
    if (!q) return null;
    return this.users.find((u) => u.username.toLowerCase() === q) ?? null;
  }
}

/** Dev/demo registry until the real one exists. MAINPREP: empty in a mainnet bundle (no fake testnet referees). */
export const MOCK_REGISTRY = new MockUserRegistry(MAINNET_ONLY_BUILD ? [] : [
  { username: "alice", account: "alice.testnet" },
  { username: "alicia_k", account: "alicia-k.testnet" },
  { username: "bob_the_ref", account: "bob-ref.testnet" },
  { username: "carol", account: "carol.testnet" },
]);

/** S4: the single decision, two radio cards (UX-4, UX-17). */
export interface DeciderChoice { kind: "ai" | "person"; label: string; blurb: string }
export const DECIDER_CHOICES: DeciderChoice[] = [
  { kind: "ai", label: "The AI decides", blurb: "Fast, no one to chase. Needs a page or source the AI can read. Either of you can challenge the ruling." },
  { kind: "person", label: "A person decides", blurb: "No AI is used. The person you pick rules YES, NO or VOID. No appeals." },
];

/** Picking a registered user makes them the human referee. */
export function pickReferee(user: RegisteredUser): { choice: RefereeChoice; username: string } {
  return { choice: { mode: "human", referee: user.account }, username: user.username };
}

/** Username + account tail only (never an email): full id for a named account, last 8 chars for an implicit one. */
export const tailOf = (account: string): string => (/^[0-9a-f]{64}$/.test(account) ? account.slice(-8) : account);
export const resultRowLabel = (u: RegisteredUser): string => `@${u.username} \u00b7 ${tailOf(u.account)}`;

/** S4b hint under the search box: before typing / no match. */
export const searchHint = (query: string): string => (query.trim().replace(/^@/, "") ? "No one with that name" : "Start typing a username.");

/** Registered-only gate: returns an error string, or null. */
export async function checkRegistered(registry: UserRegistry, choice: RefereeChoice): Promise<string | null> {
  if (choice.mode !== "human") return null;
  const a = (choice.referee ?? "").trim();
  if (!a) return "Pick someone, or switch back to the AI.";
  return (await registry.byAccount(a)) ? null : `${a} is not a registered user; only registered users can be referees.`;
}

/** UX-18 review line: who the referee is, and that taking the bet means agreeing to them. */
export function refereeTakeAgreementLine(choice: RefereeChoice, username?: string): string {
  const a = (choice.referee ?? "").trim();
  if (choice.mode !== "human" || !a) return "";
  const who = username ? `@${username} (${accountTail(a)})` : accountTail(a);
  return `Referee: ${who}. Taking this bet means you agree to this referee deciding it.`;
}

/** REG1: real registry over HTTP (services/registry). search() maps the privacy-minimal `account_tail`
 * (full id for named accounts, last 8 chars for implicit ones) into `account`; byAccount() is exact. */
export class HttpUserRegistry implements UserRegistry {
  constructor(private baseUrl: string, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {}
  private url(path: string) { return this.baseUrl.replace(/\/+$/, "") + path; }
  async search(query: string): Promise<RegisteredUser[]> {
    const q = query.trim().replace(/^@/, "").trim();
    if (!q) return [];
    try {
      const res = await this.fetchImpl(this.url(`/search?q=${encodeURIComponent(q)}`));
      if (!res.ok) return [];
      const rows = (await res.json()) as { username: string; account_tail: string }[];
      return rows.map((r) => ({ username: r.username, account: r.account_tail }));
    } catch { return []; }
  }
  /** FE4b: search() that throws on network errors and non-2xx (429/5xx) instead of returning []. */
  async searchStrict(query: string): Promise<RegisteredUser[]> {
    const q = query.trim().replace(/^@/, "").trim();
    if (!q) return [];
    const res = await this.fetchImpl(this.url(`/search?q=${encodeURIComponent(q)}`));
    if (!res.ok) throw new Error(`registry search failed: ${res.status}`);
    const rows = (await res.json()) as { username: string; account_tail: string }[];
    return rows.map((r) => ({ username: r.username, account: r.account_tail }));
  }
  async byAccount(account: string): Promise<RegisteredUser | null> {
    const res = await this.fetchImpl(this.url(`/lookup/account/${encodeURIComponent(account)}`));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`registry lookup failed: ${res.status}`);
    const j = (await res.json()) as { username: string };
    return { username: j.username, account };
  }
  /** REG2: exact username -> FULL account id (never a tail); null on 404; throws on 429/5xx so callers can retry. */
  async lookupUsername(name: string): Promise<RegisteredUser | null> {
    const q = name.trim().replace(/^@/, "").trim();
    if (!q) return null;
    const res = await this.fetchImpl(this.url(`/lookup/username/${encodeURIComponent(q)}`));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`registry lookup failed: ${res.status}`);
    const j = (await res.json()) as { username: string; account_id: string };
    return { username: j.username, account: j.account_id };
  }
}

export interface ClaimUsernameArgs {
  registryUrl: string; registryId: string; username: string; accountId: string; publicKey: string;
  /** Wallet NEP-413 signMessage: returns the raw 64-byte ed25519 signature over sha256(borsh payload). */
  signMessage: (p: { message: string; nonce: Uint8Array; recipient: string }) => Promise<{ signature: Uint8Array }>;
  fetchImpl?: typeof fetch; now?: () => number; discoverable?: boolean;
}
export type ClaimUsernameResult = { ok: true; username: string; account_id: string } | { ok: false; error: string; status?: number };

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

/** Claim (or rename to) a username. Nonce = 8-byte BE ms timestamp + 24 random bytes (registry rejects >10 min old / replays). */
export async function claimUsername(a: ClaimUsernameArgs): Promise<ClaimUsernameResult> {
  const username = a.username.trim().replace(/^@/, "").toLowerCase();
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce.subarray(8));
  new DataView(nonce.buffer).setBigUint64(0, BigInt((a.now ?? Date.now)()), false);
  let signature: Uint8Array;
  try {
    ({ signature } = await a.signMessage({ message: `praetorial-username:${username}`, nonce, recipient: a.registryId }));
  } catch (e) { return { ok: false, error: `signature_failed: ${(e as Error).message}` }; }
  const body: Record<string, unknown> = { username, account_id: a.accountId, public_key: a.publicKey, nonce: b64(nonce), signature: b64(signature) };
  if (a.discoverable === false) body.discoverable = false;
  try {
    const res = await (a.fetchImpl ?? ((...x) => fetch(...x)))(a.registryUrl.replace(/\/+$/, "") + "/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: j.error ?? "claim_failed", status: res.status };
    return { ok: true, username: j.username, account_id: j.account_id };
  } catch (e) { return { ok: false, error: `network: ${(e as Error).message}` }; }
}

export interface WalletClaimArgs {
  registryUrl: string; registryId: string; username: string; account: string; discoverable?: boolean;
  signRawHash: (address: string, hashHex: string) => Promise<string>; fetchImpl?: typeof fetch; now?: () => number;
}
/** The claim as UsernameStep sends it for a Privy embedded wallet. The wallet address is the implicit account id (64-hex raw ed25519 key);
 *  the registry requires the NEAR key form `ed25519:<base58>` (root cause of 400 bad_key_or_signature: raw hex was sent). */
export async function claimWithWallet(a: WalletClaimArgs): Promise<ClaimUsernameResult> {
  const { makeSignMessage } = await import("./nep413");
  const { base58FromHex } = await import("./delegate");
  return claimUsername({ registryUrl: a.registryUrl, registryId: a.registryId, username: a.username, accountId: a.account, publicKey: `ed25519:${base58FromHex(a.account)}`,
    signMessage: makeSignMessage(a.account, a.signRawHash), discoverable: a.discoverable, fetchImpl: a.fetchImpl, now: a.now });
}
