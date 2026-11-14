//! Item 17c4 (D-TPL1, D-SPORTS1): typed game_winner decided by CODE from the pinned event's object (MLB, NHL: league source + ESPN
//! must agree; NFL, NBA: ESPN alone). Recorded responses (fixtures/replay17b) stand in for the network. The judge must never be called.
use super::*;
use serde_json::json;
use std::cell::RefCell;
use std::collections::BTreeMap;

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/replay17b");
const U_NHL: &str = "https://api-web.nhle.com/v1/score/2026-11-05";
const U_ESPN_NHL: &str = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=20261105";
const U_MLB: &str = "https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-10-28";
const U_ESPN_MLB: &str = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=20261028";
const U_ESPN_NFL: &str = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20261101";
const U_ESPN_NBA: &str = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261104";

pub(crate) struct Fx4 {
    map: RefCell<BTreeMap<String, (Vec<u8>, String)>>,
    fail: RefCell<Vec<String>>,
    urls: RefCell<Vec<String>>,
}
impl Fx4 {
    pub(crate) fn recorded() -> Fx4 {
        let m: Value = serde_json::from_slice(&std::fs::read(format!("{}/manifest.json", DIR)).unwrap()).unwrap();
        let mut map = BTreeMap::new();
        for e in m.as_array().unwrap() {
            let f = e["file"].as_str().unwrap();
            if f.starts_with("espn_") || f.starts_with("mlb_") || f.starts_with("nhl_") {
                map.insert(e["source_url"].as_str().unwrap().to_string(), (std::fs::read(format!("{}/{}", DIR, f)).unwrap(), e["content_type"].as_str().unwrap().to_string()));
            }
        }
        Fx4 { map: RefCell::new(map), fail: RefCell::new(vec![]), urls: RefCell::new(vec![]) }
    }
    fn put(&self, url: &str, body: Value) -> &Fx4 {
        self.map.borrow_mut().insert(url.to_string(), (body.to_string().into_bytes(), "application/json".to_string()));
        self
    }
    fn down(&self, url: &str) -> &Fx4 {
        self.fail.borrow_mut().push(url.to_string());
        self
    }
    /// Re-put the recorded body of `url` after `f` edited it.
    fn edit(&self, url: &str, f: impl FnOnce(&mut Value)) -> &Fx4 {
        let mut v: Value = serde_json::from_slice(&self.map.borrow().get(url).unwrap().0).unwrap();
        f(&mut v);
        self.put(url, v)
    }
}
impl HttpFetcher for Fx4 {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        self.urls.borrow_mut().push(url.to_string());
        if self.fail.borrow().iter().any(|u| u == url) {
            return Err(format!("{} unreachable (test)", url));
        }
        let (body, ct) = self.map.borrow().get(url).cloned().ok_or_else(|| format!("no recorded fixture for URL {}", url))?;
        Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: ct, body, status_code: 200 })
    }
}
struct NoJudge;
impl ModelCaller for NoJudge {
    fn call(&self, _m: &str, _msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        (r#"{"audit":"agree"}"#.to_string(), None, None) /* 17c5: the judge only AUDITS the code outcome (agree); the code still decides, see item17c5_tests */
    }
}

pub(crate) fn t(iso: &str) -> i64 { praetorial_core::template::parse_iso(iso).unwrap() }
/// 2026-11-07T04:00Z: after every recorded game ended.
pub(crate) fn now() -> i64 { t("2026-11-07T04:00:00Z") }
fn sheet(league: &str, event_id: &str, date: &str, team_id: &str, name: &str) -> Value {
    json!({"template": {"id": "game_winner", "version": 1}, "fields": {"league": league, "event_id": event_id, "scheduled_date": date, "pick": {"team_id": team_id, "name": name}}})
}
fn nhl(team_id: &str, name: &str) -> Value { sheet("NHL", "2026020261", "2026-11-05", team_id, name) }
pub(crate) fn nsh() -> Value { nhl("18", "Nashville Predators") }
pub(crate) fn col() -> Value { nhl("21", "Colorado Avalanche") }
fn mlb(team_id: &str, name: &str) -> Value { sheet("MLB", "849799", "2026-10-28", team_id, name) }
pub(crate) fn mil() -> Value { mlb("158", "Milwaukee Brewers") }
fn tb() -> Value { mlb("139", "Tampa Bay Rays") }
pub(crate) fn buf() -> Value { sheet("NFL", "401873026", "2026-11-01", "2", "Buffalo Bills") }
fn bal() -> Value { sheet("NFL", "401873026", "2026-11-01", "33", "Baltimore Ravens") }

fn settle_job(sh: Value, fx: &Fx4, at: i64, extra: Value) -> (SubmittedResult, Vec<String>) {
    let raw = sh.to_string();
    let mut job = json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 1, "checked_until": 0, "round": 0, "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw});
    for (k, v) in extra.as_object().cloned().unwrap_or_default() {
        job[k] = v;
    }
    let (r, n, _j) = build_submission_judged_at(&job, &NoJudge, fx, false, at);
    (r, n)
}
fn settle(sh: Value, fx: &Fx4) -> (String, Vec<String>) {
    let (r, n) = settle_job(sh, fx, now(), json!({}));
    (r.outcome, n)
}
fn has(n: &[String], s: &str) -> bool { n.iter().any(|x| x.contains(s)) }

// pinned-event editors on the recorded payloads
fn nhl_game(v: &mut Value) -> &mut Value { v["games"].as_array_mut().unwrap().iter_mut().find(|g| g["id"] == 2026020261).unwrap() }
fn espn_ev<'a>(v: &'a mut Value, id: &str) -> &'a mut Value { v["events"].as_array_mut().unwrap().iter_mut().find(|e| e["id"] == id).unwrap() }
fn espn_score(ev: &mut Value, abbrev: &str, score: &str, winner: bool) {
    for c in ev["competitions"][0]["competitors"].as_array_mut().unwrap() {
        if c["team"]["abbreviation"] == abbrev {
            c["score"] = json!(score);
            c["winner"] = json!(winner);
        }
    }
}
fn mlb_game(v: &mut Value) -> &mut Value { &mut v["dates"][0]["games"][0] }

// ------------------------------------------------------------------ GAP-5a: NHL 2026020261, NSH 3 COL 2 OT, OFF
#[test]
fn nhl_2026020261_overtime_winner_nsh_is_yes() {
    let fx = Fx4::recorded();
    let (o, n) = settle(nsh(), &fx);
    assert_eq!(o, "YES", "{:?}", n);
    assert!(has(&n, "source fetched: S_LEAGUE") && has(&n, "source fetched: S_ESPN"), "{:?}", n);
}
#[test]
fn nhl_2026020261_colorado_pick_is_no() {
    let (o, n) = settle(col(), &Fx4::recorded());
    assert_eq!(o, "NO", "{:?}", n);
}
#[test]
fn mlb_849799_brewers_yes_rays_no() {
    assert_eq!(settle(mil(), &Fx4::recorded()).0, "YES");
    assert_eq!(settle(tb(), &Fx4::recorded()).0, "NO");
}
#[test]
fn nfl_401873026_buf_36_10_bal_single_source() {
    let fx = Fx4::recorded();
    let (o, n) = settle(buf(), &fx);
    assert_eq!(o, "YES", "{:?}", n);
    assert_eq!(settle(bal(), &fx).0, "NO");
    // ESPN is the only URL asked for
    let urls = fx.urls.borrow().clone();
    assert!(urls.iter().all(|u| u == U_ESPN_NFL), "{:?}", urls);
}
#[test]
fn judge_is_never_called_and_element_result_is_signed_by_code() {
    // 17c5: NoJudge now only answers the audit with agree; the outcome is still the code outcome
    let (r, _n) = settle_job(nsh(), &Fx4::recorded(), now(), json!({}));
    assert_eq!(r.outcome, "YES");
    assert!(r.next_check_ns.is_none());
}

// ------------------------------------------------------------------ final only
#[test]
fn nhl_not_final_is_retry_for_every_non_final_state() {
    for st in ["FUT", "PRE", "LIVE", "CRIT", "PPD"] {
        let fx = Fx4::recorded();
        fx.edit(U_NHL, |v| nhl_game(v)["gameState"] = json!(st));
        let (r, n) = settle_job(nsh(), &fx, now(), json!({}));
        assert_eq!(r.outcome, "RETRY", "{}: {:?}", st, n);
        assert!(r.next_check_ns.unwrap() > now() as u64 * 1_000_000_000);
    }
}
#[test]
fn nhl_final_state_also_counts() {
    let fx = Fx4::recorded();
    fx.edit(U_NHL, |v| nhl_game(v)["gameState"] = json!("FINAL"));
    assert_eq!(settle(nsh(), &fx).0, "YES");
}
#[test]
fn mlb_not_final_is_retry() {
    for st in ["Live", "Preview"] {
        let fx = Fx4::recorded();
        fx.edit(U_MLB, |v| mlb_game(v)["status"]["abstractGameState"] = json!(st));
        let (r, n) = settle_job(mil(), &fx, now(), json!({}));
        assert_eq!(r.outcome, "RETRY", "{}: {:?}", st, n);
    }
}
#[test]
fn nfl_not_final_is_retry() {
    for st in ["STATUS_IN_PROGRESS", "STATUS_SCHEDULED", "STATUS_POSTPONED"] {
        let fx = Fx4::recorded();
        fx.edit(U_ESPN_NFL, |v| espn_ev(v, "401873026")["status"]["type"]["name"] = json!(st));
        let (r, n) = settle_job(buf(), &fx, now(), json!({}));
        assert_eq!(r.outcome, "RETRY", "{}: {:?}", st, n);
    }
}
#[test]
fn league_final_but_espn_not_final_is_retry_not_a_decision() {
    let fx = Fx4::recorded();
    fx.edit(U_ESPN_NHL, |v| espn_ev(v, "401892658")["status"]["type"]["name"] = json!("STATUS_IN_PROGRESS"));
    let (r, n) = settle_job(nsh(), &fx, now(), json!({}));
    assert_eq!(r.outcome, "RETRY", "{:?}", n);
}
#[test]
fn not_final_retries_inside_7_days_then_voids() {
    let day = 86_400i64;
    let first = (now() as u64) * 1_000_000_000;
    let fx = Fx4::recorded();
    fx.edit(U_NHL, |v| nhl_game(v)["gameState"] = json!("LIVE"));
    let (r0, n0) = settle_job(nsh(), &fx, now(), json!({"first_unavailable_ns": first}));
    assert_eq!(r0.outcome, "RETRY", "{:?}", n0);
    let (r6, n6) = settle_job(nsh(), &fx, now() + 6 * day, json!({"first_unavailable_ns": first}));
    assert_eq!(r6.outcome, "RETRY", "{:?}", n6);
    assert!(r6.next_check_ns.unwrap() > (now() + 6 * day) as u64 * 1_000_000_000);
    let (r8, n8) = settle_job(nsh(), &fx, now() + 7 * day + 60, json!({"first_unavailable_ns": first}));
    assert_eq!(r8.outcome, "VOID", "{:?}", n8);
    assert!(r8.next_check_ns.is_none());
    let (rc, nc) = settle_job(nsh(), &fx, now(), json!({"first_unavailable_ns": first, "retry_count": 7}));
    assert_eq!(rc.outcome, "VOID", "{:?}", nc);
}
#[test]
fn recovered_final_after_retries_decides() {
    let first = (now() as u64 - 3 * 86_400) * 1_000_000_000;
    let (r, n) = settle_job(nsh(), &Fx4::recorded(), now(), json!({"first_unavailable_ns": first, "retry_count": 3}));
    assert_eq!(r.outcome, "YES", "{:?}", n);
}

// ------------------------------------------------------------------ tie -> VOID
#[test]
fn tie_is_void_not_a_win_for_either_side() {
    // NFL tie 20-20
    let fx = Fx4::recorded();
    fx.edit(U_ESPN_NFL, |v| {
        let ev = espn_ev(v, "401873026");
        espn_score(ev, "BUF", "20", false);
        espn_score(ev, "BAL", "20", false);
    });
    for sh in [buf(), bal()] {
        let (o, n) = settle(sh, &fx);
        assert_eq!(o, "VOID", "{:?}", n);
        assert!(has(&n, "tie"), "{:?}", n);
    }
    // MLB tie in both sources
    let fx = Fx4::recorded();
    fx.edit(U_MLB, |v| mlb_game(v)["teams"]["home"]["score"] = json!(4));
    fx.edit(U_ESPN_MLB, |v| espn_score(espn_ev(v, "401908046"), "TB", "4", false));
    let (o, n) = settle(mil(), &fx);
    assert_eq!(o, "VOID", "{:?}", n);
    assert!(has(&n, "tie"), "{:?}", n);
}

// ------------------------------------------------------------------ MLB/NHL: league + ESPN must agree
#[test]
fn nhl_league_and_espn_disagree_is_void() {
    let fx = Fx4::recorded();
    fx.edit(U_ESPN_NHL, |v| {
        let ev = espn_ev(v, "401892658");
        espn_score(ev, "NSH", "1", false);
        espn_score(ev, "COL", "2", true);
    });
    for sh in [nsh(), col()] {
        let (o, n) = settle(sh, &fx);
        assert_eq!(o, "VOID", "{:?}", n);
        assert!(has(&n, "disagree"), "{:?}", n);
    }
}
#[test]
fn mlb_league_and_espn_disagree_is_void() {
    let fx = Fx4::recorded();
    fx.edit(U_ESPN_MLB, |v| {
        let ev = espn_ev(v, "401908046");
        espn_score(ev, "TB", "6", true);
        espn_score(ev, "MIL", "4", false);
    });
    let (o, n) = settle(mil(), &fx);
    assert_eq!(o, "VOID", "{:?}", n);
    assert!(has(&n, "disagree"), "{:?}", n);
}
#[test]
fn mlb_nhl_one_source_unreachable_is_retry_never_a_one_source_decision() {
    for (sh, down) in [(nsh(), U_ESPN_NHL), (nsh(), U_NHL), (mil(), U_ESPN_MLB), (mil(), U_MLB)] {
        let fx = Fx4::recorded();
        fx.down(down);
        let (r, n) = settle_job(sh, &fx, now(), json!({}));
        assert_eq!(r.outcome, "RETRY", "{}: {:?}", down, n);
    }
    // ...and then VOID after the 7-day window
    let fx = Fx4::recorded();
    fx.down(U_ESPN_NHL);
    let first = (now() as u64) * 1_000_000_000;
    let (r, _n) = settle_job(nsh(), &fx, now() + 7 * 86_400 + 60, json!({"first_unavailable_ns": first}));
    assert_eq!(r.outcome, "VOID");
}
#[test]
fn espn_event_not_on_the_scoreboard_is_retry_for_mlb_nhl() {
    let fx = Fx4::recorded();
    fx.edit(U_ESPN_NHL, |v| v["events"] = json!([]));
    let (r, n) = settle_job(nsh(), &fx, now(), json!({}));
    assert_eq!(r.outcome, "RETRY", "{:?}", n);
}

// ------------------------------------------------------------------ OT / SO / extra innings: winner by score
#[test]
fn nhl_shootout_winner_is_decided_by_the_final_score() {
    // COL (home) wins 3-2 in a shootout
    let fx = Fx4::recorded();
    fx.edit(U_NHL, |v| {
        let g = nhl_game(v);
        g["awayTeam"]["score"] = json!(2);
        g["homeTeam"]["score"] = json!(3);
        g["periodDescriptor"]["periodType"] = json!("SO");
        g["gameOutcome"] = json!({"lastPeriodType": "SO"});
    });
    fx.edit(U_ESPN_NHL, |v| {
        let ev = espn_ev(v, "401892658");
        espn_score(ev, "NSH", "2", false);
        espn_score(ev, "COL", "3", true);
        ev["status"]["type"]["detail"] = json!("Final/SO");
    });
    assert_eq!(settle(col(), &fx).0, "YES");
    assert_eq!(settle(nsh(), &fx).0, "NO");
}
#[test]
fn mlb_extra_innings_winner_is_decided_by_the_final_score() {
    // 11 innings, Tampa Bay (home) walks it off 5-4
    let fx = Fx4::recorded();
    fx.edit(U_MLB, |v| {
        let g = mlb_game(v);
        g["teams"]["away"]["score"] = json!(4);
        g["teams"]["away"]["isWinner"] = json!(false);
        g["teams"]["home"]["score"] = json!(5);
        g["teams"]["home"]["isWinner"] = json!(true);
        g["scheduledInnings"] = json!(9);
        g["linescore"] = json!({"currentInning": 11});
    });
    fx.edit(U_ESPN_MLB, |v| {
        let ev = espn_ev(v, "401908046");
        espn_score(ev, "MIL", "4", false);
        espn_score(ev, "TB", "5", true);
        ev["status"]["type"]["detail"] = json!("Final/11");
    });
    assert_eq!(settle(tb(), &fx).0, "YES");
    assert_eq!(settle(mil(), &fx).0, "NO");
}

// ------------------------------------------------------------------ the pick must be a team in the game
#[test]
fn pick_team_not_in_the_game_is_void() {
    let (o, n) = settle(nhl("99", "Nowhere Nobodies"), &Fx4::recorded());
    assert_eq!(o, "VOID", "{:?}", n);
    let (o, n) = settle(sheet("NFL", "401873026", "2026-11-01", "77", "Nobody"), &Fx4::recorded());
    assert_eq!(o, "VOID", "{:?}", n);
}

// ------------------------------------------------------------------ NFL / NBA single source via template id only
fn nba_payload(status: &str, home_score: &str, away_score: &str) -> Value {
    let comp = |ha: &str, id: &str, ab: &str, sc: &str, w: bool| json!({"homeAway": ha, "winner": w, "score": sc, "team": {"id": id, "abbreviation": ab, "displayName": format!("Team {}", ab)}});
    let (hs, as_) = (home_score.parse::<i64>().unwrap(), away_score.parse::<i64>().unwrap());
    json!({"events": [
        {"id": "401900001", "date": "2026-11-04T00:00Z", "status": {"type": {"name": status}},
         "competitions": [{"competitors": [comp("home", "13", "LAL", home_score, hs > as_), comp("away", "9", "GS", away_score, as_ > hs)]}]},
        {"id": "401900002", "date": "2026-11-04T02:00Z", "status": {"type": {"name": "STATUS_FINAL"}},
         "competitions": [{"competitors": [comp("home", "1", "ATL", "100", true), comp("away", "2", "BOS", "90", false)]}]}
    ]})
}
fn nba(team: &str) -> Value { sheet("NBA", "401900001", "2026-11-04", team, "pick") }
#[test]
fn nba_single_source_espn_decides_by_score() {
    let fx = Fx4::recorded();
    fx.put(U_ESPN_NBA, nba_payload("STATUS_FINAL", "110", "104"));
    let (o, n) = settle(nba("13"), &fx);
    assert_eq!(o, "YES", "{:?}", n);
    assert_eq!(settle(nba("9"), &fx).0, "NO");
    let urls = fx.urls.borrow().clone();
    assert!(urls.iter().all(|u| u == U_ESPN_NBA), "{:?}", urls);
    // not final -> RETRY; ESPN down -> RETRY
    fx.put(U_ESPN_NBA, nba_payload("STATUS_IN_PROGRESS", "50", "40"));
    assert_eq!(settle_job(nba("13"), &fx, now(), json!({})).0.outcome, "RETRY");
    let fx = Fx4::recorded();
    fx.down(U_ESPN_NBA);
    assert_eq!(settle_job(nba("13"), &fx, now(), json!({})).0.outcome, "RETRY");
}
#[test]
fn rendered_rule_says_single_source_for_nfl_nba_only() {
    for sh in [buf(), nba("13")] {
        let m = praetorial_core::template::materialize(&sh).unwrap().to_string();
        assert!(m.contains("single source"), "{}", m);
    }
    for sh in [nsh(), mil()] {
        let m = praetorial_core::template::materialize(&sh).unwrap().to_string();
        assert!(!m.contains("single source"), "{}", m);
    }
}
#[test]
fn a_declared_single_source_field_does_not_enable_single_source_on_mlb_nhl() {
    // game_winner MLB with a declared extra field is refused by the schema gate; the league source is still required
    for extra in ["single_source", "single_source_ok"] {
        let mut sh = mil();
        sh["fields"][extra] = json!(true);
        let (r, n) = settle_job(sh, &Fx4::recorded(), now(), json!({}));
        assert_eq!(r.outcome, "VOID", "{:?}", n);
        assert!(has(&n, "compiler gate") || has(&n, "TPL_"), "{:?}", n);
    }
    // and an MLB sheet with its league source down never falls back to ESPN alone
    let fx = Fx4::recorded();
    fx.down(U_MLB);
    assert_eq!(settle_job(mil(), &fx, now(), json!({})).0.outcome, "RETRY");
}
#[test]
fn single_source_keys_on_template_id_not_on_other_templates_fields() {
    // a different typed template (btc_touch) carrying a declared single-source marker does not pass the gate
    let sh = json!({"template": {"id": "btc_touch", "version": 1}, "fields": {"direction": "at_or_above", "x_usd": 76000, "deadline_utc": "2026-11-09T00:00:00Z", "open_utc": "2026-11-07T00:00:00Z", "single_source": true}});
    let (r, n) = settle_job(sh, &Fx4::recorded(), now(), json!({}));
    assert_eq!(r.outcome, "VOID", "{:?}", n);
    assert!(!praetorial_core::template::single_source_allowed(&json!({"template": {"id": "custom", "version": 1}, "single_source": true, "fields": {"league": "NFL"}})));
}

// ------------------------------------------------------------------ earliest resolve = scheduled start + 4h
#[test]
fn before_start_plus_4h_is_retry_even_if_the_source_already_says_final() {
    // NHL start 2026-11-06T02:30Z -> earliest 06:30Z
    let start = t("2026-11-06T02:30:00Z");
    let (r, n) = settle_job(nsh(), &Fx4::recorded(), start + 4 * 3600 - 60, json!({}));
    assert_eq!(r.outcome, "RETRY", "{:?}", n);
    assert_eq!(r.next_check_ns, Some((start + 4 * 3600) as u64 * 1_000_000_000), "next check = start + 4h");
    assert!(has(&n, "start + 4h"), "{:?}", n);
    let (r, n) = settle_job(nsh(), &Fx4::recorded(), start + 4 * 3600, json!({}));
    assert_eq!(r.outcome, "YES", "{:?}", n);
    // NFL: ESPN start 2026-11-01T18:00Z -> earliest 22:00Z
    let s = t("2026-11-01T18:00:00Z");
    assert_eq!(settle_job(buf(), &Fx4::recorded(), s + 4 * 3600 - 1, json!({})).0.outcome, "RETRY");
    assert_eq!(settle_job(buf(), &Fx4::recorded(), s + 4 * 3600, json!({})).0.outcome, "YES");
    // MLB: gameDate 2026-10-29T00:00Z -> earliest 04:00Z
    let s = t("2026-10-29T00:00:00Z");
    assert_eq!(settle_job(mil(), &Fx4::recorded(), s + 4 * 3600 - 1, json!({})).0.outcome, "RETRY");
    assert_eq!(settle_job(mil(), &Fx4::recorded(), s + 4 * 3600, json!({})).0.outcome, "YES");
}
#[test]
fn the_early_wait_does_not_burn_the_7_day_window() {
    // retry_count at the max would VOID a not-final retry; an early (pre start+4h) wait is not an unavailability
    let start = t("2026-11-06T02:30:00Z");
    let (r, n) = settle_job(nsh(), &Fx4::recorded(), start + 3600, json!({"retry_count": 7}));
    assert_eq!(r.outcome, "RETRY", "{:?}", n);
}

// ------------------------------------------------------------------ GAP-5a: only the pinned event is looked at
#[test]
fn other_games_on_the_payload_do_not_matter() {
    // corrupt every OTHER NHL game on both payloads; the pinned game still resolves
    let fx = Fx4::recorded();
    fx.edit(U_NHL, |v| {
        for g in v["games"].as_array_mut().unwrap() {
            if g["id"] != 2026020261 {
                *g = json!({"id": g["id"], "gameState": "garbage"});
            }
        }
    });
    fx.edit(U_ESPN_NHL, |v| {
        for e in v["events"].as_array_mut().unwrap() {
            if e["id"] != "401892658" {
                *e = json!({"id": e["id"]});
            }
        }
    });
    assert_eq!(settle(nsh(), &fx).0, "YES");
}
