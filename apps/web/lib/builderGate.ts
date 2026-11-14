// PT1 (D-LAUNCH1 / D-L1MESSY2 / D-TPL1): the single gate between the custom-sheet builder and Open. A sheet is refused with
// the resolver lint's own named problems (typed -> lintTemplate, custom -> customOpenProblems) PLUS web-side ambiguity checks
// for phrasings the resolver lint accepts (web-only, named AMBIGUOUS_*; resolver gap reported as a follow-up, resolver untouched).
// Every message says what to change. CreateOffer.validate() and the review flags use this; Open is unreachable while it refuses.
import { ANCHOR, customOpenProblems } from "./customLint";
import { lintAnySheet, templateId } from "./templates";
import { addHints } from "./lintHints";

type J = any;
const quote = (s: string) => JSON.stringify(s);

function segs(ts: J): string[] {
  const s = [typeof ts?.claim === "string" ? ts.claim : ""];
  if (Array.isArray(ts?.elements)) s.push(...ts.elements.map((e: J) => (typeof e?.q === "string" ? e.q : "")));
  return s.filter((x) => x.trim() !== "");
}

// ANCHOR's trailing \b misses a full ISO timestamp ("2026-12-31T00:00:00Z"); a timestamp is a calendar date (mirrors resolver lint_hints.rs ISO_TS).
const ISO_ANCHOR = new RegExp(`${ANCHOR.source}|\\b\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}`, "i");
const RULES: Array<{ code: string; re: RegExp; unless?: RegExp; text: (m: string) => string }> = [
  { code: "AMBIGUOUS_AMOUNT", re: /\b\d[\d,.]*\s?k\b/i,
    text: (m) => `AMBIGUOUS_AMOUNT: ${quote(m)} is shorthand, not a stated level; write the level as a whole-dollar number (e.g. 100000)` },
  { code: "AMBIGUOUS_RELATIVE_DATE", re: /\b(today|now|currently|this (morning|afternoon|evening)|later)\b/i, unless: ISO_ANCHOR,
    text: (m) => `AMBIGUOUS_RELATIVE_DATE: ${quote(m)} depends on when it is read; state the calendar date (e.g. 2026-11-09) and a UTC time` },
  { code: "AMBIGUOUS_MULTI_ASSET", re: /\b[A-Z]{2,5}\s?\/\s?(?!USD\b|USDT\b|USDC\b|EUR\b)[A-Z]{2,5}\b|\b[A-Z]{3,5}\s+and\s+[A-Z]{3,5}\b/,
    text: (m) => `AMBIGUOUS_MULTI_ASSET: ${quote(m)} names more than one asset; use one claim per asset and name the asset, level and venue for each` },
  { code: "AMBIGUOUS_PERCENT_MOVE", re: /%|\bpercent\b|\bmoves?\b/i,
    text: (m) => `AMBIGUOUS_PERCENT_MOVE: ${quote(m)} is a percentage move with no fixed reference; replace it with a stated price level and a UTC time` },
  { code: "AMBIGUOUS_NO_TIMEZONE", re: /\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i, unless: /\b(utc|gmt)\b|T\d{2}:\d{2}(:\d{2})?Z/i,
    text: (m) => `AMBIGUOUS_NO_TIMEZONE: the time ${quote(m)} has no timezone; add UTC (e.g. 17:00 UTC)` },
  { code: "AMBIGUOUS_NO_STATION", re: /\b(hotter|colder|warmer|cooler|temperature|degrees|rain|snow)\b|\u00b0/i, unless: /\bK[A-Z]{3}\b/,
    text: (m) => `AMBIGUOUS_NO_STATION: ${quote(m)} is a weather claim with no NWS station; name the station (e.g. KNYC) and the reading (daily high)` },
  { code: "AMBIGUOUS_PARTY_CONTROLLED", re: /(^|[.;]\s*)(i|we)\b|\b(my|our)\s+(own\s+)?(post|tweet|account|page)\b/i,
    text: (m) => `AMBIGUOUS_PARTY_CONTROLLED: ${quote(m.trim())} is something a bettor controls; change it to an outcome neither side controls, or mark the source party-controlled and add two independent sources` },
  { code: "AMBIGUOUS_SUBJECTIVE", re: /^\s*(who|which|why|how)\b|\b(best|greatest|worst|better|worse|favou?rite)\b/i,
    text: (m) => `AMBIGUOUS_SUBJECTIVE: ${quote(m.trim())} is an opinion, not a checkable event; state a measurable outcome, who/what is measured, and the date` },
];

/** Web-side ambiguity problems for a CUSTOM sheet's claim + narrow questions (one problem per rule). */
export function ambiguityProblems(ts: J): string[] {
  const out: string[] = [];
  const all = segs(ts);
  for (const r of RULES) {
    for (const t of all) {
      const m = r.re.exec(t);
      if (m && !(r.unless && r.unless.test(t))) { out.push(r.text(m[0])); break; }
    }
  }
  return out;
}

export interface BuilderGate { refused: boolean; openDisabled: boolean; problems: string[]; message: string }

export function builderGate(ts: J, opts: { humanReferee?: boolean } = {}): BuilderGate {
  const r = templateId(ts);
  let problems: string[];
  if (r.id && r.id !== "custom") problems = lintAnySheet(ts);
  else if (!r.id) problems = addHints(r.problems);
  else problems = [...customOpenProblems(ts, opts), ...ambiguityProblems(ts)];
  const refused = problems.length > 0;
  return { refused, openDisabled: refused, problems, message: refused ? `Fix term sheet before opening: ${problems.join(" ")}` : "" };
}
