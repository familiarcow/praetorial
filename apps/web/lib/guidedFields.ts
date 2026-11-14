// WT1b (e): guided per-type inputs for the 4 launch templates. Each form value is a plain string a person types or
// picks; `fieldsFromForm` emits EXACTLY the typed `fields` object the resolver lint accepts (whole-dollar integers,
// UTC minute timestamps, {team_id,name} pick). Nothing here validates: lintTemplate (resolver port) is the judge,
// so a bad entry surfaces as the resolver's named TPL_* error.
import { LEAGUES, type TemplateId } from "./templates";
import { NWS_CITIES } from "./nwsCities";

export type GuidedForm = Record<string, string>;
export type LaunchId = Exclude<TemplateId, "custom">;

export interface GuidedField {
  key: string;
  label: string;
  kind: "text" | "number" | "select" | "datetime" | "date";
  options?: { value: string; label: string }[];
  help?: string;
  placeholder?: string;
}

const OPS = [{ value: ">=", label: "is at or above" }, { value: ">", label: "is above" }, { value: "<=", label: "is at or below" }, { value: "<", label: "is below" }];

export const GUIDED_FIELDS: Record<LaunchId, GuidedField[]> = {
  btc_close_at_t: [
    { key: "t_utc", label: "Check the Bitcoin price at (UTC)", kind: "datetime", help: "Whole minute, UTC; the 1-minute candle close at this time decides." },
    { key: "op", label: "The close", kind: "select", options: OPS },
    { key: "x_usd", label: "Price level (whole US dollars)", kind: "number", placeholder: "75900" },
  ],
  btc_touch: [
    { key: "direction", label: "Bitcoin touches", kind: "select", options: [{ value: "at_or_above", label: "at or above" }, { value: "at_or_below", label: "at or below" }] },
    { key: "x_usd", label: "Price level (whole US dollars)", kind: "number", placeholder: "76000" },
    { key: "deadline_utc", label: "Deadline (UTC)", kind: "datetime" },
  ],
  game_winner: [
    { key: "league", label: "League", kind: "select", options: LEAGUES.map((l) => ({ value: l, label: l })) },
    { key: "event_id", label: "Game id (from the league's site)", kind: "text", placeholder: "849799", help: "The numeric event id, 5-12 digits." },
    { key: "scheduled_date", label: "Game date", kind: "date" },
    { key: "pick_team_id", label: "Team id of your pick", kind: "text", placeholder: "158" },
    { key: "pick_name", label: "Team name", kind: "text", placeholder: "Milwaukee Brewers" },
  ],
  nws_daily_high: [
    { key: "station", label: "City", kind: "select", options: NWS_CITIES.map((c) => ({ value: c.code, label: c.label })) }, // TPL1: value = station code, shown as the city
    { key: "date", label: "Date (local standard-time day)", kind: "date" },
    { key: "op", label: "The daily high", kind: "select", options: OPS },
    { key: "x_f", label: "Degrees Fahrenheit (whole number)", kind: "number", placeholder: "72" },
  ],
};

/** `YYYY-MM-DDTHH:MM` (what a datetime-local input yields, read as UTC) -> `YYYY-MM-DDTHH:MM:00Z`. Anything else is passed through unchanged for the lint to name. */
export function toUtcMinute(v: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? `${v}:00Z` : v;
}
export function fromUtcMinute(v: string): string {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/.test(v) ? v.slice(0, 16) : v;
}
/** Whole-number text -> JSON integer; non-whole text is kept as the raw string so the lint names it (TPL_X_*_NOT_WHOLE). */
function whole(v: string): unknown {
  const t = (v ?? "").trim();
  return /^-?\d+$/.test(t) ? Number(t) : t === "" ? undefined : Number(t) === Number(t) ? Number(t) : t;
}

export function openUtcNow(nowMs: number): string {
  return new Date(Math.floor(nowMs / 60000) * 60000).toISOString().replace(/\.\d+Z$/, "Z");
}

/** Emit the exact `fields` object for a launch type. `nowMs` stamps btc open_utc (a UTC minute boundary, D-TPL1). */
export function fieldsFromForm(id: LaunchId, f: GuidedForm, nowMs: number): Record<string, unknown> {
  const put = (o: Record<string, unknown>, k: string, v: unknown) => { if (v !== undefined && v !== "") o[k] = v; };
  const o: Record<string, unknown> = {};
  switch (id) {
    case "btc_close_at_t":
      put(o, "t_utc", toUtcMinute(f.t_utc ?? "")); put(o, "op", f.op); put(o, "x_usd", whole(f.x_usd ?? "")); o.open_utc = openUtcNow(nowMs); break;
    case "btc_touch":
      put(o, "direction", f.direction); put(o, "x_usd", whole(f.x_usd ?? ""));
      put(o, "deadline_utc", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(f.deadline_utc ?? "") ? `${f.deadline_utc}:00Z` : f.deadline_utc); o.open_utc = openUtcNow(nowMs); break;
    case "game_winner": {
      put(o, "league", f.league); put(o, "event_id", (f.event_id ?? "").trim()); put(o, "scheduled_date", f.scheduled_date);
      const pick: Record<string, string> = {};
      if ((f.pick_team_id ?? "").trim()) pick.team_id = f.pick_team_id.trim();
      if ((f.pick_name ?? "").trim()) pick.name = f.pick_name.trim();
      o.pick = pick; break;
    }
    case "nws_daily_high":
      put(o, "station", f.station); put(o, "date", f.date); put(o, "op", f.op); put(o, "x_f", whole(f.x_f ?? "")); break;
  }
  return o;
}

/** Inverse, for tests and for editing a saved sheet: fixture `fields` -> form strings. */
export function formFromFields(id: LaunchId, fields: Record<string, any>): GuidedForm {
  const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  switch (id) {
    case "btc_close_at_t": return { t_utc: fromUtcMinute(s(fields.t_utc)), op: s(fields.op), x_usd: s(fields.x_usd) };
    case "btc_touch": return { direction: s(fields.direction), x_usd: s(fields.x_usd), deadline_utc: fromUtcMinute(s(fields.deadline_utc)) };
    case "game_winner": return { league: s(fields.league), event_id: s(fields.event_id), scheduled_date: s(fields.scheduled_date), pick_team_id: s(fields.pick?.team_id), pick_name: s(fields.pick?.name) };
    case "nws_daily_high": return { station: s(fields.station), date: s(fields.date), op: s(fields.op), x_f: s(fields.x_f) };
  }
}
