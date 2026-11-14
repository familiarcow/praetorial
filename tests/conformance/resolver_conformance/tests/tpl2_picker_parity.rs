//! TPL2 parity: every game_winner sheet the web game picker generates (apps/web/lib/sportsGames.ts, snapshot pinned by
//! apps/web/tests/sportsGames.unit.test.ts in apps/web/tests/fixtures/sports/picker-parity.json) is run through resolver/core
//! ITSELF on the recorded schedule payloads it was built from:
//!  - template lint, materialize and the clock-only open checks are clean;
//!  - the open-time sports check (`sports_event_problems`) finds the event on the league source payload for scheduled_date;
//!  - the resolver's own pairing (`league_event` + `league_game_number` + `espn_event_for_game`; NFL/NBA `espn_event_by_id`) lands
//!    on the same ESPN event and the same two team ids the picker showed (doubleheaders by game number);
//!  - `decide` with the picked team id says YES when that team wins and NO when it loses (a pick id from the wrong id namespace
//!    would be VOID "not a team in this game"). Real finals use the recorded scores; upcoming games use a synthetic final 3-2.
//! Reads fixtures only; no network. resolver/** is not edited.
use praetorial_core::sports::{self, Decision, Src};
use praetorial_core::template::{league_event_url, lint_template, materialize, open_problems, parse_iso, sports_event_problems};
use serde_json::Value;
use std::path::PathBuf;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn read(rel: &str) -> Value {
    let p = root().join(rel);
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {}", p.display(), e))).unwrap()
}
fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}

/// Mirror of sports.rs `same_team` (private there): same abbrev, or any shared name (trimmed, case-insensitive).
fn same_team(a: &sports::Team, b: &sports::Team) -> bool {
    let n = |x: &str| x.trim().to_lowercase();
    (!a.abbrev.is_empty() && n(&a.abbrev) == n(&b.abbrev)) || a.names.iter().any(|x| !n(x).is_empty() && b.names.iter().any(|y| n(x) == n(y)))
}

fn final_src(mut x: Src, home: i64, away: i64) -> Src {
    x.is_final = true;
    x.called_off = false;
    x.home.score = Some(home);
    x.away.score = Some(away);
    x
}

#[test]
fn tpl2_every_picker_sheet_is_accepted_paired_and_decided_by_resolver_core() {
    let snap = read("apps/web/tests/fixtures/sports/picker-parity.json");
    let cases = snap["cases"].as_array().expect("cases[]");
    assert!(cases.len() >= 6, "snapshot has too few cases");
    let mut checked = 0;
    let mut doubleheader = 0;
    for c in cases {
        let league = s(c, "league");
        let date = s(c, "date");
        let espn_body = read(s(c, "espn_file"));
        let single = league == "NFL" || league == "NBA";
        let league_body = if single { espn_body.clone() } else { read(c["league_file"].as_str().expect("league_file")) };
        for sh in c["sheets"].as_array().unwrap() {
            let ts = &sh["sheet"];
            let ctx = format!("{} {} {} {}", league, date, ts["fields"]["event_id"], s(sh, "side"));
            assert_eq!(lint_template(ts), Vec::<String>::new(), "lint {}", ctx);
            assert!(materialize(ts).is_ok(), "materialize {}", ctx);
            assert_eq!(open_problems(ts, parse_iso("2026-01-01T00:00:00Z").unwrap()), Vec::<String>::new(), "open {}", ctx);
            assert_eq!(sports_event_problems(ts, &league_body), Vec::<String>::new(), "open sports check {}", ctx);
            let compact = date.replace('-', "");
            let want_url = match league {
                "MLB" => format!("https://statsapi.mlb.com/api/v1/schedule?sportId=1&date={}", date),
                "NHL" => format!("https://api-web.nhle.com/v1/score/{}", date),
                "NFL" => format!("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates={}", compact),
                _ => format!("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={}", compact),
            };
            assert_eq!(league_event_url(ts).as_deref(), Some(want_url.as_str()), "league url {}", ctx);

            let eid = ts["fields"]["event_id"].as_str().unwrap();
            let pick = ts["fields"]["pick"]["team_id"].as_str().unwrap();
            let (lg, es): (Option<Src>, Option<Src>) = if single {
                let ev = sports::espn_event_by_id(&espn_body, eid).unwrap_or_else(|| panic!("ESPN event {}", ctx));
                (None, Some(sports::parse_espn(&ev).unwrap()))
            } else {
                let lev = sports::league_event(league, &league_body, eid).unwrap_or_else(|| panic!("league event {}", ctx));
                let n = sports::league_game_number(league, &lev);
                assert_eq!(n, sh["game_number"].as_i64(), "game number {}", ctx);
                if n.is_some() {
                    doubleheader += 1;
                }
                let l = sports::parse_league(league, &lev).unwrap();
                let paired = sports::espn_event_for_game(&l, n, &espn_body).unwrap();
                assert_eq!(paired.as_ref().and_then(|e| e.get("id")).and_then(|v| v.as_str()), sh["espn_id"].as_str(), "ESPN pairing {}", ctx);
                (Some(l), paired.map(|e| sports::parse_espn(&e).unwrap()))
            };
            let base = lg.as_ref().or(es.as_ref()).unwrap();
            assert_eq!(base.home.id, s(sh, "home_id"), "home team id {}", ctx);
            assert_eq!(base.away.id, s(sh, "away_id"), "away team id {}", ctx);
            let picked_home = s(sh, "side") == "home";
            assert_eq!(pick, if picked_home { &base.home.id } else { &base.away.id }, "pick id {}", ctx);

            let Some(es) = es else { continue }; // unpaired: the picker refuses these (the resolver could never decide them)
            let recorded_final = |x: &Src| x.is_final && x.home.score.is_some() && x.away.score.is_some() && x.home.score != x.away.score;
            let (lg2, es2, home_won) = if recorded_final(&es) && lg.as_ref().map(recorded_final).unwrap_or(true) {
                let hw = es.home.score > es.away.score;
                (lg.clone(), es.clone(), hw)
            } else {
                (lg.clone().map(|l| final_src(l, 3, 2)), final_src(es.clone(), 3, 2), true)
            };
            // ESPN may list the teams the other way round; the synthetic score follows the team (sports.rs same_team rule), not the side
            let es2 = match lg2.as_ref() {
                Some(l) if !single && !same_team(&l.home, &es2.home) => {
                    let mut e = es2;
                    std::mem::swap(&mut e.home.score, &mut e.away.score);
                    e
                }
                _ => es2,
            };
            let late = parse_iso("2030-01-01T00:00:00Z").unwrap();
            let d = sports::decide(single, pick, late, lg2.as_ref(), Some(&es2));
            let want_yes = picked_home == home_won;
            match (&d, want_yes) {
                (Decision::Yes(_), true) | (Decision::No(_), false) => {}
                _ => panic!("decide {}: got {:?}, want {}", ctx, d, if want_yes { "YES" } else { "NO" }),
            }
            checked += 1;
        }
    }
    assert!(checked >= 100, "only {} sheets decided", checked);
    assert!(doubleheader >= 4, "the MLB doubleheader (2 games x 2 sides) must be in the snapshot, got {}", doubleheader);
}
