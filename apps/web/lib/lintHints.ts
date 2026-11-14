// LNT1: "what to change" hint on every lint problem. Mirror of resolver/core/src/lint_hints.rs add_hint (and judge-proto/judge.py
// _hint); the strings are pinned by resolver/core/tests/fixtures/lint.json. Problems that already name the fix are left alone.
const HINT_MARK = "; to fix: ";
const STARTS: Array<[string, string]> = [
  ["models:", "remove the models field from the sheet"],
  ["missing field:", "add the missing field to the sheet"],
  ["custom definition contains an instruction", "remove the instruction and state only a definition"],
  ["unknown clause", "replace it with a known clause id"],
  ["source name", "use a short plain publisher name"],
  ["time.", "write it as a UTC timestamp, e.g. 2026-12-01T00:00:00Z"],
  ["need >= 2 independent", "add a second independent source that is not party-controlled"],
  ["rule must be", "change rule to ALL or ANY"],
  ["no fallback-source", "add a custom_definition saying which fallback source to use"],
  ["no early-settlement", "add a custom_definition saying whether YES fires early or only at the deadline"],
  ["no wick-vs-close", "add a custom_definition saying whether the HIGH (wick) or the CLOSE counts"],
  ["fork/ticker not pinned", "add a ticker_pins entry for every named source"],
  ["market_pin required", "add market_pin with condition_id and description_sha256"],
  ["repo_pin required", "add repo_pin with the numeric repo_id"],
  ["coverage rule required", "add a coverage rule custom_definition saying what proves the whole window was covered"],
  ["unresolved_at_cutoff", "change it to 'VOID' or remove it"],
  ["TPL_MALFORMED", "write template as an object {id, version}"],
  ["TPL_UNKNOWN_ID", "use one of the listed template ids"],
  ["TPL_UNKNOWN_VERSION", "use version 1"],
  ["TPL_FIELD_NOT_ALLOWED", "remove that field; the resolver builds it from the typed fields"],
  ["TPL_UNKNOWN_FIELD", "remove that field"],
  ["TPL_MISSING_FIELD", "add the missing field"],
  ["TPL_X_USD_NOT_WHOLE", "write a whole-dollar number"],
  ["TPL_X_F_NOT_WHOLE", "write whole degrees F"],
  ["TPL_OPEN_UTC_FORMAT", "write it as a UTC timestamp in the stated format"],
  ["TPL_DEADLINE_FORMAT", "write it as a UTC timestamp in the stated format"],
  ["TPL_T_UTC_NOT_MINUTE", "write it as a UTC timestamp in the stated format"],
  ["TPL_BAD_OP", "use one of the listed values"],
  ["TPL_BAD_DIRECTION", "use one of the listed values"],
  ["TPL_BAD_LEAGUE", "use one of the listed values"],
  ["TPL_EVENT_ID_FORMAT", "use the numeric event id from the league source"],
  ["TPL_BAD_DATE", "write a real calendar date YYYY-MM-DD"],
  ["TPL_BAD_PICK", "pick one of the two teams in the game"],
  ["TPL_PICK_NO_TEAM_ID", "pick one of the two teams in the game"],
  ["TPL_PICK_NO_NAME", "pick one of the two teams in the game"],
  ["TPL_STATION_NOT_CURATED", "use one of the curated station ids"],
];
export function addHint(p: string): string {
  if (p.includes(HINT_MARK) || /^(AMBIGUOUS_|CUSTOM_RELATIVE_DATE|PRICE_READING_UNDEFINED)/.test(p)) return p;
  let h: string;
  if (/^element \d+ addresses the judge/.test(p)) h = "remove the instruction and write a plain factual question";
  else if (/^element \d+ too long/.test(p)) h = "change it to a single question under 300 characters";
  else if (/^element \d+ names a vague/.test(p) || /^source .* is a vague\/undefined venue/.test(p)) h = "name a specific exchange and pair";
  else h = STARTS.find(([k]) => p.startsWith(k))?.[1] ?? "change the sheet as this message describes";
  return p + HINT_MARK + h;
}
export const addHints = (ps: string[]): string[] => ps.map(addHint);
