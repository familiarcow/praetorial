//! 17c1 (D-TPL1): term-sheet schema v1. `template = {id, version}` is part of the hashed term sheet.
//! Typed templates carry typed fields only; one fixed renderer per template produces the claim/rule text the judge
//! sees and the resolver builds the source URLs (the bettor supplies none). `custom` (or no `template`) is today's
//! free-form sheet, unchanged. Pure: no I/O, no clock reads (callers pass `now`).
//!
//! Error names are stable prefixes (`TPL_*` schema, `OPEN_*` open-time, `REQ_*` settle-request, `CUSTOM_*` custom lint)
//! followed by `: detail`.
use super::{civil_from_days, days_from_civil, format_ts, IMPERATIVE};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};

pub const TEMPLATE_IDS: [&str; 5] = ["btc_close_at_t", "btc_touch", "game_winner", "nws_daily_high", "custom"];
pub const TEMPLATE_VERSION_V1: i64 = 1;
pub const LEAGUES: [&str; 4] = ["MLB", "NHL", "NFL", "NBA"];
/// Seconds an open may be after/before the sheet's declared `open_utc` (the attestation window is checked by the escrow).
pub const OPEN_UTC_SKEW_SECS: i64 = 300;
/// D-HORIZON1a: max bet length 1,461 days (4 years) after open (matches the escrow MAX_HORIZON_NS).
pub const MAX_HORIZON_SECS: i64 = 1461 * 86400;
pub const EVIDENCE_TAIL_SECS: i64 = 7 * 86400; // D-RESOLVE1 7-day recovery window

/// The 20 stations probed in 17a (TESTING.md Source Catalog); every one has an NWS CLI product (200 for all 20).
/// (station id, standard-time UTC offset in hours). Climate days are local STANDARD time all year.
pub const NWS_STATIONS: [(&str, i64); 20] = [
    ("KNYC", -5), ("KLAX", -8), ("KORD", -6), ("KMIA", -5), ("KDFW", -6), ("KDEN", -7), ("KPHX", -7), ("KSEA", -8), ("KATL", -5), ("KBOS", -5),
    ("KIAH", -6), ("KMSP", -6), ("KDCA", -5), ("KPHL", -5), ("KSFO", -8), ("KLAS", -8), ("KAUS", -6), ("KDTW", -5), ("KMDW", -6), ("KSAN", -8),
];

static ISO_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$").unwrap());
static DATE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap());
static EVENT_ID_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[0-9]{5,12}$").unwrap());
static TEAM_ID_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[0-9A-Za-z]{1,12}$").unwrap());

/// Strict UTC `YYYY-MM-DDTHH:MM:SSZ` -> unix seconds (None for any non-calendar value).
pub fn parse_iso(s: &str) -> Option<i64> {
    if !ISO_RE.is_match(s) {
        return None;
    }
    let n = |a: usize, b: usize| -> i64 { s[a..b].parse().unwrap() };
    let (h, mi, se) = (n(11, 13), n(14, 16), n(17, 19));
    if h > 23 || mi > 59 || se > 59 {
        return None;
    }
    let d = parse_date(&s[0..10])?;
    Some(d * 86400 + h * 3600 + mi * 60 + se)
}
/// Strict `YYYY-MM-DD` -> days since epoch.
pub fn parse_date(s: &str) -> Option<i64> {
    if !DATE_RE.is_match(s) {
        return None;
    }
    let (y, m, d): (i64, i64, i64) = (s[0..4].parse().ok()?, s[5..7].parse().ok()?, s[8..10].parse().ok()?);
    let days = days_from_civil(y, m, d);
    (civil_from_days(days) == (y, m, d)).then_some(days)
}

/// `Ok(id)` for a known template (a missing `template` is `custom`), `Err(named problems)` otherwise.
pub fn template_id(ts: &Value) -> Result<&'static str, Vec<String>> {
    let Some(t) = ts.get("template") else { return Ok("custom") };
    let Some(o) = t.as_object() else {
        return Err(vec!["TPL_MALFORMED: `template` must be an object {id, version}".to_string()]);
    };
    let mut p = Vec::new();
    let id = o.get("id").and_then(|v| v.as_str());
    let known = id.and_then(|i| TEMPLATE_IDS.iter().find(|k| **k == i).copied());
    if known.is_none() {
        p.push(format!("TPL_UNKNOWN_ID: template.id {} is not one of {:?}", o.get("id").map(|v| v.to_string()).unwrap_or_else(|| "(missing)".into()), TEMPLATE_IDS));
    }
    // version must be the JSON integer 1 (a string "1", 1.0, null, 2 are all refused)
    if o.get("version").and_then(|v| v.as_i64()) != Some(TEMPLATE_VERSION_V1) || !o.get("version").map(|v| v.is_i64() || v.is_u64()).unwrap_or(false) {
        p.push(format!("TPL_UNKNOWN_VERSION: template.version {} is not 1", o.get("version").map(|v| v.to_string()).unwrap_or_else(|| "(missing)".into())));
    }
    if o.keys().any(|k| k != "id" && k != "version") {
        p.push("TPL_MALFORMED: `template` carries only {id, version}".to_string());
    }
    if p.is_empty() { Ok(known.unwrap()) } else { Err(p) }
}

/// True for a typed (non-custom) template id.
pub fn is_typed(ts: &Value) -> bool {
    matches!(template_id(ts), Ok(id) if id != "custom") || matches!(template_id(ts), Err(_) if ts.get("template").is_some())
}

/// D-SPORTS1: the single-source exception keys on `template.id == game_winner && league in {NFL, NBA}`, never on a
/// declared field of a custom sheet.
pub fn single_source_allowed(ts: &Value) -> bool {
    template_id(ts) == Ok("game_winner") && matches!(ts.pointer("/fields/league").and_then(|v| v.as_str()), Some("NFL") | Some("NBA"))
}

fn whole_pos(v: Option<&Value>) -> Option<i64> {
    v.and_then(|v| if v.is_i64() || v.is_u64() { v.as_i64() } else { None }).filter(|n| *n > 0 && *n < 10_000_000)
}

/// Schema validation of a typed sheet (empty for custom / no template). Named errors per bad field.
pub fn lint_template(ts: &Value) -> Vec<String> {
    let id = match template_id(ts) {
        Ok("custom") => return Vec::new(),
        Ok(id) => id,
        Err(p) => return p,
    };
    let mut p = Vec::new();
    if let Some(o) = ts.as_object() {
        for k in o.keys() {
            if k != "template" && k != "fields" && k != "referee" {
                p.push(format!("TPL_FIELD_NOT_ALLOWED: `{}` is not allowed on a typed template (the resolver renders claim/rule text and builds the source URLs from the typed fields)", k));
            }
        }
    }
    let Some(f) = ts.get("fields").and_then(|v| v.as_object()) else {
        p.push("TPL_MISSING_FIELD: `fields` object is required for a typed template".to_string());
        return p;
    };
    let allowed: &[&str] = match id {
        "btc_close_at_t" => &["t_utc", "op", "x_usd", "open_utc"],
        "btc_touch" => &["direction", "x_usd", "deadline_utc", "open_utc"],
        "game_winner" => &["league", "event_id", "scheduled_date", "pick"],
        _ => &["station", "date", "op", "x_f"],
    };
    for k in f.keys() {
        if !allowed.contains(&k.as_str()) {
            p.push(format!("TPL_UNKNOWN_FIELD: `{}` is not a field of {} v1", k, id));
        }
    }
    let get = |k: &str| f.get(k).filter(|v| !v.is_null());
    let need = |k: &str, p: &mut Vec<String>| -> bool {
        if get(k).is_none() {
            p.push(format!("TPL_MISSING_FIELD: {}.{} is required", id, k));
            false
        } else {
            true
        }
    };
    let minute = |k: &str, code: &str, p: &mut Vec<String>| {
        if need(k, p) {
            let s = get(k).and_then(|v| v.as_str()).unwrap_or("");
            match parse_iso(s) {
                Some(t) if t % 60 == 0 => {}
                _ => p.push(format!("{}: {}.{} must be an explicit UTC minute boundary YYYY-MM-DDTHH:MM:00Z, got {}", code, id, k, get(k).unwrap())),
            }
        }
    };
    let x_usd = |p: &mut Vec<String>| {
        if need("x_usd", p) && whole_pos(get("x_usd")).is_none() {
            p.push(format!("TPL_X_USD_NOT_WHOLE: {}.x_usd must be a positive whole number of dollars (JSON integer), got {}", id, get("x_usd").unwrap()));
        }
    };
    let open = |p: &mut Vec<String>| {
        if need("open_utc", p) {
            match get("open_utc").and_then(|v| v.as_str()).and_then(parse_iso) {
                Some(t) if t % 60 == 0 => {}
                _ => p.push(format!("TPL_OPEN_UTC_FORMAT: {}.open_utc must be a UTC minute boundary, got {}", id, get("open_utc").unwrap())),
            }
        }
    };
    let op = |ops: &[&str], p: &mut Vec<String>| {
        if need("op", p) && !ops.iter().any(|o| Some(*o) == get("op").and_then(|v| v.as_str())) {
            p.push(format!("TPL_BAD_OP: {}.op must be one of {:?}, got {}", id, ops, get("op").unwrap()));
        }
    };
    match id {
        "btc_close_at_t" => {
            minute("t_utc", "TPL_T_UTC_NOT_MINUTE", &mut p);
            op(&[">", ">=", "<", "<="], &mut p);
            x_usd(&mut p);
            open(&mut p);
        }
        "btc_touch" => {
            if need("direction", &mut p) && !matches!(get("direction").and_then(|v| v.as_str()), Some("at_or_above") | Some("at_or_below")) {
                p.push(format!("TPL_BAD_DIRECTION: btc_touch.direction must be at_or_above or at_or_below, got {}", get("direction").unwrap()));
            }
            x_usd(&mut p);
            if need("deadline_utc", &mut p) && get("deadline_utc").and_then(|v| v.as_str()).and_then(parse_iso).is_none() {
                p.push(format!("TPL_DEADLINE_FORMAT: btc_touch.deadline_utc must be UTC YYYY-MM-DDTHH:MM:SSZ, got {}", get("deadline_utc").unwrap()));
            }
            open(&mut p);
        }
        "game_winner" => {
            if need("league", &mut p) && !LEAGUES.iter().any(|l| Some(*l) == get("league").and_then(|v| v.as_str())) {
                p.push(format!("TPL_BAD_LEAGUE: game_winner.league must be one of {:?}, got {}", LEAGUES, get("league").unwrap()));
            }
            if need("event_id", &mut p) && !get("event_id").and_then(|v| v.as_str()).map(|s| EVENT_ID_RE.is_match(s)).unwrap_or(false) {
                p.push(format!("TPL_EVENT_ID_FORMAT: game_winner.event_id must be the league source's numeric event id (5-12 digits) as a string, got {}", get("event_id").unwrap()));
            }
            if need("scheduled_date", &mut p) && get("scheduled_date").and_then(|v| v.as_str()).and_then(parse_date).is_none() {
                p.push(format!("TPL_BAD_DATE: game_winner.scheduled_date must be a real calendar date YYYY-MM-DD, got {}", get("scheduled_date").unwrap()));
            }
            if need("pick", &mut p) {
                match get("pick").and_then(|v| v.as_object()) {
                    None => p.push("TPL_BAD_PICK: game_winner.pick must be {team_id, name}".to_string()),
                    Some(pk) => {
                        for k in pk.keys() {
                            if k != "team_id" && k != "name" {
                                p.push(format!("TPL_BAD_PICK: pick.{} is not allowed", k));
                            }
                        }
                        match pk.get("team_id").and_then(|v| v.as_str()) {
                            Some(t) if TEAM_ID_RE.is_match(t) => {}
                            _ => p.push("TPL_PICK_NO_TEAM_ID: pick.team_id (the league's team id, 1-12 alphanumerics) is required; a name alone is ambiguous".to_string()),
                        }
                        match pk.get("name").and_then(|v| v.as_str()) {
                            None => p.push("TPL_PICK_NO_NAME: pick.name (display name) is required".to_string()),
                            Some(n) => {
                                let ok = !n.is_empty()
                                    && n.chars().count() <= 60
                                    && n.chars().all(|c| c.is_alphanumeric() || c == ' ' || c == '.' || c == '\'' || c == '&' || c == '-')
                                    && !IMPERATIVE.is_match(n);
                                if !ok {
                                    p.push("TPL_BAD_PICK: pick.name must be a plain display name (letters, digits, space . ' & -; max 60 chars)".to_string());
                                }
                            }
                        }
                    }
                }
            }
        }
        _ => {
            if need("station", &mut p) && !NWS_STATIONS.iter().any(|(s, _)| Some(*s) == get("station").and_then(|v| v.as_str())) {
                p.push(format!("TPL_STATION_NOT_CURATED: nws_daily_high.station {} is not one of the {} curated stations", get("station").unwrap(), NWS_STATIONS.len()));
            }
            if need("date", &mut p) && get("date").and_then(|v| v.as_str()).and_then(parse_date).is_none() {
                p.push(format!("TPL_BAD_DATE: nws_daily_high.date must be a real calendar date YYYY-MM-DD (local standard-time climate day), got {}", get("date").unwrap()));
            }
            op(&[">=", "<="], &mut p);
            if need("x_f", &mut p) {
                let ok = get("x_f").map(|v| v.is_i64() || v.is_u64()).unwrap_or(false) && get("x_f").and_then(|v| v.as_i64()).map(|n| (-100..=150).contains(&n)).unwrap_or(false);
                if !ok {
                    p.push(format!("TPL_X_F_NOT_WHOLE: nws_daily_high.x_f must be whole degrees F (JSON integer, -100..150), got {}", get("x_f").unwrap()));
                }
            }
        }
    }
    p
}

fn s<'a>(ts: &'a Value, ptr: &str) -> &'a str {
    ts.pointer(ptr).and_then(|v| v.as_str()).unwrap_or("")
}
fn op_words(op: &str) -> &'static str {
    match op {
        ">" => "above (>)",
        ">=" => "at least (>=)",
        "<" => "below (<)",
        _ => "at most (<=)",
    }
}
fn ymd_compact(d: &str) -> String {
    d.replace('-', "")
}
fn venue_sources(ws: i64, we: i64) -> Value {
    let n = ((we - ws) / 60).clamp(1, 1000);
    json!([
        {"id": "S_CB", "publisher": "Coinbase BTC-USD", "url": format!("https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start={}&end={}", format_ts(ws), format_ts(we - 1))},
        {"id": "S_BS", "publisher": "Bitstamp btcusd", "url": format!("https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&limit={}&start={}&end={}", n, ws, we - 1)},
        {"id": "S_KR", "publisher": "Kraken XBT/USD", "url": format!("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1&since={}", ws - 1)},
    ])
}
/// D-SRCCHK2 (L1b4, option A): the 1-minute candle window `[ws, we)` the OPEN-time sourcecheck probes for a close-at-T
/// sheet. A source-reachability probe must ask for a candle that exists: when T is still in the future the T-1min
/// candle does not (Coinbase answers 400 "Start cannot be in the future"), so the probe is clamped to the last fully
/// CLOSED 1-minute candle before `now`. If T is already closed (`t <= floor(now to the minute)`) the probe is T
/// unchanged. Resolution never uses this: it keeps `[T-60, T)`.
pub fn close_at_t_probe_window(t: i64, now: i64) -> (i64, i64) {
    let closed_edge = now.div_euclid(60) * 60;
    if t <= closed_edge {
        (t - 60, t)
    } else {
        (closed_edge - 60, closed_edge)
    }
}
/// D-SRCCHK2 (L1b4) + D-SRCCHK3: for a typed `btc_close_at_t` or `btc_touch` sheet, the three venue sources the
/// OPEN-time sourcecheck fetches (same builder as resolution, clamped window). close-at-T: `close_at_t_probe_window`.
/// btc_touch: the last fully closed minute `[closed_edge-60, closed_edge)` whatever the bet window (the full window is
/// up to 1,461 days of 1-minute candles; Coinbase answers 400 above 300). `None` for every other template / custom
/// sheet / invalid sheet, which keep probing their own `sources_allowed` unchanged. Resolution never uses this.
pub fn sourcecheck_probe_sources(ts: &Value, now: i64) -> Option<Value> {
    let id = template_id(ts);
    if (id != Ok("btc_close_at_t") && id != Ok("btc_touch")) || !lint_template(ts).is_empty() {
        return None;
    }
    let (ws, we) = if id == Ok("btc_touch") {
        let closed_edge = now.div_euclid(60) * 60;
        (closed_edge - 60, closed_edge)
    } else {
        close_at_t_probe_window(parse_iso(s(ts, "/fields/t_utc"))?, now)
    };
    Some(venue_sources(ws, we))
}
const CLAUSES_V1: [&str; 5] = ["UTC_V1", "BEFORE_INCLUSIVE_V1", "NUMERIC_EXACT_V1", "ROUNDING_PRECISION_V1", "NO_DATA_FALLBACK_V1"];

/// URL of the league source page used by the open-time check (MLB/NHL: the league API; NFL/NBA: ESPN).
pub fn league_event_url(ts: &Value) -> Option<String> {
    if template_id(ts) != Ok("game_winner") {
        return None;
    }
    let d = s(ts, "/fields/scheduled_date");
    let c = ymd_compact(d);
    Some(match s(ts, "/fields/league") {
        "MLB" => format!("https://statsapi.mlb.com/api/v1/schedule?sportId=1&date={}", d),
        "NHL" => format!("https://api-web.nhle.com/v1/score/{}", d),
        "NFL" => format!("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates={}", c),
        "NBA" => format!("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates={}", c),
        _ => return None,
    })
}

/// The fixed renderer: a validated typed sheet -> a legacy-shaped term sheet (claim, elements, rule, clauses, time,
/// sources_allowed, ...) that the existing pipeline reads. `custom` / no template is returned unchanged.
pub fn materialize(ts: &Value) -> Result<Value, Vec<String>> {
    let id = template_id(ts).map_err(|e| e)?;
    if id == "custom" {
        return Ok(ts.clone());
    }
    let p = lint_template(ts);
    if !p.is_empty() {
        return Err(p);
    }
    let f = |k: &str| s(ts, &format!("/fields/{}", k)).to_string();
    let (claim, q, ws, we, sources, mut defs, pins): (String, String, i64, i64, Value, Vec<String>, Value);
    let fallback = "Fallback: if one named source is unavailable the remaining sources must confirm; if too few can be checked the outcome is VOID with full refunds after the recovery window.".to_string();
    match id {
        "btc_close_at_t" => {
            let t = parse_iso(&f("t_utc")).unwrap();
            let opw = op_words(&f("op"));
            claim = format!("The median of the CLOSE of the 1-minute BTC-USD candle ending {} on Coinbase, Bitstamp and Kraken is {} {} USD.", f("t_utc"), opw, ts["fields"]["x_usd"]);
            q = format!("Is the median close of the 1-minute BTC-USD candle ending {} on Coinbase, Bitstamp and Kraken {} {} USD?", f("t_utc"), opw, ts["fields"]["x_usd"]);
            ws = t - 60;
            we = t;
            sources = venue_sources(ws, we);
            defs = vec![
                "The CLOSE of the 1-minute candle is what is checked, never the high (wick). With three venues the median close decides; with two the mean, and VOID if they straddle the level; fewer than two is VOID.".into(),
                "Early resolution: never before the candle has closed; the settle request is T + 5 minutes.".into(),
                "Only the BTC-USD pair on the three named venues is eligible; no aggregators or other assets.".into(),
            ];
            pins = json!({"Coinbase BTC-USD": "BTC-USD", "Bitstamp btcusd": "btcusd", "Kraken XBT/USD": "XBT/USD"});
        }
        "btc_touch" => {
            let (o, d) = (parse_iso(&f("open_utc")).unwrap(), parse_iso(&f("deadline_utc")).unwrap());
            let above = f("direction") == "at_or_above";
            let (side, cmp, ext) = if above { ("at or above", ">=", "HIGH") } else { ("at or below", "<=", "LOW") };
            claim = format!("BTC-USD 1-minute candle {} is {} {} USD on at least two of Coinbase, Bitstamp, Kraken between {} and {}.", if above { "high" } else { "low" }, side, ts["fields"]["x_usd"], f("open_utc"), f("deadline_utc"));
            q = format!("Is a 1-minute BTC-USD candle {} {} {} on at least two of Coinbase, Bitstamp and Kraken between {} and {}?", if above { "high" } else { "low" }, cmp, ts["fields"]["x_usd"], f("open_utc"), f("deadline_utc"));
            ws = o;
            we = d;
            sources = venue_sources(ws, we);
            defs = vec![
                format!("A 1-minute candle {} (the wick), not the close, crossing the stated USD level counts as a touch; the touch requires confirmation on at least two of the three named venues.", ext),
                "Early YES resolution is allowed at the first qualifying confirmed candle, never before; if no touch occurred in the window the outcome is NO.".into(),
                "Only the BTC-USD pair on the three named venues is eligible; no aggregators or other assets.".into(),
            ];
            pins = json!({"Coinbase BTC-USD": "BTC-USD", "Bitstamp btcusd": "btcusd", "Kraken XBT/USD": "XBT/USD"});
        }
        "game_winner" => {
            let league = f("league");
            let single = single_source_allowed(ts);
            let name = s(ts, "/fields/pick/name").to_string();
            let tid = s(ts, "/fields/pick/team_id").to_string();
            let date = f("scheduled_date");
            let d0 = parse_date(&date).unwrap() * 86400;
            claim = format!("{} (team id {}) win {} game {} scheduled on {}, by the final score including overtime.{}", name, tid, league, f("event_id"), date, if single { " This is a single source bet: ESPN is the only source." } else { "" });
            q = format!("Did {} (team id {}) win {} game {} scheduled on {} according to the final score, overtime included?", name, tid, league, f("event_id"), date);
            ws = d0;
            we = d0 + 36 * 3600;
            let espn = |sport: &str, lg: &str| json!({"id": "S_ESPN", "publisher": if single { "ESPN (single source)" } else { "ESPN" }, "url": format!("https://site.api.espn.com/apis/site/v2/sports/{}/{}/scoreboard?dates={}", sport, lg, ymd_compact(&date))});
            sources = match league.as_str() {
                "MLB" => json!([{"id": "S_LEAGUE", "publisher": "MLB Stats API", "url": league_event_url(ts).unwrap()}, espn("baseball", "mlb")]),
                "NHL" => json!([{"id": "S_LEAGUE", "publisher": "NHL api-web", "url": league_event_url(ts).unwrap()}, espn("hockey", "nhl")]),
                "NFL" => json!([espn("football", "nfl")]),
                _ => json!([espn("basketball", "nba")]),
            };
            defs = vec![
                "Only a final result counts, overtime, shootout and extra innings included; a tie, postponement or cancellation is not a win for either side.".into(),
                "Early resolution: only once the source shows the game as final; never before.".into(),
            ];
            pins = Value::Null;
        }
        _ => {
            let st = f("station");
            let off = NWS_STATIONS.iter().find(|(x, _)| *x == st).map(|(_, o)| *o).unwrap_or(0);
            let date = f("date");
            let d0 = parse_date(&date).unwrap() * 86400;
            claim = format!("The NWS Daily Climate Report (CLI) maximum temperature for {} on {} (the local standard time climate day) is {} {} degrees F.", st, date, op_words(&f("op")), ts["fields"]["x_f"]);
            q = format!("Is the NWS CLI maximum temperature for {} on {} (local standard time climate day) {} {} degrees F?", st, date, op_words(&f("op")), ts["fields"]["x_f"]);
            ws = d0 - off * 3600;
            we = ws + 86400;
            let y = &date[0..4];
            sources = json!([
                {"id": "S_NWS", "publisher": "NWS CLI (api.weather.gov)", "url": format!("https://api.weather.gov/products/types/CLI/locations/{}", &st[1..])},
                {"id": "S_IEM", "publisher": "IEM CLI (mesonet.agron.iastate.edu)", "url": format!("https://mesonet.agron.iastate.edu/json/cli.py?station={}&year={}", st, y)},
            ]);
            defs = vec![
                "Early resolution: only once the CLI report for the climate day is published; never before. Both the NWS CLI and the IEM copy must give the same maximum; a missing (MM) or differing maximum is VOID.".into(),
                "The climate day is local standard time all year (no daylight saving adjustment), not the UTC day.".into(),
            ];
            pins = Value::Null;
        }
    }
    defs.insert(0, fallback);
    let mut classes = Map::new();
    for sc in sources.as_array().unwrap() {
        classes.insert(sc["publisher"].as_str().unwrap().to_string(), json!("primary"));
    }
    let cutoff = we + EVIDENCE_TAIL_SECS;
    let mut m = json!({
        "template": ts["template"].clone(), "fields": ts["fields"].clone(),
        "claim": claim, "elements": [{"id": "e1", "q": q}], "rule": "ALL", "clauses": CLAUSES_V1,
        "time": {"window_start": format_ts(ws), "window_end": format_ts(we), "evidence_cutoff": format_ts(cutoff)},
        "sources_allowed": sources, "source_classes": Value::Object(classes), "custom_definitions": defs,
        "window_close": format_ts(cutoff), "sources": true,
    });
    if !pins.is_null() {
        m["ticker_pins"] = pins;
    }
    if let Some(r) = ts.get("referee") {
        m["referee"] = r.clone();
    }
    Ok(m)
}

/// Standard-time local date (days since epoch) of unix `now` at a station.
fn lst_day(now: i64, station: &str) -> i64 {
    let off = NWS_STATIONS.iter().find(|(x, _)| *x == station).map(|(_, o)| *o).unwrap_or(0);
    (now + off * 3600).div_euclid(86400)
}

/// Open-time checks that need only the clock (lint + preflight; the bet is refused before it opens). `now` = the open
/// clock (the sourcecheck attestation time). Sheets that fail the schema return the schema problems.
pub fn open_problems(ts: &Value, now: i64) -> Vec<String> {
    let id = match template_id(ts) {
        Ok("custom") => return Vec::new(),
        Ok(id) => id,
        Err(p) => return p,
    };
    let sp = lint_template(ts);
    if !sp.is_empty() {
        return sp;
    }
    let mut p = Vec::new();
    let f = |k: &str| s(ts, &format!("/fields/{}", k)).to_string();
    let btc_open = |p: &mut Vec<String>| {
        let o = parse_iso(&f("open_utc")).unwrap();
        if (o - now).abs() > OPEN_UTC_SKEW_SECS {
            p.push(format!("OPEN_UTC_SKEW: open_utc {} is more than {}s from the open clock {}", f("open_utc"), OPEN_UTC_SKEW_SECS, format_ts(now)));
        }
    };
    match id {
        "btc_close_at_t" => {
            btc_open(&mut p);
            let t = parse_iso(&f("t_utc")).unwrap();
            if t < now + 3600 {
                p.push(format!("OPEN_T_TOO_SOON: t_utc {} must be at least 1h after open ({})", f("t_utc"), format_ts(now)));
            }
        }
        "btc_touch" => {
            btc_open(&mut p);
            let d = parse_iso(&f("deadline_utc")).unwrap();
            if d <= now {
                p.push(format!("OPEN_DEADLINE_NOT_AFTER_OPEN: deadline_utc {} is not after open ({})", f("deadline_utc"), format_ts(now)));
            } else if d > now + MAX_HORIZON_SECS {
                p.push(format!("OPEN_DEADLINE_TOO_FAR: deadline_utc {} is more than 4 years (1,461 days) after open ({})", f("deadline_utc"), format_ts(now)));
            }
        }
        "nws_daily_high" => {
            if parse_date(&f("date")).unwrap() < lst_day(now, &f("station")) {
                p.push(format!("OPEN_WEATHER_DATE_PAST: date {} is already past in {} local standard time", f("date"), f("station")));
            }
        }
        _ => {}
    }
    p
}

/// 1a settle request window: the request is at T + 5 min or later, and T is within 6h of the request (Kraken 1m depth).
pub fn settle_not_before(t_unix: i64) -> i64 {
    t_unix + 300
}
pub fn request_window_problems(t_unix: i64, request_unix: i64) -> Vec<String> {
    let mut p = Vec::new();
    if request_unix < settle_not_before(t_unix) {
        p.push("REQ_BEFORE_T_PLUS_5MIN: the settle request must come at T + 5 minutes or later".to_string());
    }
    if request_unix - t_unix > 6 * 3600 {
        p.push("REQ_T_OLDER_THAN_6H: T is more than 6h before the settle request (Kraken 1m depth)".to_string());
    }
    p
}

/// D-EARLYREQ1: the `REQ_*` problems that mean the request is TOO EARLY (before the sheet's earliest decidable time).
/// Such a request gets NO signed outcome (retryable) rather than a VOID. Every `REQ_BEFORE_*` code belongs here.
pub fn request_too_early_problems(problems: &[String]) -> Vec<String> {
    problems.iter().filter(|p| p.starts_with("REQ_BEFORE_")).cloned().collect()
}

/// Sports open check on the league source payload fetched for `scheduled_date`: the event id must be on it
/// (existence + date match), per league payload shape. `OPEN_EVENT_DATE_MISMATCH` when the payload itself is for another date.
pub fn sports_event_problems(ts: &Value, body: &Value) -> Vec<String> {
    if template_id(ts) != Ok("game_winner") || !lint_template(ts).is_empty() {
        return Vec::new();
    }
    let (league, eid, date) = (s(ts, "/fields/league"), s(ts, "/fields/event_id"), s(ts, "/fields/scheduled_date"));
    let id_is = |v: Option<&Value>| match v {
        Some(Value::String(x)) => x == eid,
        Some(Value::Number(n)) => n.to_string() == eid,
        _ => false,
    };
    // (payload date as YYYY-MM-DD if the payload states one, events present, event found)
    let (payload_date, readable, found): (Option<String>, bool, bool) = match league {
        "MLB" => {
            let dates = body.get("dates").and_then(|v| v.as_array());
            let pd = dates.and_then(|d| d.first()).and_then(|d| d.get("date")).and_then(|v| v.as_str()).map(|x| x.to_string());
            let found = dates.map(|ds| ds.iter().any(|d| d.get("games").and_then(|g| g.as_array()).map(|g| g.iter().any(|x| id_is(x.get("gamePk")))).unwrap_or(false))).unwrap_or(false);
            (pd, dates.is_some(), found)
        }
        "NHL" => {
            let games = body.get("games").and_then(|v| v.as_array());
            let pd = body.get("currentDate").and_then(|v| v.as_str()).map(|x| x.to_string());
            (pd, games.is_some(), games.map(|g| g.iter().any(|x| id_is(x.get("id")))).unwrap_or(false))
        }
        _ => {
            let ev = body.get("events").and_then(|v| v.as_array());
            // ESPN scoreboards carry no payload date: the found event's own start time must fall on scheduled_date
            // (UTC date, or the previous US evening: start - 12h), else it is another day's game.
            let hit = ev.and_then(|e| e.iter().find(|x| id_is(x.get("id"))));
            let want = parse_date(date);
            let on_date = |x: &Value| -> bool {
                let t = x.get("date").and_then(|v| v.as_str()).map(|d| if d.len() == 17 { format!("{}:00Z", &d[..16]) } else { d.to_string() }).and_then(|d| parse_iso(&d));
                match (t, want) {
                    (Some(t), Some(w)) => t.div_euclid(86400) == w || (t - 12 * 3600).div_euclid(86400) == w,
                    _ => false,
                }
            };
            let pd = hit.filter(|x| !on_date(x)).and_then(|x| x.get("date").and_then(|v| v.as_str())).map(|x| x.chars().take(10).collect::<String>());
            (pd, ev.is_some(), hit.is_some())
        }
    };
    if !readable {
        return vec![format!("OPEN_EVENT_UNREADABLE: the {} league source payload has no schedule to check event {} against", league, eid)];
    }
    if let Some(pd) = payload_date {
        if pd != date {
            return vec![format!("OPEN_EVENT_DATE_MISMATCH: the league payload is for {} but scheduled_date is {}", pd, date)];
        }
    }
    if !found {
        return vec![format!("OPEN_EVENT_NOT_ON_DATE: {} event {} is not on the league schedule for {}", league, eid, date)];
    }
    Vec::new()
}

// ---------------------------------------------------------------- custom path: the one mechanical relative-date lint (D-TPL1a)
static REL_DATE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|yesterday|tonight|next game|(next|this|last)\s+(week|weekend|month|season|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b").unwrap()
});
pub(crate) static ANCHOR_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(concat!(
        r"(?i)\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}/\d{1,2}/\d{2,4}\b|",
        r"\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\.?\s+\d{1,2}\b|",
        r"\b\d{1,2}(st|nd|rd|th)?\s+(of\s+)?(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b"
    ))
    .unwrap()
});
/// D-TPL1a: a custom claim (or element question) with a relative date/weekday and NO explicit calendar date anywhere in
/// the claim + element questions is refused at open: "Friday" / "tomorrow" / "next week" / "this season" need an anchor.
pub fn relative_date_problems(ts: &Value) -> Vec<String> {
    let mut segs: Vec<&str> = vec![ts.get("claim").and_then(|v| v.as_str()).unwrap_or("")];
    if let Some(es) = ts.get("elements").and_then(|v| v.as_array()) {
        segs.extend(es.iter().map(|e| e.get("q").and_then(|v| v.as_str()).unwrap_or("")));
    }
    // each of the claim and every element question must carry its own explicit date: a date elsewhere does not anchor it
    for t in segs {
        if let Some(m) = REL_DATE_RE.find(t) {
            if !ANCHOR_RE.is_match(t) {
                return vec![format!("CUSTOM_RELATIVE_DATE: the claim uses the relative date {:?} with no explicit calendar date (e.g. 2026-11-06); state the date", m.as_str())];
            }
        }
    }
    Vec::new()
}

// ---------------------------------------------------------------- D-L1MESSY2 (L1b8): custom price-level claims must define touch vs close
static PRICE_LEVEL_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(break|breaks|hit|hits|cross|crosses|reach|reaches|flip|flips|above|below|over|under|top|tops)\b").unwrap());
static PRICE_READING_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(touch|touches|touched|high|highs|low|lows|wick|intraday|close|closes|closed|closing|settle|settles|settled|settlement)\b").unwrap()
});
const PRICE_HOSTS: &[&str] = &["coinbase.com", "bitstamp.net", "kraken.com", "binance.com", "binance.us", "bitfinex.com", "gemini.com", "okx.com", "bybit.com", "coingecko.com", "coinmarketcap.com", "cryptocompare.com"];
/// A custom sheet is a price-level claim when its STRUCTURED fields say so (ticker_pins, or an allowed source on a price venue API), never from the claim text alone.
fn is_price_sheet(ts: &Value) -> bool {
    if ts.get("ticker_pins").and_then(|v| v.as_object()).map(|o| !o.is_empty()).unwrap_or(false) {
        return true;
    }
    ts.get("sources_allowed").and_then(|v| v.as_array()).map(|a| {
        a.iter().any(|x| {
            let u = x.get("url").and_then(|v| v.as_str()).unwrap_or("").to_ascii_lowercase();
            let host = u.split("//").nth(1).unwrap_or("").split('/').next().unwrap_or("");
            PRICE_HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{}", h)))
        })
    }).unwrap_or(false)
}
/// D-L1MESSY2: a custom (non-typed) price-level sheet whose claim uses break/hit/cross/reach/flip/above/below/over/under/top
/// but whose custom_definitions / terms never say touch (candle high/low) vs close is refused at open. Typed templates define
/// the reading themselves and are never flagged.
pub fn price_reading_problems(ts: &Value) -> Vec<String> {
    if template_id(ts) != Ok("custom") || !is_price_sheet(ts) {
        return Vec::new();
    }
    let mut segs: Vec<&str> = vec![ts.get("claim").and_then(|v| v.as_str()).unwrap_or("")];
    if let Some(es) = ts.get("elements").and_then(|v| v.as_array()) {
        segs.extend(es.iter().map(|e| e.get("q").and_then(|v| v.as_str()).unwrap_or("")));
    }
    let Some(verb) = segs.iter().find_map(|t| PRICE_LEVEL_RE.find(t)) else { return Vec::new() };
    let mut defs: Vec<&str> = ts.get("custom_definitions").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default();
    if let Some(t) = ts.get("terms").and_then(|v| v.as_str()) {
        defs.push(t);
    }
    if defs.iter().any(|d| PRICE_READING_RE.is_match(d)) {
        return Vec::new();
    }
    vec![format!(
        "PRICE_READING_UNDEFINED: the claim is a price-level claim ({:?}) but the sheet does not say whether a touch or a close counts; add ONE custom_definition: (a) \"touch: any 1-minute candle high/low at or beyond the level on <venues>\" or (b) \"close: a 1-minute candle close at or beyond the level\"",
        verb.as_str()
    )]
}

/// Every open-time problem for a sheet: typed -> `open_problems`; custom -> + the relative-date lint + the price-reading check.
pub fn open_problems_all(ts: &Value, now: i64) -> Vec<String> {
    let mut p = open_problems(ts, now);
    if template_id(ts) == Ok("custom") {
        p.extend(relative_date_problems(ts));
        p.extend(price_reading_problems(ts));
        // LNT1b (D-LNT1): the AMBIGUOUS_* wording rules (lint_hints, one implementation) also refuse at open.
        p.extend(crate::lint_hints::ambiguity_problems(ts));
    }
    p
}
