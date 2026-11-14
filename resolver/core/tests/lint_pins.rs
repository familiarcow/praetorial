//! RED/GREEN: DR-RES-3 (cashtag claims are price-like) and DR-RES-2
//! (case-insensitive / url-host market_pin & repo_pin triggers).
//! Mirrors judge-proto/test_lint_pins_v1.py; term sheets come from the
//! engine_gaps.json parity fixture so both engines see the same input.
use praetorial_core::*;
use serde_json::{json, Value};
use std::fs;

fn case_ts(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/engine_gaps.json", env!("CARGO_MANIFEST_DIR"));
    let fx: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    fx["lint_cases"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap()["ts"].clone()
}

fn with(ts: &Value, k: &str, v: Value) -> Value {
    let mut t = ts.clone();
    t[k] = v;
    t
}

fn no_bettype(ts: &Value, pubs: &[Value]) -> Value {
    let mut t = ts.clone();
    let o = t.as_object_mut().unwrap();
    for k in ["bettype", "market_pin", "repo_pin"] {
        o.remove(k);
    }
    t["sources_allowed"] = Value::Array(pubs.to_vec());
    t
}

fn has(p: &[String], needle: &str) -> bool {
    p.iter().any(|x| x.contains(needle))
}

#[test]
fn cashtag_claim_without_ticker_pins_rejected() {
    let gh = case_ts("github_release_ok");
    let t = with(&gh, "claim", json!("$BTC closes above 100k on Coinbase by 2026-12-31"));
    assert!(has(&lint(&t), "ticker"), "{:?}", lint(&t));
    let t = with(&with(&gh, "claim", json!("Bitcoin closes above 100k")), "elements", json!([{"id":"e1","q":"Does $ETH close above 5k?"}]));
    assert!(has(&lint(&t), "ticker"), "{:?}", lint(&t));
}

#[test]
fn regex_end_anchor_still_not_price_like() {
    let gh = case_ts("github_release_ok");
    let t = with(&gh, "claim", json!("A tag matching ^v2$ is published"));
    assert!(!has(&lint(&t), "ticker"), "{:?}", lint(&t));
    let t = with(&gh, "claim", json!("A release whose tag matches ^v2\\.15\\.\\d+$ is published"));
    assert!(!has(&lint(&t), "ticker"), "{:?}", lint(&t));
}

#[test]
fn lowercase_polymarket_publisher_requires_market_pin() {
    let pm = case_ts("polymarket_ok");
    for p in ["polymarket.com", "POLYMARKET", "gamma-api.polymarket.com"] {
        let t = no_bettype(&pm, &[json!({"id":"S0","publisher":p})]);
        assert!(has(&lint(&t), "market_pin required"), "{p}: {:?}", lint(&t));
    }
}

#[test]
fn lowercase_github_publisher_requires_repo_pin() {
    let gh = case_ts("github_release_ok");
    for p in ["api.github.com", "github.com", "GITHUB REST"] {
        let t = no_bettype(&gh, &[json!({"id":"S0","publisher":p})]);
        assert!(has(&lint(&t), "repo_pin required"), "{p}: {:?}", lint(&t));
    }
}

#[test]
fn source_url_host_triggers_pin_requirement() {
    let gh = case_ts("github_release_ok");
    let t = no_bettype(&gh, &[json!({"id":"S0","publisher":"Release feed","url":"https://api.github.com/repositories/1/releases"})]);
    assert!(has(&lint(&t), "repo_pin required"), "{:?}", lint(&t));
    let pm = case_ts("polymarket_ok");
    let t = no_bettype(&pm, &[json!({"id":"S0","publisher":"Market feed","url":"https://gamma-api.polymarket.com/markets/1"})]);
    assert!(has(&lint(&t), "market_pin required"), "{:?}", lint(&t));
}

#[test]
fn unrelated_publisher_not_pin_gated() {
    let gh = case_ts("github_release_ok");
    let t = no_bettype(&gh, &[json!({"id":"S0","publisher":"bls.gov"})]);
    let p = lint(&t);
    assert!(!has(&p, "repo_pin") && !has(&p, "market_pin"), "{:?}", p);
}
