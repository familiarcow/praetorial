//! RTE4b / D-RTE4a: decide a case from per-tier raw model completions THE WAY THE RESOLVER DOES (production semantics).
//! Used by judge-proto/redteam_evidence/production_pair.py so the fast gate has ONE decision implementation (Rust).
//!
//! stdin:  {"ts":..,"admitted":[..],"claims":[..],"as_of":<unix|null>,
//!          "raws":{"<element id>":{"<tier>":["<raw completion>", ..]}}}      (one raw per model, in model order)
//! stdout: {"verdicts":{"<element id>":"<verdict>"},"outcome_raw":"YES|NO|ESCALATE|VOID","why":..,"outcome":"YES|NO|VOID"}
//!
//! Path = `judge_element_tiered_at` per element (verify + element_verdict_origins + tier fall-through), the wasm-bin
//! rule (an element verdict "insufficient" is stored as "insufficient", never rewritten to not_met: R3/D-JUDGE4),
//! `decide`, and wasm-bin `map_decision_outcome` (ESCALATE -> VOID, everything else unchanged).
//! No admitted exhibit -> NO (burden on YES), exactly like wasm-bin's resolve path.
use std::io::Read;
fn main() {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).unwrap();
    let v: serde_json::Value = serde_json::from_str(&s).unwrap();
    let ts = &v["ts"];
    let admitted = v["admitted"].as_array().cloned().unwrap_or_default();
    let claims = v["claims"].as_array().cloned().unwrap_or_default();
    let as_of = v["as_of"].as_i64();
    let mut verdicts = serde_json::Map::new();
    let mut ordered: Vec<String> = vec![];
    for el in ts["elements"].as_array().cloned().unwrap_or_default() {
        let id = el["id"].as_str().unwrap_or("").to_string();
        let (verdict, _trail) = praetorial_core::judge_element_tiered_at(ts, &el, &admitted, &claims, as_of, |tier, _srcs| {
            v["raws"][&id][tier.to_string()].as_array().cloned().unwrap_or_default().iter().map(|r| r.as_str().unwrap_or("").to_string()).collect()
        });
        verdicts.insert(id, serde_json::Value::String(verdict.clone())); // insufficient stays insufficient
        ordered.push(verdict);
    }
    let (outcome_raw, why) = if !admitted.is_empty() {
        praetorial_core::decide(ts, &ordered)
    } else {
        ("NO".to_string(), "no admissible evidence (burden on YES)".to_string())
    };
    let outcome = if outcome_raw == "ESCALATE" { "VOID".to_string() } else { outcome_raw.clone() }; // wasm-bin map_decision_outcome
    println!("{}", serde_json::json!({"verdicts": verdicts, "outcome_raw": outcome_raw, "why": why, "outcome": outcome}));
}
