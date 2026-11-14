// SEC1 / SM1 MON-2, MON-5: a relayed send whose outcome is unknown (the relayer answered 202 "unknown", or the request died
// on the way back) may already have executed. Re-signing would read the next nonce and run the same intent twice (double
// withdraw / second stake). So every relayed send is stored in localStorage, keyed by the action, BEFORE it is relayed; a
// retry or a reload of the same action first resolves that entry (relayer /relay/status, then the user's key nonce and the
// delegate's maxBlockHeight) and only signs again once it is known NOT to have executed.
import type { RelayResult } from "./relayerClient";

export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export interface InflightEntry { senderId: string; publicKeyHex: string; nonce: string; maxBlockHeight: string; txHash?: string; at: number }

export const INFLIGHT_PREFIX = "praetorial.inflight.";
export const CHECKING_MESSAGE = "Checking whether it went through. It may already be done, so nothing new is sent until we know. Check again in a minute.";
export const CONSUMED_MESSAGE = "Your earlier request already reached NEAR. Check your balance before sending it again.";

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(",")}}`;
}

/** The same user action (signer, contract, method, args, deposit) always maps to the same key. */
export function actionKey(p: { senderId: string; receiverId: string; methodName: string; args: Record<string, unknown>; depositYocto?: string }): string {
  return `${INFLIGHT_PREFIX}${p.senderId}|${p.receiverId}|${p.methodName}|${p.depositYocto ?? "0"}|${stable(p.args)}`;
}

export function loadInflight(store: KV | null, key: string): InflightEntry | null {
  try { const s = store?.getItem(key); return s ? (JSON.parse(s) as InflightEntry) : null; } catch { return null; }
}
export function saveInflight(store: KV | null, key: string, e: InflightEntry): void { try { store?.setItem(key, JSON.stringify(e)); } catch { /* storage off */ } }
export function clearInflight(store: KV | null, key: string): void { try { store?.removeItem(key); } catch { /* storage off */ } }

export function browserStore(): KV | null {
  try { return typeof window !== "undefined" && window.localStorage ? window.localStorage : null; } catch { return null; }
}

export type StatusAnswer = { state: "executed" | "failed" | "pending" | "not_executed" | "not_found"; txHash?: string; receiptFailure?: string };
export type Resolution =
  | { state: "executed"; txHash?: string }
  | { state: "failed"; txHash?: string; receiptFailure?: string }
  | { state: "not_executed" }
  | { state: "consumed" } // the delegate's nonce was used but no outcome is available
  | { state: "unknown"; txHash?: string };

export interface ResolveDeps {
  /** relayer POST /relay/status; null when it can't be asked */
  status(by: { txHash: string } | { senderId: string; nonce: string }): Promise<StatusAnswer | null>;
  /** the user's access-key nonce (null = key/account missing) */
  chainNonce(senderId: string, publicKeyHex: string): Promise<bigint | null>;
  height(): Promise<bigint>;
}

export async function resolveInflight(e: InflightEntry, d: ResolveDeps): Promise<Resolution> {
  const st = await d.status(e.txHash ? { txHash: e.txHash } : { senderId: e.senderId, nonce: e.nonce }).catch(() => null);
  if (st?.state === "executed") return { state: "executed", txHash: st.txHash ?? e.txHash };
  if (st?.state === "failed") return { state: "failed", txHash: st.txHash ?? e.txHash, receiptFailure: st.receiptFailure };
  if (st?.state === "not_executed") return { state: "not_executed" };
  try {
    const [n, h] = await Promise.all([d.chainNonce(e.senderId, e.publicKeyHex), d.height()]);
    const nonce = BigInt(e.nonce);
    if (n !== null && n >= nonce) return st?.state === "pending" ? { state: "unknown", txHash: e.txHash } : { state: "consumed" };
    // past its maxBlockHeight a delegate can never execute, and its nonce is still unused: it did not happen
    if (h > BigInt(e.maxBlockHeight)) return { state: "not_executed" };
  } catch { /* can't tell */ }
  return { state: "unknown", txHash: e.txHash };
}

/** Maps a resolution of an EARLIER attempt to what the caller sees; null = it did not happen, go ahead and sign. */
export function resolutionResult(r: Resolution): RelayResult | null {
  switch (r.state) {
    case "executed": return { ok: true, txHash: r.txHash, resumed: true };
    case "failed": return { ok: false, txHash: r.txHash, receiptFailure: r.receiptFailure, error: `transaction failed on chain: ${r.receiptFailure ?? "unknown reason"}`, resumed: true };
    case "consumed": return { ok: false, status: "unknown", error: CONSUMED_MESSAGE, resumed: true };
    case "unknown": return { ok: false, status: "unknown", txHash: r.txHash, error: CHECKING_MESSAGE };
    case "not_executed": return null;
  }
}

export interface GuardedRelayDeps extends ResolveDeps {
  store: KV | null;
  /** read nonce + height, build and sign the delegate; returns its base64, delegate nonce and maxBlockHeight */
  signNew(): Promise<{ signedDelegateB64: string; nonce: bigint; maxBlockHeight: bigint }>;
  relay(b64: string): Promise<RelayResult>;
  onRelaying?(): void;
  sleep(ms: number): Promise<void>;
  pollAttempts?: number;
  pollMs?: number;
}

/** Resolve-before-sign for an EARLIER attempt of this action only (no signing). null = nothing in flight. */
export async function checkInflight(key: string, d: Pick<GuardedRelayDeps, "store"> & ResolveDeps): Promise<RelayResult | null> {
  const prev = loadInflight(d.store, key);
  if (!prev) return null;
  const r = await resolveInflight(prev, d);
  if (r.state !== "unknown") clearInflight(d.store, key);
  return resolutionResult(r);
}

export async function guardedRelay(key: string, who: { senderId: string; publicKeyHex: string }, d: GuardedRelayDeps): Promise<RelayResult> {
  const earlier = await checkInflight(key, d);
  if (earlier) return earlier;
  const s = await d.signNew();
  const entry: InflightEntry = { ...who, nonce: s.nonce.toString(), maxBlockHeight: s.maxBlockHeight.toString(), at: Date.now() };
  saveInflight(d.store, key, entry); // BEFORE the request: a reload mid-send still knows about it
  d.onRelaying?.();
  let r: RelayResult;
  try {
    r = await d.relay(s.signedDelegateB64);
  } catch (e) {
    r = { ok: false, status: "unknown", error: String((e as Error)?.message ?? e) };
  }
  if (r.status !== "unknown") { clearInflight(d.store, key); return r; } // a definite answer (done, failed on chain, or refused / not sent)
  if (r.txHash) saveInflight(d.store, key, { ...entry, txHash: r.txHash });
  for (let i = 0; i < (d.pollAttempts ?? 5); i++) {
    await d.sleep(d.pollMs ?? 3000);
    const res = await checkInflight(key, d);
    if (res === null) return { ok: false, error: "it did not go through; nothing moved" }; // resolved: it never executed
    if (res.status === "unknown" && !res.resumed) continue;
    return { ...res, resumed: false }; // this same run sent it (balances read before it are still valid)
  }
  return { ok: false, status: "unknown", txHash: r.txHash, error: CHECKING_MESSAGE };
}
