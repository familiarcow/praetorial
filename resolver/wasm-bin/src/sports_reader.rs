//! 17c4 (D-TPL1, D-SPORTS1): the typed `game_winner` reader. The CODE decides from the PINNED event's object only (GAP-5a):
//!   MLB/NHL: league source (MLB Stats API / NHL api-web) + ESPN must name the same final winner, else VOID.
//!   NFL/NBA: ESPN alone, keyed on template.id == game_winner && league in {NFL, NBA} (never a declared field).
//! Not final, a source down, or before scheduled start + 4h -> RETRY (the caller applies D-RESOLVE1's 7-day window, then VOID).
//! The judge is never called (17c5 adds the AI audit of this code outcome).
use super::*;
use praetorial_core::sports::{self, Decision, Src};

pub struct SportsOutcome {
    pub decision: Decision,
    pub notes: Vec<String>,
    /// 17c5: the values the code decided from, quoted for the AI audit.
    pub extracted: Value,
}

pub fn is_typed_sports(typed: &Value) -> bool {
    matches!(praetorial_core::template::template_id(typed), Ok("game_winner"))
}

fn source_url(term: &Value, id: &str) -> Option<String> {
    term["sources_allowed"].as_array()?.iter().find(|s| s["id"] == id).and_then(|s| s["url"].as_str()).map(|s| s.to_string())
}

/// Settle a typed game_winner sheet. `typed` = the raw typed sheet, `term` = its rendered form.
pub fn settle(typed: &Value, term: &Value, fetcher: &dyn HttpFetcher, now_unix: i64) -> SportsOutcome {
    let mut notes: Vec<String> = Vec::new();
    let f = |k: &str| typed["fields"][k].as_str().unwrap_or("").to_string();
    let (league, event_id) = (f("league"), f("event_id"));
    let pick = typed["fields"]["pick"]["team_id"].as_str().unwrap_or("").to_string();
    let single = praetorial_core::template::single_source_allowed(typed);

    let fetch = |sid: &str, notes: &mut Vec<String>| -> Option<Value> {
        let url = source_url(term, sid)?;
        match fetch_json(&url, fetcher) {
            Ok(v) => {
                notes.push(format!("source fetched: {}", sid));
                Some(v)
            }
            Err(e) => {
                notes.push(format!("source unavailable: {} ({})", sid, e));
                None
            }
        }
    };

    let (mut lg, mut es): (Option<Src>, Option<Src>) = (None, None);
    let mut lg_game: Option<i64> = None;
    if single {
        if let Some(body) = fetch("S_ESPN", &mut notes) {
            match sports::espn_event_by_id(&body, &event_id).map(|e| sports::parse_espn(&e)) {
                Some(Ok(s)) => es = Some(s),
                Some(Err(e)) => notes.push(format!("S_ESPN: event {} unreadable ({})", event_id, e)),
                None => notes.push(format!("S_ESPN: event {} is not on the scoreboard", event_id)),
            }
        }
    } else {
        if let Some(body) = fetch("S_LEAGUE", &mut notes) {
            let lev = sports::league_event(&league, &body, &event_id);
            lg_game = lev.as_ref().and_then(|e| sports::league_game_number(&league, e));
            match lev.map(|e| sports::parse_league(&league, &e)) {
                Some(Ok(s)) => lg = Some(s),
                Some(Err(e)) => notes.push(format!("S_LEAGUE: event {} unreadable ({})", event_id, e)),
                None => notes.push(format!("S_LEAGUE: event {} is not in the payload", event_id)),
            }
        }
        if let (Some(l), Some(body)) = (lg.as_ref(), fetch("S_ESPN", &mut notes)) {
            match sports::espn_event_for_game(l, lg_game, &body) {
                Ok(Some(e)) => match sports::parse_espn(&e) {
                    Ok(s) => es = Some(s),
                    Err(e) => notes.push(format!("S_ESPN: matched event unreadable ({})", e)),
                },
                Ok(None) => notes.push("S_ESPN: no unambiguous event for this game's two teams on the scoreboard (doubleheaders pair only by explicit game number)".to_string()),
                Err(e) => notes.push(format!("S_ESPN: {}", e)),
            }
        }
    }
    let decision = sports::decide(single, &pick, now_unix, lg.as_ref(), es.as_ref());
    notes.push(decision.why().to_string());
    // 17c5: the values the code decided from (each source's two teams with scores, the pick, the winner the code derived)
    let src_json = |s: &Option<Src>| match s {
        Some(s) => json!({"final": s.is_final, "home": {"id": s.home.id, "name": s.home.names.first(), "score": s.home.score}, "away": {"id": s.away.id, "name": s.away.names.first(), "score": s.away.score}}),
        None => Value::Null,
    };
    let base = lg.as_ref().or(es.as_ref());
    let winner_team_id = base.and_then(|b| match (b.home.score, b.away.score) {
        (Some(h), Some(a)) if h > a => Some(b.home.id.clone()),
        (Some(h), Some(a)) if a > h => Some(b.away.id.clone()),
        _ => None,
    });
    let extracted = json!({"kind": "game_winner", "league": league, "event_id": event_id, "pick_team_id": pick, "winner_team_id": winner_team_id,
        "league_source": src_json(&lg), "espn": src_json(&es)});
    SportsOutcome { decision, notes, extracted }
}
