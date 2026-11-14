// WT1d (2): open_utc is stamped when the form is built, but the resolver refuses a BTC sheet whose open_utc is more
// than OPEN_UTC_SKEW_SECS from the open clock (template.rs open_problems). A review screen left open past that
// window must therefore be re-stamped at Open. Re-stamping changes terms => terms_hash changes => the user must
// see the final terms and the source-check attestation (bound to the old hash) must be redone: `requiresReconfirm`.
import { canonicalTerms, parseIso, templateId, termsHash } from "./templates";
import { openUtcNow } from "./guidedFields";

export const OPEN_UTC_SKEW_SECS = 300; // resolver/core/src/template.rs OPEN_UTC_SKEW_SECS
/** Re-stamp once open_utc is this far off, leaving headroom for relay latency inside the 300s window. */
export const REFRESH_AFTER_SECS = 240;

const isBtc = (ts: any) => { const id = templateId(ts).id; return id === "btc_close_at_t" || id === "btc_touch"; };

export function openUtcSkewProblems(sheet: any, clockMs: number): string[] {
  if (!isBtc(sheet)) return [];
  const o = parseIso(sheet.fields?.open_utc);
  if (o === null) return [];
  const now = Math.floor(clockMs / 1000);
  if (Math.abs(o - now) <= OPEN_UTC_SKEW_SECS) return [];
  return [`OPEN_UTC_SKEW: open_utc ${sheet.fields.open_utc} is more than ${OPEN_UTC_SKEW_SECS}s from the open clock ${new Date(now * 1000).toISOString().replace(".000Z", "Z")}`];
}

export interface PreparedSheet {
  sheet: any;
  terms: string;
  termsHash: string;
  refreshed: boolean;
  from?: string;
  to?: string;
  requiresReconfirm: boolean;
}

export function prepareSheetForOpen(sheet: any, nowMs: number, reviewedHash: string | null): PreparedSheet {
  let out = sheet, refreshed = false, from: string | undefined, to: string | undefined;
  if (isBtc(sheet)) {
    const o = parseIso(sheet.fields?.open_utc);
    if (o === null || Math.abs(o - Math.floor(nowMs / 1000)) > REFRESH_AFTER_SECS) {
      from = sheet.fields?.open_utc; to = openUtcNow(nowMs);
      out = { ...sheet, fields: { ...sheet.fields, open_utc: to } };
      refreshed = true;
    }
  }
  const terms = canonicalTerms(out);
  const th = termsHash(terms);
  return { sheet: out, terms, termsHash: th, refreshed, from, to, requiresReconfirm: reviewedHash !== null && th !== reviewedHash };
}

// OFIX1: the resolver judges open_utc against ITS clock at check time, so every source check (first, Retry/Check again, the automatic
// re-check, a duplicated bet's check) sends a sheet stamped to the current minute -- not only once it is REFRESH_AFTER_SECS stale.
// Any typed sheet (not custom) that carries fields.open_utc is stamped; everything else is passed through. The approval then holds
// this stamped sheet, so the terms signed at Open are the ones checked (approvalGate / RESTAMP_MESSAGE are unchanged).
const hasOpenUtc = (s: any): boolean => {
  const id = s?.template && typeof s.template === "object" ? s.template.id : undefined;
  return typeof id === "string" && id !== "custom" && typeof s?.fields?.open_utc === "string";
};

// CFIX1 (same rule for a custom bet): a "Counts from" (time.window_start) the person never typed is the app's "now" stamp, so the
// check re-stamps it to this minute too (`opts.windowStart`, set from StructuredOffer.restampWindowStart). A typed value is never moved.
const isCustom = (s: any): boolean => templateId(s).id === "custom" && typeof s?.time?.window_start === "string";

export function stampForCheck(sheet: any, nowMs: number, opts: { windowStart?: boolean } = {}): PreparedSheet {
  let out = sheet, refreshed = false, from: string | undefined, to: string | undefined;
  if (hasOpenUtc(sheet)) {
    to = openUtcNow(nowMs);
    if (to !== sheet.fields.open_utc) {
      from = sheet.fields.open_utc;
      out = { ...sheet, fields: { ...sheet.fields, open_utc: to } };
      refreshed = true;
    }
  } else if (opts.windowStart && isCustom(sheet)) {
    to = openUtcNow(nowMs);
    if (to !== sheet.time.window_start) {
      from = sheet.time.window_start;
      out = { ...sheet, time: { ...sheet.time, window_start: to } };
      refreshed = true;
    }
  }
  const terms = canonicalTerms(out);
  return { sheet: out, terms, termsHash: termsHash(terms), refreshed, from, to: refreshed ? to : undefined, requiresReconfirm: false };
}
