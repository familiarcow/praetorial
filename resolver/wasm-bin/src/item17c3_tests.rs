//! Item 17c3 (D-TPL1): typed nws_daily_high decided by CODE from two copies (NWS CLI two-hop + IEM cli.py). Recorded responses
//! (fixtures/replay17b: nws_cli_list_nyc, nws_cli_nyc_*, iem_cli_knyc_2026) stand in for the network. The judge must never be called.
use super::*;
use serde_json::json;
use std::cell::RefCell;
use std::collections::BTreeMap;

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/replay17b");
const LD: &str = "application/ld+json";
const KNYC_LIST: &str = "https://api.weather.gov/products/types/CLI/locations/NYC";
const KNYC_IEM_2026: &str = "https://mesonet.agron.iastate.edu/json/cli.py?station=KNYC&year=2026";
const P_1105: &str = "https://api.weather.gov/products/7a7c269a-dc88-46b3-8e37-4c86e0f12678"; // issued 2026-11-06T06:45Z = climate day 11-05
const P_1104: &str = "https://api.weather.gov/products/54f7a672-f529-4af2-8133-36be1b0f3cb4"; // issued 2026-11-05T06:33Z = climate day 11-04

/// url -> (body, content-type); `fail` urls error; every requested URL is recorded.
pub(crate) struct Fx3 {
    map: RefCell<BTreeMap<String, (Vec<u8>, String)>>,
    fail: RefCell<Vec<String>>,
    urls: RefCell<Vec<String>>,
}
impl Fx3 {
    /// The recorded 17b NWS/IEM responses, URL-keyed through manifest.json.
    pub(crate) fn recorded() -> Fx3 {
        let m: Value = serde_json::from_slice(&std::fs::read(format!("{}/manifest.json", DIR)).unwrap()).unwrap();
        let mut map = BTreeMap::new();
        for e in m.as_array().unwrap() {
            let f = e["file"].as_str().unwrap();
            if f.starts_with("nws_") || f.starts_with("iem_") {
                map.insert(e["source_url"].as_str().unwrap().to_string(), (std::fs::read(format!("{}/{}", DIR, f)).unwrap(), e["content_type"].as_str().unwrap().to_string()));
            }
        }
        Fx3 { map: RefCell::new(map), fail: RefCell::new(vec![]), urls: RefCell::new(vec![]) }
    }
    pub(crate) fn empty() -> Fx3 {
        Fx3 { map: RefCell::new(BTreeMap::new()), fail: RefCell::new(vec![]), urls: RefCell::new(vec![]) }
    }
    fn put(&self, url: &str, body: Value, ct: &str) -> &Fx3 {
        self.map.borrow_mut().insert(url.to_string(), (body.to_string().into_bytes(), ct.to_string()));
        self
    }
    fn down(&self, url: &str) -> &Fx3 {
        self.fail.borrow_mut().push(url.to_string());
        self
    }
}
impl HttpFetcher for Fx3 {
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

fn t(iso: &str) -> i64 { praetorial_core::template::parse_iso(iso).unwrap() }
/// 2026-11-07T04:00Z: after the recorded responses (03:25Z) and after the 11-05 climate day was reported.
pub(crate) fn now() -> i64 { t("2026-11-07T04:00:00Z") }
pub(crate) fn sheet(station: &str, date: &str, op: &str, x: i64) -> Value {
    json!({"template": {"id": "nws_daily_high", "version": 1}, "fields": {"station": station, "date": date, "op": op, "x_f": x}})
}
fn settle_job(sh: Value, fx: &Fx3, at: i64, extra: Value) -> (SubmittedResult, Vec<String>) {
    let raw = sh.to_string();
    let mut job = json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 1, "checked_until": 0, "round": 0, "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw});
    for (k, v) in extra.as_object().cloned().unwrap_or_default() {
        job[k] = v;
    }
    let (r, n, _j) = build_submission_judged_at(&job, &NoJudge, fx, false, at);
    (r, n)
}
fn settle(sh: Value, fx: &Fx3) -> (String, Vec<String>) {
    let (r, n) = settle_job(sh, fx, now(), json!({}));
    (r.outcome, n)
}
fn has(n: &[String], s: &str) -> bool { n.iter().any(|x| x.contains(s)) }

/// A CLI product body as api.weather.gov serves it.
fn product(id: &str, issued: &str, summary: &str, max: &str) -> Value {
    json!({"id": id, "issuanceTime": issued, "productCode": "CLI",
        "productText": format!("\n000\nCDUS41 KOKX 050640\nCLINYC\n\n...THE CENTRAL PARK NY CLIMATE SUMMARY FOR {}...\n\nTEMPERATURE (F)\n YESTERDAY\n  MAXIMUM         {}    124 PM  78    1975  58     14       59\n  MINIMUM         58    637 AM  25    1879  45     13       47\n", summary, max)})
}
fn list(items: &[(&str, &str)]) -> Value {
    json!({"@graph": items.iter().map(|(id, iso)| json!({"id": id, "issuanceTime": iso, "productCode": "CLI"})).collect::<Vec<_>>()})
}
fn iem(rows: &[(&str, Value)]) -> Value {
    json!({"results": rows.iter().map(|(d, h)| json!({"station": "KNYC", "valid": d, "high": h})).collect::<Vec<_>>()})
}

// ------------------------------------------------------------------ known answer: KNYC 2026-11-05 high 72 (both copies)
#[test]
fn knyc_20261105_both_copies_72_each_op() {
    for (op, x, want) in [(">=", 72, "YES"), (">=", 73, "NO"), ("<=", 72, "YES"), ("<=", 71, "NO"), ("<=", 73, "YES"), (">=", 71, "YES")] {
        let (o, n) = settle(sheet("KNYC", "2026-11-05", op, x), &Fx3::recorded());
        assert_eq!(o, want, "{} {}: {:?}", op, x, n);
    }
}
#[test]
fn two_hop_fetch_picks_the_first_product_issued_after_the_climate_day() {
    let fx = Fx3::recorded();
    let (o, n) = settle(sheet("KNYC", "2026-11-05", ">=", 72), &fx);
    assert_eq!(o, "YES", "{:?}", n);
    assert!(has(&n, "source fetched: S_NWS") && has(&n, "source fetched: S_IEM"), "{:?}", n);
    let urls = fx.urls.borrow().clone();
    assert!(urls.iter().any(|u| u == KNYC_LIST) && urls.iter().any(|u| u == KNYC_IEM_2026), "{:?}", urls);
    assert!(urls.iter().any(|u| u == P_1105), "hop 2 = the 11-06T06:45Z product: {:?}", urls);
    assert!(!urls.iter().any(|u| u == P_1104), "the 11-05T06:33Z product (climate day 11-04) must not be read: {:?}", urls);
}
#[test]
fn day_before_resolves_from_its_own_product() {
    // 2026-11-04: the 11-05T06:33Z product (high 72) and IEM 72 agree.
    let (o, n) = settle(sheet("KNYC", "2026-11-04", ">=", 72), &Fx3::recorded());
    assert_eq!(o, "YES", "{:?}", n);
}

// ------------------------------------------------------------------ MM / disagree / one copy
#[test]
fn nws_cli_mm_is_void_max_missing() {
    let fx = Fx3::recorded();
    fx.put(P_1105, product("7a7c269a-dc88-46b3-8e37-4c86e0f12678", "2026-11-06T06:45:00+00:00", "NOVEMBER 5 2026", "MM"), LD);
    let (o, n) = settle(sheet("KNYC", "2026-11-05", ">=", 72), &fx);
    assert_eq!(o, "VOID", "{:?}", n);
    assert!(has(&n, "max missing"), "{:?}", n);
}
#[test]
fn iem_mm_is_void_max_missing() {
    let fx = Fx3::recorded();
    fx.put(KNYC_IEM_2026, iem(&[("2026-11-05", json!("M"))]), "application/json");
    let (o, n) = settle(sheet("KNYC", "2026-11-05", ">=", 72), &fx);
    assert_eq!(o, "VOID", "{:?}", n);
    assert!(has(&n, "max missing"), "{:?}", n);
}
#[test]
fn copies_disagree_is_void_whichever_way() {
    for iem_high in [71, 73] {
        let fx = Fx3::recorded();
        fx.put(KNYC_IEM_2026, iem(&[("2026-11-05", json!(iem_high))]), "application/json");
        for op in [">=", "<="] {
            let (o, n) = settle(sheet("KNYC", "2026-11-05", op, 72), &fx);
            assert_eq!(o, "VOID", "{} iem {}: {:?}", op, iem_high, n);
            assert!(has(&n, "copies disagree"), "{:?}", n);
        }
    }
}
#[test]
fn only_iem_present_is_retry_not_a_decision() {
    // the NWS list is unreachable; IEM alone says 72 -> never decided on one copy
    let fx = Fx3::recorded();
    fx.down(KNYC_LIST);
    let (r, n) = settle_job(sheet("KNYC", "2026-11-05", ">=", 70), &fx, now(), json!({}));
    assert_eq!(r.outcome, "RETRY", "{:?}", n);
    assert!(r.next_check_ns.unwrap() > now() as u64 * 1_000_000_000, "next_check_ns must be in the future");
}
#[test]
fn only_nws_present_is_retry_not_a_decision() {
    let fx = Fx3::recorded();
    fx.down(KNYC_IEM_2026);
    let (r, n) = settle_job(sheet("KNYC", "2026-11-05", ">=", 70), &fx, now(), json!({}));
    assert_eq!(r.outcome, "RETRY", "{:?}", n);
    assert!(r.next_check_ns.is_some());
}
#[test]
fn hop_two_failure_leaves_one_copy_so_retry() {
    let fx = Fx3::recorded();
    fx.down(P_1105);
    let (r, n) = settle_job(sheet("KNYC", "2026-11-05", ">=", 70), &fx, now(), json!({}));
    assert_eq!(r.outcome, "RETRY", "{:?}", n);
}
#[test]
fn cli_not_published_yet_is_retry_even_when_iem_has_a_row() {
    // 2026-11-06: IEM already has a row, but no CLI product was issued after that climate day (ends 11-07T05:00Z)
    let (r, n) = settle_job(sheet("KNYC", "2026-11-06", ">=", 70), &Fx3::recorded(), now(), json!({}));
    assert_eq!(r.outcome, "RETRY", "{:?}", n);
}
#[test]
fn product_for_another_day_is_not_this_days_copy() {
    let fx = Fx3::recorded();
    fx.put(P_1105, product("7a7c269a-dc88-46b3-8e37-4c86e0f12678", "2026-11-06T06:45:00+00:00", "NOVEMBER 4 2026", "72"), LD);
    let (r, n) = settle_job(sheet("KNYC", "2026-11-05", ">=", 70), &fx, now(), json!({}));
    assert_eq!(r.outcome, "RETRY", "{:?}", n);
}
#[test]
fn one_copy_retries_inside_7_days_then_voids() {
    let day = 86_400u64;
    let first = (now() as u64) * 1_000_000_000;
    // first failure just now: RETRY
    let fx = Fx3::recorded();
    fx.down(KNYC_IEM_2026);
    let (r, n) = settle_job(sheet("KNYC", "2026-11-05", ">=", 70), &fx, now(), json!({"first_unavailable_ns": first}));
    assert_eq!(r.outcome, "RETRY", "{:?}", n);
    // 6 days later: still RETRY, next check later still
    let (r6, n6) = settle_job(sheet("KNYC", "2026-11-05", ">=", 70), &fx, now() + 6 * day as i64, json!({"first_unavailable_ns": first}));
    assert_eq!(r6.outcome, "RETRY", "{:?}", n6);
    assert!(r6.next_check_ns.unwrap() > (now() + 6 * day as i64) as u64 * 1_000_000_000);
    // 7 days and a bit: VOID, no next_check
    let (r8, n8) = settle_job(sheet("KNYC", "2026-11-05", ">=", 70), &fx, now() + 7 * day as i64 + 60, json!({"first_unavailable_ns": first}));
    assert_eq!(r8.outcome, "VOID", "{:?}", n8);
    assert!(r8.next_check_ns.is_none());
    // retry_count at the contract's max_retries also VOIDs
    let (rc, nc) = settle_job(sheet("KNYC", "2026-11-05", ">=", 70), &fx, now(), json!({"first_unavailable_ns": first, "retry_count": 7}));
    assert_eq!(rc.outcome, "VOID", "{:?}", nc);
}
#[test]
fn recovered_copy_after_a_retry_decides() {
    // the retry that finds both copies decides normally, whatever the recovery state in the job
    let first = (now() as u64 - 3 * 86_400) * 1_000_000_000;
    let (r, n) = settle_job(sheet("KNYC", "2026-11-05", ">=", 72), &Fx3::recorded(), now(), json!({"first_unavailable_ns": first, "retry_count": 3}));
    assert_eq!(r.outcome, "YES", "{:?}", n);
}

// ------------------------------------------------------------------ climate day = LST: DST-season date resolves to the CLI's day, not the UTC day
#[test]
fn dst_season_date_resolves_to_the_cli_day_not_the_utc_day() {
    // KNYC 2026-07-04 (EDT). Climate day = 05:00Z 07-04 .. 05:00Z 07-05 (LST, UTC-5).
    //  - 2026-07-05T01:30Z: evening PRELIMINARY for July 4 (inside the LST day; max 85, not final).
    //  - 2026-07-05T06:40Z: the FINAL report for July 4 (max 88) = the first product issued after the climate day.
    //  - 2026-07-04T06:40Z: report for July 3 (max 70).
    // A UTC-day reader (day ends 07-05T00:00Z) would take the 01:30Z preliminary (85).
    let l = list(&[("prelim", "2026-07-05T01:30:00+00:00"), ("final", "2026-07-05T06:40:00+00:00"), ("jul3", "2026-07-04T06:40:00+00:00"), ("jul5", "2026-07-06T06:40:00+00:00")]);
    let fx = Fx3::empty();
    fx.put(KNYC_LIST, l, LD)
        .put("https://api.weather.gov/products/prelim", product("prelim", "2026-07-05T01:30:00+00:00", "JULY 4 2026", "85"), LD)
        .put("https://api.weather.gov/products/final", product("final", "2026-07-05T06:40:00+00:00", "JULY 4 2026", "88"), LD)
        .put("https://api.weather.gov/products/jul3", product("jul3", "2026-07-04T06:40:00+00:00", "JULY 3 2026", "70"), LD)
        .put("https://api.weather.gov/products/jul5", product("jul5", "2026-07-06T06:40:00+00:00", "JULY 5 2026", "99"), LD)
        .put("https://mesonet.agron.iastate.edu/json/cli.py?station=KNYC&year=2026", iem(&[("2026-07-03", json!(70)), ("2026-07-04", json!(88)), ("2026-07-05", json!(99))]), "application/json");
    let at = t("2026-07-05T12:00:00Z");
    let run = |op: &str, x: i64| {
        let (r, n) = settle_job(sheet("KNYC", "2026-07-04", op, x), &fx, at, json!({}));
        (r.outcome, n)
    };
    let (o, n) = run(">=", 88);
    assert_eq!(o, "YES", "must use the 06:40Z final (88), not the 01:30Z preliminary (85): {:?}", n);
    assert_eq!(run("<=", 87).0, "NO");
    assert_eq!(run("<=", 88).0, "YES");
    let urls = fx.urls.borrow().clone();
    assert!(urls.iter().any(|u| u.ends_with("/final")) && !urls.iter().any(|u| u.ends_with("/prelim")), "{:?}", urls);
}
#[test]
fn rendered_text_says_local_standard_time_not_utc_not_dst() {
    let m = praetorial_core::template::materialize(&sheet("KNYC", "2026-07-04", ">=", 88)).unwrap();
    let all = m.to_string();
    assert!(all.contains("local standard time"), "{}", all);
    assert!(all.contains("daylight saving") && all.contains("not the UTC day"), "{}", all);
}

// ------------------------------------------------------------------ GAP-4 content types
#[test]
fn content_type_allow_list_takes_ld_json_and_geo_json_but_nothing_else_new() {
    for ok in ["application/ld+json", "application/geo+json", "application/ld+json; charset=utf-8", "Application/GEO+JSON", "application/json", "text/html", "text/plain", "application/xml", "application/rss+xml"] {
        assert!(content_type_allowed(ok), "{}", ok);
    }
    for bad in ["application/pdf", "image/png", "video/mp4", "application/vnd.api+json", "application/problem+json", "application/jsonp", "text/json", "application/x-ld+json", "application/ld+jsonx", "", "application/octet-stream"] {
        assert!(!content_type_allowed(bad), "{}", bad);
    }
}
#[test]
fn fetch_json_accepts_ld_and_geo_json_and_still_rejects_other_types() {
    for ct in ["application/ld+json", "application/geo+json", "application/geo+json; charset=utf-8"] {
        let fx = Fx3::empty();
        fx.put(KNYC_LIST, json!({"a": 1}), ct);
        assert_eq!(fetch_json(KNYC_LIST, &fx).unwrap(), json!({"a": 1}), "{}", ct);
    }
    for ct in ["text/html", "application/pdf", "application/vnd.api+json"] {
        let fx = Fx3::empty();
        fx.put(KNYC_LIST, json!({"a": 1}), ct);
        assert!(fetch_json(KNYC_LIST, &fx).is_err(), "{}", ct);
    }
}
#[test]
fn core_blocked_fetch_json_check_matches() {
    for ct in ["application/ld+json", "application/geo+json; charset=utf-8", "application/json; charset=utf-8"] {
        assert_eq!(praetorial_core::classify_blocked_fetch(200, ct, b"{\"a\":1}", true), None, "{}", ct);
    }
    for ct in ["text/html", "application/vnd.api+json", "application/ld+jsonx"] {
        assert!(praetorial_core::classify_blocked_fetch(200, ct, b"{\"a\":1}", true).is_some(), "{}", ct);
    }
}
