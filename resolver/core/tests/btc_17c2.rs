//! 17c2 (D-TPL1, D-TPL1b): pure BTC reader rules. Exact decimals, code decides.
use praetorial_core::btc::*;
use serde_json::{json, Value};

fn d(s: &str) -> Dec { Dec::parse(s).unwrap() }
fn cl(v: &[&str]) -> Vec<(String, Dec)> { v.iter().enumerate().map(|(i, s)| (format!("V{}", i), d(s))).collect() }
fn word(x: &BtcDecision) -> &'static str { x.word() }

// ---- Dec
#[test]
fn dec_is_exact_and_rejects_junk() {
    assert_eq!(d("75900"), Dec::from_usd(75900));
    assert_eq!(d("75900.00000000"), Dec::from_usd(75900));
    assert!(d("75900.01") > Dec::from_usd(75900) && d("75899.99999999") < Dec::from_usd(75900));
    assert_eq!(d("75923.34").to_string(), "75923.34");
    for bad in ["", "1e5", "+5", "1.2.3", "abc", "1.12345678901"] { assert!(Dec::parse(bad).is_none(), "{}", bad); }
    assert_eq!(Dec::from_json(&json!(75923.34)).unwrap(), d("75923.34"));
    assert_eq!(Dec::from_json(&json!("0.1")).unwrap().0 * 3, d("0.3").0, "0.1*3 == 0.3 exactly (f64 would not)");
}

// ---- 1a: every op at exactly X (ties decided by the op, never VOID)
#[test]
fn close_at_exactly_x_each_op() {
    let c = cl(&["75900", "75900", "75900"]);
    assert_eq!(word(&close_at_t(">", 75900, &c)), "NO");
    assert_eq!(word(&close_at_t(">=", 75900, &c)), "YES");
    assert_eq!(word(&close_at_t("<", 75900, &c)), "NO");
    assert_eq!(word(&close_at_t("<=", 75900, &c)), "YES");
}
#[test]
fn close_two_venues_tie_by_mean_is_decided_by_op_not_straddle_void() {
    let c = cl(&["75900", "75900.00"]);
    assert_eq!(word(&close_at_t(">=", 75900, &c)), "YES");
    assert_eq!(word(&close_at_t(">", 75900, &c)), "NO");
}
#[test]
fn close_median_of_three_event_a() {
    // recorded real closes (17b GAP-2): A 75923.34/75925.00/75929.10 -> 75925.00
    let a = cl(&["75923.34", "75925.00", "75929.10"]);
    assert_eq!(word(&close_at_t(">", 75900, &a)), "YES");
    assert_eq!(word(&close_at_t(">", 75925, &a)), "NO");
    assert_eq!(word(&close_at_t(">=", 75925, &a)), "YES");
    // median is not the mean: one outlier venue cannot move the outcome
    let o = cl(&["75000", "75925", "99999"]);
    assert_eq!(word(&close_at_t(">", 75900, &o)), "YES");
}
#[test]
fn close_two_venues_mean_and_straddle_void() {
    // A, only CB+BS: 75923.34 / 75925.00 -> mean 75924.17 -> not >= 75927 -> NO
    let two = cl(&["75923.34", "75925.00"]);
    assert_eq!(word(&close_at_t(">=", 75927, &two)), "NO");
    assert_eq!(word(&close_at_t("<", 75927, &two)), "YES");
    let s = close_at_t(">", 75924, &two);
    assert_eq!(word(&s), "VOID");
    assert!(s.why().contains("straddle"), "{}", s.why());
    // mean is exact: 75900.00 / 75900.01 -> mean 75900.005 > 75900
    let h = cl(&["75900.00", "75900.01"]);
    assert_eq!(word(&close_at_t(">", 75900, &h)), "YES");
    assert_eq!(word(&close_at_t("<=", 75900, &h)), "NO");
}
#[test]
fn close_fewer_than_two_is_void() {
    for n in 0..2 {
        let c = cl(&["75925"][..n]);
        let r = close_at_t(">", 1, &c);
        assert_eq!(word(&r), "VOID");
        assert!(r.why().contains("fewer than 2 venues"));
    }
}

// ---- 1b: D-TPL1b table
fn v(s: &[TouchState]) -> Vec<(String, TouchState)> { s.iter().enumerate().map(|(i, s)| (format!("V{}", i), s.clone())).collect() }
use TouchState::*;
fn un() -> TouchState { Unreachable("n/a".into()) }
#[test]
fn touch_one_of_three_crossed_is_void_venues_disagree() {
    let r = touch(&v(&[Crossed, Clear, Clear]));
    assert_eq!(word(&r), "VOID");
    assert!(r.why().contains("venues disagree on touch"), "{}", r.why());
    assert!(touch(&v(&[Crossed, Clear, un()])).why().contains("venues disagree on touch"));
}
#[test]
fn touch_two_of_three_crossed_is_yes() {
    assert_eq!(word(&touch(&v(&[Crossed, Crossed, Clear]))), "YES");
    assert_eq!(word(&touch(&v(&[Crossed, Crossed, Crossed]))), "YES");
    assert_eq!(word(&touch(&v(&[Crossed, Crossed, un()]))), "YES", "an unreachable third does not stop a 2-venue YES");
}
#[test]
fn touch_none_crossed_and_complete_is_no() {
    assert_eq!(word(&touch(&v(&[Clear, Clear, Clear]))), "NO");
    assert_eq!(word(&touch(&v(&[Clear, Clear, un()]))), "NO", "Kraken beyond depth is unreachable, not VOID (GAP-1)");
}
#[test]
fn touch_fewer_than_two_reachable_is_void() {
    for s in [vec![un(), un()], vec![Clear, un(), un()], vec![un(), un(), un()], vec![Crossed, un()], vec![Crossed, un(), un()], vec![]] {
        let r = touch(&v(&s));
        assert_eq!(word(&r), "VOID", "{:?}", s);
        assert!(r.why().contains("fewer than 2 venues"), "{}", r.why());
    }
}

// ---- venue_touch from candles
fn c(ts: i64, lo: &str, hi: &str) -> Candle { Candle { open_ts: ts, high: d(hi), low: d(lo), close: d(lo) } }
#[test]
fn venue_touch_uses_high_or_low_and_exact_x() {
    let cs: Vec<Candle> = (0..3).map(|i| c(i * 60, "75899.99", if i == 1 { "75900" } else { "75899.99" })).collect();
    assert_eq!(venue_touch(&cs, 60, 0, 180, true, 75900), TouchState::Crossed, "high == X touches (at_or_above)");
    assert_eq!(venue_touch(&cs, 60, 0, 180, true, 75901), TouchState::Clear);
    assert_eq!(venue_touch(&cs, 60, 0, 180, false, 75899), TouchState::Clear, "low 75899.99 > 75899");
    assert_eq!(venue_touch(&cs, 60, 0, 180, false, 75900), TouchState::Crossed, "low <= 75900");
}
#[test]
fn venue_touch_missing_candle_or_depth_is_unreachable_never_clear() {
    let cs = vec![c(0, "1", "2"), c(120, "1", "2")];
    assert!(matches!(venue_touch(&cs, 60, 0, 180, true, 99), TouchState::Unreachable(_)), "gap at 60");
    assert!(matches!(venue_touch(&cs[..1], 60, 0, 180, true, 99), TouchState::Unreachable(_)), "short");
    assert!(matches!(venue_touch(&[], 60, 0, 180, true, 99), TouchState::Unreachable(_)));
    assert_eq!(venue_touch(&cs, 60, 0, 180, true, 2), TouchState::Crossed, "a crossing in full in-window candles counts even when coverage is incomplete");
}
#[test]
fn venue_touch_edge_candle_that_crosses_is_ambiguous_not_counted() {
    let cs = vec![c(0, "1", "100"), c(3600, "1", "2")];
    assert!(matches!(venue_touch(&cs, 3600, 1800, 7200, true, 50), TouchState::Unreachable(_)));
    assert_eq!(venue_touch(&cs, 3600, 1800, 7200, true, 500), TouchState::Clear, "edge candle present, no crossing -> covered");
}

// ---- parsers on recorded bodies (btc_A_bu.json = Binance.US klines recorded 2026-11-07, HTTP 200)
#[test]
fn parsers_read_recorded_venue_shapes_with_close() {
    let fx = concat!(env!("CARGO_MANIFEST_DIR"), "/../wasm-bin/fixtures/replay17b");
    let rd = |f: &str| -> Value { serde_json::from_slice(&std::fs::read(format!("{}/{}", fx, f)).unwrap()).unwrap() };
    let at = |cs: &[Candle], t: i64| cs.iter().find(|c| c.open_ts == t).copied().unwrap();
    let t = 1794016560 - 60;
    assert_eq!(at(&parse_coinbase(&rd("btc_A_cb_p0.json")), t).close, d("75923.34"));
    assert_eq!(at(&parse_bitstamp(&rd("btc_A_bs.json")), t).close, d("75925.00"));
    assert_eq!(at(&parse_kraken(&rd("btc_A_kr.json")), t).close, d("75929.10"));
    let bu = parse_binance_us(&rd("btc_A_bu.json"));
    assert_eq!(bu.len(), 60);
    assert_eq!(bu[0].open_ts, 1794012960, "ms -> s");
    assert!(bu.iter().all(|c| c.low <= c.high));
}
#[test]
fn kraken_api_error_body_yields_no_candles() {
    assert!(parse_kraken(&json!({"error": ["EGeneral:Invalid arguments"], "result": {"X": [[1, "1", "2", "0", "1", "1", "1", 1]]}})).is_empty());
}
