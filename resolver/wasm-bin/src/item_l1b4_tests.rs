//! L1b4 (D-SRCCHK2 option A): the open-time sourcecheck of a typed close-at-T sheet probes source reachability with the
//! latest CLOSED 1-minute candle (never the future T-1min candle). Resolution still uses T. A dead source still fails.
use super::*;
use serde_json::json;
use std::cell::RefCell;

// 2026-11-07T12:00:37Z (mid-bucket)
const NOW_NS: u64 = 1_794_052_837_000_000_000;
const NOW_S: i64 = 1_794_052_837;
struct Clk;
impl Clock for Clk {
    fn now_ns(&self) -> u64 { NOW_NS }
}
/// Coinbase behaves like the live API: a `start` in the future is HTTP 400 "Start cannot be in the future".
/// `dead` = (url-substring, status) forces an error on a venue.
struct Live { seen: RefCell<Vec<String>>, dead: Option<(&'static str, u16)>, err: Option<&'static str> }
impl Live {
    fn new() -> Live { Live { seen: RefCell::new(vec![]), dead: None, err: None } }
}
impl HttpFetcher for Live {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        self.seen.borrow_mut().push(url.to_string());
        if let Some(e) = self.err { if url.contains(e) { return Err("connection refused".into()); } }
        let mk = |status: u16, ct: &str, body: &str| RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: ct.into(), body: body.as_bytes().to_vec(), status_code: status };
        if let Some((sub, st)) = self.dead { if url.contains(sub) { return Ok(mk(st, "application/json", "{\"message\":\"NotFound\"}")); } }
        if url.contains("coinbase.com") {
            let start = url.split("start=").nth(1).and_then(|r| r.split('&').next()).and_then(|s| praetorial_core::template::parse_iso(s)).unwrap();
            if start > NOW_S { return Ok(mk(400, "application/json", "{\"message\":\"Start cannot be in the future\"}")); }
        }
        Ok(mk(200, "application/json", "[[1794052740,75900.0,75950.0,75910.0,75920.0,12.5]]"))
    }
}
fn sheet(t_off: i64) -> String {
    json!({"template": {"id": "btc_close_at_t", "version": 1},
           "fields": {"t_utc": iso_utc_from_unix((NOW_S / 60 * 60 + t_off) as u64), "op": ">=", "x_usd": 75900, "open_utc": iso_utc_from_unix((NOW_S / 60 * 60) as u64)}}).to_string()
}
fn run(f: &Live) -> SourceCheckOutcome {
    run_sourcecheck_with_clock(&json!({"mode": "sourcecheck", "terms": sheet(2 * 3600)}), f, &Clk)
}

#[test]
fn l1b4_future_t_sourcecheck_passes_despite_coinbase_400_on_future_window() {
    let f = Live::new();
    let o = run(&f);
    assert!(o.ok, "unreachable: {:?}; fetched: {:?}", o.unreachable, f.seen.borrow());
}
#[test]
fn l1b4_future_t_probe_urls_use_the_last_closed_candle_on_every_venue() {
    let f = Live::new();
    let _ = run(&f);
    let seen = f.seen.borrow().clone();
    assert_eq!(seen.len(), 3, "{:?}", seen);
    assert_eq!(seen[0], "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=2026-11-07T11:59:00Z&end=2026-11-07T11:59:59Z");
    let ws = NOW_S / 60 * 60 - 60;
    assert_eq!(seen[1], format!("https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&limit=1&start={}&end={}", ws, ws + 59));
    assert_eq!(seen[2], format!("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1&since={}", ws - 1));
}
#[test]
fn l1b4_resolution_still_uses_t_unchanged() {
    // the settle-path renderer is untouched: sources/claim still describe the T-1min candle
    let m = praetorial_core::template::materialize(&serde_json::from_str::<Value>(&sheet(2 * 3600)).unwrap()).unwrap();
    let t = iso_utc_from_unix((NOW_S / 60 * 60 + 7200) as u64);
    assert!(m["claim"].as_str().unwrap().contains(&t));
    let u = m["sources_allowed"][0]["url"].as_str().unwrap();
    assert!(u.contains(&format!("end={}", iso_utc_from_unix((NOW_S / 60 * 60 + 7200 - 1) as u64))), "{}", u);
}
#[test]
fn l1b4_dead_source_on_clamped_probe_still_fails_5xx_404_and_transport() {
    for (sub, st) in [("coinbase.com", 503u16), ("bitstamp.net", 500), ("kraken.com", 404), ("coinbase.com", 404)] {
        let mut f = Live::new();
        f.dead = Some((sub, st));
        let o = run(&f);
        assert!(!o.ok && o.unreachable.iter().any(|(_, r)| r.contains("COULDNT_CHECK")), "{} {} -> {:?}", sub, st, o.unreachable);
    }
    let mut f = Live::new();
    f.err = Some("kraken.com");
    let o = run(&f);
    assert!(!o.ok && o.unreachable.len() == 1, "{:?}", o.unreachable);
}
