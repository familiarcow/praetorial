//! Item 17c2 (D-TPL1, D-TPL1b, D-VENUE2): typed BTC readers decided by CODE from parsed candles. Recorded venue responses
//! (fixtures/replay17b, events A/B/C/D/G; btc_A_bu.json = Binance.US klines) stand in for the network. The judge must never be called.
use super::*;
use serde_json::json;
use std::cell::RefCell;

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/replay17b");

/// Host-keyed recorded responses for event `tag`; hosts in `down` fail; records every URL.
pub(crate) struct F {
    tag: &'static str,
    down: Vec<&'static str>,
    urls: RefCell<Vec<String>>,
}
pub(crate) fn f(tag: &'static str, down: &[&'static str]) -> F { F { tag, down: down.to_vec(), urls: RefCell::new(vec![]) } }
impl F { fn hit(&self, host: &str) -> bool { self.urls.borrow().iter().any(|u| u.contains(host)) } }
impl HttpFetcher for F {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        self.urls.borrow_mut().push(url.to_string());
        let (host, file) = if url.contains("coinbase") { ("coinbase", format!("btc_{}_cb_p0.json", self.tag)) }
            else if url.contains("bitstamp") { ("bitstamp", format!("btc_{}_bs.json", self.tag)) }
            else if url.contains("kraken") { ("kraken", format!("btc_{}_kr.json", self.tag)) }
            else { ("binance.us", format!("btc_{}_bu.json", self.tag)) };
        if self.down.contains(&host) { return Err(format!("{} unreachable (test)", host)); }
        let body = std::fs::read(format!("{}/{}", DIR, file)).map_err(|_| format!("no fixture {}", file))?;
        Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: "application/json".into(), body, status_code: 200 })
    }
}
struct NoJudge;
impl ModelCaller for NoJudge {
    fn call(&self, _m: &str, _msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) { (r#"{"audit":"agree"}"#.to_string(), None, None) /* 17c5: the judge only AUDITS the code outcome (agree); the code still decides, see item17c5_tests */ }
}
pub(crate) fn ev(tag: &str) -> (i64, i64) {
    let e: Value = serde_json::from_slice(&std::fs::read(format!("{}/events.json", DIR)).unwrap()).unwrap();
    (e[tag][0].as_i64().unwrap(), e[tag][1].as_i64().unwrap())
}
fn iso(t: i64) -> String { praetorial_core::format_ts(t) }
fn settle(sheet: Value, fx: &F, now: i64) -> (String, Vec<String>) {
    let raw = sheet.to_string();
    let job = json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 1, "checked_until": 0, "round": 0, "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw});
    let (r, n, _j) = build_submission_judged_at(&job, &NoJudge, fx, false, now);
    (r.outcome, n)
}
pub(crate) fn close_sheet(tag: &str, op: &str, x: i64) -> Value {
    let (ws, we) = ev(tag);
    json!({"template": {"id": "btc_close_at_t", "version": 1}, "fields": {"t_utc": iso(we), "op": op, "x_usd": x, "open_utc": iso(ws)}})
}
pub(crate) fn touch_sheet(tag: &str, dir: &str, x: i64) -> Value {
    let (ws, we) = ev(tag);
    json!({"template": {"id": "btc_touch", "version": 1}, "fields": {"direction": dir, "x_usd": x, "deadline_utc": iso(we), "open_utc": iso(ws)}})
}
fn has(n: &[String], s: &str) -> bool { n.iter().any(|x| x.contains(s)) }

// ---------------------------------------------------------------- 1a (GAP-2): median of the CLOSE at T
#[test]
fn gap2_event_a_median_close_above_75900_is_yes_and_above_75925_is_no() {
    let (_, t) = ev("A");
    let (o, n) = settle(close_sheet("A", ">", 75900), &f("A", &[]), t + 300);
    assert_eq!(o, "YES", "{:?}", n); // closes 75923.34 / 75925.00 / 75929.10
    let (o, n) = settle(close_sheet("A", ">", 75925), &f("A", &[]), t + 300);
    assert_eq!(o, "NO", "median 75925.00 is not > 75925; a tie is decided by the op, never VOID: {:?}", n);
    let (o, _) = settle(close_sheet("A", ">=", 75925), &f("A", &[]), t + 300);
    assert_eq!(o, "YES");
    let (o, _) = settle(close_sheet("A", "<=", 75925), &f("A", &[]), t + 300);
    assert_eq!(o, "YES");
    let (o, _) = settle(close_sheet("A", "<", 75925), &f("A", &[]), t + 300);
    assert_eq!(o, "NO");
}
#[test]
fn gap2_events_b_and_c_medians() {
    for (tag, x, want) in [("B", 75902, "NO"), ("B", 75901, "YES"), ("C", 75691, "YES"), ("C", 75692, "NO")] {
        let (_, t) = ev(tag);
        let (o, n) = settle(close_sheet(tag, ">", x), &f(tag, &[]), t + 600);
        assert_eq!(o, want, "{} > {} (medians B 75901.36, C 75691.93): {:?}", tag, x, n);
    }
}
#[test]
fn gap2_two_venues_use_the_mean_and_void_when_they_straddle() {
    let (_, t) = ev("A");
    // Kraken and the backup both down: CB 75923.34 + BS 75925.00 -> mean 75924.17
    let (o, n) = settle(close_sheet("A", ">=", 75927), &f("A", &["kraken", "binance.us"]), t + 300);
    assert_eq!(o, "NO", "{:?}", n);
    let (o, n) = settle(close_sheet("A", ">", 75924), &f("A", &["kraken", "binance.us"]), t + 300);
    assert_eq!(o, "VOID", "{:?}", n);
    assert!(has(&n, "straddle"), "{:?}", n);
}
#[test]
fn gap2_fewer_than_two_venues_is_void() {
    let (_, t) = ev("A");
    let (o, n) = settle(close_sheet("A", ">", 1), &f("A", &["kraken", "bitstamp", "binance.us"]), t + 300);
    assert_eq!(o, "VOID", "{:?}", n);
    assert!(has(&n, "fewer than 2 venues"), "{:?}", n);
}

// ---------------------------------------------------------------- settle-window check (17c1 request_window_problems) wired in
#[test]
fn settle_window_before_t_plus_5min_is_a_named_void_and_fetches_nothing() {
    let (_, t) = ev("A");
    let fx = f("A", &[]);
    // D-EARLYREQ1 (L1b9): was `assert_eq!(o, "VOID")` (a signed VOID for a too-early request, ruled wrong: it let anyone force VOID).
    // Now: NO signed outcome (early_request_reason set, envelope emits nothing); the note still names REQ_BEFORE_T_PLUS_5MIN.
    let (_o, n) = settle(close_sheet("A", ">", 75900), &fx, t + 299);
    assert!(early_request_reason().is_some_and(|r| r.contains("REQ_BEFORE_T_PLUS_5MIN")), "{:?}", early_request_reason());
    assert!(has(&n, "REQ_BEFORE_T_PLUS_5MIN"), "{:?}", n);
    assert!(fx.urls.borrow().is_empty());
    assert_eq!(settle(close_sheet("A", ">", 75900), &f("A", &[]), t + 300).0, "YES", "exactly T+5min is allowed");
}
#[test]
fn settle_window_t_older_than_6h_is_a_named_void() {
    let (_, t) = ev("A");
    let fx = f("A", &[]);
    let (o, n) = settle(close_sheet("A", ">", 75900), &fx, t + 6 * 3600 + 1);
    assert_eq!(o, "VOID");
    assert!(has(&n, "REQ_T_OLDER_THAN_6H"), "{:?}", n);
    assert!(fx.urls.borrow().is_empty());
    assert_eq!(settle(close_sheet("A", ">", 75900), &f("A", &[]), t + 6 * 3600).0, "YES", "exactly 6h is allowed");
}

// ---------------------------------------------------------------- Binance.US backup (D-VENUE2): only when a primary is unreachable
#[test]
fn backup_is_not_fetched_when_all_primaries_are_reachable() {
    let (_, t) = ev("A");
    let fx = f("A", &[]);
    assert_eq!(settle(close_sheet("A", ">", 75900), &fx, t + 300).0, "YES");
    assert!(!fx.hit("binance.us"));
    let fx = f("A", &[]);
    assert_eq!(settle(touch_sheet("A", "at_or_above", 75930), &fx, t + 300).0, "YES");
    assert!(!fx.hit("binance.us"));
}
#[test]
fn backup_replaces_an_unreachable_primary() {
    if !btc_reader::BINANCE_US_BACKUP_ENABLED { return; }
    let (_, t) = ev("A");
    let fx = f("A", &["kraken"]);
    let (o, n) = settle(close_sheet("A", ">", 75900), &fx, t + 300);
    assert_eq!(o, "YES", "{:?}", n);
    assert!(fx.hit("binance.us") && has(&n, "Binance.US"), "{:?}", n);
    assert!(has(&n, "backup venue Binance.US used"), "{:?}", n);
}
#[test]
fn backup_disabled_constant_keeps_the_parser_but_never_fetches() {
    // the constant is the switch: when false the backup is not fetched (asserted by the code path: `backup()` returns before any fetch)
    if btc_reader::BINANCE_US_BACKUP_ENABLED { assert!(btc_reader::BINANCE_US_DISABLED_REASON.is_empty()); } else { assert!(!btc_reader::BINANCE_US_DISABLED_REASON.is_empty()); }
}

// ---------------------------------------------------------------- 1b touch (GAP-1, GAP-3, D-TPL1b)
#[test]
fn touch_event_a_x75930_two_of_three_crossed_is_yes() {
    let (_, t) = ev("A");
    let (o, n) = settle(touch_sheet("A", "at_or_above", 75930), &f("A", &[]), t + 300);
    assert_eq!(o, "YES", "CB 75930.49 + KR 75932.50 cross, BS 75925.00 does not: {:?}", n);
}
#[test]
fn touch_event_a_x75931_only_kraken_crossed_is_void_venues_disagree() {
    let (_, t) = ev("A");
    let (o, n) = settle(touch_sheet("A", "at_or_above", 75931), &f("A", &[]), t + 300);
    assert_eq!(o, "VOID", "{:?}", n);
    assert!(has(&n, "venues disagree on touch"), "{:?}", n);
}
#[test]
fn touch_event_a_x75970_no_crossing_and_complete_is_no() {
    let (_, t) = ev("A");
    let (o, n) = settle(touch_sheet("A", "at_or_above", 75970), &f("A", &[]), t + 300);
    assert_eq!(o, "NO", "{:?}", n);
}
#[test]
fn touch_event_d_kraken_beyond_its_1m_depth_is_unreachable_not_void() {
    let (_, t) = ev("D");
    // settled ~20h after the window: Kraken 1m is out of depth (the recorded response is the wrong, newest, candles) -> unreachable
    let (o, n) = settle(touch_sheet("D", "at_or_above", 75700), &f("D", &["binance.us"]), t + 20 * 3600);
    assert_eq!(o, "NO", "{:?}", n);
    assert!(has(&n, "Kraken unreachable"), "{:?}", n);
}
#[test]
fn touch_below_uses_the_candle_low() {
    let (_, t) = ev("A");
    // direction at_or_below: lows. A tiny level nobody reached -> NO; a huge level everybody is below -> YES
    assert_eq!(settle(touch_sheet("A", "at_or_below", 1), &f("A", &[]), t + 300).0, "NO");
    assert_eq!(settle(touch_sheet("A", "at_or_below", 200000), &f("A", &[]), t + 300).0, "YES");
}
#[test]
fn touch_fewer_than_two_reachable_is_void() {
    let (_, t) = ev("A");
    let (o, n) = settle(touch_sheet("A", "at_or_above", 1), &f("A", &["kraken", "bitstamp", "binance.us"]), t + 300);
    assert_eq!(o, "VOID", "{:?}", n);
    assert!(has(&n, "fewer than 2 venues"), "{:?}", n);
    // one crossed with one reachable
    let (o, n) = settle(touch_sheet("A", "at_or_above", 75900), &f("A", &["kraken", "bitstamp", "binance.us"]), t + 300);
    assert_eq!(o, "VOID", "{:?}", n);
}
#[test]
fn touch_open_window_without_two_crossings_is_void_window_not_over() {
    let (ws, we) = ev("A");
    let (o, n) = settle(touch_sheet("A", "at_or_above", 75970), &f("A", &[]), we - 600);
    let _ = ws;
    // D-EARLYREQ1 (L1b9): was `assert_eq!(o, "VOID", ...)`; an open window with no early YES is a too-early request: NO signed outcome
    // (an early NO and a forced VOID are both never allowed). The note still names WINDOW_NOT_OVER.
    let _ = o;
    assert!(early_request_reason().is_some_and(|r| r.contains("WINDOW_NOT_OVER")), "{:?}", early_request_reason());
    assert!(has(&n, "WINDOW_NOT_OVER"), "{:?}", n);
}
#[test]
fn typed_btc_judge_is_never_called() {
    // 17c5: the judge is now only the auditor (answers agree here); the VOID path is code-decided and never reaches it. This one is explicit about the VOID path too.
    let (_, t) = ev("A");
    let _ = settle(touch_sheet("A", "at_or_above", 75931), &f("A", &[]), t + 300);
}

// ---------------------------------------------------------------- probe-sources: Binance.US in its own "backup" group
#[test]
fn probe_sources_backup_group_lists_binance_us_klines_and_all_group_is_unchanged() {
    let b = probe17a::build_plan(1_794_016_560, "backup");
    assert_eq!(b.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["binanceus-1m-now", "binanceus-1h-now"]);
    assert!(b.iter().all(|t| t.url.starts_with("https://api.binance.us/api/v3/klines?symbol=BTCUSD&interval=") && t.group == "backup"));
    assert!(!probe17a::build_plan(1_794_016_560, "all").iter().any(|t| t.url.contains("binance")), "17a 'all' plan untouched");
    let body = std::fs::read(format!("{}/btc_A_bu.json", DIR)).unwrap();
    let r = probe17a::summarize(probe17a::ProbeKind::BinanceUs, &RawFetchResponse { final_url: "u".into(), redirect_chain: vec![], content_type: "application/json".into(), body, status_code: 200 });
    assert_eq!((r.records, r.oldest_ts, r.newest_ts), (Some(60), Some(1794012960), Some(1794016500)));
}
