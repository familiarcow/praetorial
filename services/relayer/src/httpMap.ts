// Host-neutral HTTP mapping shared by the node handler (http.ts) and the Worker: which errors are client-safe,
// their status codes, and the /budget/global JSON shape. Only errors raised for caller mistakes carry a
// client-safe message; anything else (RPC/fetch/sqlite errors) can embed endpoint URLs with API keys or paths,
// so the client is told nothing.
import { BadSignedDelegate } from "./relayerErrors.js";
import { GuardViolation, GlobalCapViolation, type GlobalBudgetStatus } from "./guardStoreCore.js";
import { PolicyViolation } from "./policy.js";

/** A real SignedDelegate is a few hundred bytes; 64 KiB is generous. */
export const MAX_BODY_BYTES = 64 * 1024;

export class BadRequest extends Error {}

export function parseRelayBody(body: string): string {
  let payload: any;
  try { payload = JSON.parse(body); } catch { throw new BadRequest("body must be JSON"); }
  if (!payload || typeof payload.signedDelegate !== "string") throw new BadRequest("body must be { signedDelegate: base64 string }");
  return payload.signedDelegate;
}

export function errorResponse(err: any): { status: number; body: { ok: false; error: string }; internal: boolean } {
  if (err instanceof PolicyViolation || err instanceof GuardViolation || err instanceof BadSignedDelegate || err instanceof BadRequest) {
    return { status: err instanceof GlobalCapViolation ? 429 : 400, body: { ok: false, error: String(err.message) }, internal: false };
  }
  return { status: 500, body: { ok: false, error: "internal relayer error" }, internal: true };
}

export function budgetJson(g: GlobalBudgetStatus) {
  return {
    ok: true, capYocto: g.capYocto.toString(), openCapYocto: g.openCapYocto.toString(), reservedCapYocto: g.reservedCapYocto.toString(),
    usedYocto: g.usedYocto.toString(), openUsedYocto: g.openUsedYocto.toString(), reservedUsedYocto: g.reservedUsedYocto.toString(),
    windowStartMs: g.windowStartMs, windowEndsMs: g.windowEndsMs,
  };
}

/** RELAY500: what the 500 catch-all logs (never sent to the client): error class + message, URLs and long key-looking tokens stripped, bounded. */
export function describeInternal(err: any): string {
  const msg = String(err?.message ?? (typeof err === "string" ? err : "")).replace(/https?:\/\/\S+/g, "<url>").replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/g, "<key>").slice(0, 300);
  const name = err?.name && err.name !== "Error" ? err.name : (err instanceof Error ? err.constructor.name : "Error");
  return `${name}: ${msg}`;
}
