//! Item 17a RED tests: probe-only source-reachability mode.
use super::probe17a::*;
use super::*;
use serde_json::json;
use std::cell::RefCell;

const NOW: i64 = 1_794_000_000; // 2026-11-06T21:20:00Z

fn fx(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/fixtures/probe17a/{}.json", env!("CARGO_MANIFEST_DIR"), name)).unwrap()
}
fn resp(body: Vec<u8>, status: u16) -> RawFetchResponse {
    RawFetchResponse { final_url: "https://x".into(), redirect_chain: vec![], content_type: "application/json".into(), body, status_code: status }
}

#[test]
fn p17a_coinbase_counts_and_depth_from_fixture() {
    let r = summarize(ProbeKind::Coinbase, &resp(fx("coinbase"), 200));
    assert_eq!((r.http_status, r.records), (200, Some(6)));
    assert_eq!((r.oldest_ts, r.newest_ts), (Some(1791244800), Some(1791262800)));
    assert_eq!(r.bytes, fx("coinbase").len());
    assert!(r.error.is_none());
}
#[test]
fn p17a_bitstamp_counts_and_depth_from_fixture() {
    let r = summarize(ProbeKind::Bitstamp, &resp(fx("bitstamp"), 200));
    assert_eq!(r.records, Some(5));
    assert_eq!((r.oldest_ts, r.newest_ts), (Some(1791244800), Some(1791259200)));
}
#[test]
fn p17a_kraken_skips_last_key_and_counts() {
    let r = summarize(ProbeKind::Kraken, &resp(fx("kraken"), 200));
    assert_eq!(r.records, Some(6));
    assert_eq!((r.oldest_ts, r.newest_ts), (Some(1791428400), Some(1791446400)));
}
#[test]
fn p17a_gemini_converts_ms_to_seconds() {
    let r = summarize(ProbeKind::Gemini, &resp(fx("gemini"), 200));
    assert_eq!(r.records, Some(6));
    assert_eq!((r.oldest_ts, r.newest_ts), (Some(1793998800), Some(1794016800)));
}
#[test]
fn p17a_mlb_empty_schedule_is_zero_records_not_error() {
    let r = summarize(ProbeKind::MlbSchedule, &resp(fx("mlb"), 200));
    assert_eq!(r.records, Some(0));
    assert!(r.error.is_none());
}
#[test]
fn p17a_nhl_espn_count_games() {
    assert_eq!(summarize(ProbeKind::NhlScore, &resp(fx("nhl"), 200)).records, Some(3));
    assert_eq!(summarize(ProbeKind::EspnScoreboard, &resp(fx("espn"), 200)).records, Some(2));
}
#[test]
fn p17a_nws_parses_issuance_times() {
    let r = summarize(ProbeKind::NwsCli, &resp(fx("nws_cli"), 200));
    assert_eq!(r.records, Some(4));
    assert_eq!(r.oldest_ts, Some(1793860380)); // 2026-11-05T06:33Z
    assert_eq!(r.newest_ts, Some(1794000960)); // 2026-11-06T21:36Z
}
#[test]
fn p17a_iem_parses_valid_dates() {
    let r = summarize(ProbeKind::IemCli, &resp(fx("iem_cli"), 200));
    assert_eq!(r.records, Some(5));
    assert_eq!(r.oldest_ts, Some(1767225600)); // 2026-01-01
    assert_eq!(r.newest_ts, Some(1767571200)); // 2026-01-05
}
#[test]
fn p17a_non_2xx_and_garbage_are_reported_not_panics() {
    let r = summarize(ProbeKind::Coinbase, &resp(b"<html>blocked</html>".to_vec(), 403));
    assert_eq!((r.http_status, r.records), (403, None));
    assert!(r.error.as_deref().unwrap_or("").contains("403"));
    let g = summarize(ProbeKind::Kraken, &resp(b"not json".to_vec(), 200));
    assert!(g.error.is_some() && g.records.is_none());
    let e = summarize(ProbeKind::Kraken, &resp(br#"{"error":["EGeneral:Too many requests"],"result":{}}"#.to_vec(), 200));
    assert!(e.error.is_some());
}

#[test]
fn p17a_plan_covers_all_requested_sources() {
    let p = build_plan(NOW, "all");
    let ids: std::collections::HashSet<_> = p.iter().map(|t| t.id.clone()).collect();
    assert_eq!(ids.len(), p.len(), "ids unique");
    for v in ["coinbase", "bitstamp", "kraken"] {
        for g in ["1m", "1h"] {
            for w in ["now", "30d", "60d"] {
                assert!(ids.contains(&format!("{v}-{g}-{w}")), "missing {v}-{g}-{w}");
            }
        }
    }
    assert!(ids.contains("gemini-1m") && ids.contains("gemini-1h"));
    for s in STATIONS {
        assert!(ids.contains(&format!("nws-{s}")), "nws {s}");
        assert!(ids.contains(&format!("iem-{s}")), "iem {s}");
    }
    for l in ["nfl", "nba", "mlb", "nhl"] { assert!(ids.contains(&format!("espn-{l}"))); }
    assert!(ids.contains("mlb-schedule") && ids.contains("nhl-score"));
    assert_eq!(STATIONS.len(), 20);
    assert!(p.len() >= 50 && p.len() <= 80);
}
#[test]
fn p17a_plan_urls_are_https_and_windows_are_back_dated() {
    let p = build_plan(NOW, "all");
    for t in &p { assert!(t.url.starts_with("https://"), "{}", t.url); assert!(is_fetch_allowed(&t.url).is_ok(), "{}", t.url); }
    let get = |id: &str| p.iter().find(|t| t.id == id).unwrap().url.clone();
    // Bitstamp start is a unix ts ~60d before NOW (within a day).
    let u = get("bitstamp-1h-60d");
    let start: i64 = u.split("start=").nth(1).unwrap().split('&').next().unwrap().parse().unwrap();
    assert!((NOW - 60 * 86400 - start).abs() <= 86400, "{u}");
    let k = get("kraken-1m-30d");
    let since: i64 = k.split("since=").nth(1).unwrap().split('&').next().unwrap().parse().unwrap();
    assert!((NOW - 30 * 86400 - since).abs() <= 86400, "{k}");
    assert!(get("kraken-1m-now").contains("interval=1") && get("kraken-1h-now").contains("interval=60"));
    assert!(get("coinbase-1m-now").contains("granularity=60") && get("coinbase-1h-now").contains("granularity=3600"));
    // Coinbase 30d window ends on 2026-10-07 (NOW - 30d = 2026-10-07T21:20Z)
    assert!(get("coinbase-1h-30d").contains("2026-10-07"), "{}", get("coinbase-1h-30d"));
    assert!(get("nws-KNYC").contains("/locations/NYC"));
    assert!(get("iem-KLAX").contains("station=KLAX"));
}
#[test]
fn p17a_plan_groups_partition_all() {
    let all = build_plan(NOW, "all").len();
    let parts: usize = ["price", "sports", "weather"].iter().map(|g| build_plan(NOW, g).len()).sum();
    assert_eq!(all, parts);
    assert!(build_plan(NOW, "price").iter().all(|t| t.group == "price"));
    assert!(build_plan(NOW, "bogus").is_empty());
}

struct Rec { urls: RefCell<Vec<String>>, body: Vec<u8>, status: u16 }
impl HttpFetcher for Rec {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        self.urls.borrow_mut().push(url.to_string());
        if self.status == 0 { return Err(format!("transport error fetching {} {}", url, "x".repeat(5000))); }
        Ok(resp(self.body.clone(), self.status))
    }
}

#[test]
fn p17a_handle_job_ignores_other_modes() {
    let f = Rec { urls: RefCell::new(vec![]), body: vec![], status: 200 };
    assert!(handle_job(&json!({"mode":"resolve"}), &f, NOW).is_none());
    assert!(handle_job(&json!({}), &f, NOW).is_none());
    assert!(f.urls.borrow().is_empty());
}
#[test]
fn p17a_output_shape_and_signs_nothing() {
    let f = Rec { urls: RefCell::new(vec![]), body: fx("coinbase"), status: 200 };
    let out = handle_job(&json!({"mode":"probe-sources","group":"price"}), &f, NOW).expect("probe handled");
    assert_eq!(out["mode"], "probe-sources");
    assert_eq!(out["signed"], false);
    assert_eq!(out["near_ai_calls"], 0);
    let s = out["sources"].as_array().unwrap();
    assert_eq!(s.len(), build_plan(NOW, "price").len());
    for e in s {
        for k in ["id", "url", "http_status", "bytes", "records", "oldest_ts", "newest_ts", "error"] { assert!(e.get(k).is_some(), "{k} missing"); }
    }
    let txt = out.to_string();
    for forbidden in ["signature", "public_key", "outcome", "attest"] { assert!(!txt.contains(forbidden), "{forbidden}"); }
}
#[test]
fn p17a_only_fetches_planned_public_hosts_never_near_ai() {
    let f = Rec { urls: RefCell::new(vec![]), body: fx("coinbase"), status: 200 };
    handle_job(&json!({"mode":"probe-sources","group":"all"}), &f, NOW).unwrap();
    let urls = f.urls.borrow();
    assert_eq!(urls.len(), build_plan(NOW, "all").len());
    let allowed = ["api.exchange.coinbase.com", "www.bitstamp.net", "api.kraken.com", "api.gemini.com", "statsapi.mlb.com", "api-web.nhle.com", "site.api.espn.com", "api.weather.gov", "mesonet.agron.iastate.edu"];
    for u in urls.iter() {
        let host = u.trim_start_matches("https://").split('/').next().unwrap();
        assert!(allowed.contains(&host), "unexpected host {host}");
    }
}
#[test]
fn p17a_output_is_bounded_even_with_huge_errors() {
    let f = Rec { urls: RefCell::new(vec![]), body: vec![], status: 0 };
    let out = handle_job(&json!({"mode":"probe-sources","group":"all"}), &f, NOW).unwrap();
    let txt = out.to_string();
    assert!(txt.len() <= MAX_OUTPUT_BYTES, "{} bytes", txt.len());
    assert_eq!(out["sources"].as_array().unwrap().len(), build_plan(NOW, "all").len());
    for e in out["sources"].as_array().unwrap() { assert!(e["error"].as_str().unwrap().len() <= 200); }
}
#[test]
fn p17a_bad_group_is_an_error_not_a_panic() {
    let f = Rec { urls: RefCell::new(vec![]), body: vec![], status: 200 };
    let out = handle_job(&json!({"mode":"probe-sources","group":"bogus"}), &f, NOW).unwrap();
    assert!(out["error"].is_string());
    assert!(f.urls.borrow().is_empty());
}

// --- structural: unreachable from the signed path, no key access ---
#[test]
fn p17a_probe_module_has_no_signing_or_near_ai_or_env_access() {
    let src = include_str!("probe17a.rs");
    for bad in ["NEAR_AI", "cloud-api.near.ai", "outlayer::", "signing", "sign_", "std::env", "ed25519", "ModelCaller", "api_key"] {
        assert!(!src.contains(bad), "probe17a.rs must not reference `{bad}`");
    }
}
#[test]
fn p17a_dispatch_is_feature_gated_and_excludes_signing_feature() {
    let src = include_str!("main.rs");
    let body = &src[src.find("fn main()").unwrap()..];
    let at = body.find("probe17a::handle_job").expect("main dispatches probe");
    let before = &body[at.saturating_sub(400)..at];
    assert!(before.contains("#[cfg(feature = \"probe-sources\")]"), "probe dispatch must be cfg(probe-sources)");
    assert_eq!(body.matches("probe17a::handle_job").count(), 1);
    assert!(src.contains("all(feature = \"probe-sources\", feature = \"outlayer-sign\")") && src.contains("compile_error!"),
        "probe-sources + outlayer-sign must not co-compile");
    // dispatch precedes every path that can sign (sourcecheck / archive / resolve).
    assert!(at < body.find("Some(\"sourcecheck\")").unwrap());
    // not a default feature
    let cargo = include_str!("../Cargo.toml");
    assert!(cargo.contains("probe-sources = [\"real-http\"]"));
    assert!(cargo.contains("default = []"));
}
