//! 17c2 (D-TPL1, D-TPL1b, D-VENUE2): BTC readers. The CODE decides the outcome from parsed candles; the judge audits (17c5).
//! Prices are exact decimals (`Dec`, i128 scaled by 1e10), never f64. Pure functions: no I/O, no clock.
use serde_json::Value;

const SCALE: i128 = 10_000_000_000; // 1e10
const FRAC_DIGITS: usize = 10;

/// Exact decimal price: `units / 1e10`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Dec(pub i128);

impl Dec {
    pub fn from_usd(whole: i64) -> Dec {
        Dec(whole as i128 * SCALE)
    }
    /// "75923.34" -> Dec. Rejects exponents, signs other than a leading '-', empty text and more than 10 fractional digits.
    pub fn parse(s: &str) -> Option<Dec> {
        let s = s.trim();
        let (neg, body) = match s.strip_prefix('-') {
            Some(r) => (true, r),
            None => (false, s),
        };
        let (int, frac) = match body.split_once('.') {
            Some((i, f)) => (i, f),
            None => (body, ""),
        };
        if int.is_empty() || !int.bytes().all(|b| b.is_ascii_digit()) || !frac.bytes().all(|b| b.is_ascii_digit()) || frac.len() > FRAC_DIGITS {
            return None;
        }
        let i: i128 = int.parse().ok()?;
        let mut f: i128 = if frac.is_empty() { 0 } else { frac.parse().ok()? };
        for _ in frac.len()..FRAC_DIGITS {
            f *= 10;
        }
        let v = i.checked_mul(SCALE)?.checked_add(f)?;
        Some(Dec(if neg { -v } else { v }))
    }
    /// JSON string -> parse. JSON number -> its shortest round-trip decimal text (Rust never prints an exponent for f64 Display).
    pub fn from_json(v: &Value) -> Option<Dec> {
        match v {
            Value::String(s) => Dec::parse(s),
            Value::Number(n) => Dec::parse(&n.to_string()),
            _ => None,
        }
    }
}
impl std::fmt::Display for Dec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let a = self.0.abs();
        let (i, fr) = (a / SCALE, a % SCALE);
        let sign = if self.0 < 0 { "-" } else { "" };
        if fr == 0 {
            write!(f, "{}{}", sign, i)
        } else {
            let t = format!("{:010}", fr);
            write!(f, "{}{}.{}", sign, i, t.trim_end_matches('0'))
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Candle {
    pub open_ts: i64,
    pub high: Dec,
    pub low: Dec,
    pub close: Dec,
}

fn arr_ts(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).or_else(|| v.as_f64().map(|f| f as i64))
}

/// Coinbase Exchange: `[[time, low, high, open, close, volume], ...]`.
pub fn parse_coinbase(body: &Value) -> Vec<Candle> {
    body.as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|r| {
                    let r = r.as_array()?;
                    Some(Candle { open_ts: arr_ts(r.first()?)?, low: Dec::from_json(r.get(1)?)?, high: Dec::from_json(r.get(2)?)?, close: Dec::from_json(r.get(4)?)? })
                })
                .collect()
        })
        .unwrap_or_default()
}
/// Bitstamp: `{"data":{"ohlc":[{"timestamp","open","high","low","close","volume"}]}}` (all strings).
pub fn parse_bitstamp(body: &Value) -> Vec<Candle> {
    body["data"]["ohlc"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|r| Some(Candle { open_ts: arr_ts(&r["timestamp"])?, high: Dec::from_json(&r["high"])?, low: Dec::from_json(&r["low"])?, close: Dec::from_json(&r["close"])? }))
                .collect()
        })
        .unwrap_or_default()
}
/// Kraken: `{"error":[],"result":{"XXBTZUSD":[[time, open, high, low, close, vwap, volume, count], ...],"last":N}}`. A non-empty `error` -> no candles.
pub fn parse_kraken(body: &Value) -> Vec<Candle> {
    if body["error"].as_array().is_some_and(|e| !e.is_empty()) {
        return Vec::new();
    }
    let Some(res) = body["result"].as_object() else { return Vec::new() };
    for (k, v) in res {
        if k == "last" {
            continue;
        }
        if let Some(rows) = v.as_array() {
            return rows
                .iter()
                .filter_map(|r| {
                    let r = r.as_array()?;
                    Some(Candle { open_ts: arr_ts(r.first()?)?, high: Dec::from_json(r.get(2)?)?, low: Dec::from_json(r.get(3)?)?, close: Dec::from_json(r.get(4)?)? })
                })
                .collect();
        }
    }
    Vec::new()
}
/// Binance.US klines (BACKUP venue, D-VENUE2; BTCUSD): `[[openTime_ms, open, high, low, close, volume, closeTime_ms, ...], ...]`.
/// `open_ts` is returned in unix SECONDS.
pub fn parse_binance_us(body: &Value) -> Vec<Candle> {
    body.as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|r| {
                    let r = r.as_array()?;
                    Some(Candle { open_ts: r.first()?.as_i64()? / 1000, high: Dec::from_json(r.get(2)?)?, low: Dec::from_json(r.get(3)?)?, close: Dec::from_json(r.get(4)?)? })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BtcDecision {
    Yes(String),
    No(String),
    Void(String),
}
impl BtcDecision {
    pub fn word(&self) -> &'static str {
        match self {
            BtcDecision::Yes(_) => "YES",
            BtcDecision::No(_) => "NO",
            BtcDecision::Void(_) => "VOID",
        }
    }
    pub fn why(&self) -> &str {
        match self {
            BtcDecision::Yes(w) | BtcDecision::No(w) | BtcDecision::Void(w) => w,
        }
    }
}

pub const VOID_FEWER_THAN_2: &str = "fewer than 2 venues";
pub const VOID_VENUES_DISAGREE: &str = "venues disagree on touch";
pub const VOID_STRADDLE: &str = "venues straddle X";

/// Rule 1a: aggregate (median; mean of exactly 2) of the venues' CLOSE for the minute ending at T, compared with `op` and X
/// exactly. Ties are decided by the op, never VOID. Exactly 2 venues that straddle X (one strictly below, one strictly above) -> VOID.
/// `closes` = (venue label, close) of the venues that RETURNED the candle.
pub fn close_at_t(op: &str, x_usd: i64, closes: &[(String, Dec)]) -> BtcDecision {
    if closes.len() < 2 {
        return BtcDecision::Void(format!("{}: only {} returned the candle ending at T", VOID_FEWER_THAN_2, closes.len()));
    }
    let x = Dec::from_usd(x_usd);
    let mut v: Vec<i128> = closes.iter().map(|c| c.1 .0).collect();
    v.sort();
    // twice the aggregate keeps the mean of two exact
    let agg2: i128 = if v.len() % 2 == 1 { 2 * v[v.len() / 2] } else { v[v.len() / 2 - 1] + v[v.len() / 2] };
    if v.len() == 2 && v[0] < x.0 && x.0 < v[1] {
        return BtcDecision::Void(format!("{}: closes {} and {} lie on both sides of {}", VOID_STRADDLE, Dec(v[0]), Dec(v[1]), x));
    }
    let x2 = 2 * x.0;
    let hit = match op {
        ">" => agg2 > x2,
        ">=" => agg2 >= x2,
        "<" => agg2 < x2,
        "<=" => agg2 <= x2,
        o => return BtcDecision::Void(format!("unknown op {}", o)),
    };
    let how = if v.len() == 2 { "mean" } else { "median" };
    let why = format!("code-decided 1a: {} close of {} venues = {} {} {} {}", how, v.len(), Dec(agg2 / 2).to_string() + if agg2 % 2 != 0 { "5" } else { "" }, op, x, if hit { "true" } else { "false" });
    if hit {
        BtcDecision::Yes(why)
    } else {
        BtcDecision::No(why)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TouchState {
    /// An in-window candle's extreme crossed X.
    Crossed,
    /// Complete coverage of the window and no crossing.
    Clear,
    /// Out of depth, missing candles, fetch failure, or an ambiguous edge candle: counts as unreachable (never forces VOID by itself).
    Unreachable(String),
}

/// Rule 1b, one venue: from candles of granularity `g` over the window `[ws, we)`. Crossing is only counted from candles wholly inside
/// the window (exact: an hourly high is the max of its minute highs). A candle that crosses but overlaps a window edge is ambiguous ->
/// the venue is unreachable. Clear needs every candle open from floor(ws/g)*g up to the last open < we, with no missing candle.
pub fn venue_touch(candles: &[Candle], g: i64, ws: i64, we: i64, above: bool, x_usd: i64) -> TouchState {
    let x = Dec::from_usd(x_usd);
    let crosses = |c: &Candle| if above { c.high >= x } else { c.low <= x };
    let inside = |c: &Candle| c.open_ts >= ws && c.open_ts + g <= we;
    let overlaps = |c: &Candle| c.open_ts < we && c.open_ts + g > ws;
    if candles.iter().any(|c| inside(c) && crosses(c)) {
        return TouchState::Crossed;
    }
    if candles.iter().any(|c| overlaps(c) && !inside(c) && crosses(c)) {
        return TouchState::Unreachable("an edge candle overlapping the window start/end crosses X, so the in-window part is ambiguous".into());
    }
    let first = ws.div_euclid(g) * g;
    let mut have: Vec<i64> = candles.iter().filter(|c| overlaps(c)).map(|c| c.open_ts).collect();
    have.sort();
    have.dedup();
    let mut t = first;
    let mut i = 0;
    while t < we {
        while i < have.len() && have[i] < t {
            i += 1;
        }
        if i >= have.len() || have[i] != t {
            return TouchState::Unreachable(format!("no candle at {} (granularity {}s): coverage incomplete or beyond the venue's depth", t, g));
        }
        t += g;
    }
    TouchState::Clear
}

/// Rule 1b across venues (D-TPL1, D-TPL1b). YES needs >= 2 crossed; otherwise VOID if fewer than 2 venues are reachable;
/// exactly one crossed with the other reachable venues clear = VOID "venues disagree on touch"; none crossed (>= 2 clear) = NO.
pub fn touch(venues: &[(String, TouchState)]) -> BtcDecision {
    let crossed = venues.iter().filter(|v| v.1 == TouchState::Crossed).count();
    let clear = venues.iter().filter(|v| v.1 == TouchState::Clear).count();
    let reach = crossed + clear;
    let unreach: Vec<String> = venues.iter().filter_map(|(n, s)| if let TouchState::Unreachable(r) = s { Some(format!("{} unreachable ({})", n, r)) } else { None }).collect();
    let tail = if unreach.is_empty() { String::new() } else { format!("; {}", unreach.join("; ")) };
    if crossed >= 2 {
        return BtcDecision::Yes(format!("code-decided 1b: {} of {} venues crossed X (need 2){}", crossed, venues.len(), tail));
    }
    if reach < 2 {
        return BtcDecision::Void(format!("{}: only {} of {} venues reachable{}", VOID_FEWER_THAN_2, reach, venues.len(), tail));
    }
    if crossed == 1 {
        return BtcDecision::Void(format!("{}: exactly 1 venue crossed X and {} reachable venue(s) complete without a crossing{}", VOID_VENUES_DISAGREE, clear, tail));
    }
    BtcDecision::No(format!("code-decided 1b: {} reachable venues have complete coverage and none crossed X{}", clear, tail))
}
