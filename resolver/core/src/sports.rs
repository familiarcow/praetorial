//! 17c4 (D-TPL1, D-SPORTS1): pure game_winner rules. The CODE decides (no judge call).
//!  - GAP-5a: the pinned event's object is pulled out of each payload first (ESPN events[] by id, NHL games[] by id, MLB
//!    dates[].games[] by gamePk); nothing else in the payload is ever read or shown.
//!  - Final only (ESPN STATUS_FINAL; NHL OFF/FINAL; MLB abstractGameState Final AND codedGameState F), else RETRY.
//!  - Winner by score (OT, SO and extra innings are already in the final score); a tie is VOID.
//!  - D-SPORTS3: a decisive single-source outcome says "single source"; ESPN pairing is by explicit doubleheader game number only.
//!  - MLB/NHL: the league source and ESPN must name the same winner, else VOID. NFL/NBA: ESPN alone (`single`).
//!  - Earliest resolve = scheduled start + 4h.
use crate::template::parse_iso;
use serde_json::Value;

pub const START_PLUS_SECS: i64 = 4 * 3600;

#[derive(Debug, Clone, PartialEq)]
pub struct Team {
    pub id: String,
    pub abbrev: String,
    pub names: Vec<String>,
    pub score: Option<i64>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct Src {
    pub is_final: bool,
    /// SP1: MLB codedGameState D (Postponed) / C (Cancelled): the game was called off on this date (abstractGameState is still "Final").
    pub called_off: bool,
    pub start: Option<i64>,
    pub home: Team,
    pub away: Team,
}
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    Yes(String),
    No(String),
    Void(String),
    /// Source unavailable / not final: the keeper retries under the D-RESOLVE1 7-day window, then VOID.
    Retry(String),
    /// Too early (before start + 4h): retry at the given unix time; this is not an unavailability.
    Wait(i64, String),
}
impl Decision {
    pub fn word(&self) -> &'static str {
        match self {
            Decision::Yes(_) => "YES",
            Decision::No(_) => "NO",
            Decision::Void(_) => "VOID",
            Decision::Retry(_) | Decision::Wait(..) => "RETRY",
        }
    }
    pub fn why(&self) -> &str {
        match self {
            Decision::Yes(w) | Decision::No(w) | Decision::Void(w) | Decision::Retry(w) | Decision::Wait(_, w) => w,
        }
    }
}

fn id_is(v: Option<&Value>, id: &str) -> bool {
    match v {
        Some(Value::String(x)) => x == id,
        Some(Value::Number(n)) => n.to_string() == id,
        _ => false,
    }
}
fn id_str(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// The league source's object for the pinned event (NHL games[] by id; MLB dates[].games[] by gamePk). NFL/NBA: None.
pub fn league_event(league: &str, body: &Value, event_id: &str) -> Option<Value> {
    match league {
        "NHL" => body.get("games")?.as_array()?.iter().find(|g| id_is(g.get("id"), event_id)).cloned(),
        "MLB" => body
            .get("dates")?
            .as_array()?
            .iter()
            .filter_map(|d| d.get("games").and_then(|g| g.as_array()))
            .flatten()
            .find(|g| id_is(g.get("gamePk"), event_id))
            .cloned(),
        _ => None,
    }
}
/// ESPN events[] by id.
pub fn espn_event_by_id(body: &Value, id: &str) -> Option<Value> {
    body.get("events")?.as_array()?.iter().find(|e| id_is(e.get("id"), id)).cloned()
}

fn norm(s: &str) -> String { s.trim().to_lowercase() }
fn same_team(a: &Team, b: &Team) -> bool {
    if !a.abbrev.is_empty() && norm(&a.abbrev) == norm(&b.abbrev) {
        return true;
    }
    a.names.iter().any(|x| !norm(x).is_empty() && b.names.iter().any(|y| norm(x) == norm(y)))
}

/// The league game's explicit doubleheader game number (MLB `gameNumber` when `doubleHeader` is Y or S). Anything else: None.
pub fn league_game_number(league: &str, ev: &Value) -> Option<i64> {
    if league != "MLB" || !matches!(ev.get("doubleHeader").and_then(|v| v.as_str()), Some("Y") | Some("S")) {
        return None;
    }
    score_of(ev.get("gameNumber")).filter(|n| *n > 0)
}
/// The ESPN event's explicit doubleheader game number: a `competitions[0].notes[].headline` containing "doubleheader" and "Game N". Else None.
pub fn espn_game_number(ev: &Value) -> Option<i64> {
    for n in ev.pointer("/competitions/0/notes")?.as_array()? {
        let h = n.get("headline").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        if !h.contains("doubleheader") {
            continue;
        }
        if let Some(i) = h.find("game ") {
            let digits: String = h[i + 5..].chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(k) = digits.parse::<i64>() {
                return Some(k);
            }
        }
    }
    None
}

/// ESPN has its own event ids, so the league game is paired to an ESPN event by its two teams (D-SPORTS3). Pairing rules:
///  - exactly one team-pair match: that event, unless both sides carry an explicit game number and they differ (then None).
///  - two or more matches (doubleheader): paired ONLY by an explicit game number on both sides (`lg_game` from `league_game_number`,
///    ESPN's from `espn_game_number`) that selects exactly one event. No usable number: `Ok(None)` = ESPN UNAVAILABLE for that game
///    (not a disagreement, not a vote), so the single-source rule applies.
///  - start times are NEVER used to choose (a league placeholder start can be far from the real one); a missing start is not "gap 0".
pub fn espn_event_for_game(lg: &Src, lg_game: Option<i64>, body: &Value) -> Result<Option<Value>, String> {
    let events = body.get("events").and_then(|v| v.as_array()).ok_or_else(|| "ESPN payload has no events[]".to_string())?;
    let mut cands: Vec<&Value> = Vec::new();
    for ev in events {
        let Ok(e) = parse_espn(ev) else { continue };
        if (same_team(&lg.home, &e.home) && same_team(&lg.away, &e.away)) || (same_team(&lg.home, &e.away) && same_team(&lg.away, &e.home)) {
            cands.push(ev);
        }
    }
    if cands.len() <= 1 {
        return Ok(match (cands.first(), lg_game) {
            (Some(ev), Some(n)) if espn_game_number(ev).map(|m| m != n).unwrap_or(false) => None,
            (Some(ev), _) => Some((*ev).clone()),
            _ => None,
        });
    }
    let Some(n) = lg_game else { return Ok(None) };
    let hits: Vec<&&Value> = cands.iter().filter(|e| espn_game_number(e) == Some(n)).collect();
    Ok(if hits.len() == 1 { Some((**hits[0]).clone()) } else { None })
}
/// `espn_event_for_game` without a league game number: a doubleheader (two matches) is therefore always unpaired (None).
pub fn espn_event_for(lg: &Src, body: &Value) -> Result<Option<Value>, String> {
    espn_event_for_game(lg, None, body)
}

fn score_of(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}
fn s_of<'a>(v: &'a Value, k: &str) -> &'a str { v.get(k).and_then(|x| x.as_str()).unwrap_or("") }

/// Parse the pinned league-source object (NHL game or MLB game).
pub fn parse_league(league: &str, ev: &Value) -> Result<Src, String> {
    match league {
        "NHL" => {
            let team = |k: &str| -> Result<Team, String> {
                let t = ev.get(k).ok_or_else(|| format!("NHL game has no {}", k))?;
                let mut names = Vec::new();
                if let Some(n) = t.pointer("/name/default").and_then(|v| v.as_str()) {
                    names.push(n.to_string());
                    if let Some(p) = t.pointer("/placeName/default").and_then(|v| v.as_str()) {
                        names.push(format!("{} {}", p, n));
                    }
                }
                Ok(Team { id: id_str(t.get("id")), abbrev: s_of(t, "abbrev").to_string(), names, score: score_of(t.get("score")) })
            };
            let st = s_of(ev, "gameState");
            Ok(Src { is_final: st == "OFF" || st == "FINAL", called_off: false, start: parse_iso(s_of(ev, "startTimeUTC")), home: team("homeTeam")?, away: team("awayTeam")? })
        }
        "MLB" => {
            let team = |k: &str| -> Result<Team, String> {
                let t = ev.pointer(&format!("/teams/{}", k)).ok_or_else(|| format!("MLB game has no teams.{}", k))?;
                let name = t.pointer("/team/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                Ok(Team { id: id_str(t.pointer("/team/id")), abbrev: String::new(), names: vec![name], score: score_of(t.get("score")) })
            };
            // SP1: MLB marks Postponed (D) / Cancelled (C) games abstractGameState "Final" with no scores, so a final needs BOTH
            // abstractGameState Final AND codedGameState F (Completed Early is F). D/C are called off, never a result.
            let abstract_final = ev.pointer("/status/abstractGameState").and_then(|v| v.as_str()) == Some("Final");
            let coded = ev.pointer("/status/codedGameState").and_then(|v| v.as_str()).unwrap_or("");
            Ok(Src { is_final: abstract_final && coded == "F", called_off: abstract_final && (coded == "D" || coded == "C"), start: parse_iso(s_of(ev, "gameDate")), home: team("home")?, away: team("away")? })
        }
        other => Err(format!("{} has no league source", other)),
    }
}

/// Parse an ESPN scoreboard event.
pub fn parse_espn(ev: &Value) -> Result<Src, String> {
    let comps = ev.pointer("/competitions/0/competitors").and_then(|v| v.as_array()).ok_or_else(|| "ESPN event has no competitors".to_string())?;
    let team = |ha: &str| -> Result<Team, String> {
        let c = comps.iter().find(|c| s_of(c, "homeAway") == ha).ok_or_else(|| format!("ESPN event has no {} competitor", ha))?;
        let t = c.get("team").ok_or_else(|| "ESPN competitor has no team".to_string())?;
        let mut names: Vec<String> = ["displayName", "shortDisplayName", "name"].iter().map(|k| s_of(t, k).to_string()).filter(|s| !s.is_empty()).collect();
        if !s_of(t, "location").is_empty() && !s_of(t, "name").is_empty() {
            names.push(format!("{} {}", s_of(t, "location"), s_of(t, "name")));
        }
        Ok(Team { id: id_str(t.get("id")), abbrev: s_of(t, "abbreviation").to_string(), names, score: score_of(c.get("score")) })
    };
    let d = s_of(ev, "date");
    let start = parse_iso(&if d.len() == 17 { format!("{}:00Z", &d[..16]) } else { d.to_string() });
    Ok(Src { is_final: ev.pointer("/status/type/name").and_then(|v| v.as_str()) == Some("STATUS_FINAL"), called_off: false, start, home: team("home")?, away: team("away")? })
}

/// Scheduled start + 4h (league start when there is one, else ESPN's).
pub fn earliest_resolve(league: Option<&Src>, espn: Option<&Src>, single: bool) -> Option<i64> {
    let start = if single { espn.and_then(|e| e.start) } else { league.and_then(|l| l.start).or_else(|| espn.and_then(|e| e.start)) };
    start.map(|s| s + START_PLUS_SECS)
}

enum Win<'a> {
    Tie,
    Team(&'a Team),
    Unscored,
}
fn winner(s: &Src) -> Win<'_> {
    match (s.home.score, s.away.score) {
        (Some(h), Some(a)) if h > a => Win::Team(&s.home),
        (Some(h), Some(a)) if a > h => Win::Team(&s.away),
        (Some(_), Some(_)) => Win::Tie,
        _ => Win::Unscored,
    }
}
impl Team {
    fn label(&self) -> String {
        if !self.abbrev.is_empty() {
            self.abbrev.clone()
        } else {
            self.names.first().cloned().unwrap_or_else(|| self.id.clone())
        }
    }
}

/// The decision. `pick` = the template's pick.team_id: ESPN's team id when `single` (NFL/NBA), else the league source's team id.
pub fn decide(single: bool, pick: &str, now: i64, league: Option<&Src>, espn: Option<&Src>) -> Decision {
    let srcs: Vec<(&str, &Src)> = if single {
        match espn {
            Some(e) => vec![("ESPN", e)],
            None => return Decision::Retry("ESPN (the only source) is unavailable".into()),
        }
    } else {
        match (league, espn) {
            (Some(l), Some(e)) => vec![("league source", l), ("ESPN", e)],
            (None, _) => return Decision::Retry("the league source is unavailable; never decided on one source".into()),
            (_, None) => return Decision::Retry("ESPN is unavailable; never decided on one source".into()),
        }
    };
    if let Some(at) = earliest_resolve(league, espn, single) {
        if now < at {
            return Decision::Wait(at, format!("too early: earliest resolve is scheduled start + 4h ({})", crate::format_ts(at)));
        }
    }
    for (name, s) in &srcs {
        if s.called_off {
            return Decision::Retry(format!("{}: MLB shows the game postponed/cancelled on the pinned date; not a result (no YES/NO/tie-VOID; D-RESOLVE1 7-day window applies)", name));
        }
    }
    for (name, s) in &srcs {
        if !s.is_final {
            return Decision::Retry(format!("{} does not show the game as final yet", name));
        }
    }
    let mut winners: Vec<&Team> = Vec::new();
    for (name, s) in &srcs {
        match winner(s) {
            Win::Tie => return Decision::Void(format!("{} shows a tie; a tie is not a win for either side", name)),
            Win::Unscored => return Decision::Retry(format!("{} shows the game final but without both scores yet", name)),
            Win::Team(t) => winners.push(t),
        }
    }
    if winners.len() == 2 && !same_team(winners[0], winners[1]) {
        return Decision::Void(format!("league source and ESPN disagree on the winner ({} vs {})", winners[0].label(), winners[1].label()));
    }
    // the pick uses the ids of the first source (league source, or ESPN when single)
    let base = srcs[0].1;
    if pick != base.home.id && pick != base.away.id {
        return Decision::Void(format!("pick team id {} is not a team in this game", pick));
    }
    let w = winners[0];
    let why = format!("final: {} {} - {} {}; winner {}", base.away.label(), base.away.score.unwrap_or(0), base.home.label(), base.home.score.unwrap_or(0), w.label());
    // D-SPORTS3: a decisive outcome from ESPN alone always says so
    let why = if single { format!("{} (single source: ESPN)", why) } else { why };
    if w.id == pick {
        Decision::Yes(why)
    } else {
        Decision::No(why)
    }
}
