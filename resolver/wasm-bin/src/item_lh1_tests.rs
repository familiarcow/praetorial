//! LH1 (D-HORIZON1a / D-HORIZON2): btc_touch windows up to 1,461 days (4 years). Offline: synthetic daily-high series served by a
//! fake venue API that answers every request at the REQUESTED granularity (no network). A spike day raises the high of every
//! candle that overlaps it, exactly as a real aggregated candle would.
use super::*;
use serde_json::json;
use std::cell::RefCell;

const DAY: i64 = 86_400;
const WEEK: i64 = 7 * DAY;
const BASE_HIGH: i64 = 50_000;
const X: i64 = 80_000;
/// window start: a Thursday 00:00 UTC (week-aligned, so Kraken weekly candles tile from it)
const WS: i64 = 2_800 * WEEK;
const WIN: i64 = 1_461 * DAY;

struct Series {
    spike_day: Option<i64>, // day index (days since epoch) whose high is X+1000
    down: Vec<&'static str>,
    urls: RefCell<Vec<String>>,
}
impl Series {
    fn new(spike_day_ts: Option<i64>, down: &[&'static str]) -> Series { Series { spike_day: spike_day_ts.map(|t| t.div_euclid(DAY)), down: down.to_vec(), urls: RefCell::new(vec![]) } }
    fn high(&self, open: i64, g: i64) -> i64 {
        match self.spike_day {
            Some(d) if d * DAY < open + g && (d + 1) * DAY > open => X + 1000,
            _ => BASE_HIGH,
        }
    }
    fn q(url: &str, k: &str) -> Option<i64> { url.split(&format!("{}=", k)).nth(1)?.split('&').next()?.parse().ok() }
}
impl HttpFetcher for Series {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        self.urls.borrow_mut().push(url.to_string());
        let ok = |body: Value| Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: "application/json".into(), body: body.to_string().into_bytes(), status_code: 200 });
        let row = |o: i64, g: i64| { let h = self.high(o, g); (o, h, 40_000) };
        if url.contains("coinbase") {
            if self.down.contains(&"coinbase") { return Err("coinbase unreachable (test)".into()); }
            let g = Self::q(url, "granularity").unwrap();
            let s = btc_ts(url, "start");
            let e = btc_ts(url, "end");
            let rows: Vec<Value> = (0..).map(|i| s.div_euclid(g) * g + i * g).take_while(|o| *o <= e).filter(|o| *o >= s).map(|o| { let (o, h, l) = row(o, g); json!([o, l, h, 45_000, 46_000, 1]) }).collect();
            ok(json!(rows))
        } else if url.contains("bitstamp") {
            if self.down.contains(&"bitstamp") { return Err("bitstamp unreachable (test)".into()); }
            let (g, s, e) = (Self::q(url, "step").unwrap(), Self::q(url, "start").unwrap(), Self::q(url, "end").unwrap());
            let rows: Vec<Value> = (0..).map(|i| s + i * g).take_while(|o| *o <= e).map(|o| { let (o, h, l) = row(o, g); json!({"timestamp": o.to_string(), "open": "45000", "high": format!("{}.00", h), "low": format!("{}.00", l), "close": "46000", "volume": "1"}) }).collect();
            ok(json!({"data": {"pair": "BTC/USD", "ohlc": rows}}))
        } else if url.contains("kraken") {
            if self.down.contains(&"kraken") { return Err("kraken unreachable (test)".into()); }
            let (iv, since) = (Self::q(url, "interval").unwrap(), Self::q(url, "since").unwrap());
            let g = iv * 60;
            // the real API returns the first 720 candles after `since` (its depth is the latest 720 of this interval)
            let mut o = (since + 1 + g - 1).div_euclid(g) * g;
            let mut rows = vec![];
            while rows.len() < 720 && o < WS + WIN + 2 * WEEK {
                let (o2, h, l) = row(o, g);
                rows.push(json!([o2, "45000", format!("{}.0", h), format!("{}.0", l), "46000", "45500", "1", 1]));
                o += g;
            }
            ok(json!({"error": [], "result": {"XXBTZUSD": rows, "last": 0}}))
        } else {
            if self.down.contains(&"binance.us") { return Err("binance.us unreachable (test)".into()); }
            let (iv, s, e) = (url.split("interval=").nth(1).unwrap().split('&').next().unwrap(), Self::q(url, "startTime").unwrap() / 1000, Self::q(url, "endTime").unwrap() / 1000);
            let g = match iv { "1d" => DAY, "4h" => 14_400, "1h" => 3600, "15m" => 900, "5m" => 300, _ => 60 };
            let rows: Vec<Value> = (0..).map(|i| s + i * g).take_while(|o| *o <= e).map(|o| { let (o, h, l) = row(o, g); json!([o * 1000, "45000", format!("{}.0", h), format!("{}.0", l), "46000", "1", 0]) }).collect();
            ok(json!(rows))
        }
    }
}
fn btc_ts(url: &str, k: &str) -> i64 {
    let v = url.split(&format!("{}=", k)).nth(1).unwrap().split('&').next().unwrap();
    iso_to_unix(v).unwrap()
}
struct NoJudge;
impl ModelCaller for NoJudge {
    fn call(&self, _m: &str, _msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) { (r#"{"audit":"agree"}"#.to_string(), None, None) }
}
fn settle(ws: i64, we: i64, fx: &Series, now: i64) -> (String, Vec<String>) {
    let iso = |t: i64| praetorial_core::format_ts(t);
    let sheet = json!({"template": {"id": "btc_touch", "version": 1}, "fields": {"direction": "at_or_above", "x_usd": X, "deadline_utc": iso(we), "open_utc": iso(ws)}});
    let raw = sheet.to_string();
    let job = json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 1, "checked_until": 0, "round": 0, "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw});
    let (r, n, _j) = build_submission_judged_at(&job, &NoJudge, fx, false, now);
    (r.outcome, n)
}
fn has(n: &[String], s: &str) -> bool { n.iter().any(|x| x.contains(s)) }

// ---- (a) mid-window touch: Bitstamp + Kraken both see it -> YES, early request and at the deadline
#[test]
fn lh1a_mid_window_touch_1461_days_early_request_is_yes() {
    let we = WS + WIN;
    let spike = WS + 300 * DAY; // inside a whole weekly candle
    let now = WS + 730 * DAY; // mid-window: window not over, early YES allowed
    let fx = Series::new(Some(spike), &[]);
    let (o, n) = settle(WS, we, &fx, now);
    assert_eq!(o, "YES", "{:?}", n);
    assert!(has(&n, "1b: Bitstamp") && has(&n, "1b: Kraken"), "both venues decided: {:?}", n);
    assert!(!has(&n, "Kraken unreachable") && !has(&n, "Bitstamp unreachable"), "{:?}", n);
}
#[test]
fn lh1a_mid_window_touch_1461_days_at_deadline_is_yes() {
    let we = WS + WIN;
    let fx = Series::new(Some(WS + 300 * DAY), &[]);
    let (o, n) = settle(WS, we, &fx, we + 300);
    assert_eq!(o, "YES", "{:?}", n);
    assert!(!has(&n, "Kraken unreachable") && !has(&n, "Bitstamp unreachable"), "{:?}", n);
}
#[test]
fn lh1a_bitstamp_and_kraken_alone_decide_yes_with_coinbase_and_binance_down() {
    let we = WS + WIN;
    let fx = Series::new(Some(WS + 300 * DAY), &["coinbase", "binance.us"]);
    let (o, n) = settle(WS, we, &fx, we + 300);
    assert_eq!(o, "YES", "{:?}", n);
}
// ---- (b) no touch, complete coverage on >=2 venues -> NO at the deadline
#[test]
fn lh1b_no_touch_complete_coverage_1461_days_is_no_at_deadline() {
    let we = WS + WIN;
    let fx = Series::new(None, &[]);
    let (o, n) = settle(WS, we, &fx, we + 300);
    assert_eq!(o, "NO", "{:?}", n);
}
#[test]
fn lh1b_no_touch_bitstamp_and_kraken_alone_is_no() {
    let we = WS + WIN;
    let fx = Series::new(None, &["coinbase", "binance.us"]);
    let (o, n) = settle(WS, we, &fx, we + 300);
    assert_eq!(o, "NO", "{:?}", n);
}
// ---- (c) a weekly edge candle that crosses X is ambiguous -> that venue Unreachable, never a wrong winner
#[test]
fn lh1c_weekly_edge_candle_crossing_after_the_deadline_makes_kraken_unreachable_not_a_winner() {
    let we = WS + WIN; // not week-aligned: the last weekly candle straddles the deadline
    let spike = we + DAY; // AFTER the deadline, same weekly candle -> truth is NO
    let fx = Series::new(Some(spike), &[]);
    let (o, n) = settle(WS, we, &fx, we + 300);
    assert_eq!(o, "NO", "truth is NO (spike after the deadline): {:?}", n);
    assert!(has(&n, "Kraken unreachable"), "{:?}", n);
}
#[test]
fn lh1c_weekly_edge_candle_crossing_with_one_other_venue_is_void_not_yes_or_no() {
    let we = WS + WIN;
    let spike = we + DAY;
    let fx = Series::new(Some(spike), &["bitstamp"]); // Coinbase cannot cover; Bitstamp down; only Binance.US + (ambiguous) Kraken
    let (o, n) = settle(WS, we, &fx, we + 300);
    assert_eq!(o, "VOID", "one decidable venue only: {:?}", n);
    assert!(has(&n, "Kraken unreachable"), "{:?}", n);
}
#[test]
fn lh1c_pick_gran_budgets_for_a_1461_day_window() {
    use btc_reader::{pick_gran, Venue};
    let (ws, we) = (WS, WS + WIN);
    assert!(pick_gran(Venue::Bitstamp, ws, we, we).is_some());
    assert!(pick_gran(Venue::BinanceUs, ws, we, we).is_some());
    assert_eq!(pick_gran(Venue::Kraken, ws, we, we), Some(604_800));
}
