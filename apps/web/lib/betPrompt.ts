// TPL3 (familiarcow 11-12: "have the user's own agent generate the field inputs"): ONE copy-paste prompt the user gives ChatGPT /
// Claude / their agent, the 3 worked examples, and the parser for the JSON it returns. The prompt is shown on /guide/custom-bet,
// copied by the form's "Copy prompt" button and published in docs/BET-PROMPT.md (tests/tpl3 pins the doc to this text).
// parseAiBet never part-fills: it returns a whole form or one plain error. The filled form then goes through the SAME lint as typing.
import { blankCustomForm, type CustomForm } from "./customBuilder";
import { withDeadline } from "./betDetails";

/** The fixed JSON shape, in order. */
export const AI_FIELDS = ["claim", "question", "deadline_utc", "sources", "what_counts", "can_settle_early"] as const;
const REQUIRED = ["claim", "deadline_utc", "sources"] as const;

export const BET_PROMPT = `You are helping me set up a bet on Praetorial. An AI judge will settle it by reading public web pages after the deadline, so every part must be checkable by a stranger.

My bet, in my own words:
<<< DESCRIBE YOUR BET HERE >>>

Turn it into a bet that follows these rules:
1. Claim: one sentence that will be clearly true or false, naming who or what, what must happen, and the date. No opinions ("best", "popular"), no "soon" or "next week".
2. Question: one YES or NO question the judge answers. YES means the claim happened.
3. Deadline: one exact date and time in UTC, written like 2027-12-31T23:59Z. It must be in the future.
4. Sources: at least two public web pages from different websites that will report the result. Use public sources neither of us can edit: no personal accounts, blogs or pages either bettor controls.
5. Evidence: the judge only counts what those public sources publish before the deadline (and up to 7 days after it, if they report late). Say in "what_counts" anything that should or should not count, like "a preorder does not count".
6. If the bet is about something I or the other bettor do, rewrite it as something an outside source reports, or tell me it cannot be judged.

If anything is unclear, ask me first. When it is clear, reply with only the JSON below, no other text:

{
  "claim": "one sentence, with the date",
  "question": "one YES or NO question",
  "deadline_utc": "YYYY-MM-DDTHH:MMZ",
  "sources": [
    { "name": "site name", "url": "https://..." },
    { "name": "another site", "url": "https://..." }
  ],
  "what_counts": ["optional rule, one per item"],
  "can_settle_early": true
}

"can_settle_early" is true if the bet can be settled as soon as it happens, false if only at the deadline.`;

export interface BetExample { title: string; ask: string; json: Record<string, unknown> }

export const BET_EXAMPLES: BetExample[] = [
  {
    title: "A product launch",
    ask: "I bet Apple sells a foldable iPhone before the end of 2027.",
    json: {
      claim: "Apple makes a foldable iPhone available to buy in the US by December 31, 2027.",
      question: "Did Apple make a foldable iPhone available to buy in the US by December 31, 2027?",
      deadline_utc: "2027-12-31T23:59Z",
      sources: [{ name: "Apple Newsroom", url: "https://www.apple.com/newsroom/" }, { name: "Reuters", url: "https://www.reuters.com/technology/" }],
      what_counts: ["A preorder or an announcement alone does not count; it must be on sale in the US."],
      can_settle_early: true,
    },
  },
  {
    title: "An interest-rate decision",
    ask: "My friend thinks the Fed won't cut rates in the first half of 2027. I think it will.",
    json: {
      claim: "The US Federal Reserve announces a cut to the federal funds target range between January 1, 2027 and June 30, 2027.",
      question: "Did the Federal Reserve announce a cut to the federal funds target range between January 1, 2027 and June 30, 2027?",
      deadline_utc: "2027-06-30T23:59Z",
      sources: [{ name: "Federal Reserve", url: "https://www.federalreserve.gov/newsevents/pressreleases.htm" }, { name: "Associated Press", url: "https://apnews.com/hub/federal-reserve" }],
      what_counts: ["Only a decision announced by the Federal Open Market Committee counts.", "A cut of any size counts."],
      can_settle_early: true,
    },
  },
  {
    title: "A space mission",
    ask: "Bet: NASA lands astronauts on the Moon with Artemis by the end of 2028.",
    json: {
      claim: "NASA's Artemis program lands at least one astronaut on the surface of the Moon by December 31, 2028.",
      question: "Did a NASA Artemis mission land at least one astronaut on the surface of the Moon by December 31, 2028?",
      deadline_utc: "2028-12-31T23:59Z",
      sources: [{ name: "NASA", url: "https://www.nasa.gov/humans-in-space/artemis/" }, { name: "Associated Press", url: "https://apnews.com/hub/space-exploration" }],
      what_counts: ["The landing must be crewed; an uncrewed lander does not count."],
      can_settle_early: false,
    },
  },
];

export type AiBetResult = { ok: true; form: CustomForm; ignored: string[] } | { ok: false; error: string };

const ONLY_AT_DEADLINE = "Early resolution is not allowed: the bet settles only at the deadline.";
const DEADLINE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|UTC|\+00:?00)?$/i;

const fail = (error: string): AiBetResult => ({ ok: false, error });

/** The JSON object inside an AI's answer: tolerates ```json fences and a sentence before/after. null when there is none. */
function extractObject(text: string): unknown {
  const t = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const body = fenced ? fenced[1]!.trim() : t;
  const tries = [body];
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  if (a >= 0 && b > a) tries.push(body.slice(a, b + 1));
  for (const s of tries) { try { return JSON.parse(s); } catch { /* next */ } }
  return undefined;
}

/** The pasted answer -> a whole custom form, or one plain error (the form is then left exactly as it was). */
export function parseAiBet(text: string, nowMs: number): AiBetResult {
  if (!text.trim()) return fail("Paste the answer from your AI first.");
  const j = extractObject(text);
  if (j === undefined) return fail("That isn't the bet from the prompt. Copy your AI's whole answer, from { to }, and paste it again.");
  if (!j || typeof j !== "object" || Array.isArray(j)) return fail("That isn't the bet from the prompt. It should start with { and have a claim, a deadline_utc and sources.");
  const o = j as Record<string, unknown>;

  const missing = REQUIRED.filter((k) => o[k] === undefined || o[k] === null || (typeof o[k] === "string" && !(o[k] as string).trim()));
  if (missing.length) return fail(`Your AI left out ${missing.join(", ")}. Ask it to fill ${missing.length > 1 ? "those" : "that"} in, then paste again.`);

  if (typeof o.claim !== "string") return fail("The claim should be one sentence of text.");
  if (o.question !== undefined && typeof o.question !== "string") return fail("The question should be one YES or NO question, as text.");

  const d = typeof o.deadline_utc === "string" ? DEADLINE.exec(o.deadline_utc.trim()) : null;
  if (!d) return fail("The deadline_utc should look like 2027-12-31T23:59Z.");
  if (!d[3]) return fail("The deadline must be in UTC: end it with Z, like 2027-12-31T23:59Z.");
  const deadline = `${d[1]}T${d[2]}`;
  const ms = Date.parse(`${deadline}:00Z`);
  if (Number.isNaN(ms)) return fail("The deadline_utc isn't a real date. It should look like 2027-12-31T23:59Z.");
  if (ms <= nowMs) return fail("The deadline is in the past. Pick a date and time that hasn't happened yet.");

  if (!Array.isArray(o.sources)) return fail("The sources should be a list of web pages, each with a name and a url.");
  if (o.sources.length < 2) return fail("Add at least two sources from different websites.");
  const sources: CustomForm["sources"] = [];
  for (const s of o.sources) {
    const url = s && typeof s === "object" && typeof (s as any).url === "string" ? (s as any).url.trim() : "";
    if (!/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(url)) return fail("Each source needs a web link that starts with https://.");
    const name = typeof (s as any).name === "string" ? (s as any).name.trim() : "";
    sources.push({ publisher: name, url, partyControlled: false });
  }

  if (o.what_counts !== undefined && !(Array.isArray(o.what_counts) && o.what_counts.every((x) => typeof x === "string"))) {
    return fail("The what_counts should be a list of short rules, as text.");
  }
  if (o.can_settle_early !== undefined && typeof o.can_settle_early !== "boolean") return fail("The can_settle_early should be true or false.");

  const blank = blankCustomForm();
  const question = typeof o.question === "string" ? o.question.trim() : "";
  const rules = ((o.what_counts as string[] | undefined) ?? []).map((x) => x.trim()).filter(Boolean);
  const form = withDeadline({
    ...blank,
    claim: o.claim.trim(),
    elements: [question],
    sources,
    ...(rules.length ? { leadingDefinitions: rules } : {}),
    earlyRule: o.can_settle_early === false ? ONLY_AT_DEADLINE : blank.earlyRule,
  }, deadline, nowMs);
  const known = new Set<string>(AI_FIELDS);
  return { ok: true, form, ignored: Object.keys(o).filter((k) => !known.has(k)) };
}
