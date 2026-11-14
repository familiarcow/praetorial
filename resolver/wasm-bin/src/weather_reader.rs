//! 17c3 (D-TPL1): the typed `nws_daily_high` reader. The CODE decides from two copies of the climate day's maximum:
//!   NWS: hop 1 = CLI product list for the station's office, hop 2 = the FIRST product issued after the climate day; parse `MAXIMUM <n>`.
//!   IEM: `cli.py?station=<id>&year=<yyyy>`, the row for the date, field `high`.
//! Equal -> the op; different or MM -> VOID; only one copy -> RETRY (the caller applies the D-RESOLVE1 7-day window, then VOID).
//! The judge is never called (17c5 adds the AI audit of this code outcome).
use super::*;
use praetorial_core::weather::{self, Copy, WxDecision};

pub struct WxOutcome {
    pub decision: WxDecision,
    pub notes: Vec<String>,
    /// 17c5: the values the code decided from, quoted for the AI audit.
    pub extracted: Value,
}

pub fn is_typed_weather(typed: &Value) -> bool {
    matches!(praetorial_core::template::template_id(typed), Ok("nws_daily_high"))
}

fn source_url(term: &Value, id: &str) -> Option<String> {
    term["sources_allowed"].as_array()?.iter().find(|s| s["id"] == id).and_then(|s| s["url"].as_str()).map(|s| s.to_string())
}

/// Settle a typed nws_daily_high sheet. `typed` = the raw typed sheet, `term` = its rendered form.
pub fn settle(typed: &Value, term: &Value, fetcher: &dyn HttpFetcher) -> WxOutcome {
    let mut notes: Vec<String> = Vec::new();
    let f = |k: &str| typed["fields"][k].as_str().unwrap_or("").to_string();
    let (station, date, op) = (f("station"), f("date"), f("op"));
    let x_f = typed["fields"]["x_f"].as_i64().unwrap_or(0);

    // ---- NWS CLI, two hops (any failure leaves the NWS copy Absent, never a decision)
    let nws = (|| -> Copy {
        let Some(list_url) = source_url(term, "S_NWS") else { return Copy::Absent };
        let Some(day_end) = weather::climate_day_end_unix(&station, &date) else { return Copy::Absent };
        let list = match fetch_json(&list_url, fetcher) {
            Ok(v) => v,
            Err(e) => {
                notes.push(format!("source unavailable: S_NWS list ({})", e));
                return Copy::Absent;
            }
        };
        let Some(id) = weather::pick_cli_product_id(&list, day_end) else {
            notes.push(format!("S_NWS: no CLI product issued after the climate day {} ({}) yet", date, praetorial_core::format_ts(day_end)));
            return Copy::Absent;
        };
        if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            notes.push("S_NWS: product id has unexpected characters; ignored".to_string());
            return Copy::Absent;
        }
        let product_url = format!("https://api.weather.gov/products/{}", id);
        let prod = match fetch_json(&product_url, fetcher) {
            Ok(v) => v,
            Err(e) => {
                notes.push(format!("source unavailable: S_NWS product {} ({})", id, e));
                return Copy::Absent;
            }
        };
        notes.push(format!("source fetched: S_NWS (product {})", id));
        weather::parse_cli_max(prod["productText"].as_str().unwrap_or(""), &date)
    })();

    // ---- IEM copy
    let iem = (|| -> Copy {
        let Some(url) = source_url(term, "S_IEM") else { return Copy::Absent };
        match fetch_json(&url, fetcher) {
            Ok(v) => {
                notes.push("source fetched: S_IEM".to_string());
                weather::iem_high(&v, &date)
            }
            Err(e) => {
                notes.push(format!("source unavailable: S_IEM ({})", e));
                Copy::Absent
            }
        }
    })();

    notes.push(format!("copies: NWS CLI {:?}, IEM {:?}", nws, iem));
    let decision = weather::decide(&op, x_f, &nws, &iem);
    let cv = |c: &Copy| match c {
        Copy::Val(v) => json!(v),
        Copy::Mm => json!("MM"),
        Copy::Absent => Value::Null,
    };
    let extracted = json!({"kind": "nws_daily_high", "station": station, "date": date, "op": op, "x_f": x_f, "nws_max": cv(&nws), "iem_high": cv(&iem)});
    WxOutcome { decision, notes, extracted }
}
