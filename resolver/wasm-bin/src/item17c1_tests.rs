//! Item 17c1 (D-TPL1): open-time enforcement in the resolver binary. The OPEN path is the sourcecheck job (the
//! escrow requires its signed attestation before a bet opens), so the schema + open-time checks run there and a
//! refused sheet signs nothing. The settle path (`build_submission_with`) renders typed sheets with the fixed renderer.
//! Readers (17c2-17c4) are NOT built here. Recorded league payloads (fixtures/replay17b) stand in for the network.
use super::*;
use serde_json::json;
use std::cell::RefCell;
use std::collections::BTreeMap;

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/replay17b");
// 2026-11-07T12:00:00Z
const NOW_NS: u64 = 1_794_052_800_000_000_000;
struct Clk;
impl Clock for Clk {
    fn now_ns(&self) -> u64 { NOW_NS }
}
fn iso(secs_from_now: i64) -> String { iso_utc_from_unix((NOW_NS / 1_000_000_000) as i64 as u64 + secs_from_now as u64) }

/// Records every URL asked for; serves the recorded league payloads and a tiny page for anything else.
struct Rec(RefCell<Vec<String>>);
impl Rec { fn new() -> Rec { Rec(RefCell::new(vec![])) } fn urls(&self) -> Vec<String> { self.0.borrow().clone() } }
impl HttpFetcher for Rec {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        self.0.borrow_mut().push(url.to_string());
        let file = match url {
            "https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-10-28" => "mlb_schedule_20261028.json",
            "https://api-web.nhle.com/v1/score/2026-11-05" => "nhl_score_20261105.json",
            "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20261101" => "espn_nfl_scoreboard_20261101.json",
            "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=20261028" => "espn_mlb_scoreboard_20261028.json",
            "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=20261105" => "espn_nhl_scoreboard_20261105.json",
            _ => "",
        };
        let body = if file.is_empty() { b"<html><body><p>BTC-USD candle data page with enough visible text to be readable, 75900.00 USD.</p></body></html>".to_vec() } else { std::fs::read(format!("{}/{}", DIR, file)).unwrap() };
        let ct = if file.is_empty() { "text/html" } else { "application/json" };
        Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: ct.into(), body, status_code: 200 })
    }
}
fn check(ts: Value) -> (SourceCheckOutcome, Vec<String>) {
    let raw = ts.to_string();
    let f = Rec::new();
    let out = run_sourcecheck_with_clock(&json!({"mode": "sourcecheck", "terms": raw}), &f, &Clk);
    (out, f.urls())
}
fn reasons(o: &SourceCheckOutcome) -> String { o.unreachable.iter().map(|(_, r)| r.clone()).collect::<Vec<_>>().join(" | ") }

fn tpl(id: &str) -> Value { json!({"id": id, "version": 1}) }
fn btc_close(t_off: i64) -> Value {
    json!({"template": tpl("btc_close_at_t"), "fields": {"t_utc": iso(t_off), "op": ">=", "x_usd": 75900, "open_utc": iso(0)}})
}
fn btc_touch(deadline_off: i64) -> Value {
    json!({"template": tpl("btc_touch"), "fields": {"direction": "at_or_above", "x_usd": 76000, "deadline_utc": iso(deadline_off), "open_utc": iso(0)}})
}
fn game(league: &str, eid: &str, date: &str) -> Value {
    json!({"template": tpl("game_winner"), "fields": {"league": league, "event_id": eid, "scheduled_date": date, "pick": {"team_id": "2", "name": "Buffalo Bills"}}})
}
fn nws(date: &str, station: &str) -> Value {
    json!({"template": tpl("nws_daily_high"), "fields": {"station": station, "date": date, "op": ">=", "x_f": 72}})
}

// ---- 1. template id/version: named lint error, the bet cannot open (no attestation)
#[test]
fn open_refuses_unknown_template_id_and_version_signing_nothing() {
    let mut s = btc_touch(86400);
    s["template"]["id"] = json!("eth_touch");
    let (o, urls) = check(s);
    assert!(!o.ok && reasons(&o).contains("TPL_UNKNOWN_ID"), "{:?}", o.unreachable);
    assert!(urls.is_empty(), "nothing is fetched for a refused sheet: {:?}", urls);
    let mut s = btc_touch(86400);
    s["template"]["version"] = json!(2);
    let (o, _) = check(s);
    assert!(!o.ok && reasons(&o).contains("TPL_UNKNOWN_VERSION"), "{:?}", o.unreachable);
}
#[test]
fn open_refuses_bettor_supplied_sources_on_a_typed_template() {
    let mut s = btc_touch(86400);
    s["sources_allowed"] = json!([{"id": "S1", "publisher": "x", "url": "https://evil.example/p"}]);
    let (o, urls) = check(s);
    assert!(!o.ok && reasons(&o).contains("TPL_FIELD_NOT_ALLOWED"), "{:?}", o.unreachable);
    assert!(urls.is_empty());
}

// ---- 4. open-time checks (refused before the bet opens)
#[test]
fn open_1a_t_must_be_open_plus_1h() {
    let (o, urls) = check(btc_close(1800));
    assert!(!o.ok && reasons(&o).contains("OPEN_T_TOO_SOON"), "{:?}", o.unreachable);
    assert!(urls.is_empty());
    let (o, urls) = check(btc_close(7200));
    assert!(o.ok, "{:?}", o.unreachable);
    assert!(urls.len() == 3 && urls[0].starts_with("https://api.exchange.coinbase.com/products/BTC-USD/candles"), "sources built from the template: {:?}", urls);
}
#[test]
fn open_1b_deadline_within_four_years() {
    // D-HORIZON1a (ruling change from the former 1-year cap): 1,461 days accepted, +1 s refused
    let (o, _) = check(btc_touch(1461 * 86400));
    assert!(o.ok, "{:?}", o.unreachable);
    let (o, _) = check(btc_touch(366 * 86400));
    assert!(o.ok, "{:?}", o.unreachable);
    let (o, _) = check(btc_touch(1461 * 86400 + 1));
    assert!(!o.ok && reasons(&o).contains("OPEN_DEADLINE_TOO_FAR"), "{:?}", o.unreachable);
    let (o, _) = check(btc_touch(5 * 365 * 86400));
    assert!(!o.ok && reasons(&o).contains("OPEN_DEADLINE_TOO_FAR"), "{:?}", o.unreachable);
    let (o, _) = check(btc_touch(30 * 86400));
    assert!(o.ok, "{:?}", o.unreachable);
}
#[test]
fn open_weather_station_curated_and_date_not_past() {
    let (o, _) = check(nws("2026-11-08", "KXXX"));
    assert!(!o.ok && reasons(&o).contains("TPL_STATION_NOT_CURATED"), "{:?}", o.unreachable);
    let (o, _) = check(nws("2026-11-06", "KNYC"));
    assert!(!o.ok && reasons(&o).contains("OPEN_WEATHER_DATE_PAST"), "{:?}", o.unreachable);
    let (o, urls) = check(nws("2026-11-08", "KNYC"));
    assert!(o.ok, "{:?}", o.unreachable);
    assert!(urls.iter().any(|u| u == "https://api.weather.gov/products/types/CLI/locations/NYC"), "{:?}", urls);
}
#[test]
fn open_sports_event_checked_at_the_league_source_offline() {
    // existing event, right date: opens; the league URL is built from the template (never the bettor)
    let (o, urls) = check(game("MLB", "849799", "2026-10-28"));
    assert!(o.ok, "{:?}", o.unreachable);
    assert!(urls.iter().any(|u| u == "https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-10-28"), "{:?}", urls);
    let (o, _) = check(game("NHL", "2026020261", "2026-11-05"));
    assert!(o.ok, "{:?}", o.unreachable);
    // unknown event id on that date
    let (o, _) = check(game("MLB", "111111", "2026-10-28"));
    assert!(!o.ok && reasons(&o).contains("OPEN_EVENT_NOT_ON_DATE"), "{:?}", o.unreachable);
    // right event, wrong date
    let (o, _) = check(game("NFL", "401873026", "2026-11-02"));
    assert!(!o.ok, "{:?}", o.unreachable);
}
// D-SPORTS1 + GAP-5b (lint half): NFL/NBA single-source ESPN opens through the typed template (the legacy sheet cannot).
#[test]
fn gap5b_nfl_single_source_opens_via_typed_template_with_one_espn_source() {
    let (o, urls) = check(game("NFL", "401873026", "2026-11-01"));
    assert!(o.ok, "{:?}", o.unreachable);
    assert_eq!(urls.iter().filter(|u| u.contains("site.api.espn.com")).count(), 2, "event check + the single source fetch: {:?}", urls);
    assert!(urls.iter().all(|u| u.contains("espn.com")), "{:?}", urls);
}
// custom: today's behaviour is unchanged for an explicit-date sheet, and the relative-date lint refuses at open
#[test]
fn open_custom_sheet_unchanged_and_relative_date_refused() {
    let ok = json!({"claim": "AAPL closes above 340 on Friday, October 30, 2026.", "rule": "ALL", "sources_allowed": [{"id": "S1", "publisher": "P", "url": "https://a.example/page"}]});
    let (o, _) = check(ok);
    assert!(o.ok, "{:?}", o.unreachable);
    let bad = json!({"claim": "AAPL closes above 340 on Friday.", "rule": "ALL", "sources_allowed": [{"id": "S1", "publisher": "P", "url": "https://a.example/page"}]});
    let (o, urls) = check(bad);
    assert!(!o.ok && reasons(&o).contains("CUSTOM_RELATIVE_DATE"), "{:?}", o.unreachable);
    assert!(urls.is_empty());
    let (o, _) = check(json!({"template": tpl("custom"), "claim": "Team wins tomorrow", "rule": "ALL", "sources_allowed": []}));
    assert!(!o.ok && reasons(&o).contains("CUSTOM_RELATIVE_DATE"), "{:?}", o.unreachable);
}

// D-L1MESSY2 (L1b8): sourcecheck refuses a custom price-level claim with no touch/close reading, naming both options
#[test]
fn l1b8_sourcecheck_refuses_undefined_price_reading_and_accepts_defined() {
    let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../services/e2e/live-L1/live2/terms_btc_breaks_76140_messy.json")).unwrap();
    let messy: Value = serde_json::from_str(&raw).unwrap();
    let (o, urls) = check(messy.clone());
    assert!(!o.ok && reasons(&o).contains("PRICE_READING_UNDEFINED"), "{:?}", o.unreachable);
    assert!(reasons(&o).contains("touch: any 1-minute candle high/low") && reasons(&o).contains("close: a 1-minute candle close"), "{:?}", o.unreachable);
    assert!(urls.is_empty(), "refused before any fetch: {:?}", urls);
    let mut fixed = messy;
    fixed["custom_definitions"].as_array_mut().unwrap().push(json!("close: a 1-minute candle close at or beyond the level"));
    let (o, _) = check(fixed);
    assert!(!reasons(&o).contains("PRICE_READING_UNDEFINED"), "{:?}", o.unreachable);
}

// ---- settle path: the fixed renderer feeds the existing pipeline; the hash is over the raw typed sheet
struct NoJudge;
impl ModelCaller for NoJudge {
    fn call(&self, _m: &str, _msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        (r#"{"answer":"insufficient","reason":"none"}"#.to_string(), None, None)
    }
}
fn settle(ts: Value) -> (String, Vec<String>) {
    let raw = ts.to_string();
    let job = json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 1, "checked_until": 0, "round": 0, "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw});
    let (r, n) = build_submission_with(&job, &NoJudge, &Rec::new(), false);
    (r.outcome, n)
}
#[test]
fn settle_refuses_a_bad_typed_sheet_by_name_and_renders_a_good_one() {
    let mut bad = btc_touch(86400);
    bad["fields"]["x_usd"] = json!(75900.5);
    let (out, n) = settle(bad);
    assert_eq!(out, "VOID");
    assert!(n.iter().any(|x| x.contains("TPL_X_USD_NOT_WHOLE")), "{:?}", n);
    let (_, n) = settle(game("NFL", "401873026", "2026-11-01"));
    assert!(!n.iter().any(|x| x.contains("compiler gate")), "a typed NFL game_winner (single source, D-SPORTS1) must pass the compile gate: {:?}", n);
    let (_, n) = settle(game("MLB", "849799", "2026-10-28"));
    assert!(!n.iter().any(|x| x.contains("compiler gate")), "{:?}", n);
}
#[test]
fn settle_custom_without_template_goes_through_the_legacy_gate_unchanged() {
    let (out, n) = settle(json!({"claim": "x"}));
    assert_eq!(out, "VOID");
    assert!(n.iter().any(|x| x.contains("compiler gate")), "{:?}", n);
    let _ = BTreeMap::<u8, u8>::new();
}
