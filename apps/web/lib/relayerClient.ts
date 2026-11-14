// Thin client for services/relayer's POST /relay endpoint. Never signs
// anything itself -- it just ships an already-signed base64 borsh
// SignedDelegateAction (built by lib/delegate.ts + a Privy signRawHash)
// to the relayer and surfaces its JSON response.
import { NETWORK, requireService } from "./network";
export const RELAYER_URL = NETWORK.relayerUrl; // WEBNET1: empty on mainnet -> fail closed

export interface RelayResult {
  ok: boolean;
  txHash?: string;
  error?: string;
  receiptFailure?: string; // set when the tx reached the chain and a receipt failed
  /** SEC1/MON-2: sent (or maybe sent), outcome not known yet. NEVER read as "failed": check before re-signing (lib/inflightSend.ts). */
  status?: "unknown";
  /** SEC1/MON-2: this answer is the outcome of an EARLIER attempt of the same action (found while checking before re-signing). */
  resumed?: boolean;
}

export async function relaySignedDelegate(signedDelegateB64: string): Promise<RelayResult> {
  let base: string;
  try { base = requireService("relayer", RELAYER_URL); } catch (e) { return { ok: false, error: (e as Error).message }; }
  let res: Response;
  try {
    res = await fetch(`${base}/relay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signedDelegate: signedDelegateB64 }),
    });
  } catch (e) {
    // SEC1/MON-2: the request may have reached the relayer before the connection died: unknown, not failed.
    return { ok: false, status: "unknown", error: `could not reach the relayer: ${String((e as Error)?.message ?? e)}` };
  }
  let body: any;
  try {
    body = await res.json();
  } catch {
    // a gateway 5xx (no JSON) can come back after the relayer already sent the tx
    return res.status >= 500 ? { ok: false, status: "unknown", error: `relayer returned non-JSON (status ${res.status})` } : { ok: false, error: `relayer returned non-JSON (status ${res.status})` };
  }
  if (res.status === 202 || body?.status === "unknown") {
    return { ok: false, status: "unknown", txHash: typeof body?.txHash === "string" ? body.txHash : undefined, error: String(body?.error ?? "outcome not known yet") };
  }
  if (!res.ok && body.ok === undefined) {
    return { ok: false, error: body.error ?? `relayer http ${res.status}` };
  }
  return body as RelayResult;
}

/** SEC1/MON-2: POST /relay/status -> what became of an earlier relayed delegate; null when the relayer can't answer. */
export async function relayStatus(by: { txHash: string } | { senderId: string; nonce: string }): Promise<{ state: "executed" | "failed" | "pending" | "not_executed" | "not_found"; txHash?: string; receiptFailure?: string } | null> {
  let base: string;
  try { base = requireService("relayer", RELAYER_URL); } catch { return null; }
  try {
    const res = await fetch(`${base}/relay/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(by) });
    if (!res.ok) return null;
    const b: any = await res.json();
    return b && typeof b.state === "string" ? b : null;
  } catch {
    return null;
  }
}
