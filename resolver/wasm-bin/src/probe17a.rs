//! Item 17a: probe-only source reachability mode ("probe-sources").
//!
//! Fetches each candidate data source through the supplied `HttpFetcher` and
//! reports URL, HTTP status, byte size, record counts and history depth.
//! This module is deliberately inert: it holds no keys, reads no environment,
//! has no model client and produces nothing that is a verdict or an attestation.
//! The job dispatch lives in `main()` behind the `probe-sources` cargo feature,
//! which cannot be combined with `outlayer-sign`.
use super::{HttpFetcher, RawFetchResponse};
use serde_json::{json, Value};

pub const MAX_OUTPUT_BYTES: usize = 60_000;
const MAX_ERR_CHARS: usize = 160;
const MAX_URL_CHARS: usize = 300;
pub const STATIONS: [&str; 20] = [
    "KNYC", "KLAX", "KORD", "KMIA", "KDFW", "KDEN", "KPHX", "KSEA", "KATL", "KBOS", "KIAH", "KMSP", "KDCA", "KPHL",
    "KSFO", "KLAS", "KAUS", "KDTW", "KMDW", "KSAN",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeKind {
    Coinbase,
    Bitstamp,
    Kraken,
    Gemini,
    BinanceUs,
    MlbSchedule,
    NhlScore,
    EspnScoreboard,
    NwsCli,
    IemCli,
}

#[derive(Clone, Debug)]
pub struct ProbeTarget {
    pub id: String,
    pub group: &'static str,
    pub kind: ProbeKind,
    pub url: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SourceReport {
    pub http_status: u16,
    pub bytes: usize,
    pub records: Option<usize>,
    pub oldest_ts: Option<i64>,
    pub newest_ts: Option<i64>,
    pub error: Option<String>,
}

// ---- civil-time helpers (UTC, no external crate) ----
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
fn ymd(ts: i64) -> (i64, i64, i64) {
    civil_from_days(ts.div_euclid(86_400))
}
fn iso_z(ts: i64) -> String {
    let (y, m, d) = ymd(ts);
    let s = ts.rem_euclid(86_400);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, s / 3600, (s % 3600) / 60, s % 60)
}
fn ymd_dash(ts: i64) -> String {
    let (y, m, d) = ymd(ts);
    format!("{:04}-{:02}-{:02}", y, m, d)
}
fn ymd_compact(ts: i64) -> String {
    let (y, m, d) = ymd(ts);
    format!("{:04}{:02}{:02}", y, m, d)
}

/// "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM[:SS][.fff][Z|+HH:MM|-HH:MM]" -> unix seconds.
fn parse_iso(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let num = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let mut t = days_from_civil(num(0, 4)?, num(5, 7)?, num(8, 10)?) * 86_400;
    if b.len() >= 16 && (b[10] == b'T' || b[10] == b' ') {
        t += num(11, 13)? * 3600 + num(14, 16)? * 60;
        let mut i = 16;
        if b.len() >= 19 && b[16] == b':' {
            t += num(17, 19)?;
            i = 19;
        }
        if i < b.len() && b[i] == b'.' {
            i += 1;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
        }
        if i + 6 <= b.len() && (b[i] == b'+' || b[i] == b'-') {
            let sign = if b[i] == b'+' { 1 } else { -1 };
            let off = num(i + 1, i + 3)? * 3600 + num(i + 4, i + 6)? * 60;
            t -= sign * off;
        }
    }
    Some(t)
}

// ---- plan ----
fn push(v: &mut Vec<ProbeTarget>, id: String, group: &'static str, kind: ProbeKind, url: String) {
    v.push(ProbeTarget { id, group, kind, url });
}

pub fn build_plan(now_unix: i64, group: &str) -> Vec<ProbeTarget> {
    let mut v: Vec<ProbeTarget> = Vec::new();
    let all = group == "all";
    if all || group == "price" {
        for (gname, g) in [("1m", 60i64), ("1h", 3600i64)] {
            // 60 one-minute candles / 24 hourly candles per request.
            let n: i64 = if g == 60 { 60 } else { 24 };
            let span = n * g;
            for (wname, off) in [("now", 0i64), ("30d", 30 * 86_400), ("60d", 60 * 86_400)] {
                let end = now_unix - off;
                let start = end - span;
                push(
                    &mut v,
                    format!("coinbase-{gname}-{wname}"),
                    "price",
                    ProbeKind::Coinbase,
                    format!(
                        "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity={g}&start={}&end={}",
                        iso_z(start),
                        iso_z(end)
                    ),
                );
                push(
                    &mut v,
                    format!("bitstamp-{gname}-{wname}"),
                    "price",
                    ProbeKind::Bitstamp,
                    format!("https://www.bitstamp.net/api/v2/ohlc/btcusd/?step={g}&limit={n}&start={start}"),
                );
                push(
                    &mut v,
                    format!("kraken-{gname}-{wname}"),
                    "price",
                    ProbeKind::Kraken,
                    format!("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval={}&since={start}", g / 60),
                );
            }
        }
        // Gemini's v2 candles endpoint takes no time parameters: one request per granularity.
        push(&mut v, "gemini-1m".into(), "price", ProbeKind::Gemini, "https://api.gemini.com/v2/candles/btcusd/1m".into());
        push(&mut v, "gemini-1h".into(), "price", ProbeKind::Gemini, "https://api.gemini.com/v2/candles/btcusd/1hr".into());
    }
    // 17c2 (D-VENUE2): Binance.US BTCUSD backup. Its own group ("backup"): kept out of "all" so the 17a plan/host-allowlist tests are unchanged.
    if group == "backup" {
        for (gname, iv, n) in [("1m", "1m", 60i64), ("1h", "1h", 24i64)] {
            push(&mut v, format!("binanceus-{gname}-now"), "backup", ProbeKind::BinanceUs, format!("https://api.binance.us/api/v3/klines?symbol=BTCUSD&interval={iv}&limit={n}"));
        }
    }
    if all || group == "sports" {
        let day = now_unix - 86_400;
        push(
            &mut v,
            "mlb-schedule".into(),
            "sports",
            ProbeKind::MlbSchedule,
            format!("https://statsapi.mlb.com/api/v1/schedule?sportId=1&date={}", ymd_dash(day)),
        );
        push(&mut v, "nhl-score".into(), "sports", ProbeKind::NhlScore, format!("https://api-web.nhle.com/v1/score/{}", ymd_dash(day)));
        for (l, path) in [("nfl", "football/nfl"), ("nba", "basketball/nba"), ("mlb", "baseball/mlb"), ("nhl", "hockey/nhl")] {
            push(
                &mut v,
                format!("espn-{l}"),
                "sports",
                ProbeKind::EspnScoreboard,
                format!("https://site.api.espn.com/apis/site/v2/sports/{path}/scoreboard?dates={}", ymd_compact(day)),
            );
        }
    }
    if all || group == "weather" {
        let year = ymd(now_unix).0;
        for s in STATIONS {
            push(
                &mut v,
                format!("nws-{s}"),
                "weather",
                ProbeKind::NwsCli,
                format!("https://api.weather.gov/products/types/CLI/locations/{}", &s[1..]),
            );
        }
        for s in STATIONS {
            push(
                &mut v,
                format!("iem-{s}"),
                "weather",
                ProbeKind::IemCli,
                format!("https://mesonet.agron.iastate.edu/json/cli.py?station={s}&year={year}"),
            );
        }
    }
    v
}

// ---- summarize ----
fn ts_range(ts: impl Iterator<Item = Option<i64>>) -> (Option<i64>, Option<i64>) {
    let t: Vec<i64> = ts.flatten().collect();
    (t.iter().copied().min(), t.iter().copied().max())
}

fn as_i64(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
}

pub fn summarize(kind: ProbeKind, resp: &RawFetchResponse) -> SourceReport {
    let mut r = SourceReport { http_status: resp.status_code, bytes: resp.body.len(), ..Default::default() };
    if !(200..300).contains(&resp.status_code) {
        r.error = Some(format!("HTTP {}", resp.status_code));
        return r;
    }
    let v: Value = match serde_json::from_slice(&resp.body) {
        Ok(v) => v,
        Err(_) => {
            r.error = Some("body is not valid JSON".into());
            return r;
        }
    };
    let arr_ts = |a: &Vec<Value>, f: &dyn Fn(&Value) -> Option<i64>| ts_range(a.iter().map(f));
    let records: Option<(usize, (Option<i64>, Option<i64>))> = match kind {
        ProbeKind::Coinbase => v.as_array().map(|a| (a.len(), arr_ts(a, &|e| e.get(0).and_then(as_i64)))),
        ProbeKind::Gemini | ProbeKind::BinanceUs => v.as_array().map(|a| (a.len(), arr_ts(a, &|e| e.get(0).and_then(as_i64).map(|m| m / 1000)))),
        ProbeKind::Bitstamp => v
            .pointer("/data/ohlc")
            .and_then(|o| o.as_array())
            .map(|a| (a.len(), arr_ts(a, &|e| e.get("timestamp").and_then(as_i64)))),
        ProbeKind::Kraken => {
            if let Some(errs) = v.get("error").and_then(|e| e.as_array()).filter(|e| !e.is_empty()) {
                r.error = Some(format!("api error: {}", errs[0].as_str().unwrap_or("?")));
                return r;
            }
            v.get("result")
                .and_then(|o| o.as_object())
                .and_then(|o| o.iter().find(|(k, _)| k.as_str() != "last"))
                .and_then(|(_, a)| a.as_array())
                .map(|a| (a.len(), arr_ts(a, &|e| e.get(0).and_then(as_i64))))
        }
        ProbeKind::MlbSchedule => v.get("dates").and_then(|d| d.as_array()).map(|d| {
            let n = d.iter().map(|x| x.get("games").and_then(|g| g.as_array()).map_or(0, |g| g.len())).sum();
            (n, (None, None))
        }),
        ProbeKind::NhlScore => v.get("games").and_then(|g| g.as_array()).map(|a| (a.len(), (None, None))),
        ProbeKind::EspnScoreboard => v.get("events").and_then(|g| g.as_array()).map(|a| (a.len(), (None, None))),
        ProbeKind::NwsCli => v
            .get("@graph")
            .and_then(|g| g.as_array())
            .map(|a| (a.len(), arr_ts(a, &|e| e.get("issuanceTime").and_then(|t| t.as_str()).and_then(parse_iso)))),
        ProbeKind::IemCli => v
            .get("results")
            .and_then(|g| g.as_array())
            .map(|a| (a.len(), arr_ts(a, &|e| e.get("valid").and_then(|t| t.as_str()).and_then(parse_iso)))),
    };
    match records {
        Some((n, (lo, hi))) => {
            r.records = Some(n);
            r.oldest_ts = lo;
            r.newest_ts = hi;
        }
        None => r.error = Some("unexpected JSON shape".into()),
    }
    r
}

fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn report_json(t: &ProbeTarget, r: &SourceReport, extra: Option<(String, u128)>) -> Value {
    let mut o = json!({
        "id": t.id,
        "kind": format!("{:?}", t.kind),
        "url": clip(&t.url, MAX_URL_CHARS),
        "http_status": r.http_status,
        "bytes": r.bytes,
        "records": r.records,
        "oldest_ts": r.oldest_ts,
        "newest_ts": r.newest_ts,
        "error": r.error.as_deref().map(|e| clip(e, MAX_ERR_CHARS)),
    });
    if let Some((final_url, ms)) = extra {
        o["elapsed_ms"] = json!(ms);
        if final_url != t.url {
            o["final_url"] = json!(clip(&final_url, MAX_URL_CHARS));
        }
    }
    o
}

/// Handles `{"mode":"probe-sources","group":"all|price|sports|weather"}`.
/// Returns `None` for any other mode (the caller falls through unchanged).
pub fn handle_job(job: &Value, fetcher: &dyn HttpFetcher, now_unix: i64) -> Option<Value> {
    if job.get("mode").and_then(|m| m.as_str()) != Some("probe-sources") {
        return None;
    }
    let group = job.get("group").and_then(|g| g.as_str()).unwrap_or("all");
    let plan = build_plan(now_unix, group);
    if plan.is_empty() {
        return Some(json!({"mode": "probe-sources", "signed": false, "near_ai_calls": 0,
            "error": format!("unknown group {:?} (all|price|sports|weather)", clip(group, 40))}));
    }
    let start = std::time::Instant::now();
    let mut sources: Vec<Value> = Vec::new();
    for t in &plan {
        let t0 = start.elapsed().as_millis();
        let entry = match fetcher.fetch(&t.url) {
            Ok(resp) => {
                let rep = summarize(t.kind, &resp);
                report_json(t, &rep, Some((resp.final_url.clone(), start.elapsed().as_millis() - t0)))
            }
            Err(e) => {
                let rep = SourceReport { error: Some(format!("fetch failed: {e}")), ..Default::default() };
                report_json(t, &rep, Some((t.url.clone(), start.elapsed().as_millis() - t0)))
            }
        };
        sources.push(entry);
    }
    let mut out = json!({
        "mode": "probe-sources",
        "signed": false,
        "near_ai_calls": 0,
        "now_unix": now_unix,
        "group": group,
        "planned": plan.len(),
        "total_elapsed_ms": start.elapsed().as_millis(),
        "truncated": false,
        "sources": sources,
    });
    while out.to_string().len() > MAX_OUTPUT_BYTES {
        let s = out["sources"].as_array_mut().unwrap();
        if s.is_empty() {
            break;
        }
        s.pop();
        out["truncated"] = json!(true);
    }
    Some(out)
}
