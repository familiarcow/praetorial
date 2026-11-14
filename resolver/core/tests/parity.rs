//! Parity tests: replay fixtures exported *without any model call* from the
//! real Python prototype (see judge-proto/export_fixtures.py) through this
//! Rust port's pure functions, and assert byte-identical prompts and
//! identical verdicts/decisions.

use praetorial_core::*;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;

fn load(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{}", env!("CARGO_MANIFEST_DIR"), name);
    let data = fs::read_to_string(&path).unwrap_or_else(|e| panic!("reading {}: {}", path, e));
    serde_json::from_str(&data).unwrap()
}

fn msgs_as_json(msgs: &[(String, String)]) -> Value {
    Value::Array(
        msgs.iter()
            .map(|(role, content)| serde_json::json!({"role": role, "content": content}))
            .collect(),
    )
}

#[test]
fn dispute1_appeal_matches_python() {
    let fx = load("dispute1_appeal.json");
    let cases = fx["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 7, "expected 7 decide_appeal cases");
    for c in cases {
        let standing = c["standing_outcome"].as_str().unwrap();
        let votes: Vec<String> = c["votes"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        let (outcome, reason) = decide_appeal(standing, &votes);
        assert_eq!(outcome, c["expect_outcome"].as_str().unwrap(), "decide_appeal outcome mismatch for case {}", c["name"]);
        assert_eq!(reason, c["expect_reason"].as_str().unwrap(), "decide_appeal reason mismatch for case {}", c["name"]);
    }
    let panels = fx["panels"].as_array().unwrap();
    assert_eq!(panels.len(), 2);
    for p in panels {
        let round_no = p["round_no"].as_u64().unwrap() as u32;
        let got = panel_for_round(round_no);
        let want_families: Vec<String> = p["panel"]["families"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        let got_families: Vec<String> = got.families.iter().map(|s| s.to_string()).collect();
        assert_eq!(got_families, want_families, "panel_for_round({round_no}) families mismatch");
        assert_eq!(got.debate, p["panel"]["debate"].as_bool().unwrap(), "panel_for_round({round_no}) debate flag mismatch");
    }
}

#[test]
fn revision_window_publisher_fix_matches_python() {
    // Nightly redteam fix (5bed7bf, revision_window_corrects_ignores_publisher_identity):
    // judge-proto/export_fixtures.py::revision_window_publisher_fixtures() exports pure
    // apply_revision_window() cases, no model calls. Same-publisher behaviour (timely
    // correction replaces original, late correction dropped) stays unchanged; a
    // cross-publisher `corrects` pointer must always be dropped, the real original must
    // always survive, both with byte-identical drop notes between Python and Rust.
    let fx = load("revision_window_publisher.json");
    let cases = fx["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 4, "expected 4 revision_window_publisher cases");
    for c in cases {
        let sources: Vec<Value> = c["sources"].as_array().unwrap().clone();
        let (kept, notes) = apply_revision_window(&sources, 24);
        let mut kept_ids: Vec<&str> = kept.iter().map(|s| s["id"].as_str().unwrap()).collect();
        kept_ids.sort();
        let want_ids: Vec<&str> = c["kept_ids"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(kept_ids, want_ids, "kept ids mismatch for {}", c["name"]);
        let want_notes: Vec<&str> = c["notes"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(notes, want_notes, "drop notes mismatch for {}", c["name"]);
    }
}

#[test]
fn resolve_ambiguous_element_matches_python() {
    // Item 7r3 parity fixture (judge-proto/export_fixtures.py ::
    // resolve_ambiguous_fixtures): replays the Python prototype's
    // resolve_ambiguous_element cases through the Rust port and asserts
    // byte-identical outcome/why strings.
    let fx = load("resolve_ambiguous.json");
    let cases = fx["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 5, "expected 5 resolve_ambiguous_element cases");
    for c in cases {
        let maker_side = c["maker_side"].as_str().unwrap();
        let is_library_clause = c["is_library_clause"].as_bool().unwrap();
        let unanimous_ambiguous = c["unanimous_ambiguous"].as_bool().unwrap();
        let reading_for_yes = c["reading_for_yes"].as_bool().unwrap();
        let reading_for_no = c["reading_for_no"].as_bool().unwrap();
        let patent = c["patent_ambiguity_flagged_and_accepted"].as_bool().unwrap();
        let got = resolve_ambiguous_element(
            maker_side, is_library_clause, unanimous_ambiguous, reading_for_yes, reading_for_no, patent,
        );
        let want_outcome = c["expect_outcome"].as_str();
        let want_why = c["expect_why"].as_str().unwrap();
        match (got, want_outcome) {
            (Some((outcome, why)), Some(want_outcome)) => {
                assert_eq!(outcome, want_outcome, "resolve_ambiguous_element outcome mismatch for case {}", c["name"]);
                assert_eq!(why, want_why, "resolve_ambiguous_element why mismatch for case {}", c["name"]);
            }
            (None, None) => {}
            (got, want) => panic!("resolve_ambiguous_element None/Some mismatch for case {}: got {:?}, want outcome {:?}", c["name"], got, want),
        }
    }
}

#[test]
fn lint_matches_python() {
    let fx = load("lint.json");
    let cases = fx["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 6, "expected 6 lint cases (5 attack + baseline)");
    for c in cases {
        let got = lint(&c["ts"]);
        let want: Vec<String> = c["problems"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert_eq!(got, want, "lint mismatch for case {}", c["name"]);
    }
}

#[test]
fn verifier_attacks_match_python() {
    let fx = load("verifier.json");
    let cases = fx["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 10);
    for c in cases {
        let sources: Vec<Value> = c["sources"].as_array().unwrap().clone();
        let rules_text = c["rules_text"].as_str().unwrap();
        let (answer, extra) = verify(c["raw"].as_str().unwrap(), &sources, rules_text);
        assert_eq!(answer, c["expect_answer"].as_str().unwrap(), "answer mismatch for {}", c["name"]);
        let want_extra = c["expect_extra"].as_str().map(|s| s.to_string());
        assert_eq!(extra, want_extra, "extra mismatch for {}", c["name"]);
    }
}

// Explicit named versions of the 6 attacks the task calls out, so they read
// as dedicated unit tests even though they're also covered generically above.
#[test]
fn verifier_attack_fabricated_quote_is_invalid() {
    let srcs = vec![serde_json::json!({"id": "S1", "text": "Apple today announced iPhone Fold. Pre-orders begin December 18, 2027.", "party_controlled": false})];
    let (a, _) = verify(r#"{"answer":"met","quote":"iPhone Fold is available today in the United States","source_id":"S1"}"#, &srcs, "Question: available?");
    assert_eq!(a, "invalid");
}

#[test]
fn verifier_attack_quote_from_rules_is_invalid() {
    let srcs = vec![serde_json::json!({"id": "S1", "text": "Apple today announced iPhone Fold.", "party_controlled": false})];
    let rules = "Question: Did Apple make iPhone Fold available to purchase in the United States?";
    let (a, _) = verify(&format!(r#"{{"answer":"met","quote":"{}","source_id":"S1"}}"#, "Did Apple make iPhone Fold available to purchase in the United States"), &srcs, rules);
    assert_eq!(a, "invalid");
}

#[test]
fn verifier_attack_unknown_source_is_invalid() {
    let srcs = vec![serde_json::json!({"id": "S1", "text": "Apple today announced iPhone Fold.", "party_controlled": false})];
    let (a, _) = verify(r#"{"answer":"met","quote":"Apple today announced iPhone Fold","source_id":"S7"}"#, &srcs, "rules");
    assert_eq!(a, "invalid");
}

#[test]
fn verifier_attack_bad_schema_is_invalid() {
    let srcs: Vec<Value> = vec![];
    let (a, _) = verify(r#"{"answer":"probably"}"#, &srcs, "rules");
    assert_eq!(a, "invalid");
}

#[test]
fn verifier_attack_zero_width_quote_is_defeated_by_normalization() {
    let srcs = vec![serde_json::json!({"id": "S1", "text": "Pre-orders begin December 18, 2027.", "party_controlled": false})];
    let (a, _) = verify("{\"answer\":\"not_met\",\"quote\":\"Pre-\u{200b}orders begin December 18, 2027\",\"source_id\":\"S1\"}", &srcs, "rules");
    assert_eq!(a, "not_met", "zero-width char must be stripped so the quote still matches");
}

#[test]
fn verifier_attack_tiny_quote_is_invalid() {
    let srcs = vec![serde_json::json!({"id": "S1", "text": "Apple today announced iPhone Fold.", "party_controlled": false})];
    let (a, _) = verify(r#"{"answer":"met","quote":"iPhone","source_id":"S1"}"#, &srcs, "rules");
    assert_eq!(a, "invalid");
}

#[test]
fn redteam_cases_match_python() {
    let fx = load("redteam.json");
    let cases = fx["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 18, "expected all 18 redteam cases");
    for c in cases {
        let ts = &c["ts"];
        let src: Vec<Value> = c["src"].as_array().unwrap().clone();
        let (eligible, dropped) = eligible_sources(ts, &src);
        let want_dropped: Vec<String> = c["dropped"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert_eq!(dropped, want_dropped, "eligibility drop notes mismatch for {}", c["name"]);
        let want_eligible = c["eligible_sources"].clone();
        assert_eq!(Value::Array(eligible.clone()), want_eligible, "eligible source set mismatch for {}", c["name"]);

        let mut verdicts_ordered = Vec::new();
        for el in ts["elements"].as_array().unwrap() {
            let el_id = el["id"].as_str().unwrap();
            let fx_el = &c["elements"][el_id];

            // byte-identical prompt check
            let msgs = build_messages(ts, el, &eligible);
            assert_eq!(msgs_as_json(&msgs), fx_el["messages"], "prompt not byte-identical for {} / {}", c["name"], el_id);

            let rules_text = msgs[1].1.split("</rules>").next().unwrap();
            assert_eq!(rules_text, fx_el["rules_text"].as_str().unwrap(), "rules_text mismatch for {} / {}", c["name"], el_id);

            // verify() parity on the exact same raw completions Python used
            let raws: Vec<String> = fx_el["raw_answers"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
            let results: Vec<(String, Option<String>)> = raws.iter().map(|r| verify(r, &eligible, rules_text)).collect();
            let want_results: Vec<(String, Option<String>)> = fx_el["verify_results"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| {
                    let arr = r.as_array().unwrap();
                    (arr[0].as_str().unwrap().to_string(), arr[1].as_str().map(|s| s.to_string()))
                })
                .collect();
            assert_eq!(results, want_results, "verify() mismatch for {} / {}", c["name"], el_id);

            let verdict = element_verdict(&results, ts, &eligible);
            assert_eq!(verdict, fx_el["verdict"].as_str().unwrap(), "element_verdict mismatch for {} / {}", c["name"], el_id);
            verdicts_ordered.push(verdict);
        }

        let (outcome, why) = decide(ts, &verdicts_ordered);
        assert_eq!(outcome, c["decision"]["outcome"].as_str().unwrap(), "decide() outcome mismatch for {}", c["name"]);
        assert_eq!(why, c["decision"]["why"].as_str().unwrap(), "decide() why mismatch for {}", c["name"]);
        let expect: Vec<&str> = c["expect"].as_str().unwrap().split('|').collect();
        assert!(expect.contains(&outcome.as_str()), "{}: outcome {} not in expected {:?}", c["name"], outcome, expect);
    }
}

#[test]
fn evidence_cases_match_python() {
    let fx = load("evidence.json");
    let cases = fx["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 16, "expected all 16 evidence cases (+2 for item 7r1 brief/rebuttal caps)");
    for c in cases {
        let term = &c["term"];
        let exhibits: Vec<Value> = c["exhibits"].as_array().unwrap().clone();
        let window_close = c["window_close"].as_str().unwrap();
        let (admitted, rejected) = admit(term, &exhibits, window_close);
        let want_rejected: Vec<(String, String, String)> = c["rejected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                let a = r.as_array().unwrap();
                (a[0].as_str().unwrap().to_string(), a[1].as_str().unwrap().to_string(), a[2].as_str().unwrap().to_string())
            })
            .collect();
        assert_eq!(rejected, want_rejected, "admit() rejections mismatch for {}", c["name"]);
        assert_eq!(Value::Array(admitted.clone()), c["admitted"], "admit() admitted set mismatch for {}", c["name"]);

        let briefs: Vec<Value> = c["briefs"].as_array().unwrap().clone();
        let (claims, struck) = check_claims(&briefs, &admitted);
        assert_eq!(Value::Array(claims.clone()), c["claims"], "check_claims() ok-claims mismatch for {}", c["name"]);
        let want_struck: Vec<(String, String, String)> = c["struck"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| {
                let a = r.as_array().unwrap();
                (a[0].as_str().unwrap().to_string(), a[1].as_str().unwrap().to_string(), a[2].as_str().unwrap().to_string())
            })
            .collect();
        assert_eq!(struck, want_struck, "check_claims() struck mismatch for {}", c["name"]);

        let mut verdicts_ordered = Vec::new();
        for el in term["elements"].as_array().unwrap() {
            let el_id = el["id"].as_str().unwrap();
            let fx_trail = c["trails"][el_id].as_array().unwrap();
            let mut raw_by_tier: BTreeMap<i64, Vec<String>> = BTreeMap::new();
            for t in fx_trail {
                raw_by_tier.insert(
                    t["tier"].as_i64().unwrap(),
                    t["raw_answers"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect(),
                );
            }
            let (v, trail) = judge_element_tiered_fixed(term, el, &admitted, &claims, &raw_by_tier);
            assert_eq!(trail.len(), fx_trail.len(), "tier trail length mismatch for {} / {}", c["name"], el_id);
            for (got, want) in trail.iter().zip(fx_trail.iter()) {
                assert_eq!(got.tier, want["tier"].as_i64().unwrap(), "tier mismatch for {} / {}", c["name"], el_id);
                assert_eq!(got.verdict, want["verdict"].as_str().unwrap(), "tier verdict mismatch for {} / {}", c["name"], el_id);
                assert_eq!(msgs_as_json(&got.messages), want["messages"], "tier prompt not byte-identical for {} / {}", c["name"], el_id);
            }
            let stored = if v == "insufficient" { "not_met".to_string() } else { v };
            assert_eq!(stored, c["verdicts"][el_id].as_str().unwrap(), "stored verdict mismatch for {} / {}", c["name"], el_id);
            verdicts_ordered.push(stored);
        }

        let (outcome, why) = if !admitted.is_empty() {
            decide(term, &verdicts_ordered)
        } else {
            ("NO".to_string(), "no admissible evidence (burden on YES)".to_string())
        };
        assert_eq!(outcome, c["decision"]["outcome"].as_str().unwrap(), "evidence decide() outcome mismatch for {}", c["name"]);
        assert_eq!(why, c["decision"]["why"].as_str().unwrap(), "evidence decide() why mismatch for {}", c["name"]);
        let expect: Vec<&str> = c["expect"].as_str().unwrap().split('|').collect();
        assert!(expect.contains(&outcome.as_str()), "{}: outcome {} not in expected {:?}", c["name"], outcome, expect);
    }
}

#[test]
fn clauses_v2_cases_match_python() {
    // v2 clause corpus (10 Kalshi/Polymarket-derived clauses, 30 scenarios): see
    // judge-proto/clauses_redteam.py. Exercises the two new deterministic code hooks
    // (no_data_available, apply_revision_window) plus byte-identical prompts for the
    // seven prompt-only clauses, through the same verify/element_verdict/decide pipeline.
    let fx = load("clauses.json");
    let cases = fx["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 30, "expected all 30 v2 clause scenarios");
    for c in cases {
        let ts = &c["ts"];
        let src: Vec<Value> = c["src"].as_array().unwrap().clone();
        let clauses: std::collections::BTreeSet<&str> = ts["clauses"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();

        let (mut eligible, mut dropped) = eligible_sources(ts, &src);
        if clauses.contains("REVISION_WINDOW_V1") {
            let (kept, rw_notes) = apply_revision_window(&eligible, 24);
            eligible = kept;
            dropped.extend(rw_notes);
        }
        assert_eq!(dropped, c["dropped"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect::<Vec<_>>(), "drop notes mismatch for {}", c["name"]);
        assert_eq!(Value::Array(eligible.clone()), c["eligible_sources"], "eligible source set mismatch for {}", c["name"]);

        let code_voided = c["code_voided"].as_bool().unwrap_or(false);
        let no_data_clause = clauses.contains("SOURCE_SUBSTITUTION_V1") || clauses.contains("NO_DATA_FALLBACK_V1");
        assert_eq!(no_data_clause && no_data_available(&eligible), code_voided, "no_data_available() mismatch for {}", c["name"]);

        let outcome = if code_voided {
            "VOID".to_string()
        } else {
            let mut verdicts_ordered = Vec::new();
            for el in ts["elements"].as_array().unwrap() {
                let el_id = el["id"].as_str().unwrap();
                let fx_el = &c["elements"][el_id];
                let msgs = build_messages(ts, el, &eligible);
                assert_eq!(msgs_as_json(&msgs), fx_el["messages"], "prompt not byte-identical for {} / {}", c["name"], el_id);
                let rules_text = msgs[1].1.split("</rules>").next().unwrap();
                let raws: Vec<String> = fx_el["raw_answers"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
                let results: Vec<(String, Option<String>)> = raws.iter().map(|r| verify(r, &eligible, rules_text)).collect();
                let verdict = element_verdict(&results, ts, &eligible);
                assert_eq!(verdict, fx_el["verdict"].as_str().unwrap(), "element_verdict mismatch for {} / {}", c["name"], el_id);
                verdicts_ordered.push(verdict);
            }
            let (outcome, _why) = decide(ts, &verdicts_ordered);
            outcome
        };
        assert_eq!(outcome, c["decision"]["outcome"].as_str().unwrap(), "decide() outcome mismatch for {}", c["name"]);
        let expect: Vec<&str> = c["expect"].as_str().unwrap().split('|').collect();
        assert!(expect.contains(&outcome.as_str()), "{}: outcome {} not in expected {:?}", c["name"], outcome, expect);
    }
}

#[test]
fn receipt_hash_is_deterministic() {
    let r = Receipt {
        schema: "praetorial-receipt-v1".into(),
        bet_id: "bet-1".into(),
        spec_hash: "sha256:abc".into(),
        resolver_wasm_hash: "sha256:def".into(),
        template_version: TEMPLATE_VERSION.into(),
        checked_until: "2027-10-06T19:00:00Z".into(),
        sources: serde_json::json!([{"id": "S1", "sha256": "aaa"}]),
        elements: serde_json::json!([{"id": "e1", "verdict": "met"}]),
        decision: serde_json::json!({"outcome": "YES", "rule": "ALL"}),
    };
    let h1 = receipt_hash(&r);
    let h2 = receipt_hash(&r);
    assert_eq!(h1, h2, "same input must hash identically");
    assert_eq!(h1.len(), 64);
    // Key order must not matter (JCS sorts keys).
    let v = r.to_value();
    let shuffled = serde_json::json!({
        "decision": v["decision"], "elements": v["elements"], "bet_id": v["bet_id"],
        "schema": v["schema"], "sources": v["sources"], "checked_until": v["checked_until"],
        "spec_hash": v["spec_hash"], "resolver": v["resolver"],
    });
    assert_eq!(canonical_json(&shuffled), canonical_json(&v), "canonicalization must be key-order independent");
}

#[test]
fn engine_gaps_lint_matches_python() {
    // Item 15 (engine-gaps-from-bettypes): origin-count independence, coverage rule for absence bets,
    // market_pin / repo_pin per-bet-type required fields, `$` regex anchor not a price claim,
    // unresolved_at_cutoff validation. Fixture exported from Python J.lint.
    let fx = load("engine_gaps.json");
    let cases = fx["lint_cases"].as_array().unwrap();
    assert_eq!(cases.len(), 21, "expected 21 engine-gap lint cases");
    for c in cases {
        let got = lint(&c["ts"]);
        let want: Vec<String> = c["problems"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert_eq!(got, want, "engine-gap lint mismatch for case {}", c["name"]);
    }
}

#[test]
fn engine_gaps_unresolved_at_cutoff_matches_python() {
    let fx = load("engine_gaps.json");
    let cases = fx["recovery_cases"].as_array().unwrap();
    assert_eq!(cases.len(), 4);
    for c in cases {
        let setting = c["unresolved_at_cutoff"].as_str();
        let first = c["first_unavailable_at"].as_str();
        let r = resolve_with_recovery_cutoff(c["now"].as_str().unwrap(), first, c["window_close"].as_str().unwrap(), setting == Some("VOID"));
        let want = c["outcome"].as_str().unwrap();
        assert_eq!(r.outcome.split(':').next().unwrap(), want, "outcome mismatch for {}", c["name"]);
        assert_eq!(r.next_check.as_deref(), c["next_check"].as_str(), "next_check mismatch for {}", c["name"]);
        if want == "VOID" && setting == Some("VOID") {
            assert_eq!(r.why, c["why"].as_str().unwrap(), "why mismatch for {}", c["name"]);
        }
    }
}
