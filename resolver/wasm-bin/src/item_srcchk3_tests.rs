//! SRCCHK3 (D-SRCCHK3): the OPEN-time sourcecheck must pass for EVERY valid typed sheet at the shortest and the longest
//! window the builder + contract accept (D-HORIZON1a: 1,461 days). The mock fetcher enforces the real venue limits, so a
//! probe that asks a venue for something it refuses (Coinbase > 300 one-minute candles / future start, Bitstamp limit
//! > 1000) fails the sheet closed exactly as it did live (SRCW1 finding 2). Offline; no network.
use super::*;
use serde_json::json;
use std::cell::RefCell;

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/replay17b");
// 2026-11-07T12:00:37Z (mid-bucket)
const NOW_NS: u64 = 1_794_052_837_000_000_000;
const NOW_S: i64 = 1_794_052_837;
struct Clk;
impl Clock for Clk {
    fn now_ns(&self) -> u64 { NOW_NS }
}
const OPEN_S: i64 = NOW_S / 60 * 60; // open_utc is a minute boundary
fn iso(off: i64) -> String { iso_utc_from_unix((OPEN_S + off) as u64) }
fn q(url: &str, key: &str) -> Option<String> { url.split(&format!("{}=", key)).nth(1).and_then(|r| r.split('&').next()).map(|s| s.to_string()) }

/// Real venue limits. Records every URL; each violation is HTTP 400 (Kraken: it silently serves only the last 720 candles).
struct Venues { seen: RefCell<Vec<String>> }
impl HttpFetcher for Venues {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        self.seen.borrow_mut().push(url.to_string());
        let mk = |status: u16, ct: &str, body: Vec<u8>| Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: ct.into(), body, status_code: status });
        let json400 = |m: &str| mk(400, "application/json", format!("{{\"message\":\"{}\"}}", m).into_bytes());
        let candle = "[[1794052740,75900.0,75950.0,75910.0,75920.0,12.5]]";
        if url.contains("coinbase.com") {
            let start = praetorial_core::template::parse_iso(&q(url, "start").unwrap()).unwrap();
            let end = praetorial_core::template::parse_iso(&q(url, "end").unwrap()).unwrap();
            if start > NOW_S { return json400("Start cannot be in the future"); }
            if (end - start + 1 + 59) / 60 > 300 { return json400("granularity too small for the requested time range"); }
            return mk(200, "application/json", candle.as_bytes().to_vec());
        }
        if url.contains("bitstamp.net") {
            if q(url, "limit").unwrap().parse::<i64>().unwrap() > 1000 { return json400("limit: Ensure this value is less than or equal to 1000."); }
            return mk(200, "application/json", b"{\"data\":{\"pair\":\"BTC/USD\",\"ohlc\":[{\"timestamp\":\"1794052740\",\"open\":\"75900\",\"high\":\"75950\",\"low\":\"75890\",\"close\":\"75920\",\"volume\":\"1.2\"}]}}".to_vec());
        }
        if url.contains("kraken.com") {
            // only the last 720 one-minute candles exist; an older `since` returns those (never an error), still data
            return mk(200, "application/json", b"{\"error\":[],\"result\":{\"XXBTZUSD\":[[1794052740,\"75900\",\"75950\",\"75890\",\"75920\",\"75910\",\"1.2\",5]],\"last\":1794052740}}".to_vec());
        }
        let file = match url {
            "https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-10-28" => "mlb_schedule_20261028.json",
            "https://api-web.nhle.com/v1/score/2026-11-05" => "nhl_score_20261105.json",
            "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20261101" => "espn_nfl_scoreboard_20261101.json",
            "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=20261028" => "espn_mlb_scoreboard_20261028.json",
            "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=20261105" => "espn_nhl_scoreboard_20261105.json",
            _ => "",
        };
        if file.is_empty() {
            return mk(200, "text/html", b"<html><body><p>Climate report page with enough visible text to be readable: maximum temperature 72 F.</p></body></html>".to_vec());
        }
        mk(200, "application/json", std::fs::read(format!("{}/{}", DIR, file)).unwrap())
    }
}
fn tpl(id: &str) -> Value { json!({"id": id, "version": 1}) }
fn btc_close(t_off: i64) -> Value { json!({"template": tpl("btc_close_at_t"), "fields": {"t_utc": iso(t_off), "op": ">=", "x_usd": 75900, "open_utc": iso(0)}}) }
fn btc_touch(deadline_off: i64) -> Value { json!({"template": tpl("btc_touch"), "fields": {"direction": "at_or_above", "x_usd": 76000, "deadline_utc": iso(deadline_off), "open_utc": iso(0)}}) }
fn game(league: &str, eid: &str, date: &str, tid: &str, name: &str) -> Value {
    json!({"template": tpl("game_winner"), "fields": {"league": league, "event_id": eid, "scheduled_date": date, "pick": {"team_id": tid, "name": name}}})
}
fn nws(date: &str) -> Value { json!({"template": tpl("nws_daily_high"), "fields": {"station": "KNYC", "date": date, "op": ">=", "x_f": 72}}) }

fn check(ts: &Value) -> (SourceCheckOutcome, Vec<String>) {
    let f = Venues { seen: RefCell::new(vec![]) };
    let out = run_sourcecheck_with_clock(&json!({"mode": "sourcecheck", "terms": ts.to_string()}), &f, &Clk);
    let seen = f.seen.borrow().clone();
    (out, seen)
}

const MAX: i64 = 1461 * 86400; // D-HORIZON1a

#[test]
fn srcchk3_every_typed_template_passes_sourcecheck_at_shortest_and_longest_window_under_real_venue_limits() {
    let cases: Vec<(String, Value)> = vec![
        ("btc_close_at_t shortest (T=open+1h+1m)".into(), btc_close(3600 + 60)),
        ("btc_close_at_t longest (T=open+1461d)".into(), btc_close(MAX)),
        ("btc_touch shortest (deadline=open+60s)".into(), btc_touch(60)),
        ("btc_touch 1h".into(), btc_touch(3600)),
        ("btc_touch 5h".into(), btc_touch(5 * 3600)),
        ("btc_touch 6h".into(), btc_touch(6 * 3600)),
        ("btc_touch 30d".into(), btc_touch(30 * 86400)),
        ("btc_touch longest (deadline=open+1461d)".into(), btc_touch(MAX)),
        ("nws_daily_high shortest (today)".into(), nws(&iso(0)[..10])),
        ("nws_daily_high longest (today+1461d)".into(), nws(&iso(MAX)[..10])),
        ("game_winner MLB".into(), game("MLB", "849799", "2026-10-28", "158", "Milwaukee Brewers")),
        ("game_winner NHL".into(), game("NHL", "2026020261", "2026-11-05", "18", "Nashville Predators")),
        ("game_winner NFL".into(), game("NFL", "401873026", "2026-11-01", "2", "Buffalo Bills")),
    ];
    let mut bad = vec![];
    for (name, ts) in &cases {
        let (o, seen) = check(ts);
        if !(o.ok && o.unreachable.is_empty()) { bad.push(format!("{}: ok={} unreachable={:?} fetched={:?}", name, o.ok, o.unreachable, seen)); }
    }
    assert!(bad.is_empty(), "sourcecheck failed closed for:\n{}", bad.join("\n"));
}

#[test]
fn srcchk3_btc_touch_probes_one_closed_minute_wholly_in_the_past_on_every_venue() {
    let ws = OPEN_S - 60;
    for w in [60, 3600, 6 * 3600, 30 * 86400, MAX] {
        let (o, seen) = check(&btc_touch(w));
        assert!(o.ok, "{}s: {:?}", w, o.unreachable);
        assert_eq!(seen.len(), 3, "{}s: {:?}", w, seen);
        assert_eq!(seen[0], "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=2026-11-07T11:59:00Z&end=2026-11-07T11:59:59Z", "{}s", w);
        assert_eq!(seen[1], format!("https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&limit=1&start={}&end={}", ws, ws + 59), "{}s", w);
        assert_eq!(seen[2], format!("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1&since={}", ws - 1), "{}s", w);
        // Kraken keeps only the last 720 one-minute candles: the probed `since` must be inside them
        let since: i64 = q(&seen[2], "since").unwrap().parse().unwrap();
        assert!(since >= NOW_S - 720 * 60, "{}s", w);
    }
}

#[test]
fn srcchk3_a_dead_venue_still_fails_a_long_btc_touch_probe() {
    struct Dead(Venues);
    impl HttpFetcher for Dead {
        fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
            if url.contains("kraken.com") { return Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: "application/json".into(), body: b"{\"message\":\"down\"}".to_vec(), status_code: 503 }); }
            self.0.fetch(url)
        }
    }
    let f = Dead(Venues { seen: RefCell::new(vec![]) });
    let o = run_sourcecheck_with_clock(&json!({"mode": "sourcecheck", "terms": btc_touch(30 * 86400).to_string()}), &f, &Clk);
    assert!(!o.ok && o.unreachable.len() == 1 && o.unreachable[0].0 == "S_KR", "{:?}", o.unreachable);
}

// Resolution must not change: spec_hash of the raw sheet and the materialized sheet text are pinned.
#[test]
fn srcchk3_btc_touch_resolution_inputs_and_spec_hash_are_pinned() {
    for (w, raw_pin, mat_pin) in [(30 * 86400, "8616e4042abce14cfd46ce99b18a0d6f474342fa133783709f8b7a2b6104a897", "98c21e2325f63eb215969a1bdb05ee6c8abb734b0305008401167ed8fb343238"), (MAX, "8d826360a0ab607ecedcb0f4f0d5407e5bc09add8e8461363ce982dc5f90bf9b", "165fc3c8611d79e15d6dfe21c3ea9d28226ddbb6c6eebbc215ee6139f372a505")] {
        let ts = btc_touch(w);
        let raw = ts.to_string();
        let (o, _) = check(&ts);
        assert_eq!(o.spec_hash, raw_pin, "spec_hash of raw sheet, window {}", w);
        let m = praetorial_core::template::materialize(&ts).unwrap();
        assert_eq!(praetorial_core::sha_hex(&m.to_string()), mat_pin, "materialized sheet text, window {}", w);
        assert_eq!(o.spec_hash, praetorial_core::sha_hex(&raw));
        // the resolve path still asks the venues for the WHOLE window, never the probe's single minute
        let u = m["sources_allowed"][0]["url"].as_str().unwrap();
        assert!(u.contains(&format!("start={}", iso(0))) && u.contains(&format!("end={}", iso(w - 1))), "{}", u);
    }
}
// The btc_touch resolve path's granularity choice (btc_reader / choose_granularity) is unchanged.
#[test]
fn srcchk3_btc_touch_resolve_path_granularity_is_pinned() {
    let mut got = vec![];
    for w in [3600i64, 6 * 3600, 30 * 86400, MAX] {
        for v in [PriceVenue::Coinbase, PriceVenue::Bitstamp, PriceVenue::Kraken] {
            got.push(format!("{}:{:?}={:?}", w, v, choose_granularity(v, OPEN_S, OPEN_S + w)));
        }
    }
    assert_eq!(got.join(";"), "3600:Coinbase=Some(60);3600:Bitstamp=Some(60);3600:Kraken=Some(60);21600:Coinbase=Some(60);21600:Bitstamp=Some(60);21600:Kraken=Some(60);2592000:Coinbase=Some(21600);2592000:Bitstamp=Some(7200);2592000:Kraken=Some(14400);126230400:Coinbase=None;126230400:Bitstamp=Some(259200);126230400:Kraken=Some(604800)");
}
