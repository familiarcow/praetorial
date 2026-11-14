// Minimal Privy REST client for the Praetorial app, server-side only.
// Auth: Basic <appId:appSecret>, plus the privy-app-id header, exactly
// per docs.privy.io/api-reference. The app secret is read from the env
// var PRIVY_APP_SECRET (loaded by the caller from
// $PRAETORIAL_SECRETS_DIR/praetorial-privy.env) -- never logged, never
// returned from any function here.
export const PRIVY_APP_ID = "cmw1b5stc01q60glap4q18que";
const BASE = "https://api.privy.io";

function authHeader(): string {
  const secret = process.env.PRIVY_APP_SECRET;
  if (!secret) throw new Error("PRIVY_APP_SECRET not set in env");
  return "Basic " + Buffer.from(`${PRIVY_APP_ID}:${secret}`).toString("base64");
}

async function req(path: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: authHeader(),
      "privy-app-id": PRIVY_APP_ID,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err: any = new Error(`Privy ${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(json)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export interface PrivyUser {
  id: string;
  created_at: number;
  linked_accounts: any[];
  wallets?: any[];
  [k: string]: any;
}

export interface PrivyWallet {
  id: string;
  address: string;
  chain_type: string;
  owner_id?: string | null;
  [k: string]: any;
}

/** Create a server-managed test user with an email login, no inline
 * wallet. See lib/walletService.ts doc for why wallets are created
 * standalone (not inline) in this app's "user-controlled-server-wallets"
 * config -- inline wallets come back owned by a user-authorization key
 * and raw_sign then requires a user session we don't have server-side. */
export async function createUser(email: string): Promise<PrivyUser> {
  return req("/v1/users", "POST", {
    linked_accounts: [{ type: "email", address: email }],
  });
}

/** Kept for the audit record (01_create_privy_user.ts's original probe
 * that surfaced the owner_id/user-session finding above) -- not used
 * by the wallet service. */
export async function createUserWithNearWallet(email: string): Promise<PrivyUser> {
  return req("/v1/users", "POST", {
    linked_accounts: [{ type: "email", address: email }],
    wallets: [{ chain_type: "near" }],
  });
}

export async function getUser(userId: string): Promise<PrivyUser> {
  return req(`/v1/users/${encodeURIComponent(userId)}`, "GET");
}

/** Standalone wallet creation -- deliberately no `owner_id`, which is
 * what keeps the wallet signable with just the app secret (see
 * lib/walletService.ts doc). `externalId` is a free-form label for our
 * own discoverability (set to the Privy user's did:privy:... id); it
 * is NOT an owner/authorization control. */
export async function createWallet(chainType: string, externalId?: string): Promise<PrivyWallet> {
  const body: any = { chain_type: chainType };
  if (externalId) body.external_id = externalId;
  return req("/v1/wallets", "POST", body);
}

export async function getWallet(walletId: string): Promise<PrivyWallet> {
  return req(`/v1/wallets/${encodeURIComponent(walletId)}`, "GET");
}

export interface RawSignResult {
  signatureHex: string; // 128 hex chars, 64 bytes, no 0x prefix
}

/** POST /v1/wallets/{wallet_id}/raw_sign -- signs a pre-computed 32-byte
 * hash on the wallet's curve (ed25519 for chain_type 'near'). This is
 * Tier-1 NEAR support: Privy signs the hash we hand it; WE build,
 * serialize and broadcast the NEAR transaction ourselves. */
export async function rawSign(walletId: string, hash32: Uint8Array): Promise<RawSignResult> {
  const hashHex = "0x" + Buffer.from(hash32).toString("hex");
  const resp = await req(`/v1/wallets/${encodeURIComponent(walletId)}/raw_sign`, "POST", {
    params: { hash: hashHex },
  });
  const sig: string = resp?.data?.signature;
  if (!sig) throw new Error(`raw_sign: no signature in response: ${JSON.stringify(resp)}`);
  return { signatureHex: sig.replace(/^0x/, "") };
}

/** GET /v1/users/.../ or the export endpoint -- we never call the real
 * export action (it returns a raw private key); this only probes
 * whether the endpoint exists / is enabled for this wallet type by
 * reading Privy's own docs + (optionally) a dry capability check. See
 * scripts/06_export_check.ts: it deliberately does NOT call this. */
export const EXPORT_ENDPOINT_DOC = "POST /v1/wallets/{wallet_id}/export (docs.privy.io/wallets/wallets/export)";
