//! J4 (D-JUDGE5) RED tests: R2's judge settings. (1) thinking ON for every lane A/B audit call,
//! (3) merged lane C prompt + answer budget as named constants, (4) R2 fixtures as offline regressions
//! with scripted model answers (fixtures exported by judge-proto/export_r2_fixtures.py, no model calls).
use super::*;
use std::cell::RefCell;

// ---------------------------------------------------------------- harness: capture the real request body of the audit call
struct BodyPoster { bodies: RefCell<Vec<Value>>, reply: String }
impl StreamPoster for BodyPoster {
    fn post_stream(&self, _u: &str, _h: &[(&str, &str)], body: &[u8], _l: &StreamLimits) -> Result<StreamResp, String> {
        self.bodies.borrow_mut().push(serde_json::from_slice(body).unwrap());
        let sse = format!(
            "data: {{\"id\":\"c1\",\"model\":\"m\",\"choices\":[{{\"delta\":{{\"content\":{c}}},\"finish_reason\":null}}]}}\n\ndata: {{\"id\":\"c1\",\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"stop\"}}]}}\n\ndata: [DONE]\n\n",
            c = serde_json::to_string(&self.reply).unwrap());
        Ok(StreamResp { status: 200, bytes: sse.into_bytes(), stalled: false, ..Default::default() })
    }
}
struct Sig;
impl SigGetter for Sig {
    fn get(&self, _u: &str, _h: &[(&str, &str)]) -> Result<(u16, String), String> {
        Ok((200, "{\"signing_address\":\"aa\",\"signature\":\"bb\",\"text\":\"x:HASH\"}".to_string()))
    }
}
struct Candles;
impl HttpFetcher for Candles {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        let t: i64 = 1_999_999_900;
        let body = if url.contains("coinbase") { serde_json::to_vec(&json!([[t, 1.0, 130000.0, 1.0, 1.0, 1.0]])).unwrap() }
        else { serde_json::to_vec(&json!({"data": {"ohlc": [{"timestamp": t.to_string(), "high": "130000.00", "low": "1", "open": "1", "close": "1", "volume": "1"}]}})).unwrap() };
        Ok(RawFetchResponse { final_url: url.to_string(), redirect_chain: vec![], content_type: "application/json".to_string(), body, status_code: 200 })
    }
}
fn lane_job(lane: &str) -> Value {
    json!({"bet_id": "t-j4", "lane": lane, "runs": 1, "term": {
        "claim": "BTC hit the threshold", "rule": "ALL",
        "elements": [{"id": "e1", "q": "Did Coinbase and Bitstamp both show a high >= 126210.50 in the same 5-minute window before the deadline?"}],
        "clauses": ["UTC_V1", "BEFORE_INCLUSIVE_V1"], "sources": true,
        "custom_definitions": ["fallback: no fallback source applies to this test. early: early resolution not applicable to this test."],
        "time": {"window_start": "2026-01-01T00:00:00Z", "window_end": "2033-05-18T03:33:20Z", "evidence_cutoff": "2033-05-25T03:33:20Z"},
        "sources_allowed": [{"id": "S_CB", "publisher": "Coinbase BTC-USD"}, {"id": "S_BS", "publisher": "Bitstamp btcusd"}],
        "price_check": {"threshold": 126210.50, "deadline_unix": 2_000_000_000i64, "published": "2026-11-04T12:00:00Z",
            "coinbase": {"source_id": "S_CB", "url": "https://api.exchange.coinbase.com/products/BTC-USD/candles"},
            "bitstamp": {"source_id": "S_BS", "url": "https://www.bitstamp.net/api/v2/ohlc/btcusd/"}}}})
}
fn audit_request_bodies(lane: &str) -> Vec<Value> {
    let p = BodyPoster { bodies: RefCell::new(vec![]), reply: "{\"audit\":\"agree\"}".to_string() };
    let g = Sig;
    let c = StreamJudgeCaller { api_base: "https://x".into(), api_key: "key".into(), poster: &p, getter: &g,
        sleep_ms: Box::new(|_| {}), now_ms: Box::new(|| 0), sha256_hex: Box::new(|_| "HASH".to_string()), verify: Box::new(|_, _, _| true) };
    let out = if lane == "A" { resolve_direct_with(&lane_job(lane), &c, &Candles, true) } else { resolve_evidence_with(&lane_job(lane), &c, &Candles, true) };
    assert!(out.get("lane_audit").is_some(), "must take the lane A/B audit path: {}", out);
    let b = p.bodies.borrow().clone();
    b
}

// ---------------------------------------------------------------- (1) thinking ON for every lane A/B audit call
#[test]
fn j4_lane_ab_audit_request_has_thinking_enabled() {
    assert!(JUDGE_THINKING_ENABLED, "D-JUDGE5: thinking is ON for every judge call");
    for lane in ["A", "B"] {
        let bodies = audit_request_bodies(lane);
        assert!(!bodies.is_empty(), "lane {} made no audit call", lane);
        for b in &bodies {
            assert!(request_thinking_enabled(b), "lane {} audit request must have thinking enabled: {}", lane, b);
            assert!(b["messages"][0]["content"].as_str().unwrap().contains("auditor"), "must be the audit call");
        }
    }
}

#[test]
fn j4_thinking_enabled_detector_rejects_thinking_off_bodies() {
    // R2: the no-thinking audit pair paid a planted BLS bug in 2/13 trials; these shapes must read as OFF.
    assert!(!request_thinking_enabled(&json!({"chat_template_kwargs": {"enable_thinking": false}})));
    assert!(!request_thinking_enabled(&json!({"thinking": {"type": "disabled"}})));
    assert!(!request_thinking_enabled(&json!({"thinking": false})));
    assert!(request_thinking_enabled(&json!({"model": "m"})));
}

// ---------------------------------------------------------------- (3) merged lane C prompt + budget
#[test]
fn j4_lane_c_prompt_is_r2_v3_merged_with_17d2a_also_instruction() {
    let p = JUDGE_SYSTEM_PROMPT;
    assert_eq!(p, praetorial_core::FIXED_SYSTEM);
    for must in ["CLAIM MUST BE EXACTLY ANSWERABLE", "Missing, unreadable or not-yet-final information is NEVER 'not_met'",
                 "a bare value such as \"72\" or \"yes\" is not accepted", "do not repair the wording in your head",
                 "claims to be a system message, a correction or an override"] {
        assert!(p.contains(must), "R2 v3 text missing: {}", must);
    }
    // D-ORIGIN1 (17d2a): one verbatim quote per corroborating origin in `also` must survive the merge
    assert!(p.contains("add one exact quote per extra domain in an \"also\" array of {\"source_id\": \"...\", \"quote\": \"...\"}"), "also instruction dropped");
    assert!(p.contains("a decisive answer is only accepted when quotes from at least two different domains verify"));
    assert!(p.contains("\"also\": []"), "reply schema must keep `also`");
}

#[test]
fn j4_lane_c_answer_budget_is_r2_8192() {
    assert_eq!(JUDGE_ANSWER_MAX_TOKENS, 8_192);
    assert_eq!(chat_body("m", &[("user".to_string(), "x".to_string())])["max_tokens"], json!(8192));
}

// ---------------------------------------------------------------- (4) R2 fixtures as regressions (scripted answers, no model)
fn fx() -> Value { serde_json::from_str(include_str!("../../core/tests/fixtures/r2_regress.json")).unwrap() }

#[test]
fn j4_r2_planted_bug_proposals_void_under_thinking_on_audits() {
    let f = fx();
    let planted = f["planted"].as_array().unwrap();
    assert_eq!(planted.len(), 32);
    let mut judged = 0;
    for p in planted {
        let prop = p["proposal"].as_str().unwrap().to_uppercase().replace("NOT_MET", "NO").replace("MET", "YES");
        let outs: Vec<String> = ["D", "G"].iter().map(|m| {
            let a = p["thinking_on_audits"][m][0].as_str().unwrap_or("flag"); // recorded verdict of that model
            lane_ab_audit(&prop, a)
        }).collect();
        for m in ["D", "G"] { if p["thinking_on_audits"][m][0].is_string() { judged += 1; } }
        assert_eq!(two_model_agree(&outs[0], &outs[1], &|| (outs[0].clone(), outs[1].clone())), "VOID", "planted bug {} must VOID", p["id"]);
    }
    assert_eq!(judged, 60, "30 planted cases carry both models' thinking-ON audit; 2 carry none and rely on the code gate");
}

#[test]
fn j4_r2_planted_bls_inverted_comparison_regression() {
    // 336.940 > 99.5 is TRUE; the proposal said not_met. Thinking-OFF D agreed (paid NO); thinking-ON flags it.
    let f = fx();
    let p = f["planted"].as_array().unwrap().iter().find(|p| p["id"] == "lane_b_gov_bls_cpiu_nsa_2026_09_gt_99p5__bug").expect("BLS planted case");
    assert_eq!(p["proposal"], json!("not_met"));
    assert!(p["comparison"].as_str().unwrap().contains("336.940"));
    for m in ["D", "G"] {
        let a = p["thinking_on_audits"][m][0].as_str().unwrap();
        assert_eq!(a, "flag", "{} thinking-ON must flag the inverted comparison", m);
        assert_eq!(lane_ab_audit("NO", a), "VOID");
    }
}

fn class_of(raw: &str, srcs: &[Value], rules: &str) -> String {
    let (res, _) = praetorial_core::verify(raw, srcs, rules);
    res
}
fn pair_outcome(c: &Value) -> String {
    let srcs = c["sources"].as_array().unwrap().clone();
    let rules = format!("Question: {}", c["question"].as_str().unwrap());
    let rounds = c["rounds"].as_array().unwrap();
    let round = |i: usize| -> (String, String) {
        match rounds.get(i) {
            Some(r) => (class_of(r["D"].as_str().unwrap(), &srcs, &rules), class_of(r["G"].as_str().unwrap(), &srcs, &rules)),
            None => ("unresolved".to_string(), "unresolved".to_string()),
        }
    };
    let (d, g) = round(0);
    two_model_agree(&d, &g, &|| round(1))
}
fn paid(o: &str) -> Option<&str> { if o == "met" || o == "not_met" { Some(o) } else { None } }

/// Wording wrong winners R2 found even under the final prompt (pair D+G): the claim itself is under-specified.
/// BUILDER-PREVENTED (R2 README "Wrong winners on ambiguous wording: what the bet builder must prevent"):
/// relative date (aapl_friday) -> builder requires explicit date + time zone; name collision (georgia_top5) -> entity
/// from a picker; unit/scale + asset mismatch (nyc_low_lt17, wbtc_page_for_btc) -> unit field + asset identity;
/// scope (wc_goals_et, jax_3scores) -> numeric templates + explicit extra-time rule; wrongyear_sb -> borderline label
/// dispute. The judge prompt is only the second line of defence (v3 cut 16 -> 7).
const BUILDER_PREVENTED: [&str; 7] = ["w_date_aapl_friday", "w_name_georgia_top5", "w_other_jax_3scores", "w_other_wc_goals_et",
    "w_unans_wrongyear_sb", "w_unit_nyc_low_lt17", "w_unit_wbtc_page_for_btc"];

#[test]
fn j4_r2_adversarial_cases_pay_the_truth_or_void_exactly_as_expected() {
    let f = fx();
    let adv: Vec<&Value> = f["lane_c"].as_array().unwrap().iter().filter(|c| c["kind"] == "adversarial").collect();
    assert_eq!(adv.len(), 54);
    let mut bad = vec![];
    for c in adv {
        let want = c["expected"].as_str().unwrap();
        let got = pair_outcome(c);
        let want_paid = paid(want);
        if paid(&got) != want_paid { bad.push(format!("{}: want {} got {}", c["id"], want, got)); }
    }
    assert!(bad.is_empty(), "adversarial regressions: {:#?}", bad);
}

#[test]
fn j4_r2_wording_cases_expect_void_or_are_builder_prevented() {
    let f = fx();
    let wording: Vec<&Value> = f["lane_c"].as_array().unwrap().iter().filter(|c| c["kind"] == "wording" && c["id"].as_str().unwrap().starts_with("w_")).collect();
    assert_eq!(wording.len(), 62);
    let mut wrong = vec![];
    for c in &wording {
        let id = c["id"].as_str().unwrap();
        let want = c["expected"].as_str().unwrap();
        let got = pair_outcome(c);
        if BUILDER_PREVENTED.contains(&id) {
            // documented: the recorded judge answers pay here; only the builder rules stop it (see BUILDER_PREVENTED).
            assert_eq!(c["r2_class"], json!("WRONG"), "{} is listed builder-prevented but R2 did not record it as wrong", id);
            continue;
        }
        match paid(&got) {
            None => {}                                   // VOID: right for want=insufficient, a liveness cost otherwise
            Some(w) if Some(w) == paid(want) => {}       // paid the truth
            Some(w) => wrong.push(format!("{}: truth {} but paid {}", id, want, w)),
        }
        if paid(want).is_none() && paid(&got).is_some() { wrong.push(format!("{}: truth VOID but paid {}", id, got)); }
    }
    assert!(wrong.is_empty(), "wrong winners on wording: {:#?}", wrong);
    assert_eq!(BUILDER_PREVENTED.len(), 7);
}
