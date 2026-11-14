// BET1a (UX-33 section 2): the "any web page" Details step shows only the claim, ONE deadline (typed in local time,
// stored as a UTC minute) and two source links. Everything else lives under "More options" and, when left blank, gets a
// default taken from existing template code (nothing new for the judge):
//   - window start: "now" (the typed BTC templates' open_utc, D-TPL1); CFIX1: re-stamped every time the deadline is picked and before
//     the source check, until the person types their own value. It is never the deadline.
//   - evidence cutoff: deadline + 7 days (resolver template.rs EVIDENCE_TAIL_SECS = RECOVERY_SECS, D-RESOLVE1)
//   - the judge's one yes/no question: the claim itself
//   - a source's publisher: the link's site name (the lint's origin check reads the URL's domain anyway)
//   - fallback / early rules and the standard clauses: blankCustomForm's existing defaults
// The lint itself is unchanged; detailFieldsFor maps each problem it reports to the field the person must change.
import { RECOVERY_SECS } from "./templates";
import type { CustomForm } from "./customBuilder";

export const DETAILS_EVIDENCE_TAIL_MS = RECOVERY_SECS * 1000;
const MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const pad = (n: number) => String(n).padStart(2, "0");

/** Stored UTC minute (`YYYY-MM-DDTHH:MM`) -> the same instant as a local `datetime-local` value. "" when not a full minute. */
export function utcToLocalInput(utcMinute: string): string {
  if (!MINUTE.test(utcMinute)) return "";
  const d = new Date(`${utcMinute}:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local `datetime-local` value -> stored UTC minute. "" while the value is incomplete. */
export function localInputToUtc(local: string): string {
  if (!MINUTE.test(local)) return "";
  const d = new Date(local); // no zone suffix: parsed as local time
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 16);
}

export const utcMinuteOf = (ms: number) => new Date(Math.floor(ms / 60000) * 60000).toISOString().slice(0, 16);

/** CFIX1: the window start is the app's own stamp (blank, or stamped by withDeadline and not typed over since). */
export const windowStartIsAuto = (f: CustomForm): boolean => f.windowStart === "" || f.windowStartAuto === true;

/** Set the deadline (end of the event window). CFIX1 (PM): the window start is set to NOW (UTC, minute floor) every time the
 *  deadline is picked, unless the person typed their own; it is never derived from the deadline. A preset/copied value is kept. */
export function withDeadline(f: CustomForm, windowEndUtc: string, nowMs: number): CustomForm {
  if (!windowStartIsAuto(f)) return { ...f, windowEnd: windowEndUtc };
  return windowEndUtc
    ? { ...f, windowEnd: windowEndUtc, windowStart: utcMinuteOf(nowMs), windowStartAuto: true }
    : { ...f, windowEnd: windowEndUtc, windowStart: "", windowStartAuto: undefined };
}

/** CFIX1: the person typed in "Counts from". Clearing it hands it back to the app (now, once a deadline is set). */
export function withWindowStart(f: CustomForm, v: string, nowMs: number): CustomForm {
  if (v === "") return withDeadline({ ...f, windowStart: "", windowStartAuto: undefined }, f.windowEnd, nowMs);
  return { ...f, windowStart: v, windowStartAuto: false };
}

export const WINDOW_START_ORDER_PROBLEM = "time.window_start must be before time.window_end (the deadline)";
const MINUTE_MS = (v: string) => (MINUTE.test(v) ? Date.parse(`${v}:00Z`) : NaN);
/** CFIX1: "Counts from" at or after the deadline leaves no time for the event; web-side check (the resolver lint does not order them). */
export function windowOrderProblems(f: CustomForm): string[] {
  const s = MINUTE_MS(f.windowStart), e = MINUTE_MS(f.windowEnd);
  return Number.isFinite(s) && Number.isFinite(e) && s >= e ? [WINDOW_START_ORDER_PROBLEM] : [];
}

/** The link's site name, e.g. "https://www.reuters.com/x" -> "reuters.com". "" for anything that is not an http(s) URL. */
export function publisherFromUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return u.hostname.replace(/^www\./, "");
  } catch { return ""; }
}

/** The judge's single yes/no question when none was written: the claim itself. */
export function defaultQuestion(claim: string): string {
  const c = claim.trim().replace(/[.?!\s]+$/, "");
  return c ? `Is this true: ${c}?` : "";
}

export function defaultEvidenceCutoff(windowEndUtc: string): string {
  if (!MINUTE.test(windowEndUtc)) return "";
  const t = Date.parse(`${windowEndUtc}:00Z`);
  return Number.isNaN(t) ? "" : new Date(t + DETAILS_EVIDENCE_TAIL_MS).toISOString().slice(0, 16);
}

/** The form with every blank More-options value replaced by its default. Pure: the same form always gives the same result. */
export function withDetailDefaults(f: CustomForm): CustomForm {
  const noQuestions = f.elements.every((q) => q.trim() === "");
  const q = defaultQuestion(f.claim);
  return {
    ...f,
    elements: noQuestions && q ? [q] : f.elements,
    sources: f.sources.map((s) => (s.publisher.trim() === "" && s.url.trim() !== "" ? { ...s, publisher: publisherFromUrl(s.url) } : s)),
    evidenceCutoff: f.evidenceCutoff || defaultEvidenceCutoff(f.windowEnd),
  };
}

/** Fields on the Details step. The first three are always shown; the rest sit under "More options". */
export type DetailField = "claim" | "deadline" | "links" | "elements" | "sourceDetails" | "windowStart" | "evidenceCutoff" | "windowClose" | "fallbackRule" | "earlyRule" | "rules" | "clauses";
export const MORE_OPTION_FIELDS: DetailField[] = ["elements", "sourceDetails", "windowStart", "evidenceCutoff", "windowClose", "fallbackRule", "earlyRule", "rules", "clauses"];

const BY_START: Array<[RegExp, DetailField]> = [
  [/^(CUSTOM_RELATIVE_DATE|AMBIGUOUS_[A-Z_]+):/, "claim"],
  [/^missing field: claim/, "claim"],
  [/^missing field: (elements|rule)|^element \d+|^rule must be/, "elements"],
  [/^missing field: sources|^need >= 2 independent/, "links"],
  [/^source name|^source .* is a vague|^fork\/ticker not pinned|^market_pin|^repo_pin/, "sourceDetails"],
  [/^time\.window_start/, "windowStart"],
  [/^time\.window_end|^missing field: time/, "deadline"],
  [/^time\.evidence_cutoff/, "evidenceCutoff"],
  [/^no fallback-source/, "fallbackRule"],
  [/^no early-settlement/, "earlyRule"],
  [/^no wick-vs-close|^PRICE_READING_UNDEFINED|^custom definition|^coverage rule/, "rules"],
  [/^unknown clause|^missing field: clauses/, "clauses"],
];

/** The fields to open/highlight for the lint's problems, in a stable order. A claim wording problem also points at typed questions. */
export function detailFieldsFor(problems: string[], f: CustomForm): DetailField[] {
  const out = new Set<DetailField>();
  for (const p of problems) {
    const hit = BY_START.find(([re]) => re.test(p));
    if (!hit) continue;
    out.add(hit[1]);
    if (hit[1] === "claim" && f.elements.some((q) => q.trim() !== "")) out.add("elements");
  }
  return Array.from(out);
}
