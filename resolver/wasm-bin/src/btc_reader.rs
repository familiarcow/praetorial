//! 17c2 (D-TPL1, D-TPL1b, D-VENUE2): the typed BTC readers. For `btc_close_at_t` / `btc_touch` the CODE decides the outcome from
//! parsed candles (exact decimals); no judge verdict is consulted for the outcome (17c5 adds the AI audit of this code outcome).
use super::*;
use praetorial_core::btc::{self, BtcDecision, Candle, TouchState};

/// D-VENUE2 backup. Set to false (and the reason recorded in `BINANCE_US_DISABLED_REASON`) if the TEE probe cannot reach Binance.US.
pub const BINANCE_US_BACKUP_ENABLED: bool = true;
pub const BINANCE_US_DISABLED_REASON: &str = "";
pub const BINANCE_US_KLINES: &str = "https://api.binance.us/api/v3/klines";
/// Touch edge/size limits: pages per venue per request set (bounds TEE time).
const MAX_PAGES: i64 = 3;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Venue {
    Coinbase,
    Bitstamp,
    Kraken,
    BinanceUs,
}
impl Venue {
    fn label(self) -> &'static str {
        match self {
            Venue::Coinbase => "Coinbase",
            Venue::Bitstamp => "Bitstamp",
            Venue::Kraken => "Kraken",
            Venue::BinanceUs => "Binance.US (backup)",
        }
    }
    fn grans(self) -> &'static [i64] {
        match self {
            Venue::Coinbase => CB_GRANS,
            Venue::Bitstamp => BS_GRANS,
            Venue::Kraken => KR_GRANS,
            Venue::BinanceUs => &[60, 300, 900, 3600, 14_400, 86_400],
        }
    }
    fn page_size(self) -> i64 {
        match self {
            Venue::Coinbase => 250,
            Venue::Bitstamp => 1000,
            Venue::Kraken => 720,
            Venue::BinanceUs => 1000,
        }
    }
    fn pages(self) -> i64 {
        if self == Venue::Kraken { 1 } else { MAX_PAGES }
    }
}

fn bu_interval(g: i64) -> &'static str {
    match g {
        60 => "1m",
        300 => "5m",
        900 => "15m",
        3600 => "1h",
        14_400 => "4h",
        _ => "1d",
    }
}

/// Finest granularity of the venue's ladder whose candles (from floor(ws/g)*g to the last open < we) fit the page budget and, for Kraken,
/// whose depth (the latest 720 candles of that interval) still reaches back to the first needed open. None = the venue cannot cover it.
pub fn pick_gran(venue: Venue, ws: i64, we: i64, now: i64) -> Option<i64> {
    venue.grans().iter().copied().find(|&g| {
        let (first, end) = (ws.div_euclid(g) * g, (we + g - 1).div_euclid(g) * g);
        let rows = (end - first) / g;
        rows >= 1 && rows <= venue.page_size() * venue.pages() && (venue != Venue::Kraken || (now - first) / g < 700)
    })
}

fn urls_for(venue: Venue, base: &str, g: i64, first: i64, last: i64) -> Vec<String> {
    match venue {
        Venue::Coinbase => price_window_urls(base, PriceVenue::Coinbase, g, first, last),
        Venue::Bitstamp => price_window_urls(base, PriceVenue::Bitstamp, g, first, last),
        Venue::Kraken => price_window_urls(base, PriceVenue::Kraken, g, first, last),
        Venue::BinanceUs => price_pages(PriceVenue::Bitstamp, g, first, last)
            .into_iter()
            .map(|(s, e)| format!("{}?symbol=BTCUSD&interval={}&startTime={}&endTime={}&limit={}", BINANCE_US_KLINES, bu_interval(g), s * 1000, (e - 1) * 1000, (e - s) / g))
            .collect(),
    }
}

/// Fetch every candle open from `first` to `last` (inclusive, spacing g) from one venue; Err = unreachable (fetch/parse failure).
pub fn fetch_candles(venue: Venue, base: &str, g: i64, first: i64, last: i64, fetcher: &dyn HttpFetcher) -> Result<Vec<Candle>, String> {
    let urls = urls_for(venue, base, g, first, last);
    if urls.is_empty() || urls.len() as i64 > venue.pages() {
        return Err(format!("{} request would need {} pages (max {})", venue.label(), urls.len(), venue.pages()));
    }
    let mut out = Vec::new();
    for u in &urls {
        let body = fetch_json(u, fetcher).map_err(|e| format!("page failed ({}): {}", u, e))?;
        let cs = match venue {
            Venue::Coinbase => btc::parse_coinbase(&body),
            Venue::Bitstamp => btc::parse_bitstamp(&body),
            Venue::Kraken => btc::parse_kraken(&body),
            Venue::BinanceUs => btc::parse_binance_us(&body),
        };
        out.extend(cs);
    }
    out.sort_by_key(|c| c.open_ts);
    out.dedup_by_key(|c| c.open_ts);
    Ok(out)
}

/// The primary venues' base URLs from the rendered sheet (`sources_allowed` S_CB / S_BS / S_KR).
fn primary_bases(term: &Value) -> Vec<(Venue, String)> {
    let mut v = Vec::new();
    for s in term["sources_allowed"].as_array().into_iter().flatten() {
        let (Some(id), Some(url)) = (s["id"].as_str(), s["url"].as_str()) else { continue };
        match id {
            "S_CB" => v.push((Venue::Coinbase, url.to_string())),
            "S_BS" => v.push((Venue::Bitstamp, url.to_string())),
            "S_KR" => v.push((Venue::Kraken, url.to_string())),
            _ => {}
        }
    }
    v
}

pub struct BtcOutcome {
    pub decision: BtcDecision,
    pub notes: Vec<String>,
    /// 17c5: the values the code decided from, quoted for the AI audit.
    pub extracted: Value,
    /// D-EARLYREQ1: set when the request precedes the sheet's decidable time; the caller emits NO signed outcome.
    pub early: Option<String>,
}

/// Is `id` a typed template whose outcome the code decides?
pub fn is_typed_btc(typed: &Value) -> bool {
    matches!(praetorial_core::template::template_id(typed), Ok("btc_close_at_t") | Ok("btc_touch"))
}

/// Settle a typed BTC sheet. `typed` = the raw typed sheet, `term` = its rendered form, `now` = the settle request clock (unix s).
pub fn settle(typed: &Value, term: &Value, fetcher: &dyn HttpFetcher, now: i64) -> BtcOutcome {
    let mut notes: Vec<String> = Vec::new();
    let id = praetorial_core::template::template_id(typed).unwrap_or("");
    let f = |k: &str| typed["fields"][k].as_str().unwrap_or("").to_string();
    let bases = primary_bases(term);
    let mut early: Option<String> = None;
    let (decision, backup_note, extracted) = if id == "btc_close_at_t" {
        let t = iso_to_unix(&f("t_utc")).unwrap_or(0);
        let problems = praetorial_core::template::request_window_problems(t, now);
        if !problems.is_empty() {
            notes.push(format!("settle request refused (17c1 window check): {}", problems.join("; ")));
            let early = praetorial_core::template::request_too_early_problems(&problems);
            let early = if early.is_empty() { None } else { Some(early.join("; ")) };
            return BtcOutcome { decision: BtcDecision::Void(problems.join("; ")), notes, extracted: Value::Null, early };
        }
        let x = typed["fields"]["x_usd"].as_i64().unwrap_or(0);
        let mut closes: Vec<(String, btc::Dec)> = Vec::new();
        let mut primary_missing = false;
        let mut try_venue = |venue: Venue, base: &str, closes: &mut Vec<(String, btc::Dec)>, notes: &mut Vec<String>| -> bool {
            match fetch_candles(venue, base, 60, t - 60, t - 60, fetcher) {
                Ok(cs) => match cs.iter().find(|c| c.open_ts == t - 60) {
                    Some(c) => {
                        notes.push(format!("1a: {} close of the minute ending T = {}", venue.label(), c.close));
                        closes.push((venue.label().to_string(), c.close));
                        true
                    }
                    None => {
                        notes.push(format!("1a: {} did not return the candle opening {} (unreachable)", venue.label(), t - 60));
                        false
                    }
                },
                Err(e) => {
                    notes.push(format!("1a: {} unreachable: {}", venue.label(), e));
                    false
                }
            }
        };
        for (v, b) in &bases {
            if !try_venue(*v, b, &mut closes, &mut notes) {
                primary_missing = true;
            }
        }
        let mut bn = None;
        if primary_missing {
            bn = Some(backup(&mut |n: &mut Vec<String>| try_venue(Venue::BinanceUs, BINANCE_US_KLINES, &mut closes, n), &mut notes));
        }
        let mut vals: Vec<i128> = closes.iter().map(|c| c.1 .0).collect();
        vals.sort();
        let agg: Option<btc::Dec> = if vals.is_empty() { None } else if vals.len() % 2 == 1 { Some(btc::Dec(vals[vals.len() / 2])) } else { Some(btc::Dec((vals[vals.len() / 2 - 1] + vals[vals.len() / 2]) / 2)) };
        let extracted = json!({"kind": "btc_close_at_t", "t_utc": f("t_utc"), "op": f("op"), "x_usd": x,
            "closes": closes.iter().map(|(v, c)| json!({"venue": v, "close": c.to_string()})).collect::<Vec<_>>(),
            "aggregate_close": agg.and_then(|a| a.to_string().parse::<f64>().ok())});
        (btc::close_at_t(&f("op"), x, &closes), bn, extracted)
    } else {
        let above = f("direction") == "at_or_above";
        let x = typed["fields"]["x_usd"].as_i64().unwrap_or(0);
        let (ws, we) = (iso_to_unix(&f("open_utc")).unwrap_or(0), iso_to_unix(&f("deadline_utc")).unwrap_or(0));
        // early YES: a window still open is evaluated up to the last whole minute; only a YES is final then
        let open_window = now < we;
        let we_eff = if open_window { now.div_euclid(60) * 60 } else { we };
        let mut states: Vec<(String, TouchState)> = Vec::new();
        let mut one = |venue: Venue, base: &str, states: &mut Vec<(String, TouchState)>, notes: &mut Vec<String>| -> bool {
            let st = match pick_gran(venue, ws, we_eff, now) {
                None => TouchState::Unreachable("no granularity of this venue's ladder covers the window within its page budget/depth".into()),
                Some(g) => {
                    let (first, last) = (ws.div_euclid(g) * g, (we_eff + g - 1).div_euclid(g) * g - g);
                    match fetch_candles(venue, base, g, first, last, fetcher) {
                        Ok(cs) => {
                            let s = btc::venue_touch(&cs, g, ws, we_eff, above, x);
                            notes.push(format!("1b: {} granularity {}s, {} candles -> {:?}", venue.label(), g, cs.len(), s));
                            s
                        }
                        Err(e) => TouchState::Unreachable(e),
                    }
                }
            };
            let ok = !matches!(st, TouchState::Unreachable(_));
            if let TouchState::Unreachable(r) = &st {
                notes.push(format!("1b: {} unreachable (counted as unreachable, not VOID): {}", venue.label(), r));
            }
            states.push((venue.label().to_string(), st));
            ok
        };
        let mut primary_missing = false;
        for (v, b) in &bases {
            if !one(*v, b, &mut states, &mut notes) {
                primary_missing = true;
            }
        }
        let mut bn = None;
        if primary_missing {
            bn = Some(backup(&mut |n: &mut Vec<String>| one(Venue::BinanceUs, BINANCE_US_KLINES, &mut states, n), &mut notes));
        }
        let mut d = btc::touch(&states);
        if open_window && !matches!(d, BtcDecision::Yes(_)) {
            early = Some(format!("WINDOW_NOT_OVER: the deadline {} is after the settle request and no early YES was found", f("deadline_utc")));
            d = BtcDecision::Void(format!("WINDOW_NOT_OVER: the deadline {} is after the settle request and no early YES (>= 2 venues crossed) was found; {}", f("deadline_utc"), d.why()));
        }
        let extracted = json!({"kind": "btc_touch", "direction": f("direction"), "x_usd": x, "open_utc": f("open_utc"), "deadline_utc": f("deadline_utc"),
            "venues": states.iter().map(|(v, s)| json!({"venue": v, "state": match s { TouchState::Crossed => "Crossed", TouchState::Clear => "Clear", TouchState::Unreachable(_) => "Unreachable" }})).collect::<Vec<_>>()});
        (d, bn, extracted)
    };
    if let Some(b) = backup_note {
        notes.push(b);
    }
    notes.push(format!("decision: {} ({})", decision.word(), decision.why()));
    BtcOutcome { decision, notes, extracted, early }
}

/// Run the Binance.US backup only when enabled (D-VENUE2); returns the note describing what happened.
fn backup(run: &mut dyn FnMut(&mut Vec<String>) -> bool, notes: &mut Vec<String>) -> String {
    if !BINANCE_US_BACKUP_ENABLED {
        return format!("backup venue Binance.US disabled: {}", BINANCE_US_DISABLED_REASON);
    }
    let ok = run(notes);
    format!("backup venue Binance.US used because a primary venue was unreachable: {}", if ok { "reachable" } else { "also unreachable" })
}
