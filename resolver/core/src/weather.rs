//! 17c3 (D-TPL1): pure NWS daily-high rules. The CODE decides from two copies of the day's maximum (NWS CLI text and the IEM
//! cli.py row); it never decides on one copy alone. Climate day = local STANDARD time all year (no daylight saving).
use crate::template::{parse_date, parse_iso, NWS_STATIONS};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

/// One copy of the daily maximum. `Mm` = the source says the maximum is missing; `Absent` = not (yet) available / unreadable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Copy {
    Val(i64),
    Mm,
    Absent,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WxDecision {
    Yes(String),
    No(String),
    Void(String),
    Retry(String),
}
impl WxDecision {
    pub fn word(&self) -> &'static str {
        match self {
            WxDecision::Yes(_) => "YES",
            WxDecision::No(_) => "NO",
            WxDecision::Void(_) => "VOID",
            WxDecision::Retry(_) => "RETRY",
        }
    }
    pub fn why(&self) -> &str {
        match self {
            WxDecision::Yes(w) | WxDecision::No(w) | WxDecision::Void(w) | WxDecision::Retry(w) => w,
        }
    }
}

static SUMMARY_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)SUMMARY FOR\s+([A-Z]+)\s+(\d{1,2})\s+(\d{4})").unwrap());
static MAX_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"MAXIMUM\s+(MM|-?\d+)(?:\s?R)?\b").unwrap());
const MONTHS: [&str; 12] = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];

/// NWS `issuanceTime` (`2026-11-06T06:45:00+00:00` or `...Z`) -> unix seconds.
pub fn parse_issuance(s: &str) -> Option<i64> {
    let head = s.get(0..19)?;
    let base = parse_iso(&format!("{}Z", head))?;
    let tz = s.get(19..)?;
    if tz == "Z" || tz.is_empty() {
        return Some(base);
    }
    let sign = match tz.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let (h, m) = (tz.get(1..3)?.parse::<i64>().ok()?, tz.get(4..6)?.parse::<i64>().ok()?);
    Some(base - sign * (h * 3600 + m * 60))
}

/// Unix second at which the station's climate day `date` (local standard time) ends.
pub fn climate_day_end_unix(station: &str, date: &str) -> Option<i64> {
    let off = NWS_STATIONS.iter().find(|(s, _)| *s == station)?.1;
    Some(parse_date(date)? * 86400 - off * 3600 + 86400)
}

/// Hop 1 -> hop 2: the id of the FIRST CLI product issued at or after the end of the climate day.
pub fn pick_cli_product_id(list: &Value, day_end: i64) -> Option<String> {
    list.get("@graph")?
        .as_array()?
        .iter()
        .filter_map(|p| Some((parse_issuance(p.get("issuanceTime")?.as_str()?)?, p.get("id")?.as_str()?.to_string())))
        .filter(|(t, _)| *t >= day_end)
        .min_by_key(|(t, _)| *t)
        .map(|(_, id)| id)
}

/// `MAXIMUM <n>` of the CLI text for the pinned `date` (YYYY-MM-DD). `MM` -> Mm. A report whose summary is for another day
/// (or one that cannot be read) is Absent: it is not this day's copy.
pub fn parse_cli_max(text: &str, date: &str) -> Copy {
    if parse_date(date).is_none() {
        return Copy::Absent;
    }
    let (y, m, d): (u32, usize, u32) = match (date[0..4].parse(), date[5..7].parse::<usize>(), date[8..10].parse()) {
        (Ok(y), Ok(m), Ok(d)) if (1..=12).contains(&m) => (y, m, d),
        _ => return Copy::Absent,
    };
    let Some(c) = SUMMARY_RE.captures(text) else { return Copy::Absent };
    let same = c[1].eq_ignore_ascii_case(MONTHS[m - 1]) && c[2].parse::<u32>().ok() == Some(d) && c[3].parse::<u32>().ok() == Some(y);
    if !same {
        return Copy::Absent;
    }
    let Some(t) = text.find("TEMPERATURE (F)") else { return Copy::Absent };
    match MAX_RE.captures(&text[t..]) {
        Some(c) if &c[1] == "MM" => Copy::Mm,
        Some(c) => c[1].parse().map(Copy::Val).unwrap_or(Copy::Absent),
        None => Copy::Absent,
    }
}

/// IEM `cli.py` body: the row for `date`, field `high`. A row with a non-integer high (`M`, null) is Mm; no row is Absent.
pub fn iem_high(body: &Value, date: &str) -> Copy {
    let Some(rows) = body.get("results").and_then(|r| r.as_array()) else { return Copy::Absent };
    let Some(row) = rows.iter().find(|r| r.get("valid").and_then(|v| v.as_str()) == Some(date)) else { return Copy::Absent };
    match row.get("high") {
        Some(Value::Number(n)) => match n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)) {
            Some(v) => Copy::Val(v),
            None => Copy::Mm,
        },
        _ => Copy::Mm,
    }
}

/// The decision, in code. MM in either copy -> VOID. Both present and equal -> the op (>= or <=, whole F; ties by the op).
/// Different -> VOID. Only one (or neither) present -> RETRY (the caller applies the D-RESOLVE1 7-day window, then VOID).
pub fn decide(op: &str, x_f: i64, nws: &Copy, iem: &Copy) -> WxDecision {
    if *nws == Copy::Mm || *iem == Copy::Mm {
        return WxDecision::Void(format!("max missing (MM) in the {}", if *nws == Copy::Mm { "NWS CLI" } else { "IEM copy" }));
    }
    match (nws, iem) {
        (Copy::Val(a), Copy::Val(b)) if a != b => WxDecision::Void(format!("copies disagree: NWS CLI maximum {} vs IEM high {}", a, b)),
        (Copy::Val(a), Copy::Val(_)) => {
            let hit = match op {
                ">=" => *a >= x_f,
                "<=" => *a <= x_f,
                _ => return WxDecision::Void(format!("unsupported op {}", op)),
            };
            let why = format!("NWS CLI maximum and IEM high agree: {} F; {} {} {}", a, a, op, x_f);
            if hit { WxDecision::Yes(why) } else { WxDecision::No(why) }
        }
        _ => WxDecision::Retry(format!(
            "need both copies; NWS CLI {}, IEM {}",
            if matches!(nws, Copy::Val(_)) { "present" } else { "absent" },
            if matches!(iem, Copy::Val(_)) { "present" } else { "absent" }
        )),
    }
}
