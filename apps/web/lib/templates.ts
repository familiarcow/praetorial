// D-LAUNCH1 typed term-sheet templates -- a TypeScript port of
// resolver/core/src/template.rs `lint_template`. The shared fixtures
// resolver/core/tests/fixtures/template_cases.json pin that this port returns
// the same named error codes as the resolver (tests/templates.unit.test.ts).
import { sha256 } from "js-sha256";
import { lintCustom } from "./customLint";
import { addHints } from "./lintHints";

export const TEMPLATE_IDS = ["btc_close_at_t", "btc_touch", "game_winner", "nws_daily_high", "custom"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
export const LAUNCH_TEMPLATES: Exclude<TemplateId, "custom">[] = ["btc_close_at_t", "btc_touch", "game_winner", "nws_daily_high"];
export const LEAGUES = ["MLB", "NHL", "NFL", "NBA"];
// Standard-time UTC offset (hours) per curated station -- NWS climate days are local STANDARD time.
export const NWS_UTC_OFFSET: Record<string, number> = { KNYC: -5, KLAX: -8, KORD: -6, KMIA: -5, KDFW: -6, KDEN: -7, KPHX: -7, KSEA: -8, KATL: -5, KBOS: -5, KIAH: -6, KMSP: -6, KDCA: -5, KPHL: -5, KSFO: -8, KLAS: -8, KAUS: -6, KDTW: -5, KMDW: -6, KSAN: -8 };
export const NWS_STATIONS = Object.keys(NWS_UTC_OFFSET);
export const MAX_HORIZON_SECS = 1461 * 86400; // D-HORIZON1a
export const RECOVERY_SECS = 7 * 86400; // D-RESOLVE1

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Strict UTC YYYY-MM-DDTHH:MM:SSZ -> unix seconds, or null. */
export function parseIso(s: unknown): number | null {
  if (typeof s !== "string" || !ISO_RE.test(s)) return null;
  const h = +s.slice(11, 13), mi = +s.slice(14, 16), se = +s.slice(17, 19);
  if (h > 23 || mi > 59 || se > 59) return null;
  const d = parseDate(s.slice(0, 10));
  return d === null ? null : d * 86400 + h * 3600 + mi * 60 + se;
}
/** Strict YYYY-MM-DD -> days since epoch, or null for a non-calendar date. */
export function parseDate(s: unknown): number | null {
  if (typeof s !== "string" || !DATE_RE.test(s)) return null;
  const ms = Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  if (new Date(ms).toISOString().slice(0, 10) !== s) return null;
  return Math.round(ms / 86400000);
}

type J = any;
const isObj = (v: J) => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v: J) => typeof v === "number" && Number.isInteger(v);

/** Resolve the template id; a missing `template` is custom. */
export function templateId(ts: J): { id?: TemplateId; problems: string[] } {
  if (!isObj(ts) || !("template" in ts)) return { id: "custom", problems: [] };
  const t = ts.template;
  if (!isObj(t)) return { problems: ["TPL_MALFORMED: `template` must be an object {id, version}"] };
  const p: string[] = [];
  const known = TEMPLATE_IDS.find((k) => k === t.id);
  if (!known) p.push(`TPL_UNKNOWN_ID: template.id ${t.id === undefined ? "(missing)" : JSON.stringify(t.id)} is not one of ${JSON.stringify(TEMPLATE_IDS)}`);
  if (t.version !== 1) p.push(`TPL_UNKNOWN_VERSION: template.version ${t.version === undefined ? "(missing)" : JSON.stringify(t.version)} is not 1`);
  if (Object.keys(t).some((k) => k !== "id" && k !== "version")) p.push("TPL_MALFORMED: `template` carries only {id, version}");
  return p.length ? { problems: p } : { id: known, problems: [] };
}

/** Schema validation of a typed sheet (empty for custom / no template). Named errors per bad field. */
export function lintTemplate(ts: J): string[] {
  const r = templateId(ts);
  if (!r.id) return r.problems;
  if (r.id === "custom") return [];
  const id = r.id;
  const p: string[] = [];
  for (const k of Object.keys(ts)) {
    if (k !== "template" && k !== "fields" && k !== "referee") {
      p.push(`TPL_FIELD_NOT_ALLOWED: \`${k}\` is not allowed on a typed template (the resolver renders claim/rule text and builds the source URLs from the typed fields)`);
    }
  }
  if (!isObj(ts.fields)) {
    p.push("TPL_MISSING_FIELD: `fields` object is required for a typed template");
    return p;
  }
  const f = ts.fields;
  const allowed: Record<string, string[]> = {
    btc_close_at_t: ["t_utc", "op", "x_usd", "open_utc"],
    btc_touch: ["direction", "x_usd", "deadline_utc", "open_utc"],
    game_winner: ["league", "event_id", "scheduled_date", "pick"],
    nws_daily_high: ["station", "date", "op", "x_f"],
  };
  for (const k of Object.keys(f)) if (!allowed[id].includes(k)) p.push(`TPL_UNKNOWN_FIELD: \`${k}\` is not a field of ${id} v1`);
  const get = (k: string) => (f[k] === null || f[k] === undefined ? undefined : f[k]);
  const need = (k: string) => {
    if (get(k) === undefined) { p.push(`TPL_MISSING_FIELD: ${id}.${k} is required`); return false; }
    return true;
  };
  const show = (v: J) => JSON.stringify(v);
  const minute = (k: string, code: string) => {
    if (!need(k)) return;
    const t = parseIso(get(k));
    if (t === null || t % 60 !== 0) p.push(`${code}: ${id}.${k} must be an explicit UTC minute boundary YYYY-MM-DDTHH:MM:00Z, got ${show(get(k))}`);
  };
  const xUsd = () => {
    if (need("x_usd")) {
      const v = get("x_usd");
      if (!(isInt(v) && v > 0 && v < 10_000_000)) p.push(`TPL_X_USD_NOT_WHOLE: ${id}.x_usd must be a positive whole number of dollars (JSON integer), got ${show(v)}`);
    }
  };
  const open = () => {
    if (need("open_utc")) {
      const t = parseIso(get("open_utc"));
      if (t === null || t % 60 !== 0) p.push(`TPL_OPEN_UTC_FORMAT: ${id}.open_utc must be a UTC minute boundary, got ${show(get("open_utc"))}`);
    }
  };
  const op = (ops: string[]) => {
    if (need("op") && !ops.includes(get("op"))) p.push(`TPL_BAD_OP: ${id}.op must be one of ${show(ops)}, got ${show(get("op"))}`);
  };
  if (id === "btc_close_at_t") {
    minute("t_utc", "TPL_T_UTC_NOT_MINUTE"); op([">", ">=", "<", "<="]); xUsd(); open();
  } else if (id === "btc_touch") {
    if (need("direction") && !["at_or_above", "at_or_below"].includes(get("direction"))) p.push(`TPL_BAD_DIRECTION: btc_touch.direction must be at_or_above or at_or_below, got ${show(get("direction"))}`);
    xUsd();
    if (need("deadline_utc") && parseIso(get("deadline_utc")) === null) p.push(`TPL_DEADLINE_FORMAT: btc_touch.deadline_utc must be UTC YYYY-MM-DDTHH:MM:SSZ, got ${show(get("deadline_utc"))}`);
    open();
  } else if (id === "game_winner") {
    if (need("league") && !LEAGUES.includes(get("league"))) p.push(`TPL_BAD_LEAGUE: game_winner.league must be one of ${show(LEAGUES)}, got ${show(get("league"))}`);
    if (need("event_id") && !(typeof get("event_id") === "string" && /^[0-9]{5,12}$/.test(get("event_id")))) p.push(`TPL_EVENT_ID_FORMAT: game_winner.event_id must be the league source's numeric event id (5-12 digits) as a string, got ${show(get("event_id"))}`);
    if (need("scheduled_date") && parseDate(get("scheduled_date")) === null) p.push(`TPL_BAD_DATE: game_winner.scheduled_date must be a real calendar date YYYY-MM-DD, got ${show(get("scheduled_date"))}`);
    if (need("pick")) {
      const pk = get("pick");
      if (!isObj(pk)) p.push("TPL_BAD_PICK: game_winner.pick must be {team_id, name}");
      else {
        for (const k of Object.keys(pk)) if (k !== "team_id" && k !== "name") p.push(`TPL_BAD_PICK: pick.${k} is not allowed`);
        if (!(typeof pk.team_id === "string" && /^[0-9A-Za-z]{1,12}$/.test(pk.team_id))) p.push("TPL_PICK_NO_TEAM_ID: pick.team_id (the league's team id, 1-12 alphanumerics) is required; a name alone is ambiguous");
        if (typeof pk.name !== "string") p.push("TPL_PICK_NO_NAME: pick.name (display name) is required");
        else if (!(pk.name.length > 0 && [...pk.name].length <= 60 && /^[\p{L}\p{N} .'&-]+$/u.test(pk.name))) p.push("TPL_BAD_PICK: pick.name must be a plain display name (letters, digits, space . ' & -; max 60 chars)");
      }
    }
  } else {
    if (need("station") && !NWS_STATIONS.includes(get("station"))) p.push(`TPL_STATION_NOT_CURATED: nws_daily_high.station ${show(get("station"))} is not one of the ${NWS_STATIONS.length} curated stations`);
    if (need("date") && parseDate(get("date")) === null) p.push(`TPL_BAD_DATE: nws_daily_high.date must be a real calendar date YYYY-MM-DD (local standard-time climate day), got ${show(get("date"))}`);
    op([">=", "<="]);
    if (need("x_f")) {
      const v = get("x_f");
      if (!(isInt(v) && v >= -100 && v <= 150)) p.push(`TPL_X_F_NOT_WHOLE: nws_daily_high.x_f must be whole degrees F (JSON integer, -100..150), got ${show(v)}`);
    }
  }
  return p;
}

export function problemCode(p: string): string {
  const head = p.split(":")[0];
  return /^[A-Z0-9_]+$/.test(head) ? head : "legacy";
}

/** Typed sheet exactly as the resolver lints it: {template:{id,version:1}, fields}. */
export function buildTypedSheet(id: Exclude<TemplateId, "custom">, fields: Record<string, unknown>): Record<string, unknown> {
  return { template: { id, version: 1 }, fields };
}

/** A sheet the resolver rejects is refused with the same named error (the first problem leads). */
export class TemplateRefusedError extends Error {
  constructor(public problems: string[]) { super(problems[0] ?? "template refused"); this.name = "TemplateRefusedError"; }
}
export function assertTemplateOk(ts: J): void {
  const p = lintTemplate(ts);
  if (p.length) throw new TemplateRefusedError(p);
}

/** Deterministic canonical JSON (keys sorted recursively): the raw `terms` string that is hashed AND sent. */
export function canonicalTerms(ts: J): string {
  const sort = (v: J): J => Array.isArray(v) ? v.map(sort) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(ts));
}
/** sha256 hex of the raw terms string: identical to resolver `sha_hex(terms)` and services/common `sha256Hex`. */
export function termsHash(terms: string): string {
  return sha256(terms);
}

import { fundingDeadlineSecs, openWindowProblem } from "./offerExpiry";
export interface DerivedDeadlines { fundingDeadlineNs: bigint; resolveDeadlineNs: bigint }

export function eventTimes(ts: J): { closeSecs: number; endSecs: number } {
  const id = templateId(ts).id;
  const f = ts.fields ?? {};
  if (id === "btc_close_at_t") { const t = parseIso(f.t_utc)!; return { closeSecs: t, endSecs: t }; }
  if (id === "btc_touch") { const t = parseIso(f.deadline_utc)!; return { closeSecs: t, endSecs: t }; }
  if (id === "game_winner") { const d = parseDate(f.scheduled_date)! * 86400; return { closeSecs: d, endSecs: d + 86400 }; }
  if (id === "nws_daily_high") {
    const d = parseDate(f.date)! * 86400;
    const off = NWS_UTC_OFFSET[f.station] ?? -8;
    return { closeSecs: d - off * 3600, endSecs: d + 86400 - off * 3600 };
  }
  throw new Error("deriveDeadlines: a typed template is required");
}

/**
 * D-RESOLVE1 / D-HORIZON1a. btc_close_at_t: funding closes at T, resolve >= T + 7d.
 * btc_touch: funding closes at the deadline, resolve = deadline + 7d.
 * game_winner / nws_daily_high: funding closes when the game/climate day starts, resolve = day end + 7d.
 * The whole span is capped at 1,461 days after open.
 */
export const HUMAN_RESOLVE_SECS = 365 * 86400; // D-REFUI3b: a person has until event + 1 year to rule
export function deriveDeadlines(ts: J, nowSecs: number, opts: { humanReferee?: boolean; resolveSecs?: number; expirySecs?: number } = {}): DerivedDeadlines {
  const { closeSecs, endSecs } = eventTimes(ts);
  if (endSecs <= nowSecs) throw new Error("OPEN_DEADLINE_NOT_AFTER_OPEN: the event end is not after now");
  if (openWindowProblem({ endSecs, nowSecs })) throw new Error("OPEN_WINDOW_TOO_SHORT: the event ends before a taker has a window to take the offer (DR3W1)");
  const funding = fundingDeadlineSecs({ latestSecs: closeSecs, nowSecs, expirySecs: opts.expirySecs }).secs;
  const resolve = opts.humanReferee && opts.resolveSecs !== undefined ? opts.resolveSecs : endSecs + (opts.humanReferee ? HUMAN_RESOLVE_SECS : RECOVERY_SECS);
  if (resolve <= endSecs) throw new Error("OPEN_RESOLVE_NOT_AFTER_EVENT: the resolve deadline has to be after the event");
  if (resolve - nowSecs > MAX_HORIZON_SECS) {
    throw new Error("OPEN_DEADLINE_TOO_FAR: deadline plus the recovery window is more than 4 years (1,461 days) after open (D-HORIZON1a)");
  }
  return { fundingDeadlineNs: BigInt(funding) * 1_000_000_000n, resolveDeadlineNs: BigInt(resolve) * 1_000_000_000n };
}

/** WT1b (d): the full resolver `lint()` for any sheet: typed -> schema lint; custom -> the resolver-format custom lint. */
export function lintAnySheet(ts: J): string[] {
  const r = templateId(ts);
  if (!r.id) return addHints(r.problems);
  return r.id === "custom" ? lintCustom(ts) : addHints(lintTemplate(ts));
}
