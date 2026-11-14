// TPL2: the "Who wins a game" picker. A person picks a league, a day and a game card ("Hurricanes @ Kraken · 12:00 pm ET"), then
// the team they back; this module turns the public schedules into the four game_winner fields the resolver lints, so nobody ever
// types a game id or a team id.
//
// Sources (the same URLs the resolver reads, resolver/core/src/template.rs league_event_url + the ESPN scoreboard):
//  - ESPN scoreboard (CORS open) lists every league's games.
//  - MLB: statsapi.mlb.com schedule?sportId=1&date= (CORS open). NHL: api-web.nhle.com/v1/score/<date> (no CORS) through the web
//    Worker's GET-only allowlisted /_proxy/sports/nhl route (worker/index.ts).
// Ids (resolver/core/src/sports.rs `decide`): MLB/NHL event_id + pick.team_id are the LEAGUE source's (gamePk / api-web game id and
// its team ids); NFL/NBA are ESPN's (ESPN is the only source). MLB/NHL league games are paired to ESPN by the two teams exactly like
// sports.rs `espn_event_for_game` (abbrev or a shared name; a doubleheader only by the explicit game number on both sides). A game
// the resolver could not pair would never be decided, so it is listed but cannot be picked.
// Parity: tests/sportsGames.unit.test.ts (fixtures) + tests/conformance/resolver_conformance/tests/tpl2_picker_parity.rs (resolver/core
// itself on the sheets this module generates, via tests/fixtures/sports/picker-parity.json).
import type { GuidedForm } from "./guidedFields";

export type League = "MLB" | "NHL" | "NFL" | "NBA";
export const PICKER_LEAGUES: { value: League; label: string }[] = [
  { value: "NHL", label: "NHL (hockey)" }, { value: "NBA", label: "NBA (basketball)" }, { value: "NFL", label: "NFL (football)" }, { value: "MLB", label: "MLB (baseball)" },
];
/** DR3W1: a taker needs at least 30 minutes; the offer's funding window must close before face-off. */
export const MIN_LEAD_SECS = 30 * 60;
export const FACE_OFF_NOTE = "Betting closes at face-off, so only games that haven't started can be picked.";
// COPY1 (secrev1 SR-C3): the keeper asks for a ruling at funding close, which can be right away; before the game the judge answers
// "try again at start + 4h", and the escrow refuses a retry dated more than 48h ahead, so a game more than 44h away could sit
// unruled until the refund deadline. Until the keeper waits for the game's end (a familiarcow decision), only near games can be picked.
export const MAX_LEAD_SECS = 44 * 3600;
export const PICKER_DAYS = 2;
export const NEAR_TERM_NOTE = "For now only games starting within 44 hours (today and tomorrow) can be picked, so the judge can rule on time.";
export const CACHE_MS = 5 * 60 * 1000;
const ET = "America/New_York";

export interface Team { id: string; name: string; short: string; abbrev: string }
export type GameStatus = "upcoming" | "started" | "final" | "postponed";
export interface Game {
  key: string;
  league: League;
  scheduledDate: string;
  /** The template's event_id: league id (MLB/NHL) or ESPN id (NFL/NBA). */
  eventId: string;
  /** The ESPN event the resolver pairs with (null = unpaired; MLB/NHL only). */
  espnId: string | null;
  startUtc: string | null;
  away: Team;
  home: Team;
  gameNumber: number | null;
  status: GameStatus;
  pickable: boolean;
  /** Why it cannot be picked, in plain words. */
  reason?: string;
}

// ---------------------------------------------------------------- resolver/core/src/sports.rs port (pairing + parsing)
type J = any;
interface RTeam { id: string; abbrev: string; names: string[] }
const idStr = (v: J): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const str = (v: J): string => (typeof v === "string" ? v : "");
const norm = (s: string) => s.trim().toLowerCase();
function sameTeam(a: RTeam, b: RTeam): boolean {
  if (a.abbrev && norm(a.abbrev) === norm(b.abbrev)) return true;
  return a.names.some((x) => norm(x) !== "" && b.names.some((y) => norm(x) === norm(y)));
}
function num(v: J): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\s*-?\d+\s*$/.test(v)) return parseInt(v, 10);
  return null;
}
/** sports.rs league_game_number: MLB gameNumber when doubleHeader is Y or S. */
export function leagueGameNumber(league: League, ev: J): number | null {
  if (league !== "MLB" || !["Y", "S"].includes(ev?.doubleHeader)) return null;
  const n = num(ev?.gameNumber);
  return n !== null && n > 0 ? n : null;
}
/** sports.rs espn_game_number: a competitions[0].notes[].headline with "doubleheader" and "Game N". */
export function espnGameNumber(ev: J): number | null {
  const notes = ev?.competitions?.[0]?.notes;
  if (!Array.isArray(notes)) return null;
  for (const n of notes) {
    const h = str(n?.headline).toLowerCase();
    if (!h.includes("doubleheader")) continue;
    const i = h.indexOf("game ");
    if (i >= 0) {
      const m = /^\d+/.exec(h.slice(i + 5));
      if (m) return parseInt(m[0], 10);
    }
  }
  return null;
}
function espnSide(ev: J, ha: "home" | "away"): { r: RTeam; t: J } | null {
  const comps = ev?.competitions?.[0]?.competitors;
  if (!Array.isArray(comps)) return null;
  const c = comps.find((x: J) => x?.homeAway === ha);
  const t = c?.team;
  if (!t) return null;
  const names = ["displayName", "shortDisplayName", "name"].map((k) => str(t[k])).filter((s) => s !== "");
  if (str(t.location) && str(t.name)) names.push(`${t.location} ${t.name}`);
  return { r: { id: idStr(t.id), abbrev: str(t.abbreviation), names }, t };
}
function leagueSide(league: League, ev: J, ha: "home" | "away"): RTeam | null {
  if (league === "NHL") {
    const t = ev?.[`${ha}Team`];
    if (!t) return null;
    const names: string[] = [];
    const n = str(t?.name?.default);
    if (n) { names.push(n); const p = str(t?.placeName?.default); if (p) names.push(`${p} ${n}`); }
    return { id: idStr(t.id), abbrev: str(t.abbrev), names };
  }
  const t = ev?.teams?.[ha];
  if (!t) return null;
  return { id: idStr(t?.team?.id), abbrev: "", names: [str(t?.team?.name)] };
}
/** sports.rs espn_event_for_game (D-SPORTS3). Start times are never used to choose. */
export function espnEventForGame(lg: { home: RTeam; away: RTeam }, lgGame: number | null, espnBody: J): J | null {
  const events = espnBody?.events;
  if (!Array.isArray(events)) return null;
  const cands = events.filter((ev: J) => {
    const h = espnSide(ev, "home"), a = espnSide(ev, "away");
    if (!h || !a) return false;
    return (sameTeam(lg.home, h.r) && sameTeam(lg.away, a.r)) || (sameTeam(lg.home, a.r) && sameTeam(lg.away, h.r));
  });
  if (cands.length <= 1) {
    const ev = cands[0];
    if (!ev) return null;
    const m = espnGameNumber(ev);
    return lgGame !== null && m !== null && m !== lgGame ? null : ev;
  }
  if (lgGame === null) return null;
  const hits = cands.filter((e: J) => espnGameNumber(e) === lgGame);
  return hits.length === 1 ? hits[0] : null;
}

// ---------------------------------------------------------------- listing
/** A pick.name the template lint accepts: letters/digits/space . ' & - only, max 60 chars. */
export function pickName(s: string): string {
  return [...s.replace(/[^\p{L}\p{N} .'&-]+/gu, "").replace(/\s+/g, " ").trim()].slice(0, 60).join("").trim();
}
/** ESPN "2026-11-12T17:00Z" (no seconds) and league "…:00Z" -> strict "YYYY-MM-DDTHH:MM:SSZ"; null if unreadable. */
function isoOf(v: J): string | null {
  const s = str(v);
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?(\.\d+)?Z$/.exec(s);
  return m ? `${m[1]}${m[2] ?? ":00"}Z` : null;
}
function espnStatus(ev: J): GameStatus {
  const t = ev?.status?.type ?? {};
  const name = str(t.name);
  if (/POSTPONED|CANCEL|SUSPENDED|FORFEIT/.test(name)) return "postponed";
  if (t.state === "post" || t.completed === true) return "final";
  if (t.state === "in") return "started";
  return "upcoming";
}
function leagueStatus(league: League, ev: J): GameStatus {
  if (league === "NHL") {
    const sched = str(ev?.gameScheduleState);
    if (sched === "PPD" || sched === "CNCL" || sched === "SUSP") return "postponed";
    const st = str(ev?.gameState);
    if (st === "OFF" || st === "FINAL") return "final";
    if (st === "LIVE" || st === "CRIT") return "started";
    return "upcoming";
  }
  const coded = str(ev?.status?.codedGameState);
  if (coded === "D" || coded === "C" || coded === "T" || coded === "U") return "postponed"; // postponed, cancelled, suspended
  const abs = str(ev?.status?.abstractGameState);
  if (abs === "Final") return "final";
  if (abs === "Live") return "started";
  return "upcoming";
}
const RANK: Record<GameStatus, number> = { upcoming: 0, started: 1, final: 2, postponed: 3 };
const worst = (a: GameStatus, b: GameStatus) => (RANK[a] >= RANK[b] ? a : b);

function display(r: RTeam | null, e: { r: RTeam; t: J } | null, league: League): Team {
  if (e) return { id: r ? r.id : e.r.id, name: pickName(str(e.t.displayName) || e.r.names[0] || ""), short: str(e.t.shortDisplayName) || str(e.t.name) || str(e.t.displayName), abbrev: e.r.abbrev };
  // unpaired league game: the league's own names
  const full = league === "NHL" ? (r?.names[1] ?? r?.names[0] ?? "") : (r?.names[0] ?? "");
  const short = league === "NHL" ? (r?.names[0] ?? "") : full.split(" ").slice(-1)[0];
  return { id: r?.id ?? "", name: pickName(full), short, abbrev: r?.abbrev ?? "" };
}

function finish(g: Omit<Game, "pickable" | "reason">, nowMs: number): Game {
  const start = g.startUtc ? Date.parse(g.startUtc) : NaN;
  let reason: string | undefined;
  if (g.status === "postponed") reason = "This game was postponed or cancelled.";
  else if (g.status === "final") reason = "This game has already been played.";
  else if (g.status === "started" || (Number.isFinite(start) && start <= nowMs)) reason = "This game has already started. Betting closes at face-off.";
  else if (!Number.isFinite(start)) reason = "The start time isn't set yet, so betting can't close at face-off. Check back later.";
  else if (start - nowMs < MIN_LEAD_SECS * 1000) reason = "This game starts in under 30 minutes: too late for someone to take the bet. Betting closes at face-off.";
  else if (start - nowMs > MAX_LEAD_SECS * 1000) reason = "This game starts more than 44 hours from now. For now only today's and tomorrow's games can be picked.";
  else if (!g.espnId && g.league !== "NFL" && g.league !== "NBA") reason = "ESPN doesn't list this game the same way as the league yet, so it couldn't be checked. Pick another game or try later.";
  else if (!g.home.id || !g.away.id || !/^[0-9]{5,12}$/.test(g.eventId)) reason = "This game is missing details we need. Pick another game.";
  return reason ? { ...g, pickable: false, reason } : { ...g, pickable: true };
}

/** Every game the league (MLB/NHL) or ESPN (NFL/NBA) lists for `date`, in start order. */
export function gamesFromPayloads(league: League, date: string, espnBody: J, leagueBody: J | null, nowMs: number): Game[] {
  const out: Game[] = [];
  if (league === "NFL" || league === "NBA") {
    for (const ev of Array.isArray(espnBody?.events) ? espnBody.events : []) {
      const h = espnSide(ev, "home"), a = espnSide(ev, "away");
      if (!h || !a) continue;
      const id = idStr(ev.id);
      out.push(finish({ key: `${league}:${id}`, league, scheduledDate: date, eventId: id, espnId: id, startUtc: isoOf(ev.date), home: display(null, h, league), away: display(null, a, league), gameNumber: espnGameNumber(ev), status: espnStatus(ev) }, nowMs));
    }
  } else {
    const games: J[] = league === "NHL" ? (Array.isArray(leagueBody?.games) ? leagueBody.games : [])
      : (Array.isArray(leagueBody?.dates) ? leagueBody.dates : []).flatMap((d: J) => (Array.isArray(d?.games) ? d.games : []));
    for (const ev of games) {
      const lh = leagueSide(league, ev, "home"), la = leagueSide(league, ev, "away");
      if (!lh || !la) continue;
      const gn = leagueGameNumber(league, ev);
      const e = espnEventForGame({ home: lh, away: la }, gn, espnBody);
      // the ESPN event may list the teams the other way round: match each league side to its ESPN side by team
      let eh = e ? espnSide(e, "home") : null, ea = e ? espnSide(e, "away") : null;
      if (eh && ea && !sameTeam(lh, eh.r)) [eh, ea] = [ea, eh];
      const id = idStr(league === "NHL" ? ev.id : ev.gamePk);
      const st = worst(leagueStatus(league, ev), e ? espnStatus(e) : "upcoming");
      const tbd = league === "MLB" && ev?.status?.startTimeTBD === true;
      out.push(finish({
        key: `${league}:${id}`, league, scheduledDate: date, eventId: id, espnId: e ? idStr(e.id) : null,
        startUtc: tbd ? null : isoOf(league === "NHL" ? ev.startTimeUTC : ev.gameDate),
        home: display(lh, eh, league), away: display(la, ea, league), gameNumber: gn, status: st,
      }, nowMs));
    }
  }
  return out.sort((x, y) => (x.startUtc ?? "~").localeCompare(y.startUtc ?? "~") || (x.gameNumber ?? 0) - (y.gameNumber ?? 0));
}

// ---------------------------------------------------------------- labels, days, search
export function etTimeLabel(iso: string): string {
  const t = new Intl.DateTimeFormat("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
  return `${t.replace(/\s?(AM|PM)$/i, (m) => ` ${m.trim().toLowerCase()}`)} ET`;
}
/** "Hurricanes @ Kraken · 12:00 pm ET" (+ " · Game 2" for a doubleheader). */
export function gameCardLabel(g: Game): string {
  const parts = [`${g.away.short} @ ${g.home.short}`, g.startUtc ? etTimeLabel(g.startUtc) : "time to be set"];
  if (g.gameNumber) parts.push(`Game ${g.gameNumber}`);
  return parts.join(" · ");
}
const etDate = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: ET, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
export function dayLabel(date: string, todayDate: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const diff = Math.round((d.getTime() - new Date(`${todayDate}T12:00:00Z`).getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(d);
}
/** Today in US Eastern time plus the next 6 days (league schedules use the US local game day). */
export function upcomingDays(nowMs: number, n = 7): { date: string; label: string }[] {
  const today = etDate(nowMs);
  const base = Date.parse(`${today}T12:00:00Z`);
  return Array.from({ length: n }, (_, i) => {
    const date = new Date(base + i * 86400000).toISOString().slice(0, 10);
    return { date, label: dayLabel(date, today) };
  });
}
export function searchGames(games: Game[], q: string): Game[] {
  const s = norm(q);
  if (!s) return [];
  return games.filter((g) => [g.home, g.away].some((t) => [t.name, t.short, t.abbrev].some((x) => norm(x).includes(s))));
}

// ---------------------------------------------------------------- the four template fields
export function sheetFieldsFor(g: Game, side: "home" | "away"): Record<string, unknown> {
  const t = g[side];
  return { league: g.league, event_id: g.eventId, scheduled_date: g.scheduledDate, pick: { team_id: t.id, name: t.name } };
}
/** The guided form for a pick: the template fields + both teams and the start (display only; fieldsFromForm reads just the fields). */
export function formForPick(g: Game, side: "home" | "away"): GuidedForm {
  const t = g[side];
  return {
    league: g.league, event_id: g.eventId, scheduled_date: g.scheduledDate, pick_team_id: t.id, pick_name: t.name,
    home_team_id: g.home.id, home_team_name: g.home.name, away_team_id: g.away.id, away_team_name: g.away.name,
    game_label: gameCardLabel(g), game_start_utc: g.startUtc ?? "", pick_side: side,
  };
}

// ---------------------------------------------------------------- fetching
const SPORT_PATH: Record<League, string> = { MLB: "baseball/mlb", NHL: "hockey/nhl", NFL: "football/nfl", NBA: "basketball/nba" };
export function espnScoreboardUrl(league: League, date: string): string {
  return `https://site.api.espn.com/apis/site/v2/sports/${SPORT_PATH[league]}/scoreboard?dates=${date.replace(/-/g, "")}`;
}
export function leagueScheduleUrl(league: League, date: string): string | null {
  if (league === "MLB") return `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`;
  if (league === "NHL") return `/_proxy/sports/nhl/v1/score/${date}`;
  return null;
}
const cache = new Map<string, { at: number; body: J }>();
export function clearScheduleCache(): void { cache.clear(); }
async function getJson(url: string, doFetch: typeof fetch, nowMs: number): Promise<J> {
  const hit = cache.get(url);
  if (hit && nowMs - hit.at < CACHE_MS) return hit.body;
  const r = await doFetch(url, { method: "GET" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = await r.json();
  cache.set(url, { at: nowMs, body });
  return body;
}
export type LoadResult = { games: Game[] } | { error: string };
export async function loadGames(league: League, date: string, doFetch: typeof fetch = fetch, nowMs: number = Date.now()): Promise<LoadResult> {
  const fail = { error: `We couldn't load the ${league} schedule right now. Check your connection and try again.` };
  try {
    const lu = leagueScheduleUrl(league, date);
    const [espn, lg] = await Promise.all([getJson(espnScoreboardUrl(league, date), doFetch, nowMs), lu ? getJson(lu, doFetch, nowMs) : Promise.resolve(null)]);
    const readable = Array.isArray(espn?.events) && (league === "NHL" ? Array.isArray(lg?.games) : league === "MLB" ? Array.isArray(lg?.dates) : true);
    if (!readable) { for (const u of [espnScoreboardUrl(league, date), lu]) if (u) cache.delete(u); return fail; }
    return { games: gamesFromPayloads(league, date, espn, lg, nowMs) };
  } catch {
    return fail;
  }
}

// ---------------------------------------------------------------- parity snapshot (read by the resolver/core Rust test)
export interface ParityInput { league: League; date: string; espn: string; leagueFile: string | null; now: string }
/** Repo-relative fixture paths. */
export const PARITY_CASES: ParityInput[] = [
  { league: "NHL", date: "2026-11-12", espn: "apps/web/tests/fixtures/sports/espn_nhl_20261112.json", leagueFile: "apps/web/tests/fixtures/sports/nhl_score_20261112.json", now: "2026-11-12T16:18:45Z" },
  { league: "NHL", date: "2026-11-13", espn: "apps/web/tests/fixtures/sports/espn_nhl_20261113.json", leagueFile: "apps/web/tests/fixtures/sports/nhl_score_20261113.json", now: "2026-11-12T16:18:45Z" },
  { league: "NHL", date: "2026-11-14", espn: "apps/web/tests/fixtures/sports/espn_nhl_20261114.json", leagueFile: "apps/web/tests/fixtures/sports/nhl_score_20261114.json", now: "2026-11-12T16:18:45Z" },
  { league: "NBA", date: "2026-11-12", espn: "apps/web/tests/fixtures/sports/espn_nba_20261112.json", leagueFile: null, now: "2026-11-12T16:18:45Z" },
  { league: "NFL", date: "2026-11-12", espn: "apps/web/tests/fixtures/sports/espn_nfl_20261112.json", leagueFile: null, now: "2026-11-12T16:18:45Z" },
  { league: "NHL", date: "2026-11-05", espn: "resolver/core/tests/fixtures/sports/espn_nhl_scoreboard_20261105.json", leagueFile: "resolver/core/tests/fixtures/sports/nhl_score_20261105.json", now: "2026-11-01T00:00:00Z" },
  { league: "MLB", date: "2026-04-04", espn: "resolver/core/tests/fixtures/sports/espn_mlb_scoreboard_20260404.json", leagueFile: "resolver/core/tests/fixtures/sports/mlb_schedule_20260404.json", now: "2026-04-01T00:00:00Z" },
  { league: "MLB", date: "2026-04-03", espn: "resolver/core/tests/fixtures/sports/espn_mlb_scoreboard_20260403.json", leagueFile: "resolver/core/tests/fixtures/sports/mlb_schedule_20260403.json", now: "2026-04-01T00:00:00Z" },
];
export function parityCase(c: ParityInput, read: (repoPath: string) => J) {
  const games = gamesFromPayloads(c.league, c.date, read(c.espn), c.leagueFile ? read(c.leagueFile) : null, Date.parse(c.now));
  return {
    league: c.league, date: c.date, espn_file: c.espn, league_file: c.leagueFile,
    sheets: games.filter((g) => g.home.id && g.away.id && g.status !== "postponed").flatMap((g) => (["home", "away"] as const).map((side) => ({
      side, espn_id: g.espnId, game_number: g.gameNumber, home_id: g.home.id, away_id: g.away.id,
      sheet: { template: { id: "game_winner", version: 1 }, fields: sheetFieldsFor(g, side) },
    }))),
  };
}
