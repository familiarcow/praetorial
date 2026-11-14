//! Item 16h (D-RESOLVE7 / D-RESOLVE6b): Coinbase TEE 400 hardening + coarse-evidence gate.
use super::item16e2_tests::Sim;
use super::item16e_tests::*;
use super::*;
use std::cell::RefCell;

const VENUES: [PriceVenue; 3] = [PriceVenue::Coinbase, PriceVenue::Bitstamp, PriceVenue::Kraken];
type HighBox = Box<dyn Fn(&str, i64) -> f64>;

// ---- page builder: <=300 candles per page, half-open, tiles with no gap/overlap ----
#[test]
fn d_resolve7_every_page_holds_at_most_the_venue_limit_of_candles() {
    for v in VENUES {
        let lim = match v { PriceVenue::Coinbase => 300, PriceVenue::Bitstamp => 1000, PriceVenue::Kraken => 720 };
        for g in [60i64, 300, 900, 3600, 21_600] {
            for n in [1i64, 2, 299, 300, 301, 302, 599, 600, 601, 667, 700] {
                let (first, last) = (1_759_276_800, 1_759_276_800 + (n - 1) * g);
                for (s, e_excl) in price_pages(v, g, first, last) {
                    let cnt = (e_excl - s) / g;
                    assert!(cnt >= 1 && cnt <= lim, "{:?} g={} n={} page {}..{} = {} candles", v, g, n, s, e_excl, cnt);
                }
            }
        }
    }
}

#[test]
fn d_resolve7_pages_are_half_open_and_tile_the_window_without_gap_or_overlap() {
    for v in [PriceVenue::Coinbase, PriceVenue::Bitstamp] {
        for g in [60i64, 3600] {
            for n in [1i64, 299, 300, 301, 600, 667, 700] {
                let (first, last) = (1_759_276_800, 1_759_276_800 + (n - 1) * g);
                let pages = price_pages(v, g, first, last);
                assert!(!pages.is_empty());
                assert_eq!(pages[0].0, first, "{:?} g={} n={}", v, g, n);
                assert_eq!(pages.last().unwrap().1, last + g, "{:?} g={} n={}: end is EXCLUSIVE (one past the last candle open)", v, g, n);
                for w in pages.windows(2) {
                    assert_eq!(w[0].1, w[1].0, "{:?} g={} n={}: next page must start exactly where the previous ends (half-open)", v, g, n);
                }
                let total: i64 = pages.iter().map(|(s, e)| (e - s) / g).sum();
                assert_eq!(total, n, "{:?} g={} n={}: pages must cover each candle exactly once", v, g, n);
            }
        }
    }
}

fn q(url: &str, k: &str) -> Option<String> {
    url.split('?').nth(1)?.split('&').find_map(|p| p.strip_prefix(&format!("{}=", k)).map(|s| s.to_string()))
}

#[test]
fn d_resolve7_coinbase_urls_never_ask_for_more_than_300_candles_inclusive_of_end() {
    let f = Sim::jason();
    let _ = build_submission(&jason_job(), &Rec(RefCell::new(vec![]), String::new()), &f);
    let urls: Vec<String> = f.urls.borrow().iter().filter(|u| u.contains("coinbase.com")).cloned().collect();
    assert!(!urls.is_empty());
    let mut prev_end: Option<i64> = None;
    for u in &urls {
        let g: i64 = q(u, "granularity").unwrap().parse().unwrap();
        let s = iso_to_unix(&q(u, "start").unwrap()).unwrap();
        let e = iso_to_unix(&q(u, "end").unwrap()).unwrap();
        // Coinbase `end` is INCLUSIVE: candles requested = floor(e/g)-ceil(s/g)+1
        let n = e.div_euclid(g) - (s + g - 1).div_euclid(g) + 1;
        assert!(n <= 300, "page asks {} candles (>300): {}", n, u);
        assert!(e - s <= 300 * g, "range {}s exceeds 300*g: {}", e - s, u);
        assert!(e % g != 0, "half-open: end must be exclusive-minus-1s, got aligned end: {}", u);
        if let Some(pe) = prev_end { assert!(s > pe, "pages overlap or touch: prev end {} vs start {}", pe, s); }
        prev_end = Some(e);
    }
}

#[test]
fn d_resolve7_bitstamp_urls_have_page_limit_guard_and_half_open_ranges() {
    let f = Sim::jason();
    let _ = build_submission(&jason_job(), &Rec(RefCell::new(vec![]), String::new()), &f);
    let urls: Vec<String> = f.urls.borrow().iter().filter(|u| u.contains("bitstamp.net")).cloned().collect();
    assert!(!urls.is_empty());
    let mut prev_end: Option<i64> = None;
    for u in &urls {
        let g: i64 = q(u, "step").unwrap().parse().unwrap();
        let lim: i64 = q(u, "limit").expect("bitstamp limit param").parse().unwrap();
        let s: i64 = q(u, "start").unwrap().parse().unwrap();
        let e: i64 = q(u, "end").unwrap().parse().unwrap();
        assert!(lim >= 1 && lim <= 1000, "limit {} outside Bitstamp's 1..=1000: {}", lim, u);
        let n = e.div_euclid(g) - (s + g - 1).div_euclid(g) + 1;
        assert!(n <= lim, "page asks {} candles > limit {}: {}", n, lim, u);
        assert!(e % g != 0, "Bitstamp `end` must be exclusive-minus-1s (half-open), got aligned end {}: {}", e, u);
        if let Some(pe) = prev_end { assert!(s > pe, "pages overlap: {} vs {}", pe, s); }
        prev_end = Some(e);
    }
}

// ---- request headers the wasm sends ----
#[test]
fn d_resolve7_outbound_headers_carry_a_user_agent() {
    let h = outbound_headers();
    let ua = h.iter().find(|(k, _)| k.eq_ignore_ascii_case("user-agent")).map(|(_, v)| *v).unwrap_or("");
    assert!(ua.starts_with("praetorial-resolver/") && ua.len() > "praetorial-resolver/".len(), "User-Agent missing/insane: {:?}", h);
}

#[test]
fn d_resolve7_outbound_headers_carry_a_sane_accept_and_no_secrets() {
    let h = outbound_headers();
    let acc = h.iter().find(|(k, _)| k.eq_ignore_ascii_case("accept")).map(|(_, v)| *v).unwrap_or("");
    assert!(acc.contains("application/json"), "Accept must name JSON: {:?}", h);
    assert!(!h.iter().any(|(k, _)| k.eq_ignore_ascii_case("authorization") || k.eq_ignore_ascii_case("cookie")), "{:?}", h);
}

#[test]
fn d_resolve7_wasi_fetcher_sends_the_outbound_headers_on_every_hop() {
    let src = include_str!("main.rs");
    let a = src.find("impl HttpFetcher for WasiFetcher").expect("WasiFetcher impl");
    let body = &src[a..a + 2500];
    assert!(body.contains("outbound_headers()"), "WasiFetcher must apply outbound_headers() to its GET");
}

// ---- D-RESOLVE6b: coarse evidence vs 5-minute coincidence tolerance ----
struct EvidenceModel;
impl ModelCaller for EvidenceModel {
    fn call(&self, _m: &str, msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        // D-JUDGETIME1b (a): a gate-decided sheet gets the short audit prompt; answer {"audit":"agree"} there, the evidence verdict on full-judge prompts.
        if msgs.iter().any(|(_, c)| c.contains("<proposal>")) { return (r#"{"audit":"agree"}"#.to_string(), None, None); }
        let user = &msgs[1].1;
        let block = |id: &str| -> Option<String> {
            let a = user.find(&format!("<source id=\"{}\"", id))?;
            let b = user[a..].find("</source>")?;
            Some(user[a..a + b].to_string())
        };
        let hit = |id: &str| -> Option<String> {
            block(id)?.lines().find(|l| {
                let mut it = l.split(',');
                matches!((it.next().and_then(|x| x.parse::<i64>().ok()), it.next().and_then(|x| x.parse::<f64>().ok())), (Some(_), Some(h)) if h >= 126_210.5)
            }).map(|l| l.to_string())
        };
        match (hit("S_CB"), hit("S_BS")) {
            (Some(row), Some(_)) => (json!({"answer": "met", "source_id": "S_CB", "quote": row}).to_string(), None, None),
            _ => (r#"{"answer":"insufficient","reason":"no qualifying candle in evidence"}"#.to_string(), None, None),
        }
    }
}

fn touch_at(venues: &'static [&'static str]) -> HighBox {
    Box::new(move |v, ts| {
        if ts < WIN_START { return 188_888.5; }
        if ts >= WIN_END { return 90_000.5; }
        if ts == WIN_START + 2 * 86_400 + 5 * 3600 && venues.contains(&v) { return 126_500.5; }
        100_000.5 + ((ts / 3600) % 100) as f64
    })
}

#[test]
fn d_resolve6b_prompt_states_the_granularity_caveat_when_evidence_is_coarser_than_the_tolerance() {
    let rec = Rec(RefCell::new(vec![]), String::new());
    let _ = build_submission(&jason_job(), &rec, &Sim::jason());
    let p = rec.0.borrow().first().cloned().unwrap_or_default();
    assert!(p.contains("GRANULARITY CAVEAT (D-RESOLVE6b)"), "{}", &p[..p.len().min(2500)]);
    assert!(p.contains("3600s") && p.contains("300s"), "caveat must name both granularities");
    // D-JUDGE4a: was 'caveat must also contain the COULDNT_CHECK rule', now dropped (granularity caveat itself still required above) because D-JUDGE4 (ii) / R3 scope item 7 removes the COULDNT_CHECK caveat instruction
}

#[test]
fn d_resolve6b_both_venues_touching_in_the_same_hour_is_void_never_yes() {
    let f = Sim::jason().with_high(touch_at(&["cb", "bs", "kr"]));
    let (r, n) = build_submission(&jason_job(), &EvidenceModel, &f);
    assert_eq!(r.outcome, "VOID", "same-hour highs on hourly evidence cannot prove 5-minute coincidence: {:?}", n);
    assert!(n.iter().any(|x| x.contains("COULDNT_CHECK") && x.contains("D-RESOLVE6b")), "{:?}", n);
}

#[test]
fn d_resolve6b_one_venue_touching_on_coarse_evidence_is_void_not_no() {
    let f = Sim::jason().with_high(touch_at(&["cb"]));
    let (r, n) = build_submission(&jason_job(), &EvidenceModel, &f);
    assert_eq!(r.outcome, "VOID", "{:?}", n);
}

#[test]
fn d_resolve6b_no_venue_touching_on_coarse_evidence_is_a_real_no() {
    let (r, n) = build_submission(&jason_job(), &EvidenceModel, &Sim::jason());
    assert_eq!(r.outcome, "NO", "{:?}", n);
}

#[test]
fn d_resolve6b_gate_is_code_not_prompt_a_model_that_says_no_despite_a_touch_is_void() {
    struct AlwaysNo;
    impl ModelCaller for AlwaysNo {
        fn call(&self, _m: &str, _msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) {
            (r#"{"answer":"insufficient","reason":"ignored caveat"}"#.to_string(), None, None)
        }
    }
    let f = Sim::jason().with_high(touch_at(&["cb", "bs"]));
    let (r, n) = build_submission(&jason_job(), &AlwaysNo, &f);
    assert_eq!(r.outcome, "VOID", "{:?}", n);
}

#[test]
fn d_resolve6b_fine_evidence_still_resolves_yes_and_has_no_caveat() {
    // 6h window -> 1-minute candles (<= the 5-minute tolerance): coincidence is checkable.
    let mut t: Value = serde_json::from_str(JASON_16C_TERMS).unwrap();
    t["time"]["window_start"] = json!("2025-10-01T00:00:00Z");
    t["time"]["window_end"] = json!("2025-10-01T06:00:00Z");
    let terms = t.to_string();
    let job = json!({"contract": "escrow.testnet", "bet_id": 2, "run_no": 2, "checked_until": 0, "round": 0,
           "envelope": {"terms_hash": praetorial_core::sha_hex(&terms)}, "terms": terms});
    let hit_ts = WIN_START + 3600;
    let mk = move || Sim::jason().with_high(Box::new(move |_v, ts| if ts == hit_ts { 126_500.5 } else { 100_000.5 }));
    let rec = Rec(RefCell::new(vec![]), String::new());
    let _ = build_submission(&job, &rec, &mk());
    assert!(!rec.0.borrow().first().cloned().unwrap_or_default().contains("GRANULARITY CAVEAT"));
    let (r, n) = build_submission(&job, &EvidenceModel, &mk());
    assert_eq!(r.outcome, "YES", "{:?}", n);
}

// D-JUDGETIME1b (a)/(c): on the gate-decided 6h sheet the model now only audits, so the "no GRANULARITY CAVEAT in the judge prompt" check
// above sees the short audit prompt. This copy keeps the FULL-judge path covered: a Kraken gap (kr is a named venue) means the gate cannot
// fully decide the sheet, so Coinbase+Bitstamp evidence goes to the full judge, which still resolves YES with no caveat.
#[test]
fn d_resolve6b_fine_evidence_still_resolves_yes_and_has_no_caveat_full_judge_path() {
    let mut t: Value = serde_json::from_str(JASON_16C_TERMS).unwrap();
    t["time"]["window_start"] = json!("2025-10-01T00:00:00Z");
    t["time"]["window_end"] = json!("2025-10-01T06:00:00Z");
    let terms = t.to_string();
    let job = json!({"contract": "escrow.testnet", "bet_id": 2, "run_no": 2, "checked_until": 0, "round": 0,
           "envelope": {"terms_hash": praetorial_core::sha_hex(&terms)}, "terms": terms});
    let hit_ts = WIN_START + 3600;
    let mk = move || Sim::jason().with_high(Box::new(move |_v, ts| if ts == hit_ts { 126_500.5 } else { 100_000.5 })).with_gap(Box::new(move |v, ts| v == "kr" && ts == hit_ts + 7200));
    let rec = Rec(RefCell::new(vec![]), String::new());
    let _ = build_submission(&job, &rec, &mk());
    let p = rec.0.borrow().first().cloned().unwrap_or_default();
    assert!(!p.contains("<proposal>"), "gap sheet must keep the full-judge prompt");
    assert!(!p.contains("GRANULARITY CAVEAT"));
    let (r, n) = build_submission(&job, &EvidenceModel, &mk());
    assert_eq!(r.outcome, "YES", "{:?}", n);
}
