// FE3b Q1 (D-FE3b): display-only map from a lint/resolver problem to one plain-English sentence (UX-1..UX-20: no codes, no
// field names, no jargon, says what to change). The lints, their messages and their tests are untouched; the raw message is kept
// for a "details" toggle. An unmapped problem shows GENERIC_PLAIN. tests/plainErrors.unit.test.ts scans the lint sources for every
// code and fails if one has no mapping.
export const GENERIC_PLAIN = "Something in this bet isn't filled in the way we can check it. Please review the fields above.";

export interface PlainProblem { text: string; raw: string; mapped: boolean }

const BY_CODE: Record<string, string> = {
  TPL_MALFORMED: "This bet's setup is incomplete. Go back and pick the bet type again.",
  TPL_UNKNOWN_ID: "This bet type isn't one we support. Go back and pick one of the options.",
  TPL_UNKNOWN_VERSION: "This bet type is out of date. Go back and pick it again.",
  TPL_FIELD_NOT_ALLOWED: "Something extra was added to this bet that we can't use. Go back and pick the bet type again.",
  TPL_UNKNOWN_FIELD: "Something extra was added to this bet that we can't use. Go back and pick the bet type again.",
  TPL_MISSING_FIELD: "Fill in every box before moving on.",
  TPL_X_USD_NOT_WHOLE: "Enter the price as a whole number of dollars, like 76000.",
  TPL_X_F_NOT_WHOLE: "Enter the temperature as a whole number of degrees, like 72.",
  TPL_OPEN_UTC_FORMAT: "We couldn't read the start time. Reload the page and try again.",
  TPL_DEADLINE_FORMAT: "Pick a deadline date and time.",
  TPL_T_UTC_NOT_MINUTE: "Pick the exact minute the price is checked.",
  TPL_BAD_OP: "Choose how the price or temperature compares, like \"at or above\".",
  TPL_BAD_DIRECTION: "Choose whether the price is touched from above or from below.",
  TPL_BAD_LEAGUE: "Choose the league the game is in.",
  TPL_EVENT_ID_FORMAT: "Enter the game's number from the league's site. It is 5 to 12 digits.",
  TPL_BAD_DATE: "Pick a real date.",
  TPL_BAD_PICK: "Enter the team you're picking, using letters only.",
  TPL_PICK_NO_TEAM_ID: "Enter your team's id number from the league's site.",
  TPL_PICK_NO_NAME: "Enter the name of the team you're picking.",
  TPL_STATION_NOT_CURATED: "Choose a city from the list.",
  PRICE_LEVEL_NOT_POSITIVE: "Enter the price in US dollars, like 950 or 0.25.",
  PRICE_TOO_FEW_VENUES: "This coin is not listed on enough exchanges to check its price. Pick another coin.",
  OUTPERFORM_END_NOT_AFTER_START: "The end time must be after the start time.",
  OUTPERFORM_START_PASSED: "The start time has passed. Pick a start in the future.",
  OUTPERFORM_NEED_TWO_COINS: "Pick two coins to compare.",
  OUTPERFORM_SAME_COIN: "Pick two different coins.",
  OUTPERFORM_MARGIN: "Enter the margin in percentage points, more than 0 and at most 100, like 0.5.",
  CUSTOM_RELATIVE_DATE: "Use an exact date, like Dec 1, 2027, instead of words like \"tomorrow\" or \"next week\".",
  PRICE_READING_UNDEFINED: "Say whether a quick touch of the price counts, or only where the price ends up at the close.",
  AMBIGUOUS_AMOUNT: "Write the amount as a full number, like 100000, instead of a short form like 100k.",
  AMBIGUOUS_RELATIVE_DATE: "Use an exact date and a UTC time instead of words like \"today\" or \"later\".",
  AMBIGUOUS_MULTI_ASSET: "This mentions more than one asset. Make one bet per asset.",
  AMBIGUOUS_PERCENT_MOVE: "Use a set price and an exact time instead of a percent move.",
  AMBIGUOUS_NO_TIMEZONE: "Add the time zone to the time, like 17:00 UTC.",
  AMBIGUOUS_NO_STATION: "Name the weather station, like KNYC, and say it's the daily high.",
  AMBIGUOUS_PARTY_CONTROLLED: "Bet on something neither of you controls, that a public source reports.",
  AMBIGUOUS_SUBJECTIVE: "This is an opinion. Bet on something that can be checked, with who or what is measured and the date.",
};

// Un-coded messages (resolver lint wording), matched on the start of the message.
const BY_START: Array<[RegExp, string]> = [
  [/^models:/, "Judge settings can't be changed here. Remove them."],
  [/^missing field: claim/, "Write the bet in one sentence."],
  [/^missing field: elements/, "Add at least one yes-or-no question for the judge."],
  [/^missing field: rule/, "Choose whether all questions or any one must be YES."],
  [/^missing field: sources/, "Add at least two sources the AI can check."],
  [/^missing field: time/, "Fill in the event dates and times."],
  [/^missing field: clauses/, "Pick at least one standard rule."],
  [/^missing field:/, "Fill in every box before moving on."],
  [/^element \d+ addresses the judge/, "A question reads like an instruction to the judge. Write it as a plain yes-or-no question about what happens."],
  [/^element \d+ too long/, "A question is too long. Keep each one to a single short question."],
  [/^element \d+ names a vague/, "A question doesn't name a specific exchange and pair. Say exactly which one."],
  [/^custom definition contains an instruction/, "One of your rules reads like an instruction to the judge. State only what counts."],
  [/^unknown clause/, "One of the standard rules isn't recognised. Untick it and pick another."],
  [/^source name/, "A source name has odd characters or is too long. Use a short, plain name like Reuters."],
  [/^time\.window_start must be before/, "\"Counts from\" must be before the deadline. Set it to now or earlier."],
  [/^time\.window_start/, "Pick when the event window starts."],
  [/^time\.window_end/, "Pick when the event window ends."],
  [/^time\.evidence_cutoff/, "Pick the last time evidence is accepted."],
  [/^time\./, "Fill in the event dates and times."],
  [/^need >= 2 independent/, "Add at least two sources from different public websites that neither of you can edit."],
  [/^rule must be/, "Choose whether all questions or any one must be YES."],
  [/^source .* is a vague\/undefined venue/, "A source is too vague. Name a specific exchange and pair."],
  [/^no fallback-source/, "Say what happens if a named source is down, for example that any other source can confirm."],
  [/^no early-settlement/, "Say whether the bet can settle early or only at the deadline."],
  [/^no wick-vs-close/, "Say whether a quick touch of the price counts, or only where the price ends up at the close."],
  [/^fork\/ticker not pinned/, "Each price source needs its trading pair named. Add it to every source."],
  [/^market_pin required/, "Add the market's details for the Polymarket source."],
  [/^repo_pin required/, "Add the repository's number for the GitHub source."],
  [/^coverage rule required/, "Say how we can tell the whole time window was covered."],
  [/^unresolved_at_cutoff/, "Remove the unresolved setting; unresolved bets are refunded."],
];

export function plainProblem(raw: string): PlainProblem {
  const code = /^([A-Z][A-Z0-9_]+):/.exec(raw)?.[1];
  if (code && BY_CODE[code]) return { text: BY_CODE[code], raw, mapped: true };
  for (const [re, text] of BY_START) if (re.test(raw)) return { text, raw, mapped: true };
  return { text: GENERIC_PLAIN, raw, mapped: false };
}
