// B1 (familiarcow 2026-11-11: "The sources, the prompts, etc."): rebuild the AI judge's messages for one bet from the SAME text and the
// SAME steps the resolver uses (resolver/core/src/lib.rs build_messages_at, resolver/wasm-bin/src/template_audit.rs messages), with
// the strings copied byte for byte by scripts/genJudgePrompt.ts. What the browser cannot know is marked, never invented: the page
// text the resolver fetched from each source at resolution time and that text's sha256 / published date, and the exact resolution
// time it writes into the rules.
import { sha256 } from "js-sha256";
import { AUDIT_SYSTEM, AUDIT_USER_FORMAT, CLAUSES, EXHIBIT_FORMAT, FIXED_SYSTEM, NOW_SENTENCE, RESOLUTION_TIME_FORMAT, RULES_FORMAT, USER_FORMAT } from "./judgePrompt.generated";

export { CLAUSES, FIXED_SYSTEM, AUDIT_SYSTEM };

/** Mirrors core::sanitize: CRLF/CR -> LF; drops format (Cf), control (Cc, except \n \t) and private-use characters. */
export function sanitize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/[\p{Cf}\p{Co}]|(?![\n\t])\p{Cc}/gu, "");
}
/** Mirrors core::escape. */
export const escapeText = (t: string): string => sanitize(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Mirrors core::escape_attr. */
export const escapeAttr = (t: string): string =>
  sanitize(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;").replace(/[\n\t]/g, " ");

/** Fill a Rust format string's positional `{}` in order and its named `{r}` (Rust: format!("..{}..{r}..", a, b, r = x)). */
export function fillFormat(fmt: string, positional: string[], named: Record<string, string> = {}): string {
  let i = 0;
  return fmt.replace(/\{(\w*)\}/g, (_, name: string) => (name ? named[name] ?? "" : positional[i++] ?? ""));
}

/** What a placeholder stands for, so the screen can mark it (it is not part of the real prompt). */
export const PLACEHOLDER = {
  pageText: (url: string | null) => `[page text the resolver fetched from ${url ?? "this source"} when the result was requested]`,
  published: "[publish date of that page]",
  sha: "[sha256]",
  resolutionTime: "[the time the result was requested]",
};

export interface PromptSource { id: string; publisher: string; url: string | null; /** Real page text (tests / golden parity); absent = placeholder. */ text?: string; published?: string }
export interface ElementPrompt { elementId: string; question: string; system: string; user: string }

/** The messages the judge gets for one question (element) of a custom / materialized term sheet. Mirrors build_messages_at. */
export function elementMessages(ts: any, element: { id: string; q: string }, sources: PromptSource[], asOf: "placeholder" | number | null = "placeholder"): ElementPrompt {
  const defs: string[] = [];
  for (const c of Array.isArray(ts?.clauses) ? ts.clauses : []) if (typeof c === "string" && CLAUSES[c]) defs.push(CLAUSES[c]);
  for (const c of Array.isArray(ts?.custom_definitions) ? ts.custom_definitions : []) if (typeof c === "string") defs.push(c);
  const t = ts?.time ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  let rules = fillFormat(RULES_FORMAT, [element.q ?? "", defs.join("\n- "), str(t.evidence_cutoff), str(t.window_start), str(t.window_end)]);
  if (asOf === "placeholder") rules += fillFormat(RESOLUTION_TIME_FORMAT, [PLACEHOLDER.resolutionTime, NOW_SENTENCE]);
  else if (typeof asOf === "number" && asOf >= 0) rules += fillFormat(RESOLUTION_TIME_FORMAT, [new Date(asOf * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), NOW_SENTENCE]);
  const blocks = sources.map((s) => {
    const id = escapeAttr(s.id);
    const real = typeof s.text === "string";
    return fillFormat(EXHIBIT_FORMAT, [id, id, escapeAttr(s.publisher), real ? escapeAttr(s.published ?? "") : PLACEHOLDER.published,
      real ? sha256(s.text!).slice(0, 16) : PLACEHOLDER.sha, real ? escapeText(s.text!) : PLACEHOLDER.pageText(s.url), id]);
  });
  const user = fillFormat(USER_FORMAT, [blocks.join("\n\n")], { r: escapeText(rules) });
  return { elementId: element.id, question: element.q, system: FIXED_SYSTEM, user };
}

/** The typed-template audit messages (the code decides YES/NO; the AI may only agree or flag). Mirrors template_audit::messages. */
export function auditMessages(claim: string, question: string, outcome: string | null): { system: string; user: string } {
  const rule = `${claim} ${question}`;
  const o = outcome ?? "[YES or NO, as computed by the code]";
  return { system: AUDIT_SYSTEM, user: fillFormat(AUDIT_USER_FORMAT, [rule, o, "[the values the code read from the source]", o]) };
}
