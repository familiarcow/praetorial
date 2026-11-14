// SRCW1 (D-SRCW1): the sourcecheck HTTP core. Pure: every effect (lint, rate limiter, OutLayer chain, alerts, clock) is injected.
// Request {mode:"sourcecheck",terms} -> {ok,spec_hash,checked_at,unreachable,signing:{pubkey_hex,signature_hex}} (apps/web/lib/sourceCheckClient.ts).
// Order: CORS/origin -> shape -> LINT (4xx, no OutLayer) -> rate limits (429) -> OutLayer -> verify -> ok. Anything off => 5xx ok:false, never partial.
import { IP_PER_HOUR, SourceCheckLimiter } from "./limiter.js";

export const MAX_TERMS_BYTES = 100_000;
export interface SourceCheckChain {
  /** The escrow's pinned attest pubkey (resolver_keys[1]), hex. */
  pinnedAttestPubkeyHex(): Promise<string>;
  /** Runs the sourcecheck job on OutLayer and returns the guest's JSON output. Throws on error; name==="SourceCheckTimeout" on timeout. */
  execute(terms: string): Promise<unknown>;
}
export interface SourceCheckDeps {
  allowedOrigins: string[];
  limiter: Pick<SourceCheckLimiter, "consume">;
  /** LIVE2: the per-IP hourly cap the limiter enforces (for the refusal text); default IP_PER_HOUR. */
  ipPerHour?: number;
  lint(terms: string): string[];
  chain: SourceCheckChain;
  alert(message: string): Promise<void>;
  nowMs(): number;
  /** SECREV1 SR-2: verified attestations by spec_hash. A fresh one is returned again without a paid OutLayer run or quota. */
  cache?: AttestationCache;
}
export interface AttestationCache {
  get(specHash: string): Promise<{ checked_at: string; signature_hex: string } | undefined>;
  put(specHash: string, v: { checked_at: string; signature_hex: string }): Promise<void>;
}
/** SECREV1 SR-2: reuse window. The escrow accepts an attestation up to 1h old (SOURCECHECK_FRESHNESS_NS); a reused one keeps >= 40 min. */
export const CACHE_REUSE_MS = 20 * 60_000;

export function parseAllowedOrigins(s: string | undefined): string[] {
  return (s ?? "").split(",").map((x) => x.trim().replace(/\/+$/, "")).filter((x) => x && x !== "*" && /^https?:\/\//.test(x));
}

const hexOf = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b instanceof Uint8Array ? b : new Uint8Array(b))].map((x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string): Uint8Array | null => (/^([0-9a-f]{2})+$/i.test(h) ? Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16))) : null);
export async function sha256Hex(s: string): Promise<string> { return hexOf(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); }
async function verifyEd25519(pubHex: string, sigHex: string, msg: string): Promise<boolean> {
  const pub = fromHex(pubHex), sig = fromHex(sigHex);
  if (!pub || pub.length !== 32 || !sig || sig.length !== 64) return false;
  try { return await crypto.subtle.verify({ name: "Ed25519" }, await crypto.subtle.importKey("raw", pub as Uint8Array<ArrayBuffer>, { name: "Ed25519" }, false, ["verify"]), sig as Uint8Array<ArrayBuffer>, new TextEncoder().encode(msg)); } catch { return false; }
}
export const sourceCheckMessage = (specHash: string, checkedAt: string) => `praetorial:sourcecheck:v1:${specHash}:${checkedAt}`;

export async function handleSourceCheck(request: Request, d: SourceCheckDeps): Promise<Response> {
  const origin = request.headers.get("origin");
  const originOk = origin !== null && d.allowedOrigins.includes(origin.replace(/\/+$/, ""));
  const cors: Record<string, string> = originOk ? { "access-control-allow-origin": origin!, vary: "Origin" } : { vary: "Origin" };
  const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors, ...extra } });
  const fail = (status: number, reason: string, extra: Record<string, unknown> = {}, h: Record<string, string> = {}) => json(status, { ok: false, reason, unreachable: [], ...extra }, h);

  if (origin !== null && !originOk) return new Response(JSON.stringify({ ok: false, reason: "origin not allowed" }), { status: 403, headers: { "content-type": "application/json", vary: "Origin" } });
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" } });
  }
  if (request.method !== "POST") return fail(405, "method not allowed", {}, { allow: "POST, OPTIONS" });

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_TERMS_BYTES + 1000) return fail(413, "request too large");
  let body: any;
  try { body = JSON.parse(raw); } catch { return fail(400, "request body must be JSON"); }
  if (!body || body.mode !== "sourcecheck") return fail(400, 'request must be {"mode":"sourcecheck","terms":"<raw sheet>"}');
  if (typeof body.terms !== "string" || body.terms === "") return fail(400, "terms must be the raw term sheet string");
  const terms: string = body.terms;
  if (new TextEncoder().encode(terms).length > MAX_TERMS_BYTES) return fail(413, "term sheet too large");
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  if (!ip) return fail(400, "client address unavailable (fail closed)");

  // (4) lint BEFORE the limiter or any OutLayer call: an invalid sheet costs nothing and executes nothing.
  const problems = d.lint(terms);
  if (problems.length > 0) return fail(422, `term sheet failed lint: ${problems.join("; ")}`, { problems });

  // SECREV1 SR-2: the same sheet again while its verified attestation is fresh costs nothing (no OutLayer run, no quota).
  const specHashEarly = await sha256Hex(terms);
  if (d.cache) {
    const hit = await d.cache.get(specHashEarly).catch(() => undefined);
    if (hit && /^\d+$/.test(hit.checked_at)) {
      const ageMs = Number((BigInt(d.nowMs()) * 1_000_000n - BigInt(hit.checked_at)) / 1_000_000n);
      if (ageMs >= 0 && ageMs <= CACHE_REUSE_MS) {
        const pinned = (await d.chain.pinnedAttestPubkeyHex().catch(() => "")).toLowerCase();
        if (pinned && (await verifyEd25519(pinned, hit.signature_hex, sourceCheckMessage(specHashEarly, hit.checked_at)))) {
          return json(200, { ok: true, spec_hash: specHashEarly, checked_at: hit.checked_at, unreachable: [], signing: { pubkey_hex: pinned, signature_hex: hit.signature_hex } });
        }
      }
    }
  }

  // (5) caps, fail closed with an alert hook.
  const lim = await d.limiter.consume(ip, d.nowMs());
  if (!lim.ok) {
    const perHour = d.ipPerHour ?? IP_PER_HOUR;
    const reason = lim.scope === "global" ? "global daily sourcecheck cap reached (300/day); try again tomorrow" : `rate limit: ${perHour} sourcechecks per hour per address; try again later`;
    await d.alert(`sourcecheck ${lim.scope === "global" ? "GLOBAL daily cap (300) hit" : `per-IP rate limit (${perHour}/h) hit`}: refusing${lim.scope === "ip" ? ` ${ip}` : ""}`).catch(() => undefined);
    return fail(429, reason, { scope: lim.scope }, { "retry-after": String(lim.retryAfterS), "access-control-expose-headers": "retry-after" });
  }

  let pinned: string, out: any;
  try {
    pinned = (await d.chain.pinnedAttestPubkeyHex()).toLowerCase();
    out = await d.chain.execute(terms);
  } catch (e: any) {
    const timeout = e?.name === "SourceCheckTimeout";
    await d.alert(`sourcecheck ${timeout ? "TIMEOUT" : "OutLayer/chain error"}: ${String(e?.message ?? e).slice(0, 200)}`).catch(() => undefined);
    return fail(timeout ? 504 : 502, timeout ? "OutLayer sourcecheck timed out" : `OutLayer sourcecheck failed: ${String(e?.message ?? e).slice(0, 200)}`);
  }

  const unreachable = Array.isArray(out?.unreachable) ? out.unreachable.map((u: any) => ({ id: String(u?.id), reason: String(u?.reason) })) : [];
  if (!out || typeof out !== "object") return fail(502, "OutLayer returned a malformed result");
  if (out.ok !== true) return fail(502, "one or more sources were unreachable or the check failed", { unreachable });
  if (unreachable.length > 0) return fail(502, "result lists unreachable sources", { unreachable });
  const s = out.signing;
  if (!s || typeof s.pubkey_hex !== "string" || typeof s.signature_hex !== "string") return fail(502, "result is unsigned (fail closed)");
  if (String(s.pubkey_hex).toLowerCase() !== pinned) {
    await d.alert("sourcecheck SECURITY: signing pubkey != the escrow's pinned attest key; refusing").catch(() => undefined);
    return fail(502, "signing pubkey does not match the escrow's pinned attest key");
  }
  const specHash = await sha256Hex(terms);
  if (out.spec_hash !== specHash) return fail(502, "spec_hash is not sha256 of the submitted terms");
  const checkedAt = typeof out.checked_at === "string" ? out.checked_at : (typeof out.checked_at === "number" && Number.isSafeInteger(out.checked_at) ? String(out.checked_at) : "");
  if (!/^\d+$/.test(checkedAt)) return fail(502, "checked_at is missing or malformed");
  if (!(await verifyEd25519(pinned, s.signature_hex, sourceCheckMessage(specHash, checkedAt)))) return fail(502, "signature does not verify under the pinned attest key");
  await d.cache?.put(specHash, { checked_at: checkedAt, signature_hex: s.signature_hex }).catch(() => undefined);
  return json(200, { ok: true, spec_hash: specHash, checked_at: checkedAt, unreachable: [], signing: { pubkey_hex: pinned, signature_hex: s.signature_hex } });
}
