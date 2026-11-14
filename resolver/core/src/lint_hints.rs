//! LNT1: (1) the AMBIGUOUS_* custom-sheet rules, ported from apps/web/lib/builderGate.ts (same rule codes, same regexes;
//! shared case table fixtures/lint_parity/cases.json), and (2) a "what to change" hint on EVERY lint problem.
//! Hints are appended as `; to fix: <what to change>`; problems that already name the fix (AMBIGUOUS_*, CUSTOM_RELATIVE_DATE,
//! PRICE_READING_UNDEFINED) are left alone. Mirrored by judge-proto/judge.py `_hint` and apps/web/lib/lintHints.ts.
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

use crate::template::ANCHOR_RE;

const HINT_MARK: &str = "; to fix: ";

fn rx(s: &str) -> Regex {
    Regex::new(s).unwrap()
}

static AMOUNT: Lazy<Regex> = Lazy::new(|| rx(r"(?i)\b\d[\d,.]*\s?k\b"));
static ISO_TS: Lazy<Regex> = Lazy::new(|| rx(r"\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"));
static REL_NOW: Lazy<Regex> = Lazy::new(|| rx(r"(?i)\b(today|now|currently|this (morning|afternoon|evening)|later)\b"));
static MULTI_SLASH: Lazy<Regex> = Lazy::new(|| rx(r"\b[A-Z]{2,5}\s?/\s?([A-Z]{2,5})\b"));
static MULTI_AND: Lazy<Regex> = Lazy::new(|| rx(r"\b[A-Z]{3,5}\s+and\s+[A-Z]{3,5}\b"));
static PERCENT: Lazy<Regex> = Lazy::new(|| rx(r"(?i)%|\bpercent\b|\bmoves?\b"));
static TIME_NO_TZ: Lazy<Regex> = Lazy::new(|| rx(r"(?i)\b\d{1,2}(:\d{2})?\s?(am|pm)\b"));
static TZ_OK: Lazy<Regex> = Lazy::new(|| rx(r"(?i)\b(utc|gmt)\b|T\d{2}:\d{2}(:\d{2})?Z"));
static WEATHER: Lazy<Regex> = Lazy::new(|| rx(r"(?i)\b(hotter|colder|warmer|cooler|temperature|degrees|rain|snow)\b|\x{00b0}"));
static STATION: Lazy<Regex> = Lazy::new(|| rx(r"\bK[A-Z]{3}\b"));
static PARTY: Lazy<Regex> = Lazy::new(|| rx(r"(?i)(^|[.;]\s*)(i|we)\b|\b(my|our)\s+(own\s+)?(post|tweet|account|page)\b"));
static SUBJECTIVE: Lazy<Regex> = Lazy::new(|| rx(r"(?i)^\s*(who|which|why|how)\b|\b(best|greatest|worst|better|worse|favou?rite)\b"));

fn q(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}

fn multi_asset(t: &str) -> Option<String> {
    for c in MULTI_SLASH.captures_iter(t) {
        if !["USD", "USDT", "USDC", "EUR"].contains(&&c[1]) {
            return Some(c[0].to_string());
        }
    }
    MULTI_AND.find(t).map(|m| m.as_str().to_string())
}

/// Ambiguity problems for a CUSTOM sheet's claim + narrow questions (one problem per rule, in the web gate's order).
pub fn ambiguity_problems(ts: &Value) -> Vec<String> {
    let mut segs: Vec<&str> = vec![ts.get("claim").and_then(|v| v.as_str()).unwrap_or("")];
    if let Some(es) = ts.get("elements").and_then(|v| v.as_array()) {
        segs.extend(es.iter().map(|e| e.get("q").and_then(|v| v.as_str()).unwrap_or("")));
    }
    let segs: Vec<&str> = segs.into_iter().filter(|s| !s.trim().is_empty()).collect();
    // (code, finder returning the matched text, message builder)
    type Finder = fn(&str) -> Option<String>;
    let rules: Vec<(Finder, fn(&str) -> String)> = vec![
        (|t| AMOUNT.find(t).map(|m| m.as_str().to_string()),
         |m| format!("AMBIGUOUS_AMOUNT: {} is shorthand, not a stated level; write the level as a whole-dollar number (e.g. 100000)", q(m))),
        (|t| if ANCHOR_RE.is_match(t) || ISO_TS.is_match(t) { None } else { REL_NOW.find(t).map(|m| m.as_str().to_string()) },
         |m| format!("AMBIGUOUS_RELATIVE_DATE: {} depends on when it is read; state the calendar date (e.g. 2026-11-09) and a UTC time", q(m))),
        (multi_asset,
         |m| format!("AMBIGUOUS_MULTI_ASSET: {} names more than one asset; use one claim per asset and name the asset, level and venue for each", q(m))),
        (|t| PERCENT.find(t).map(|m| m.as_str().to_string()),
         |m| format!("AMBIGUOUS_PERCENT_MOVE: {} is a percentage move with no fixed reference; replace it with a stated price level and a UTC time", q(m))),
        (|t| if TZ_OK.is_match(t) { None } else { TIME_NO_TZ.find(t).map(|m| m.as_str().to_string()) },
         |m| format!("AMBIGUOUS_NO_TIMEZONE: the time {} has no timezone; add UTC (e.g. 17:00 UTC)", q(m))),
        (|t| if STATION.is_match(t) { None } else { WEATHER.find(t).map(|m| m.as_str().to_string()) },
         |m| format!("AMBIGUOUS_NO_STATION: {} is a weather claim with no NWS station; name the station (e.g. KNYC) and the reading (daily high)", q(m))),
        (|t| PARTY.find(t).map(|m| m.as_str().trim().to_string()),
         |m| format!("AMBIGUOUS_PARTY_CONTROLLED: {} is something a bettor controls; change it to an outcome neither side controls, or mark the source party-controlled and add two independent sources", q(m))),
        (|t| SUBJECTIVE.find(t).map(|m| m.as_str().trim().to_string()),
         |m| format!("AMBIGUOUS_SUBJECTIVE: {} is an opinion, not a checkable event; state a measurable outcome, who/what is measured, and the date", q(m))),
    ];
    let mut out = Vec::new();
    for (find, text) in rules {
        for t in &segs {
            if let Some(m) = find(t) {
                out.push(text(&m));
                break;
            }
        }
    }
    out
}

static STARTS: &[(&str, &str)] = &[
    ("models:", "remove the models field from the sheet"),
    ("missing field:", "add the missing field to the sheet"),
    ("custom definition contains an instruction", "remove the instruction and state only a definition"),
    ("unknown clause", "replace it with a known clause id"),
    ("source name", "use a short plain publisher name"),
    ("time.", "write it as a UTC timestamp, e.g. 2026-12-01T00:00:00Z"),
    ("need >= 2 independent", "add a second independent source that is not party-controlled"),
    ("rule must be", "change rule to ALL or ANY"),
    ("no fallback-source", "add a custom_definition saying which fallback source to use"),
    ("no early-settlement", "add a custom_definition saying whether YES fires early or only at the deadline"),
    ("no wick-vs-close", "add a custom_definition saying whether the HIGH (wick) or the CLOSE counts"),
    ("fork/ticker not pinned", "add a ticker_pins entry for every named source"),
    ("market_pin required", "add market_pin with condition_id and description_sha256"),
    ("repo_pin required", "add repo_pin with the numeric repo_id"),
    ("coverage rule required", "add a coverage rule custom_definition saying what proves the whole window was covered"),
    ("unresolved_at_cutoff", "change it to 'VOID' or remove it"),
    ("TPL_MALFORMED", "write template as an object {id, version}"),
    ("TPL_UNKNOWN_ID", "use one of the listed template ids"),
    ("TPL_UNKNOWN_VERSION", "use version 1"),
    ("TPL_FIELD_NOT_ALLOWED", "remove that field; the resolver builds it from the typed fields"),
    ("TPL_UNKNOWN_FIELD", "remove that field"),
    ("TPL_MISSING_FIELD", "add the missing field"),
    ("TPL_X_USD_NOT_WHOLE", "write a whole-dollar number"),
    ("TPL_X_F_NOT_WHOLE", "write whole degrees F"),
    ("TPL_OPEN_UTC_FORMAT", "write it as a UTC timestamp in the stated format"),
    ("TPL_DEADLINE_FORMAT", "write it as a UTC timestamp in the stated format"),
    ("TPL_T_UTC_NOT_MINUTE", "write it as a UTC timestamp in the stated format"),
    ("TPL_BAD_OP", "use one of the listed values"),
    ("TPL_BAD_DIRECTION", "use one of the listed values"),
    ("TPL_BAD_LEAGUE", "use one of the listed values"),
    ("TPL_EVENT_ID_FORMAT", "use the numeric event id from the league source"),
    ("TPL_BAD_DATE", "write a real calendar date YYYY-MM-DD"),
    ("TPL_BAD_PICK", "pick one of the two teams in the game"),
    ("TPL_PICK_NO_TEAM_ID", "pick one of the two teams in the game"),
    ("TPL_PICK_NO_NAME", "pick one of the two teams in the game"),
    ("TPL_STATION_NOT_CURATED", "use one of the curated station ids"),
];
static ELEMENT_INSTR: Lazy<Regex> = Lazy::new(|| rx(r"^element \d+ addresses the judge"));
static ELEMENT_LONG: Lazy<Regex> = Lazy::new(|| rx(r"^element \d+ too long"));
static ELEMENT_VAGUE: Lazy<Regex> = Lazy::new(|| rx(r"^element \d+ names a vague"));
static SOURCE_VAGUE: Lazy<Regex> = Lazy::new(|| rx(r"^source .* is a vague/undefined venue"));

/// Append the "what to change" hint to a lint problem (idempotent; unknown prefixes get a generic hint, never none).
pub fn add_hint(p: String) -> String {
    if p.contains(HINT_MARK)
        || p.starts_with("AMBIGUOUS_")
        || p.starts_with("CUSTOM_RELATIVE_DATE")
        || p.starts_with("PRICE_READING_UNDEFINED")
    {
        return p;
    }
    let hint = if ELEMENT_INSTR.is_match(&p) {
        "remove the instruction and write a plain factual question"
    } else if ELEMENT_LONG.is_match(&p) {
        "change it to a single question under 300 characters"
    } else if ELEMENT_VAGUE.is_match(&p) || SOURCE_VAGUE.is_match(&p) {
        "name a specific exchange and pair"
    } else if let Some((_, h)) = STARTS.iter().find(|(k, _)| p.starts_with(k)) {
        h
    } else {
        "change the sheet as this message describes"
    };
    format!("{}{}{}", p, HINT_MARK, hint)
}
