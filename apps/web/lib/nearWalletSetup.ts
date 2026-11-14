// WALLET1 (a): get the user's Privy NEAR wallet address on first login.
//
// Privy react-auth 3.x `useCreateWallet` (extended-chains) resolves to { user, wallet }, not to the wallet itself.
// The old code read `w.address` and so never saw the new wallet until a page refresh re-read the user.
// This helper reads the address from any shape, falls back to refreshUser(), and gives up after a timeout.

type AnyUser = { id?: string; linkedAccounts?: unknown[] } | null | undefined;

export interface EnsureNearWalletDeps {
  user: AnyUser;
  createWallet: () => Promise<unknown>;
  refreshUser: () => Promise<AnyUser>;
  timeoutMs?: number;
}

export class WalletSetupTimeoutError extends Error {
  constructor(ms: number) {
    super(`NEAR wallet setup timed out after ${ms} ms`);
    this.name = "WalletSetupTimeoutError";
  }
}

export function findNearWallet(user: AnyUser): string | null {
  for (const a of (user?.linkedAccounts ?? []) as any[]) {
    if (a && a.type === "wallet" && (a.chainType === "near" || a.chain_type === "near") && typeof a.address === "string" && a.address) return a.address;
  }
  return null;
}

/** Address out of whatever createWallet resolved to: { wallet }, { user }, or (older SDKs) the wallet itself. */
function addressFromCreateOutput(out: any): string | null {
  if (!out || typeof out !== "object") return null;
  if (typeof out.wallet?.address === "string" && out.wallet.address) return out.wallet.address;
  const fromUser = findNearWallet(out.user);
  if (fromUser) return fromUser;
  if (typeof out.address === "string" && out.address) return out.address;
  return null;
}

async function attempt(d: EnsureNearWalletDeps): Promise<string> {
  const existing = findNearWallet(d.user);
  if (existing) return existing;
  let createErr: unknown = null;
  try {
    const addr = addressFromCreateOutput(await d.createWallet());
    if (addr) return addr;
  } catch (e) {
    createErr = e; // e.g. the wallet already exists but our `user` object is stale
  }
  const fresh = findNearWallet(await d.refreshUser().catch(() => null));
  if (fresh) return fresh;
  throw createErr ?? new Error("NEAR wallet was created but no address was returned");
}

export function ensureNearWallet(d: EnsureNearWalletDeps): Promise<string> {
  const ms = d.timeoutMs ?? NearWalletSetup.DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new WalletSetupTimeoutError(ms)), ms); });
  return Promise.race([attempt(d), timeout]).finally(() => clearTimeout(timer));
}

/** One in-flight setup per user id, so React effect re-fires (new `user` objects, StrictMode) don't create twice. */
export class NearWalletSetup {
  static readonly DEFAULT_TIMEOUT_MS = 20_000;
  private inflight: { key: string; p: Promise<string> } | null = null;

  run(d: EnsureNearWalletDeps): Promise<string> {
    const key = d.user?.id ?? "";
    if (this.inflight && this.inflight.key === key) return this.inflight.p;
    const p = ensureNearWallet(d).finally(() => { if (this.inflight?.p === p) this.inflight = null; });
    this.inflight = { key, p };
    return p;
  }
}
