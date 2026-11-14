// FUND2: a user funded only through a deposit address holds a betting balance on intents under their implicit id while that NEAR
// account does not exist on chain yet, so there is no access key to sign a meta-transaction with. Before signing, the relay path
// reads the nonce; if the account/key is missing it asks the relayer to create the account (POST /activate: implicit ids with a
// nonzero betting balance only) and waits for the key to appear.
import { NETWORK, requireService } from "./network";

export class ActivationError extends Error {
  constructor(message: string, readonly detail: string) { super(message); this.name = "ActivationError"; }
}

const MISSING = /UNKNOWN_ACCOUNT|UNKNOWN_ACCESS_KEY|does not exist|doesn't exist/i;

/** view_access_key result (or the error it threw) -> nonce, or null when the account/key does not exist. Other errors rethrow. */
export function parseAccessKeyNonce(r: unknown): bigint | null {
  if (r instanceof Error) { if (MISSING.test(r.message)) return null; throw r; }
  const o = r as { nonce?: number | string; error?: string } | null;
  if (o && o.nonce !== undefined && o.nonce !== null) return BigInt(o.nonce);
  if (o && typeof o.error === "string" && MISSING.test(o.error)) return null;
  throw new Error(`unexpected access key answer: ${JSON.stringify(r).slice(0, 200)}`);
}

export interface ActivateAnswer { ok: boolean; error?: string }

export async function requestActivation(accountId: string, fetchImpl: typeof fetch = fetch): Promise<ActivateAnswer> {
  let base: string;
  try { base = requireService("relayer", NETWORK.relayerUrl); } catch (e) { return { ok: false, error: (e as Error).message }; }
  try {
    const res = await fetchImpl(`${base}/activate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountId }) });
    const body = await res.json().catch(() => ({}));
    return res.ok && body?.ok ? { ok: true } : { ok: false, error: String(body?.error ?? `relayer http ${res.status}`) };
  } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) }; }
}

const SETUP_FAILED = "We couldn't set up your account on NEAR yet, so nothing was sent. Try again in a moment.";

export async function nonceOrActivate(p: { read: () => Promise<bigint | null>; activate: () => Promise<ActivateAnswer>; sleep: (ms: number) => Promise<void>; attempts?: number; delayMs?: number }): Promise<bigint> {
  const first = await p.read();
  if (first !== null) return first;
  const a = await p.activate();
  if (!a.ok) throw new ActivationError(SETUP_FAILED, a.error ?? "activation refused");
  for (let i = 0; i < (p.attempts ?? 10); i++) {
    const n = await p.read();
    if (n !== null) return n;
    await p.sleep(p.delayMs ?? 1500);
  }
  throw new ActivationError(SETUP_FAILED, "the account was created but its key is not visible yet");
}
