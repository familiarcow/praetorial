//! Item 17c5 (D-TPL1, D-JUDGE4): AI audit of a typed template's CODE outcome. The audit may only confirm the code outcome or
//! force VOID ("audit disagreed"): agree -> stands; disagree -> exactly one re-run -> still disagrees -> VOID. It never yields a
//! different winner. Scripted judge only (no model call). Covers BTC (close + touch), nws_daily_high and game_winner.
use super::*;
use serde_json::json;
use std::cell::RefCell;
use std::collections::VecDeque;

use super::item17c2_tests as c2;
use super::item17c3_tests as c3;
use super::item17c4_tests as c4;

const AGREE: &str = r#"{"audit":"agree"}"#;
const FLAG: &str = r#"{"audit":"flag"}"#;

/// Scripted judge: pops one reply per call (the last repeats); records every prompt.
struct Script {
    replies: RefCell<VecDeque<String>>,
    prompts: RefCell<Vec<String>>,
}
impl Script {
    fn new(r: &[&str]) -> Script {
        Script { replies: RefCell::new(r.iter().map(|s| s.to_string()).collect()), prompts: RefCell::new(vec![]) }
    }
    fn calls(&self) -> usize { self.prompts.borrow().len() }
    fn prompt(&self, i: usize) -> String { self.prompts.borrow()[i].clone() }
}
impl ModelCaller for Script {
    fn call(&self, _m: &str, msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        self.prompts.borrow_mut().push(msgs.iter().map(|(r, c)| format!("[{}] {}", r, c)).collect::<Vec<_>>().join("\n"));
        let mut q = self.replies.borrow_mut();
        let r = if q.len() > 1 { q.pop_front().unwrap() } else { q.front().cloned().unwrap_or_default() };
        (r, None, None)
    }
}

fn job_for(sheet: &Value) -> Value {
    let raw = sheet.to_string();
    json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 1, "checked_until": 0, "round": 0, "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw})
}
fn has(n: &[String], s: &str) -> bool { n.iter().any(|x| x.contains(s)) }

type Run = Box<dyn Fn(&dyn ModelCaller) -> (String, Vec<String>)>;
fn sports(sh: Value) -> Run {
    Box::new(move |j| {
        let (r, n, _) = build_submission_judged_at(&job_for(&sh), j, &c4::Fx4::recorded(), false, c4::now());
        (r.outcome, n)
    })
}
fn weather(op: &'static str, x: i64) -> Run {
    Box::new(move |j| {
        let (r, n, _) = build_submission_judged_at(&job_for(&c3::sheet("KNYC", "2026-11-05", op, x)), j, &c3::Fx3::recorded(), false, c3::now());
        (r.outcome, n)
    })
}
fn btc_close(op: &'static str, x: i64) -> Run {
    Box::new(move |j| {
        let (_, t) = c2::ev("A");
        let (r, n, _) = build_submission_judged_at(&job_for(&c2::close_sheet("A", op, x)), j, &c2::f("A", &[]), false, t + 300);
        (r.outcome, n)
    })
}
fn btc_touch(x: i64) -> Run {
    Box::new(move |j| {
        let (_, t) = c2::ev("A");
        let (r, n, _) = build_submission_judged_at(&job_for(&c2::touch_sheet("A", "at_or_above", x)), j, &c2::f("A", &[]), false, t + 300);
        (r.outcome, n)
    })
}
fn scenarios() -> Vec<(&'static str, &'static str, Run)> {
    vec![
        ("sports", "YES", sports(c4::nsh())),
        ("sports", "NO", sports(c4::col())),
        ("weather", "YES", weather(">=", 72)),
        ("weather", "NO", weather(">=", 73)),
        ("btc_close", "YES", btc_close(">", 75900)),
        ("btc_close", "NO", btc_close(">", 75925)),
        ("btc_touch", "YES", btc_touch(75930)),
        ("btc_touch", "NO", btc_touch(75970)),
    ]
}

// ---------------------------------------------------------------- agree -> the code outcome stands, one audit call
#[test]
fn audit_agrees_code_outcome_stands_with_one_call() {
    for (name, want, run) in scenarios() {
        let j = Script::new(&[AGREE]);
        let (o, n) = run(&j);
        assert_eq!(o, want, "{} {:?}", name, n);
        assert_eq!(j.calls(), 1, "{}: exactly one audit call when it agrees", name);
    }
}
// ---------------------------------------------------------------- the audit question carries the outcome, rule and extracted values
#[test]
fn audit_prompt_carries_outcome_rendered_rule_and_extracted_values() {
    let j = Script::new(&[AGREE]);
    let _ = sports(c4::nsh())(&j);
    let p = j.prompt(0);
    assert!(p.contains("<proposal>YES</proposal>"), "{}", p);
    assert!(p.contains("Nashville Predators") && p.contains("2026020261"), "rendered rule: {}", p);
    assert!(p.contains("\"winner_team_id\"") && p.contains("\"pick_team_id\""), "extracted values: {}", p);

    let j = Script::new(&[AGREE]);
    let _ = weather(">=", 72)(&j);
    let p = j.prompt(0);
    assert!(p.contains("KNYC") && p.contains("\"nws_max\"") && p.contains("\"iem_high\""), "{}", p);

    let j = Script::new(&[AGREE]);
    let _ = btc_close(">", 75900)(&j);
    let p = j.prompt(0);
    assert!(p.contains("\"closes\"") && p.contains("Coinbase") && p.contains("\"aggregate_close\""), "{}", p);

    let j = Script::new(&[AGREE]);
    let _ = btc_touch(75930)(&j);
    let p = j.prompt(0);
    assert!(p.contains("\"venues\"") && p.contains("Crossed"), "{}", p);
}
// ---------------------------------------------------------------- disagree then agree on the re-run -> code outcome, two calls
#[test]
fn audit_disagrees_then_agrees_on_rerun_code_outcome_stands() {
    for (name, want, run) in scenarios() {
        let j = Script::new(&[FLAG, AGREE]);
        let (o, n) = run(&j);
        assert_eq!(o, want, "{} {:?}", name, n);
        assert_eq!(j.calls(), 2, "{}: one audit + exactly one re-run", name);
    }
}
// ---------------------------------------------------------------- disagree twice -> VOID "audit disagreed", exactly one re-run
#[test]
fn audit_disagrees_twice_is_void_audit_disagreed_after_exactly_one_rerun() {
    for (name, _want, run) in scenarios() {
        let j = Script::new(&[FLAG, FLAG, AGREE, AGREE]);
        let (o, n) = run(&j);
        assert_eq!(o, "VOID", "{} {:?}", name, n);
        assert!(has(&n, "audit disagreed"), "{} {:?}", name, n);
        assert_eq!(j.calls(), 2, "{}: exactly one re-run, never a third call", name);
    }
}
// ---------------------------------------------------------------- the AI never produces a different winner
#[test]
fn audit_answering_the_opposite_side_never_flips_the_winner() {
    for (name, want, run) in scenarios() {
        let other = if want == "YES" { "NO" } else { "YES" };
        for bad in [
            format!(r#"{{"audit":"flag","outcome":"{}"}}"#, other),
            format!(r#"{{"audit":"{}"}}"#, other),
            format!(r#"{{"audit":"flag","proposal":"{}","winner":"other team"}}"#, other),
            other.to_string(),
        ] {
            let j = Script::new(&[bad.as_str()]);
            let (o, n) = run(&j);
            assert_eq!(o, "VOID", "{} {} {:?}", name, bad, n);
            assert_ne!(o, other);
            assert_eq!(j.calls(), 2, "{} {}", name, bad);
        }
        // an agree that also names the opposite outcome still leaves the CODE outcome standing
        let agree_other = format!(r#"{{"audit":"agree","outcome":"{}"}}"#, other);
        let j = Script::new(&[agree_other.as_str()]);
        let (o, n) = run(&j);
        assert_eq!(o, want, "{} {:?}", name, n);
    }
}
// ---------------------------------------------------------------- non-exact / unreadable audit replies count as disagreement
#[test]
fn audit_unreadable_or_non_strict_replies_count_as_disagreement() {
    for bad in ["", "agree", "I agree.", r#"{"audit":"Agree"}"#, r#"{"audit":"agree"} and more"#, r#"{"audit":["agree"]}"#, "{}"] {
        let j = Script::new(&[bad]);
        let (o, n) = sports(c4::nsh())(&j);
        assert_eq!(o, "VOID", "{:?} {:?}", bad, n);
        assert!(has(&n, "audit disagreed"), "{:?}", n);
        assert_eq!(j.calls(), 2, "{:?}", bad);
    }
}
// ---------------------------------------------------------------- decisions that are not YES/NO never reach the judge
#[test]
fn audit_is_not_called_for_void_or_retry_code_decisions() {
    // sports: before start + 4h -> RETRY; judge must not be called
    let j = Script::new(&[AGREE]);
    let (r, _n, _) = build_submission_judged_at(&job_for(&c4::nsh()), &j, &c4::Fx4::recorded(), false, c4::t("2026-11-05T22:00:00Z"));
    assert_eq!(r.outcome, "RETRY");
    assert_eq!(j.calls(), 0);
    // btc: no venue reachable -> VOID by code
    let j = Script::new(&[AGREE]);
    let (_, t) = c2::ev("A");
    let fx = c2::f("A", &["coinbase", "bitstamp", "kraken", "binance.us"]);
    let (r, _n, _) = build_submission_judged_at(&job_for(&c2::close_sheet("A", ">", 75900)), &j, &fx, false, t + 300);
    assert_eq!(r.outcome, "VOID");
    assert_eq!(j.calls(), 0);
    // weather: nothing fetched -> RETRY/VOID by code
    let j = Script::new(&[AGREE]);
    let (r, _n, _) = build_submission_judged_at(&job_for(&c3::sheet("KNYC", "2026-11-05", ">=", 72)), &j, &c3::Fx3::empty(), false, c3::now());
    assert_ne!(r.outcome, "YES");
    assert_ne!(r.outcome, "NO");
    assert_eq!(j.calls(), 0);
}

// ---------------------------------------------------------------- planted wrong code value: the audit catches it -> VOID
/// A scripted judge that really audits: reads the question's <extracted> JSON and answers `agree` only when the quoted values
/// support the proposed outcome under the template's rule.
struct Auditor {
    calls: RefCell<usize>,
}
impl Auditor {
    fn verdict(prompt: &str) -> &'static str {
        let proposal = if prompt.contains("<proposal>YES</proposal>") { "YES" } else { "NO" };
        let a = prompt.find("<extracted>").expect("prompt has <extracted>") + "<extracted>".len();
        let b = prompt.find("</extracted>").expect("prompt has </extracted>");
        let x: Value = serde_json::from_str(&prompt[a..b]).expect("extracted is JSON");
        let holds = match x["kind"].as_str().unwrap_or("") {
            "game_winner" => x["winner_team_id"] == x["pick_team_id"],
            "nws_daily_high" => {
                let (v, t) = (x["nws_max"].as_i64().unwrap(), x["x_f"].as_i64().unwrap());
                if x["op"] == ">=" { v >= t } else { v <= t }
            }
            "btc_close_at_t" => {
                let (v, t) = (x["aggregate_close"].as_f64().unwrap(), x["x_usd"].as_f64().unwrap());
                match x["op"].as_str().unwrap() { ">" => v > t, ">=" => v >= t, "<" => v < t, _ => v <= t }
            }
            "btc_touch" => x["venues"].as_array().unwrap().iter().filter(|v| v["state"] == "Crossed").count() >= 2,
            k => panic!("unknown kind {}", k),
        };
        if (proposal == "YES") == holds { "agree" } else { "flag" }
    }
}
impl ModelCaller for Auditor {
    fn call(&self, _m: &str, msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        *self.calls.borrow_mut() += 1;
        let p = msgs.iter().map(|(_, c)| c.as_str()).collect::<Vec<_>>().join("\n");
        (format!(r#"{{"audit":"{}"}}"#, Auditor::verdict(&p)), None, None)
    }
}
fn audit_direct(rule: &str, outcome: &str, extracted: Value) -> (template_audit::AuditResult, usize) {
    let a = Auditor { calls: RefCell::new(0) };
    let r = template_audit::audit_code_outcome(&a, "mock", rule, outcome, &extracted);
    let n = *a.calls.borrow();
    (r, n)
}
#[test]
fn planted_swapped_team_id_is_caught_by_the_audit() {
    let rule = "Did the Nashville Predators (team 18) win NHL game 2026020261?";
    let (r, n) = audit_direct(rule, "YES", json!({"kind": "game_winner", "pick_team_id": "18", "winner_team_id": "18"}));
    assert_eq!((r.outcome.as_str(), n), ("YES", 1));
    // the code swapped the team ids: it says YES but the quoted values show team 21 won
    let (r, n) = audit_direct(rule, "YES", json!({"kind": "game_winner", "pick_team_id": "18", "winner_team_id": "21"}));
    assert_eq!(r.outcome, "VOID", "{}", r.note);
    assert!(r.note.contains("audit disagreed"));
    assert_eq!(n, 2);
}
#[test]
fn planted_wrong_temperature_is_caught_by_the_audit() {
    let rule = "Was the KNYC high on 2026-11-05 >= 72 F?";
    let (r, _) = audit_direct(rule, "YES", json!({"kind": "nws_daily_high", "op": ">=", "x_f": 72, "nws_max": 72}));
    assert_eq!(r.outcome, "YES");
    let (r, n) = audit_direct(rule, "YES", json!({"kind": "nws_daily_high", "op": ">=", "x_f": 72, "nws_max": 68}));
    assert_eq!((r.outcome.as_str(), n), ("VOID", 2));
    // a NO the values do not support is caught too, never turned into YES
    let (r, _) = audit_direct(rule, "NO", json!({"kind": "nws_daily_high", "op": ">=", "x_f": 72, "nws_max": 80}));
    assert_eq!(r.outcome, "VOID");
}
#[test]
fn planted_wrong_price_is_caught_by_the_audit() {
    let rule = "Was the BTC close at T > 75900 USD?";
    let (r, _) = audit_direct(rule, "YES", json!({"kind": "btc_close_at_t", "op": ">", "x_usd": 75900, "aggregate_close": 75925.0}));
    assert_eq!(r.outcome, "YES");
    let (r, n) = audit_direct(rule, "YES", json!({"kind": "btc_close_at_t", "op": ">", "x_usd": 75900, "aggregate_close": 75100.0}));
    assert_eq!((r.outcome.as_str(), n), ("VOID", 2));
}
// the real readers' extracted values must carry what the auditing judge needs (the honest auditor agrees with every real outcome)
#[test]
fn real_reader_extracted_values_satisfy_the_auditing_judge() {
    for (name, want, run) in scenarios() {
        let a = Auditor { calls: RefCell::new(0) };
        let (o, n) = run(&a);
        assert_eq!(o, want, "{} {:?}", name, n);
        assert_eq!(*a.calls.borrow(), 1, "{}: honest auditor agrees first time", name);
    }
}
