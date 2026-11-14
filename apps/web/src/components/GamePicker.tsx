// TPL2 (familiarcow 11-12: "I don't know the team IDs and the Game IDs"): the "Who wins a game" form. League -> day (today + 6) -> that day's
// games as cards ("Hurricanes @ Kraken · 12:00 pm ET") -> the team you back. The pick fills event_id, scheduled_date and the pick's team
// id + name (lib/sportsGames.ts, same ids/pairing as the resolver); ids are only ever shown under Details, where they can also be typed
// by hand. Only games that haven't started can be picked: betting closes at face-off.
import React, { useEffect, useMemo, useState } from "react";
import { Button, Banner, Card, ClickCard, TextField } from "../ui";
import {
  FACE_OFF_NOTE, NEAR_TERM_NOTE, PICKER_DAYS, PICKER_LEAGUES, gameCardLabel, loadGames, searchGames, upcomingDays, formForPick, type Game, type League,
} from "../../lib/sportsGames";
import type { GuidedForm } from "../../lib/guidedFields";

const PICK_KEYS = ["event_id", "scheduled_date", "pick_team_id", "pick_name", "home_team_id", "home_team_name", "away_team_id", "away_team_name", "game_label", "game_start_utc", "pick_side"];
const MANUAL: { key: string; label: string; type: "text" | "date"; placeholder?: string }[] = [
  { key: "event_id", label: "Game id", type: "text", placeholder: "849799" },
  { key: "scheduled_date", label: "Game date", type: "date" },
  { key: "pick_team_id", label: "Team id of your pick", type: "text", placeholder: "158" },
  { key: "pick_name", label: "Team name", type: "text", placeholder: "Milwaukee Brewers" },
];
const ROW: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: "var(--spacing-2, 8px)" };
const LIST: React.CSSProperties = { display: "grid", gap: "var(--spacing-2, 8px)", maxWidth: 560, margin: "var(--spacing-2, 8px) 0" };
const QUIET: React.CSSProperties = { display: "block", color: "var(--color-text-secondary)" };

type Load = { state: "idle" } | { state: "loading" } | { state: "error"; error: string } | { state: "ok"; games: Game[] };

function GameCard({ g, onPick, showDay }: { g: Game; onPick: (g: Game) => void; showDay?: string }) {
  const label = gameCardLabel(g);
  const body = (
    <span style={{ display: "block", minWidth: 0 }}>
      {showDay && <small style={QUIET}>{showDay}</small>}
      <strong style={{ display: "block", color: g.pickable ? undefined : "var(--color-text-secondary)" }}>{label}{g.pickable ? "" : " \u00b7 closed"}</strong>
      <span style={{ display: "block", color: "var(--color-text-secondary)" }}>{g.away.name} at {g.home.name}</span>
      {!g.pickable && <small data-testid={`game-closed-${g.eventId}`} style={QUIET}>{g.reason}</small>}
    </span>
  );
  return g.pickable
    ? <ClickCard label={`${label}. ${g.away.name} at ${g.home.name}`} data-testid={`game-card-${g.eventId}`} data-pickable="true" onClick={() => onPick(g)}>{body}</ClickCard>
    : <Card data-testid={`game-card-${g.eventId}`} data-pickable="false">{body}</Card>;
}

export default function GamePicker({ guided, onChange, nowMs = Date.now() }: { guided: GuidedForm; onChange: (g: GuidedForm) => void; nowMs?: number }) {
  const league = (guided.league ?? "") as League | "";
  const days = useMemo(() => upcomingDays(nowMs, PICKER_DAYS), [Math.floor(nowMs / 3600000)]);
  const [day, setDay] = useState<string>(() => days.find((d) => d.date === guided.scheduled_date)?.date ?? days[0].date);
  const [load, setLoad] = useState<Load>({ state: "idle" });
  const [tick, setTick] = useState(0);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<Load>({ state: "idle" });
  const [chosen, setChosen] = useState<Game | null>(null);
  const picked = (guided.pick_name ?? "").trim() !== "" && (guided.event_id ?? "").trim() !== "";

  useEffect(() => {
    if (!league || picked) return;
    let live = true;
    setLoad({ state: "loading" });
    loadGames(league, day).then((r) => { if (live) setLoad("games" in r ? { state: "ok", games: r.games } : { state: "error", error: r.error }); });
    return () => { live = false; };
  }, [league, day, tick, picked]);

  useEffect(() => {
    const q = query.trim();
    if (!league || picked || !q) { setSearch({ state: "idle" }); return; }
    let live = true;
    setSearch({ state: "loading" });
    const t = setTimeout(() => {
      Promise.all(days.map((d) => loadGames(league, d.date))).then((rs) => {
        if (!live) return;
        const bad = rs.find((r) => "error" in r) as { error: string } | undefined;
        const all = rs.flatMap((r) => ("games" in r ? r.games : []));
        setSearch(bad && all.length === 0 ? { state: "error", error: bad.error } : { state: "ok", games: searchGames(all, q) });
      });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [league, query, tick, picked]);

  const clearPick = (extra: GuidedForm = {}) => {
    const g: GuidedForm = { ...guided, ...extra };
    for (const k of PICK_KEYS) delete g[k];
    onChange(g);
  };
  const setLeague = (l: string) => { setChosen(null); setQuery(""); clearPick({ league: l }); };
  const back = (side: "home" | "away") => { if (chosen) { onChange({ ...guided, ...formForPick(chosen, side) }); setChosen(null); } };
  const dayLabel = (date: string) => days.find((d) => d.date === date)?.label ?? date;

  return (
    <div data-testid="game-picker">
      <label style={{ display: "block", margin: "6px 0" }}>
        League{" "}
        <select data-testid="guided-league" value={league} onChange={(e) => setLeague(e.target.value)}>
          <option value="">choose...</option>
          {PICKER_LEAGUES.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
        </select>
      </label>

      {league && picked && (
        <Card data-testid="game-picked">
          <span style={{ display: "block" }}>
            <small style={QUIET}>You back</small>
            <strong data-testid="game-picked-team" style={{ display: "block", fontSize: "1.1em" }}>{guided.pick_name}</strong>
            {guided.game_label
              ? <span data-testid="game-picked-game" style={{ display: "block" }}>{guided.game_label} · {dayLabel(guided.scheduled_date ?? "")}</span>
              : <span data-testid="game-picked-game" style={{ display: "block" }}>{league} game on {guided.scheduled_date}</span>}
            <small style={QUIET}>{FACE_OFF_NOTE}</small>
          </span>
          <span style={{ display: "block", marginTop: "var(--spacing-2, 8px)" }}>
            <Button data-testid="game-change" onClick={() => clearPick()}>Change game</Button>
          </span>
        </Card>
      )}

      {league && !picked && chosen && (
        <div data-testid="game-team-step">
          <p style={{ margin: "8px 0 4px" }}><strong>Who do you back?</strong> <span style={QUIET}>{gameCardLabel(chosen)} · {dayLabel(chosen.scheduledDate)}</span></p>
          <div style={ROW}>
            <Button variant="primary" data-testid="game-team-away" onClick={() => back("away")}>{chosen.away.name}</Button>
            <Button variant="primary" data-testid="game-team-home" onClick={() => back("home")}>{chosen.home.name}</Button>
          </div>
          <p style={{ margin: "8px 0" }}><Button variant="ghost" data-testid="game-team-back" onClick={() => setChosen(null)}>Pick another game</Button></p>
        </div>
      )}

      {league && !picked && !chosen && (
        <div data-testid="game-browse">
          <TextField label={`Search ${league} teams, today and tomorrow`} data-testid="game-search" placeholder="Team or city, e.g. Kraken" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
          {query.trim() ? (
            <div data-testid="game-search-results" style={LIST}>
              {search.state === "loading" && <span data-testid="game-loading">Searching today and tomorrow…</span>}
              {search.state === "error" && <Banner status="error" data-testid="game-error">{search.error}</Banner>}
              {search.state === "ok" && search.games.length === 0 && <span data-testid="game-empty">No {league} games for “{query.trim()}” today or tomorrow.</span>}
              {search.state === "ok" && search.games.map((g) => <GameCard key={g.key} g={g} onPick={setChosen} showDay={dayLabel(g.scheduledDate)} />)}
            </div>
          ) : (
            <>
              <div role="group" aria-label="Game day" data-testid="game-days" style={{ ...ROW, margin: "var(--spacing-2, 8px) 0" }}>
                {days.map((d) => (
                  <Button key={d.date} size="sm" variant={d.date === day ? "primary" : "secondary"} aria-pressed={d.date === day} data-testid={`game-day-${d.date}`} onClick={() => setDay(d.date)}>{d.label}</Button>
                ))}
              </div>
              <small style={QUIET}>Times are US Eastern. {FACE_OFF_NOTE}</small>
              <small data-testid="game-near-term" style={QUIET}>{NEAR_TERM_NOTE}</small>
              <div data-testid="game-list" style={LIST}>
                {load.state === "loading" && <span data-testid="game-loading">Loading {league} games…</span>}
                {load.state === "error" && (
                  <Banner status="error" data-testid="game-error">
                    {load.error}{" "}<Button size="sm" data-testid="game-retry" onClick={() => setTick((t) => t + 1)}>Try again</Button>
                  </Banner>
                )}
                {load.state === "ok" && load.games.length === 0 && <span data-testid="game-empty">No {league} games {dayLabel(day) === "Today" || dayLabel(day) === "Tomorrow" ? dayLabel(day).toLowerCase() : `on ${dayLabel(day)}`}. Try another day.</span>}
                {load.state === "ok" && load.games.map((g) => <GameCard key={g.key} g={g} onPick={setChosen} />)}
              </div>
            </>
          )}
        </div>
      )}

      <details data-testid="game-details" style={{ margin: "var(--spacing-2, 8px) 0" }}>
        <summary>Details{picked ? "" : ": enter the game by hand"}</summary>
        <small style={QUIET}>The ids the result is checked with: {league === "NFL" || league === "NBA" ? "ESPN's" : "the league's own"} game id and team id.</small>
        {MANUAL.map((m) => (
          <label key={m.key} style={{ display: "block", margin: "6px 0" }}>
            {m.label}{" "}
            <TextField label={m.label} hideLabel data-testid={`guided-${m.key}`} type={m.type} placeholder={m.placeholder} value={guided[m.key] ?? ""}
              onChange={(e) => { const v = e.currentTarget.value; const g: GuidedForm = { ...guided, [m.key]: v }; for (const k of ["game_label", "game_start_utc", "pick_side", "home_team_id", "home_team_name", "away_team_id", "away_team_name"]) delete g[k]; onChange(g); }} />
          </label>
        ))}
      </details>
    </div>
  );
}
