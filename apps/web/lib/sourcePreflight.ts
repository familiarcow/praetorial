// FE6 (S6, D-UX21): pure helpers for the source-preflight step -- plain-English failure text (UX-1..UX-20: no codes, no jargon, says what
// to do next), the freshness timer, and the human-mode rule. The 1h window is the contract's own (sourceCheckClient.SOURCECHECK_FRESHNESS_NS).
import { SOURCECHECK_FRESHNESS_NS, type RateLimitInfo, type SourceCheckFailKind } from "./sourceCheckClient";

export const PREFLIGHT_STEPS = ["Reaching the sources", "Reading the pages", "Checking the answer can be found"];

/** Human mode (a named referee) makes no AI call and no source check at all (spec S6 / UX-18..20). */
export function preflightApplies(refereeAccount: string | null): boolean {
  return !refereeAccount;
}

const GENERIC_REASON = "We couldn't read this source the way the AI needs to.";

export function plainSourceReason(raw: string): string {
  const r = String(raw).toLowerCase();
  const http = r.match(/http (\d{3})/);
  if (http) {
    const n = Number(http[1]);
    if (n === 429) return "The site says we sent too many requests. Try again in a minute.";
    if (n === 401 || n === 403) return "The site won't let us in. It blocks automated readers.";
    if (n === 404 || n === 410) return "The page isn't there any more, or the link is wrong.";
    if (n >= 500) return "The site is down or having trouble right now.";
    return "The site didn't give us the page.";
  }
  if (r.includes("login wall")) return "The page needs you to log in, so the AI can't read it.";
  if (r.includes("captcha") || r.includes("challenge") || r.includes("bot")) return "The site asks visitors to check that you're human, so the AI can't read it.";
  if (r.includes("empty")) return "The page came back empty.";
  if (r.includes("invalid or truncated") || r.includes("json")) {
    if (r.includes("content-type")) return "The link gives a web page, which isn't the kind of data this source should return.";
    return "The data on this page is cut off or unreadable, so we can't read it.";
  }
  if (r.includes("content-type")) return "The link isn't the kind of data this source should return.";
  return GENERIC_REASON;
}

export interface PlainFailure {
  headline: string; lines: Array<{ source: string; reason: string }>; retry: boolean;
  /** WEBRL1: set for a 429. `minutes` only when the Worker gave a usable retry-after (ip scope). */
  state?: "rate-limited"; minutes?: number; waitMs?: number; scope?: "ip" | "global";
  /** SRCREF1: the source-check service's own reason, shown verbatim under the headline. */
  detail?: string;
  /** OFIX1: the resolver refused the TERMS (a "<terms>" row), not a source; the OPEN_* code (e.g. "OPEN_UTC_SKEW"), or "TERMS". */
  termsCode?: string;
}

// OFIX1: the resolver reports a refusal of the bet's own terms (open-time checks, lint) as an unreachable row with id "<terms>" and a
// reason "OPEN_*: detail" (resolver/core/src/template.rs open_problems). That is not a source the AI couldn't read: say what is wrong.
export const TERMS_ROW = "<terms>";
const TERMS_COPY: Array<[string, string, boolean]> = [
  // [code prefix, plain copy, checking again can help]
  ["OPEN_UTC_SKEW", "The start time went stale. Tap Check again.", true],
  ["OPEN_T_TOO_SOON", "The price time must be at least 1 hour after the bet opens. Pick a later time.", false],
  ["OPEN_DEADLINE_NOT_AFTER_OPEN", "The deadline has already passed. Pick a later deadline.", false],
  ["OPEN_DEADLINE_TOO_FAR", "The deadline is more than 4 years away. Pick an earlier deadline.", false],
  ["OPEN_WEATHER_DATE_PAST", "That day has already started at the weather station. Pick a later date.", false],
  ["OPEN_EVENT_NOT_ON_DATE", "That game isn't on the league schedule for that date. Check the game and the date.", false],
  ["OPEN_EVENT_DATE_MISMATCH", "The league schedule we got is for a different date than the game. Check the game and the date.", false],
  ["OPEN_EVENT_UNREADABLE", "We couldn't load the league schedule to confirm the game. Try again in a few minutes.", true],
];
const TERMS_FALLBACK = "The AI can't settle the bet's terms as written. Change the wording, or pick a person to decide.";

const codeOf = (reason: string): string => {
  const m = /^\s*([A-Z][A-Z0-9_]*)\s*:/.exec(String(reason));
  return m ? m[1] : "TERMS";
};
/** The resolver's code for the first "<terms>" row (e.g. "OPEN_UTC_SKEW"; "TERMS" when it has none), or null when no row is one. */
export function termsCode(sources: Array<{ id: string; reason: string }>): string | null {
  const t = sources.find((s) => s.id === TERMS_ROW);
  return t ? codeOf(t.reason) : null;
}
/** Plain copy for a "<terms>" reason. Never the raw code, never "couldn't read this source". */
export function plainTermsReason(raw: string): string {
  const code = codeOf(raw);
  return TERMS_COPY.find(([c]) => c === code)?.[1] ?? TERMS_FALLBACK;
}
function termsFailure(sources: Array<{ id: string; reason: string }>): PlainFailure {
  const rows = sources.filter((s) => s.id === TERMS_ROW);
  const code = codeOf(rows[0].reason);
  const copies = [...new Set(rows.map((r) => plainTermsReason(r.reason)))];
  const retry = rows.every((r) => TERMS_COPY.find(([c]) => c === codeOf(r.reason))?.[2] ?? false);
  const others = sources.filter((s) => s.id !== TERMS_ROW).map((s) => ({ source: s.id, reason: plainSourceReason(s.reason) }));
  return { headline: copies[0], lines: [...copies.slice(1).map((reason) => ({ source: "Also", reason })), ...others], retry, termsCode: code };
}

function rateLimited(rl?: RateLimitInfo): PlainFailure {
  const scope = rl?.scope ?? "ip";
  const waitMs = rl?.retryAfterS === undefined ? undefined : rl.retryAfterS * 1000;
  if (scope === "global") return { headline: "Too many checks right now. Try again tomorrow.", lines: [], retry: true, state: "rate-limited", scope, ...(waitMs === undefined ? {} : { waitMs }) };
  if (rl?.retryAfterS === undefined) return { headline: "Too many checks. Try again in a minute.", lines: [], retry: true, state: "rate-limited", scope };
  const minutes = Math.max(1, Math.ceil(rl.retryAfterS / 60));
  return { headline: `Too many checks right now. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`, lines: [], retry: true, state: "rate-limited", minutes, scope, waitMs };
}

export function plainPreflightFailure(kind: SourceCheckFailKind, sources: Array<{ id: string; reason: string }>, rateLimit?: RateLimitInfo, workerReason?: string): PlainFailure {
  // OFIX1: the service's own reason for a "<terms>" refusal is its generic "sources were unreachable" line: not shown.
  if (kind === "unreachable" && termsCode(sources) !== null) return termsFailure(sources);
  const f = plainPreflightFailureBase(kind, sources, rateLimit);
  return workerReason && kind !== "rate_limit" ? { ...f, detail: workerReason } : f;
}
function plainPreflightFailureBase(kind: SourceCheckFailKind, sources: Array<{ id: string; reason: string }>, rateLimit?: RateLimitInfo): PlainFailure {
  const advice = "Change the page or the wording, or pick a person to decide.";
  switch (kind) {
    case "timeout": return { headline: "The check is taking too long. Retry.", lines: [], retry: true };
    case "rate_limit": return rateLimited(rateLimit);
    case "service": return { headline: "Checking sources is unavailable. You can still make a bet with a person as referee.", lines: [], retry: true };
    case "rejected": return { headline: "This bet can't open as written. The source check refused it:", lines: [], retry: false };
    case "stale": return { headline: "That check is already out of date. Check the sources again.", lines: [], retry: true };
    case "unreachable":
      return { headline: `The AI can't settle this as written: it can't read ${sources.length === 1 ? "one of the sources" : "some of the sources"}. ${advice}`,
        lines: sources.map((s) => ({ source: s.id, reason: plainSourceReason(s.reason) })), retry: false };
    default:
      return { headline: `The AI can't settle this as written: the check didn't come back clean. ${advice}`, lines: [], retry: true };
  }
}

/** Milliseconds the attestation can still be used for an Open (contract window), floored at 0; a future checked_at is never usable. */
export function attestationTimeLeftMs(checkedAtNs: string | bigint, nowMs: number): number {
  const checked = BigInt(checkedAtNs);
  const now = BigInt(Math.trunc(nowMs)) * 1_000_000n;
  if (checked > now) return 0;
  const left = (checked + SOURCECHECK_FRESHNESS_NS - now) / 1_000_000n;
  return left > 0n ? Number(left) : 0;
}

export function formatTimeLeft(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function checkedAtLabel(checkedAtNs: string | bigint): string {
  const d = new Date(Number(BigInt(checkedAtNs) / 1_000_000n));
  return `${d.toISOString().slice(11, 16)} UTC`;
}
