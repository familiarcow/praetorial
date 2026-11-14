// D-FETCH2 (queue item 7f2): requests the resolver's sourcecheck job and
// turns its result into the `SourceCheckAttestation` shape
// `TransferMsg::Open` now requires on-chain (contracts/escrow/src/lib.rs
// ~227-240/~855-900). Message format, freshness window and field names
// mirror `services/common/src/sourceCheck.ts` and
// `resolver/core::sourcecheck_message` byte-for-byte; all three (plus
// `judge-proto/evidence.py`) pin against the shared fixture
// `contracts/escrow/tests/fixtures/sourcecheck_crosscheck.json`.
//
// The endpoint is the sourcecheck Worker (services/workers/sourcecheck), selected per network in
// lib/networkSelect.ts; VITE_SOURCECHECK_URL overrides. The job's request/response shape
// here matches resolver/README.md's documented `"sourcecheck"` job:
//   request:  {"mode":"sourcecheck","terms":"<raw term sheet string>"}   (D-ATTEST1, 7g4)
//   response: {"ok","spec_hash","checked_at","unreachable":[{id,reason}],"signing"?}
// The resolver derives spec_hash (sha256 of `terms`), the sources, the referee
// exemption and checked_at itself -- none are sent. `signing`, when present, is
// `{pubkey_hex, signature_hex}`; the on-chain `SourceCheckAttestation` is
// `{ checked_at (response top-level), signature_hex }`.

import { resolveSourcecheckUrl, readBuildEnv } from "./networkSelect";
// WEBSRC1: network-selected (testnet Worker by default; mainnet placeholder; VITE_SOURCECHECK_URL overrides). Never localhost.
export const SOURCECHECK_URL: string = resolveSourcecheckUrl(readBuildEnv());

/** Builds the exact message a resolver signs (and the contract verifies)
 * -- MUST stay byte-identical to `sourcecheck_message` in
 * contracts/escrow/src/lib.rs (~line 229) and
 * services/common/src/sourceCheck.ts::buildSourceCheckMessage. */
export function sourcecheckMessage(specHash: string, checkedAtNs: string | bigint): string {
  const checkedAt = typeof checkedAtNs === "bigint" ? checkedAtNs.toString() : checkedAtNs;
  if (!/^\d+$/.test(checkedAt)) {
    throw new Error(`sourcecheckMessage: checkedAtNs must be a non-negative integer, got ${checkedAtNs}`);
  }
  return `praetorial:sourcecheck:v1:${specHash}:${checkedAt}`;
}

/** One hour in nanoseconds -- D-FETCH2's freshness window, inclusive at
 * the boundary (exactly 1h old passes, 1h+1ns fails). Matches
 * contracts/escrow/src/lib.rs::SOURCECHECK_FRESHNESS_NS and
 * services/common/src/sourceCheck.ts::SOURCECHECK_FRESHNESS_WINDOW_NS. */
export const SOURCECHECK_FRESHNESS_NS = 3_600n * 1_000_000_000n;

export function isSourceCheckFresh(checkedAtNs: string | bigint, nowNs: string | bigint): boolean {
  const checkedAt = BigInt(checkedAtNs);
  const now = BigInt(nowNs);
  if (checkedAt > now) return false; // future checked_at always refused
  return now - checkedAt <= SOURCECHECK_FRESHNESS_NS;
}

/** On-chain attestation shape `TransferMsg::Open` carries, verbatim
 * (field names/case matter -- this is what gets JSON-serialized into the
 * `msg` the contract parses). */
export interface OpenAttestation {
  checked_at: string;
  signature_hex: string;
}

export interface SourceCheckSourceSpec {
  id: string;
  url?: string;
  referee_source_mode?: boolean;
}

interface SourceCheckJobResponse {
  ok: boolean;
  spec_hash: string;
  checked_at: string;
  unreachable: Array<{ id: string; reason: string }>;
  signing?: { pubkey_hex?: string; signature_hex: string };
}

/** Thrown for every way a source check can fail to produce a usable,
 * fresh attestation -- unreachable sources, network/endpoint failure,
 * malformed response, spec_hash mismatch, or staleness. Always carries a
 * clear, user-facing `message` (no raw stack/JSON dump). */
export type SourceCheckFailKind = "unreachable" | "timeout" | "rate_limit" | "service" | "bad_response" | "stale" | "rejected";
/** WEBRL1: what the Worker's 429 told us. `retryAfterS` is only set when the retry-after header was a positive whole number of seconds. */
export interface RateLimitInfo { scope: "ip" | "global"; retryAfterS?: number }
export class SourceCheckFailedError extends Error {
  /** SRCREF1: the Worker's own `reason` text (e.g. its 422 lint refusal), shown to the user verbatim under the plain headline. */
  public workerReason?: string;
  constructor(message: string, public kind: SourceCheckFailKind = "service", public sources: Array<{ id: string; reason: string }> = [], public rateLimit?: RateLimitInfo, workerReason?: string) {
    super(message);
    if (workerReason) this.workerReason = workerReason;
  }
}

/** FE6 (S6): how long the app waits for the resolver before saying "The check is taking too long". */
export const SOURCECHECK_TIMEOUT_MS = 60_000;

/** Requests a fresh sourcecheck attestation for `specHash` (the term
 * sheet's `terms_hash`, i.e. `Envelope.terms_hash` -- no new hash scheme)
 * from the configured resolver endpoint. Throws `SourceCheckFailedError`
 * with a clear reason on any failure; NEVER returns a stale or
 * unreachable-sources result as if it were usable (D-FETCH2: "if any
 * source can't be fetched, creation fails"). */
export async function requestSourceCheck(
  specHash: string,
  rawTerms: string,
  endpoint: string = SOURCECHECK_URL,
  timeoutMs: number = SOURCECHECK_TIMEOUT_MS,
  /** REVIEW1 (#10): "now" for the freshness check in ns. null = skip it here: the caller judges freshness from chain + monotonic time
   *  (lib/openApproval approvalTimeLeftMs), because a device clock that is behind makes a fresh check look like it is from the future.
   *  undefined = the device clock read when the RESPONSE arrives (CS1: the resolver stamps checked_at during the ~15 s check, so a
   *  "now" captured at call start made every fresh attestation look like it came from the future). */
  nowNs?: bigint | null,
): Promise<OpenAttestation> {
  let res: Response;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "sourcecheck", terms: rawTerms }),
      signal: ctl.signal,
    });
  } catch (err: any) {
    if (ctl.signal.aborted || err?.name === "AbortError") {
      throw new SourceCheckFailedError(`source check timed out after ${timeoutMs}ms`, "timeout");
    }
    throw new SourceCheckFailedError(
      `could not reach the source-check service at ${endpoint}: ${String(err?.message ?? err)}`,
      "service",
    );
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) {
    // The Worker sends {ok:false, reason, scope:"ip"|"global"} + retry-after (seconds). Anything missing/garbage degrades to "no number".
    let scope: "ip" | "global" = "ip";
    try { if ((await res.json())?.scope === "global") scope = "global"; } catch { /* non-JSON body: treat as ip */ }
    const raw = (res.headers.get("retry-after") ?? "").trim();
    const secs = /^\d+$/.test(raw) ? Number(raw) : NaN;
    throw new SourceCheckFailedError("source check rate-limited", "rate_limit", [], { scope, ...(secs > 0 ? { retryAfterS: secs } : {}) });
  }

  let body: SourceCheckJobResponse;
  try {
    body = await res.json();
  } catch {
    throw new SourceCheckFailedError(`source-check service at ${endpoint} returned a non-JSON response`, "service");
  }

  if (!res.ok || !body.ok || !body.signing) {
    const unreachable = Array.isArray(body?.unreachable) ? body.unreachable : [];
    const reasons = unreachable.map((u) => `${u.id}: ${u.reason}`).join("; ");
    // SRCREF1: keep the Worker's own reason (never swallow it into a generic error). A 4xx other than 429 is the Worker refusing the sheet.
    const workerReason = typeof (body as any)?.reason === "string" && (body as any).reason.trim() !== "" ? String((body as any).reason).slice(0, 1000) : undefined;
    const rejected = !reasons && res.status >= 400 && res.status < 500;
    throw new SourceCheckFailedError(
      reasons
        ? `source check failed -- unreachable source(s): ${reasons}. Cannot open this offer without a fresh attestation.`
        : `source check failed -- ${workerReason ?? "the resolver could not produce a signed attestation"}. Cannot open this offer.`,
      reasons ? "unreachable" : rejected ? "rejected" : "bad_response",
      unreachable,
      undefined,
      workerReason,
    );
  }

  if (body.spec_hash !== specHash) {
    throw new SourceCheckFailedError(
      "source-check attestation's spec_hash does not match this term sheet -- refusing to use it.",
      "bad_response",
    );
  }

  if (!/^\d+$/.test(String(body.checked_at))) {
    throw new SourceCheckFailedError("source-check attestation has no usable checked_at -- refusing to use it.", "bad_response");
  }
  const freshAt = nowNs === undefined ? BigInt(Date.now()) * 1_000_000n : nowNs;
  if (freshAt !== null && !isSourceCheckFresh(String(body.checked_at), freshAt)) {
    throw new SourceCheckFailedError(
      "source-check attestation is stale (older than the 1-hour freshness window) -- request a new one before opening.",
      "stale",
    );
  }

  return { checked_at: String(body.checked_at), signature_hex: body.signing.signature_hex };
}
