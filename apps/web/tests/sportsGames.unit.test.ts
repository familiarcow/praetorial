// TPL2: the game picker's pure logic, on RECORDED schedule payloads (tests/fixtures/sports, recorded 2026-11-12; plus the resolver's
// own SP1 fixtures under resolver/core/tests/fixtures/sports for an MLB doubleheader and finished NHL games). The picker fills
// game_winner {league, event_id, scheduled_date, pick:{team_id,name}} exactly as resolver/core lints and pairs them:
//  - MLB/NHL: event_id + team ids are the LEAGUE source's (statsapi gamePk / api-web game id), paired to ESPN by the two teams
//    (abbrev or a shared name) and, for a doubleheader, ONLY by the explicit game number on both sides (sports.rs espn_event_for_game).
//  - NFL/NBA: ESPN alone (event id + team ids are ESPN's).
// The Rust side of the parity lives in tests/conformance/resolver_conformance/tests/tpl2_picker_parity.rs and reads the snapshot
// pinned by the last test here (tests/fixtures/sports/picker-parity.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  gamesFromPayloads, sheetFieldsFor, formForPick, gameCardLabel, etTimeLabel, upcomingDays, searchGames, loadGames, espnScoreboardUrl,
  leagueScheduleUrl, pickName, clearScheduleCache, FACE_OFF_NOTE, PARITY_CASES, parityCase, type Game,
  MAX_LEAD_SECS, PICKER_DAYS, NEAR_TERM_NOTE,
} from "../lib/sportsGames";
import { buildTypedSheet, lintTemplate } from "../lib/templates";
import { typedSheetFor, blankFill, fillProblems, betSentence } from "../lib/betTypePicker";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const fx = (n: string) => JSON.parse(readFileSync(join(here, "fixtures/sports", n), "utf8"));
const rfx = (n: string) => JSON.parse(readFileSync(join(root, "resolver/core/tests/fixtures/sports", n), "utf8"));
const at = (iso: string) => Date.parse(iso);
const NOW = at("2026-11-12T16:18:45Z"); // the recording time
const nhl12 = (now = NOW) => gamesFromPayloads("NHL", "2026-11-12", fx("espn_nhl_20261112.json"), fx("nhl_score_20261112.json"), now);
const byId = (gs: Game[], id: string) => gs.find((g) => g.eventId === id)!;

test("NHL 2026-11-12: every league game is listed with the NHL game id and NHL team ids, paired to its ESPN event", () => {
  const gs = nhl12();
  assert.equal(gs.length, 11);
  const g = byId(gs, "2026020309");
  assert.equal(g.league, "NHL"); assert.equal(g.scheduledDate, "2026-11-12");
  assert.equal(g.espnId, "401891808");
  assert.deepEqual([g.away.id, g.away.name, g.away.short], ["12", "Carolina Hurricanes", "Hurricanes"]);
  assert.deepEqual([g.home.id, g.home.name, g.home.short], ["55", "Seattle Kraken", "Kraken"]);
  assert.equal(g.startUtc, "2026-11-12T17:00:00Z");
  for (const x of gs) { assert.match(x.eventId, /^202602\d{4}$/); assert.ok(x.espnId, `${x.eventId} paired`); assert.equal(x.pickable, true, x.eventId); }
});

test("card label: 'Hurricanes @ Kraken · 12:00 pm ET' (away @ home, Eastern time); evening games read 7:00 pm ET", () => {
  const gs = nhl12();
  assert.equal(gameCardLabel(byId(gs, "2026020309")), "Hurricanes @ Kraken · 12:00 pm ET");
  assert.equal(gameCardLabel(byId(gs, "2026020299")), "Canadiens @ Bruins · 7:00 pm ET");
  assert.equal(etTimeLabel("2026-07-04T23:05:00Z"), "7:05 pm ET"); // summer: EDT
});

test("only games not yet started can be picked; under 30 minutes to face-off is too late for a taker; the reason is in plain words", () => {
  const soon = byId(nhl12(at("2026-11-12T16:45:00Z")), "2026020309");
  assert.equal(soon.pickable, false);
  assert.match(soon.reason!, /betting closes at face-off/i);
  const started = byId(nhl12(at("2026-11-12T17:01:00Z")), "2026020309");
  assert.equal(started.pickable, false);
  assert.match(started.reason!, /already started/i);
  assert.match(FACE_OFF_NOTE, /betting closes at face-off/i);
  // the 7 pm games are still open at 17:01Z
  assert.equal(byId(nhl12(at("2026-11-12T17:01:00Z")), "2026020299").pickable, true);
});

test("a league game ESPN shows as started (or the league shows live/final) is not pickable even if the clock says otherwise", () => {
  const espn = fx("espn_nhl_20261112.json");
  const ev = espn.events.find((e: any) => e.id === "401891808");
  ev.status.type = { ...ev.status.type, name: "STATUS_IN_PROGRESS", state: "in", completed: false }; // synthetic_in_progress
  const g = byId(gamesFromPayloads("NHL", "2026-11-12", espn, fx("nhl_score_20261112.json"), NOW), "2026020309");
  assert.equal(g.pickable, false); assert.match(g.reason!, /already started/i);
});

test("an NHL game ESPN does not list cannot be picked (the resolver needs both sources; it would never decide)", () => {
  const espn = fx("espn_nhl_20261112.json");
  espn.events = espn.events.filter((e: any) => e.id !== "401891808"); // synthetic_missing_on_espn
  const g = byId(gamesFromPayloads("NHL", "2026-11-12", espn, fx("nhl_score_20261112.json"), NOW), "2026020309");
  assert.equal(g.espnId, null); assert.equal(g.pickable, false);
  assert.match(g.reason!, /ESPN/);
});

test("finished games (resolver fixture NHL 2026-11-05) are listed but not pickable", () => {
  const gs = gamesFromPayloads("NHL", "2026-11-05", rfx("espn_nhl_scoreboard_20261105.json"), rfx("nhl_score_20261105.json"), at("2026-11-08T00:00:00Z"));
  assert.ok(gs.length > 0);
  const g = byId(gs, "2026020251");
  assert.equal(g.pickable, false); assert.match(g.reason!, /already been played/i);
});

test("MLB doubleheader (resolver fixture 2026-04-04, Brewers @ Royals): Game 1 / Game 2 labels, gamePk ids, paired by game number", () => {
  const gs = gamesFromPayloads("MLB", "2026-04-04", rfx("espn_mlb_scoreboard_20260404.json"), rfx("mlb_schedule_20260404.json"), at("2026-04-01T00:00:00Z"));
  const g1 = byId(gs, "824132"), g2 = byId(gs, "824134");
  assert.equal(g1.gameNumber, 1); assert.equal(g2.gameNumber, 2);
  assert.match(gameCardLabel(g1), /^Brewers @ Royals · .* · Game 1$/);
  assert.match(gameCardLabel(g2), /^Brewers @ Royals · .* · Game 2$/);
  assert.equal(g1.espnId, "401814804"); assert.equal(g2.espnId, "401867376");
  assert.equal(g1.home.id, "118"); assert.equal(g1.away.id, "158"); // MLB team ids (Royals 118, Brewers 158)
});

test("MLB postponed game (resolver fixture 2026-04-02, coded D) is not pickable and says postponed", () => {
  const gs = gamesFromPayloads("MLB", "2026-04-02", rfx("espn_mlb_scoreboard_20260402.json"), rfx("mlb_schedule_20260402.json"), at("2026-04-01T00:00:00Z"));
  const g = byId(gs, "824621");
  assert.equal(g.pickable, false); assert.match(g.reason!, /postponed|cancel/i);
});

test("NBA / NFL: ESPN alone -- event id and team ids are ESPN's", () => {
  const nba = gamesFromPayloads("NBA", "2026-11-12", fx("espn_nba_20261112.json"), null, NOW);
  assert.equal(nba.length, 4);
  const t = byId(nba, "401909976");
  assert.equal(t.espnId, "401909976");
  assert.equal(gameCardLabel(t), "Raptors @ 76ers · 7:00 pm ET");
  assert.match(t.home.id, /^\d+$/); assert.equal(t.pickable, true);
  const nfl = gamesFromPayloads("NFL", "2026-11-12", fx("espn_nfl_20261112.json"), null, NOW);
  assert.equal(nfl.length, 1);
  assert.equal(gameCardLabel(nfl[0]), "Commanders @ Giants · 8:15 pm ET");
});

test("no games that day (MLB off-season 2026-11-12, recorded): an empty list, not an error", () => {
  assert.deepEqual(gamesFromPayloads("MLB", "2026-11-12", fx("espn_mlb_20261112.json"), fx("mlb_schedule_20261112.json"), NOW), []);
});

test("picking a team fills exactly the four resolver fields; the sheet passes the lint; both teams kept for display only", () => {
  const g = byId(nhl12(), "2026020309");
  const fields = sheetFieldsFor(g, "home");
  assert.deepEqual(fields, { league: "NHL", event_id: "2026020309", scheduled_date: "2026-11-12", pick: { team_id: "55", name: "Seattle Kraken" } });
  assert.deepEqual(lintTemplate(buildTypedSheet("game_winner", fields)), []);
  const form = formForPick(g, "away");
  assert.equal(form.pick_team_id, "12"); assert.equal(form.pick_name, "Carolina Hurricanes");
  assert.equal(form.home_team_id, "55"); assert.equal(form.away_team_id, "12");
  const fill = { ...blankFill("game_winner"), guided: form };
  assert.deepEqual(fillProblems(fill, NOW), []);
  assert.deepEqual((typedSheetFor(fill, NOW) as any).fields, sheetFieldsFor(g, "away"));
  assert.match(betSentence(fill), /Carolina Hurricanes beat Seattle Kraken/);
});

test("every pickable game in every recorded fixture yields a lint-clean sheet for either side", () => {
  const sets = [nhl12(), gamesFromPayloads("NHL", "2026-11-13", fx("espn_nhl_20261113.json"), fx("nhl_score_20261113.json"), NOW),
    gamesFromPayloads("NHL", "2026-11-14", fx("espn_nhl_20261114.json"), fx("nhl_score_20261114.json"), NOW),
    gamesFromPayloads("NBA", "2026-11-12", fx("espn_nba_20261112.json"), null, NOW), gamesFromPayloads("NFL", "2026-11-12", fx("espn_nfl_20261112.json"), null, NOW)];
  let n = 0;
  for (const gs of sets) for (const g of gs) for (const side of ["home", "away"] as const) { assert.deepEqual(lintTemplate(buildTypedSheet("game_winner", sheetFieldsFor(g, side))), [], g.eventId); n++; }
  assert.ok(n >= 50, String(n));
});

test("pick.name is always a plain display name the lint accepts (accents kept, other symbols dropped)", () => {
  assert.equal(pickName("Montréal Canadiens"), "Montréal Canadiens");
  assert.equal(pickName("St. Louis Blues"), "St. Louis Blues");
  assert.equal(pickName("A/B (FC)"), "AB FC");
});

test("COPY1 SR-C3: until the keeper waits for game end, only games starting within 44 hours can be picked (today + tomorrow), with a one-line reason", () => {
  // keeper requests at funding close (as early as now); the resolver's pre-game RETRY is dated start + 4h and the escrow refuses a
  // RETRY more than 48h ahead (secrev1 SR-C3), so start - now must be <= 44h or the bet sits in Resolving until the deadline VOID.
  assert.equal(MAX_LEAD_SECS, 44 * 3600);
  assert.equal(PICKER_DAYS, 2);
  const g = byId(nhl12(), "2026020309"); // starts 2026-11-12T17:00Z
  const edge = Date.parse(g.startUtc!) - MAX_LEAD_SECS * 1000;
  assert.equal(byId(nhl12(edge), "2026020309").pickable, true, "exactly 44h ahead is still pickable");
  const far = byId(nhl12(edge - 60_000), "2026020309");
  assert.equal(far.pickable, false, "44h + 1 min ahead is not");
  assert.match(far.reason!, /44 hours/);
  assert.match(far.reason!, /today|tomorrow/i);
  assert.match(NEAR_TERM_NOTE, /44 hours/);
  assert.ok(!NEAR_TERM_NOTE.includes("\n") && NEAR_TERM_NOTE.length < 160, "one line");
  // the picker's days are today and tomorrow (US Eastern)
  const d = upcomingDays(at("2026-11-13T03:00:00Z"), PICKER_DAYS);
  assert.deepEqual(d.map((x) => x.label), ["Today", "Tomorrow"]);
  // a Saturday game seen on Thursday afternoon is listed as not pickable
  const sat = gamesFromPayloads("NHL", "2026-11-14", fx("espn_nhl_20261114.json"), fx("nhl_score_20261114.json"), NOW);
  for (const x of sat) if (x.status === "upcoming" && x.startUtc && Date.parse(x.startUtc) - NOW > MAX_LEAD_SECS * 1000) {
    assert.equal(x.pickable, false, x.eventId); assert.match(x.reason!, /44 hours/);
  }
});

test("days: today in US Eastern time plus the next 6 (a 10 pm ET evening is still 'today')", () => {
  const d = upcomingDays(at("2026-11-13T03:00:00Z"));
  assert.equal(d.length, 7);
  assert.equal(d[0].date, "2026-11-12"); assert.equal(d[0].label, "Today");
  assert.equal(d[1].label, "Tomorrow"); assert.equal(d[6].date, "2026-11-18");
  assert.match(d[2].label, /^Sat, Nov 14$/);
});

test("search: 'kraken' matches by nickname, city or abbreviation, case-insensitive", () => {
  const gs = [...nhl12(), ...gamesFromPayloads("NHL", "2026-11-14", fx("espn_nhl_20261114.json"), fx("nhl_score_20261114.json"), NOW)];
  const hits = searchGames(gs, "kraken");
  assert.deepEqual(hits.map((g) => g.eventId).sort(), ["2026020309", byId(gs, hits.find((h) => h.scheduledDate === "2026-11-14")!.eventId).eventId].sort());
  assert.equal(searchGames(gs, "SEATTLE").length, 2);
  assert.equal(searchGames(gs, "  ").length, 0);
});

test("URLs: ESPN direct (CORS open), MLB statsapi direct (CORS open, the resolver's own URL), NHL via the same-origin allowlisted proxy", () => {
  assert.equal(espnScoreboardUrl("NHL", "2026-11-12"), "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=20261112");
  assert.equal(espnScoreboardUrl("NFL", "2026-11-12"), "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20261112");
  assert.equal(leagueScheduleUrl("MLB", "2026-11-12"), "https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-11-12");
  assert.equal(leagueScheduleUrl("NHL", "2026-11-12"), "/_proxy/sports/nhl/v1/score/2026-11-12");
  assert.equal(leagueScheduleUrl("NBA", "2026-11-12"), null);
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
test("loadGames: fetches ESPN + the league source for that day; a failure is a plain 'try again' error, never a crash", async () => {
  clearScheduleCache();
  const calls: string[] = [];
  const ok = (async (u: any) => { const s = String(u); calls.push(s); return s.includes("espn") ? json(fx("espn_nhl_20261112.json")) : json(fx("nhl_score_20261112.json")); }) as typeof fetch;
  const r = await loadGames("NHL", "2026-11-12", ok, NOW);
  assert.ok("games" in r && r.games.length === 11);
  assert.deepEqual(calls.sort(), ["/_proxy/sports/nhl/v1/score/2026-11-12", espnScoreboardUrl("NHL", "2026-11-12")].sort());
  // cached for 5 minutes: no second fetch
  await loadGames("NHL", "2026-11-12", ok, NOW + 60_000);
  assert.equal(calls.length, 2);
  clearScheduleCache();
  const down = (async (u: any) => String(u).includes("espn") ? json({}, 503) : json(fx("nhl_score_20261112.json"))) as typeof fetch;
  const e = await loadGames("NHL", "2026-11-12", down, NOW);
  assert.ok("error" in e); assert.match(e.error, /couldn.t load the NHL schedule/i); assert.match(e.error, /try again/i);
  clearScheduleCache();
  const thrown = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
  const t = await loadGames("NBA", "2026-11-12", thrown, NOW);
  assert.ok("error" in t);
  clearScheduleCache();
  const garbage = (async () => json({ nope: true })) as typeof fetch;
  assert.ok("error" in (await loadGames("NHL", "2026-11-12", garbage, NOW)));
});

// The snapshot the Rust parity test reads. Regenerate (only after a deliberate picker change): TPL2_WRITE=1 npx tsx --test tests/sportsGames.unit.test.ts
test("parity snapshot: tests/fixtures/sports/picker-parity.json is exactly what the picker produces now", () => {
  const file = join(here, "fixtures/sports/picker-parity.json");
  const now = { cases: PARITY_CASES.map((c) => parityCase(c, (p) => JSON.parse(readFileSync(join(root, p), "utf8")))) };
  if (process.env.TPL2_WRITE) writeFileSync(file, JSON.stringify(now, null, 1) + "\n");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), now);
  assert.ok(now.cases.length >= 6);
  for (const c of now.cases) for (const s of c.sheets) assert.deepEqual(lintTemplate(s.sheet), []);
});
