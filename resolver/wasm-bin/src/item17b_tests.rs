//! Item 17b: resolvability replay. Recorded real source responses (fixtures/replay17b, URL-keyed via
//! manifest.json) go through the CURRENT resolver core path the TEE judge uses (`build_submission_with`:
//! lint -> fetch/admit or price-window -> D-RESOLVE6/8/6b gates -> judge -> decide -> outcome). The
//! judge is a scripted, recorded stand-in (no NEAR AI). Term sheets are written in the only shape the
//! core can express today (no typed 1a/1b/2/3 templates exist yet). See services/e2e/replay17b/REPORT.md.
use super::*;
use serde_json::json;
use std::cell::RefCell;
use std::collections::BTreeMap;

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/replay17b");

struct Fx(BTreeMap<String, (String, String)>); // url -> (file, content_type)
impl Fx {
    fn load() -> Fx {
        let m: Value = serde_json::from_slice(&std::fs::read(format!("{}/manifest.json", DIR)).unwrap()).unwrap();
        Fx(m.as_array().unwrap().iter().map(|e| (e["source_url"].as_str().unwrap().to_string(), (e["file"].as_str().unwrap().to_string(), e["content_type"].as_str().unwrap().to_string()))).collect())
    }
}
impl HttpFetcher for Fx {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        let (f, ct) = self.0.get(url).ok_or_else(|| format!("no recorded fixture for URL {}", url))?;
        Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: ct.clone(), body: std::fs::read(format!("{}/{}", DIR, f)).unwrap(), status_code: 200 })
    }
}

/// Recorded judge: `f(prompt) -> raw reply JSON`. Counts calls (0 = the model was never reached).
struct Judge<F: Fn(&str) -> String>(F, RefCell<usize>);
impl<F: Fn(&str) -> String> ModelCaller for Judge<F> {
    fn call(&self, _m: &str, msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        *self.1.borrow_mut() += 1;
        (self.0(&msgs.iter().map(|(_, c)| c.as_str()).collect::<Vec<_>>().join("\n")), None, None)
    }
}
fn insufficient(_: &str) -> String {
    r#"{"answer":"insufficient","reason":"recorded judge: evidence does not establish it"}"#.to_string()
}
fn met(sid: &str, quote: &str) -> String {
    json!({"answer": "met", "quote": quote, "source_id": sid, "reason": "recorded judge"}).to_string()
}
/// First `ts,high` row of source `sid` in the prompt with high >= th.
fn row_at_least(p: &str, sid: &str, th: f64) -> Option<String> {
    let a = p.find(&format!("<source id=\"{}\"", sid))?;
    let blk = &p[a..a + p[a..].find("</source>")?];
    blk.lines().find(|l| l.split_once(',').is_some_and(|(t, h)| t.parse::<i64>().is_ok() && h.parse::<f64>().is_ok_and(|h| h >= th))).map(|s| s.to_string())
}

fn run<F: Fn(&str) -> String>(terms: Value, f: F) -> (String, Vec<String>, usize) {
    let raw = terms.to_string();
    let job = json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 1, "checked_until": 0, "round": 0,
        "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw});
    let j = Judge(f, RefCell::new(0));
    let (r, n) = build_submission_with(&job, &j, &Fx::load(), false);
    let calls = *j.1.borrow();
    (r.outcome, n, calls)
}
fn has(n: &[String], s: &str) -> bool { n.iter().any(|x| x.contains(s)) }

/// 17c2: run a TYPED btc_touch sheet (code decides) over the recorded window `tag`, with a fixed settle-request clock. Same recorded fixtures.
fn run_typed_touch(tag: &str, x: i64, now_after_deadline: i64) -> (String, Vec<String>, usize) {
    let ev: Value = serde_json::from_slice(&std::fs::read(format!("{}/events.json", DIR)).unwrap()).unwrap();
    let (ws, we) = (ev[tag][0].as_i64().unwrap(), ev[tag][1].as_i64().unwrap());
    let raw = json!({"template": {"id": "btc_touch", "version": 1}, "fields": {"direction": "at_or_above", "x_usd": x, "deadline_utc": praetorial_core::format_ts(we), "open_utc": praetorial_core::format_ts(ws)}}).to_string();
    let job = json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 1, "checked_until": 0, "round": 0, "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw});
    // 17c5: the judge only audits the code outcome; this recorded judge agrees (the code outcome is what is asserted)
    let j = Judge(|_p: &str| r#"{"audit":"agree"}"#.to_string(), RefCell::new(0));
    let (r, n, _) = build_submission_judged_at(&job, &j, &Fx::load(), false, we + now_after_deadline);
    let calls = *j.1.borrow();
    (r.outcome, n, calls)
}

const CLAUSES: [&str; 5] = ["UTC_V1", "BEFORE_INCLUSIVE_V1", "NUMERIC_EXACT_V1", "ROUNDING_PRECISION_V1", "NO_DATA_FALLBACK_V1"];
const CB: &str = "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60";
const BS: &str = "https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&limit=100";
const KR: &str = "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1";

/// Typed-as-far-as-the-core-allows BTC sheet over the recorded window `tag` (events.json).
fn btc_terms(tag: &str, claim: &str, q: &str) -> Value {
    let ev: Value = serde_json::from_slice(&std::fs::read(format!("{}/events.json", DIR)).unwrap()).unwrap();
    let (ws, we) = (ev[tag][0].as_i64().unwrap(), ev[tag][1].as_i64().unwrap());
    json!({"claim": claim, "elements": [{"id": "e1", "q": q}], "rule": "ALL", "clauses": CLAUSES,
        "time": {"window_start": praetorial_core::format_ts(ws), "window_end": praetorial_core::format_ts(we), "evidence_cutoff": "2026-11-20T00:00:00Z"},
        "sources_allowed": [{"id": "S_CB", "publisher": "Coinbase BTC-USD", "url": CB}, {"id": "S_BS", "publisher": "Bitstamp btcusd", "url": BS}, {"id": "S_KR", "publisher": "Kraken XBT/USD", "url": KR}],
        "source_classes": {"Coinbase BTC-USD": "primary", "Bitstamp btcusd": "primary", "Kraken XBT/USD": "primary"},
        "custom_definitions": [
            "A 1-minute candle HIGH (the wick), not the close, reaching or exceeding the stated USD level counts as a touch; the trigger requires confirmation on at least two of the three named venues.",
            "Fallback: if one named venue is unavailable (no admissible exhibit reaches the evidence cutoff), the remaining venues must confirm; if fewer than two can be checked at all, the outcome is VOID with full refunds.",
            "Early YES resolution is allowed at the first qualifying confirmed candle, never before; if no touch occurred in the window the outcome is NO.",
            "Only USD-quoted pairs on the three named venues are eligible; no aggregators or other exchanges."],
        "ticker_pins": {"Coinbase BTC-USD": "BTC-USD", "Bitstamp btcusd": "btcusd", "Kraken XBT/USD": "XBT/USD"},
        "window_close": "2026-11-20T00:00:00Z", "sources": true})
}
fn touch_terms(tag: &str, th: u32) -> Value {
    let c = format!("BTC-USD 1-minute candle high reaches or exceeds ${}.00 on at least two of Coinbase, Bitstamp, Kraken in the window", th);
    let q = format!("Is a 1-minute candle high >= {} on at least two of the three venues in the window?", th);
    btc_terms(tag, &c, &q)
}
fn judge_touch(th: f64) -> impl Fn(&str) -> String {
    move |p| match row_at_least(p, "S_CB", th) { Some(r) => met("S_CB", &r), None => insufficient(p) }
}

// ------------------------------------------------------------------ 1b touch (core can express: high >= X)
#[test]
fn t1b_event_a_near_miss_75970_is_no_by_code() {
    // venue maxima 75930.49 / 75925.00 / 75932.50: all < 75970 (within $40). Complete, gap-free on all 3 venues.
    let (o, n, calls) = run(touch_terms("A", 75970), insufficient);
    assert_eq!(o, "NO", "{:?}", n);
    assert!(calls >= 1 && has(&n, "code-checked (D-RESOLVE6b)"), "{:?}", n);
}
#[test]
fn t1b_event_b_all_three_venues_touched_is_yes() {
    // maxima 76086.99 / 76087.35 / 76084.30 all >= 76080
    let (o, n, calls) = run(touch_terms("B", 76080), judge_touch(76080.0));
    assert_eq!(o, "YES", "{:?}", n);
    assert!(calls >= 1);
}
#[test]
fn t1b_event_g_real_coinbase_two_minute_gap_is_complete_with_gaps_and_reaches_judge() {
    // Real Coinbase gap 2026-10-30T19:55Z..19:56Z (2 of 360 candles); Kraken beyond depth; BS covers the gap slots.
    let (o, n, calls) = run(touch_terms("G", 77340), judge_touch(77340.0));
    assert!(has(&n, "COMPLETE_WITH_GAPS") && has(&n, "S_CB"), "{:?}", n);
    assert!(has(&n, "price evidence INCOMPLETE for S_KR"), "{:?}", n);
    assert_eq!(o, "YES", "CB max 77353, BS max 77349.48 >= 77340: {:?}", n);
    assert!(calls >= 1);
}
#[test]
fn t1b_coinbase_gap_scan_is_recorded_honestly() {
    let s: Value = serde_json::from_slice(&std::fs::read(format!("{}/coinbase_gap_scan.json", DIR)).unwrap()).unwrap();
    let runs = s["gap_runs"].as_array().unwrap();
    assert_eq!(runs.len(), 2, "60d scan found exactly two real gap runs");
    assert!(runs.iter().any(|r| r["start"] == "2026-10-30T19:55:00Z" && r["minutes"] == 2));
}

// ================================================================== replay of templates 1a / 2 / 3 (generic builders)
/// Block text of source `sid` as it appears in the judge prompt.
fn block<'a>(p: &'a str, sid: &str) -> Option<&'a str> {
    let a = p.find(&format!("<source id=\"{}\"", sid))?;
    Some(&p[a..a + p[a..].find("</source>")?])
}
/// Recorded judge: cite the literal `needle` if it occurs in source `sid`, else `insufficient`.
fn cite(sid: &'static str, needle: &'static str) -> impl Fn(&str) -> String {
    move |p| match block(p, sid) {
        Some(b) if b.contains(needle) => met(sid, needle),
        _ => insufficient(p),
    }
}
fn generic_terms(claim: &str, q: &str, srcs: Value, start: &str, end: &str) -> Value {
    json!({"claim": claim, "elements": [{"id": "e1", "q": q}], "rule": "ALL", "clauses": CLAUSES,
        "time": {"window_start": start, "window_end": end, "evidence_cutoff": "2026-11-20T00:00:00Z"},
        "sources_allowed": srcs,
        "source_classes": {"A": "primary"},
        "custom_definitions": [
            "Fallback: if one named source is unavailable the other must confirm; if neither can be checked the outcome is VOID with full refunds.",
            "Early resolution: only once the source shows the result as final; never before."],
        "window_close": "2026-11-20T00:00:00Z", "sources": true})
}
fn src(id: &str, publisher: &str, url: &str) -> Value { json!({"id": id, "publisher": publisher, "origin": publisher, "url": url}) }


// ------------------------------------------------------------------ 1b: >=2-of-3 (design) where the core can express it
#[test]
fn t1b_event_a_two_of_three_touched_is_yes() {
    // X=75930: Coinbase max 75930.49 and Kraken max 75932.50 touch, Bitstamp (75925.00) does not -> 2 of 3 -> YES (design).
    let (o, n, calls) = run(touch_terms("A", 75930), judge_touch(75930.0));
    assert_eq!(o, "YES", "{:?}", n);
    assert!(calls >= 1);
}

// ------------------------------------------------------------------ 1a close-at-T (recorded data only; resolver cannot express it, see GAPS.md GAP-2)
fn fx_json(f: &str) -> Value { serde_json::from_slice(&std::fs::read(format!("{}/{}", DIR, f)).unwrap()).unwrap() }
/// (coinbase, bitstamp, kraken) close of the 1m candle OPENING at `open_ts` for window tag.
fn closes_at(tag: &str, open_ts: i64) -> (f64, f64, f64) {
    let cb = fx_json(&format!("btc_{}_cb_p0.json", tag));
    let cb = cb.as_array().unwrap().iter().find(|r| r[0].as_i64() == Some(open_ts)).unwrap()[4].as_f64().unwrap();
    let bs = fx_json(&format!("btc_{}_bs.json", tag));
    let bs = bs["data"]["ohlc"].as_array().unwrap().iter().find(|r| r["timestamp"].as_str().unwrap().parse::<i64>().unwrap() == open_ts).unwrap()["close"].as_str().unwrap().parse::<f64>().unwrap();
    let kr = fx_json(&format!("btc_{}_kr.json", tag));
    let kr = kr["result"]["XXBTZUSD"].as_array().unwrap().iter().find(|r| r[0].as_i64() == Some(open_ts)).unwrap()[4].as_str().unwrap().parse::<f64>().unwrap();
    (cb, bs, kr)
}
#[test]
fn t1a_recorded_closes_and_medians_for_events_a_b_c() {
    // The designed 1a value: median of the three venues' CLOSE of the minute ending at T (window end).
    let ev = fx_json("events.json");
    let want = [("A", (75923.34, 75925.00, 75929.10), 75925.00), ("B", (75901.36, 75895.91, 75906.10), 75901.36), ("C", (75687.31, 75691.93, 75703.90), 75691.93)];
    for (tag, c, med) in want {
        let t = ev[tag][1].as_i64().unwrap();
        let got = closes_at(tag, t - 60);
        assert_eq!(got, c, "{}", tag);
        let mut v = [got.0, got.1, got.2];
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(v[1], med, "{}", tag);
    }
}

// ------------------------------------------------------------------ template 2 games: MLB (two official-ish origins; core CAN express it)
const U_MLB: &str = "https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-10-28";
const U_ESPN_MLB: &str = "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=20261028";
fn mlb_terms(claim: &str, q: &str) -> Value {
    generic_terms(claim, q, json!([src("S_MLB", "MLB Stats API", U_MLB), src("S_ESPN", "ESPN", U_ESPN_MLB)]), "2026-10-28T00:00:00Z", "2026-10-29T12:00:00Z")
}
#[test]
fn t2_mlb_849799_brewers_win_is_yes_on_final() {
    // MLB Stats API: status Final, MIL 4 - TB 1. Design: winner of a final game -> YES.
    let (o, n, calls) = run(mlb_terms("The Milwaukee Brewers beat the Tampa Bay Rays in MLB game 849799", "Did Milwaukee win MLB gamePk 849799 (final)?"), cite("S_MLB", "\"score\":4,\"isWinner\":true"));
    assert_eq!(o, "YES", "{:?}", n);
    assert!(calls >= 1 && has(&n, "source fetched: S_MLB") && has(&n, "source fetched: S_ESPN"), "{:?}", n);
}
#[test]
fn t2_mlb_849799_rays_win_is_no() {
    let (o, n, _) = run(mlb_terms("The Tampa Bay Rays beat the Milwaukee Brewers in MLB game 849799", "Did Tampa Bay win MLB gamePk 849799 (final)?"),
        |_| json!({"answer": "not_met", "quote": "\"score\":1,\"isWinner\":false", "source_id": "S_MLB", "reason": "recorded judge"}).to_string());
    assert_eq!(o, "NO", "{:?}", n);
}
#[test]
fn t2_t3_recorded_known_answers_in_fixtures() {
    let nfl = std::fs::read_to_string(format!("{}/espn_nfl_scoreboard_20261101.json", DIR)).unwrap();
    assert!(nfl.contains("\"id\":\"401873026\"") && nfl.contains("STATUS_FINAL"));
    let nhl = fx_json("nhl_score_20261105.json");
    let g = nhl["games"].as_array().unwrap().iter().find(|g| g["id"] == 2026020261).unwrap();
    assert_eq!((g["awayTeam"]["abbrev"].as_str(), g["awayTeam"]["score"].as_i64(), g["homeTeam"]["score"].as_i64(), g["gameOutcome"]["lastPeriodType"].as_str(), g["gameState"].as_str()), (Some("NSH"), Some(3), Some(2), Some("OT"), Some("OFF")));
    let iem = fx_json("iem_cli_knyc_2026.json");
    let r = iem["results"].as_array().unwrap().iter().find(|r| r["valid"] == "2026-11-05").unwrap();
    assert_eq!(r["high"].as_i64(), Some(72));
    let nws = std::fs::read_to_string(format!("{}/nws_cli_nyc_20261106T0645.json", DIR)).unwrap();
    assert!(nws.contains("MAXIMUM         72"));
}


// ================================================================== 17c2: BTC gap tests compiled in AS-IS from services/e2e/replay17b (GAP-1 Kraken depth, GAP-2, GAP-3, GAP-6).
// GAP-4/5 (weather/sports) belong to 17c3/17c4 and are not compiled here. GAP-2 and GAP-6 are comment-only stubs in the source files (they pass vacuously);
// their real designed bodies live in item17c2_tests.rs.
// Designed-behaviour test (MVP Bet Design, Type 1 'Rules': 1b 'venues missing data count as not touched; VOID only if <2 venues are reachable').
// FAILS on the current core: outcome is VOID, not NO. Uses the harness in resolver/wasm-bin/src/item17b_tests.rs. For 17c to turn into a RED test.
#[test]
fn t1b_event_d_kraken_depth_exceeded_still_resolves_on_two_venues() {
    // Kraken 1m for a window ~20h old returns the latest 721 candles (since ignored) -> Kraken excluded as INCOMPLETE,
    // Coinbase+Bitstamp complete (D-RESOLVE6 needs 2) -> NO (maxima 75688.43/75685.94 < 75700).
    // 17c2 flip (GAP-1): typed btc_touch; settled ~20h after the window so Kraken 1m is out of depth.
    let (o, n, _c) = run_typed_touch("D", 75700, 20 * 3600);
    assert!(has(&n, "Kraken unreachable"), "{:?}", n);
    assert_eq!(o, "NO", "{:?}", n);
}

// GAP-2 (Type 1, 1a: median of the 3 venues' CLOSE of the minute ending T). Event A: closes 75923.34/75925.00/75929.10 -> median 75925.00.
// Current core: evidence rows are `unix_ts,high_usd` only; no close, no median. Replayed: a 1-minute window at T VOIDs (per-minute fetch not even admissible
// in the recorded set) and a 1h window gives 60 HIGH rows per venue and the judge has nothing to compute a close from -> ESCALATE/VOID.
#[test]
fn t1a_event_a_median_close_above_75900_is_yes_and_above_75925_is_no() {
    // typed 1a sheet, X=75900, "above" strictly: median close 75925.00 > 75900 -> YES
    // typed 1a sheet, X=75925, "above" strictly: median close 75925.00 !> 75925 -> NO (ties decided by operator, never VOID)
    // typed 1a sheet, X=75927 with only CB+BS reachable: mean of the 2 = 75924.17 -> NO; if they straddle X -> VOID
}
// GAP-3 (Type 1 1b, ">=2 of 3 venues touched"). Event A maxima CB 75930.49 / BS 75925.00 / KR 75932.50. X=75931: only Kraken touched -> designed NO.
// Current core replay: honest judge ("insufficient") -> VOID (code-NO refused because KR high >= X); a judge citing the KR row -> YES (wrong winner).
#[test]
fn t1b_event_a_only_one_venue_touched_is_no() {
    // 17c2 flip (GAP-3): typed btc_touch, the code counts venues. D-TPL1b (PM ruling) supersedes the original designed NO: exactly one venue
    // crossed (Kraken) with the other reachable venues complete and not crossing is VOID "venues disagree on touch", never NO, never YES.
    let (o, n, c) = run_typed_touch("A", 75931, 300);
    assert_eq!(o, "VOID", "{:?}", n);
    assert!(has(&n, "venues disagree on touch"), "{:?}", n);
    assert_eq!(c, 0, "the judge is never called for a typed BTC sheet");
}
// GAP-6 (Type 1 Sources: Gemini backup). Gemini is not a price venue: it is fetched as a generic 88 KB JSON text page and ignored by the D-RESOLVE6/6b gates.
// Replay: CB + BS + Gemini, X=75970 -> NO decided on "all 2 price venues" (Gemini listed but not counted as backup/venue).
#[test]
fn t1_gemini_backup_counts_as_third_venue_when_kraken_missing() { /* designed: Gemini replaces Kraken as 3rd venue; quorum 2 of {CB,BS,GM} */ }

// ================================================================== 17c3: GAP-4 (weather) compiled in AS-IS from services/e2e/replay17b/gap_tests_designed.rs.txt.
// The source body is a comment-only stub (passes vacuously, like GAP-2/GAP-6 in 17c2); the real designed assertions are in item17c3_tests.rs.
// GAP-4 (Type 3). The NWS CLI product (api.weather.gov, Content-Type application/ld+json) is dropped by fetch_and_admit_source ("content-type not allowed").
// Designed: KNYC 2026-11-05 CLI MAXIMUM 72 (product 7a7c269a-..., issued 2026-11-06T06:45Z) and IEM high 72 agree -> ">= 72" YES, "<= 71" NO.
#[test]
fn t3_knyc_20261105_nws_cli_and_iem_agree_72() {
    // sources: NWS CLI product (pinned at Open) + IEM cli.py?station=KNYC&year=2026 (389 KB; fits the prompt cap, 391,615 of 414,464 bytes)
    // current: S_NWS dropped (FETCH_FAIL: content-type not allowed: application/ld+json); S_IEM alone -> YES (no agreement check; design VOIDs "two copies disagree" and
    // wants quorum of 2). Also: no climate-day LST, no `MM` handling, no code extraction (judge reads a year of rows as text).
    // assert: has(&n, "source fetched: S_NWS") && outcome == "YES" for >=72 and "NO" for >=73, and outcome == "VOID" if either copy says MM or they differ.
}

// ================================================================== 17c4: GAP-5a/5b (sports) compiled in AS-IS from services/e2e/replay17b/gap_tests_designed.rs.txt.
// Both source bodies are comment-only stubs (pass vacuously, like GAP-2/4/6); the real designed assertions are in item17c4_tests.rs and core tests/sports_17c4.rs.
// GAP-5a (Type 2, NHL). Official api-web (86 KB) + ESPN (332 KB) together exceed the per-element prompt cap -> BUDGET_EXCEEDED -> VOID. Designed: YES for NSH in OT (game 2026020261, NSH 3 COL 2, OT, OFF).
#[test]
fn t2_nhl_2026020261_overtime_winner_nsh_is_yes() {
    // sources: NHL api-web v1/score/2026-11-05 + ESPN nhl scoreboard?dates=20261105
    // current: "prompt exceeds spec §2 cap (~103616 tokens/element, BUDGET_EXCEEDED)", judge never called -> VOID.  A structured adapter extracts only the pinned game.
}

// GAP-5b (Type 2, NFL). Design "Decision for the MVP": launch NFL single source (ESPN) with VOID if ESPN is unreachable 7 days.
// Current: lint rejects it ("need >= 2 independent, non-party-controlled origins") -> VOID at the compile gate, judge never called. Two ESPN URLs: same rejection (origin = publisher).
#[test]
fn t2_nfl_401873026_single_source_espn_buf_36_10_bal_is_yes() {
    // generic_terms(..., json!([src("S_ESPN","ESPN",U_NFL)]), ...) with judge citing the BUF `"winner":true` competitor -> designed YES; current VOID(INVALID_INPUT)
}
// Related: the origin is a bettor-declared string (`origin` field in sources_allowed). Declaring a different origin for the same ESPN URL passes lint
