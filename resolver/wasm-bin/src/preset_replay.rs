//! PT7 (D-LAUNCH1/D-TPL1) preset replay harness, test-only. Table-driven: each case is
//! `{name, preset, sheet, now, fixtures[], truth?, expect:{outcome, note_contains?}}`.
//! fixtures[] entries (first match wins, in order):
//!   {url | url_contains, file | body, content_type?}   serve a recorded file (relative to fixtures/) or inline JSON body
//!   {url | url_contains, error}                        that fetch fails (source unreachable)
//!   {manifest: "<dir>", file_prefix: [..]}             every manifest.json entry of fixtures/<dir> whose file starts with a prefix, by source_url
//! A request flagged too early (D-EARLYREQ1: no signed outcome) replays as outcome `NO_OUTCOME` (counted as rejected).
//! Anything not served is a fetch error. No network. `truth` (YES|NO) is the known real answer: a decided outcome that is
//! the OPPOSITE side is a wrong winner, counted apart from outcome mismatches, and fails the whole run.
use super::*;
use serde_json::json;
use std::collections::BTreeMap;

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures");

#[derive(Default, Clone, Debug)]
pub struct Row { pub decided: usize, pub expected_void: usize, pub unexpected_void: usize, pub rejected: usize, pub wrong_winner: usize }
#[derive(Default, Debug)]
pub struct Report { pub rows: BTreeMap<String, Row>, pub diffs: Vec<String>, pub total: usize, pub mismatches: usize, pub wrong_winners: usize }
impl Report {
    pub fn ok(&self) -> bool { self.mismatches == 0 && self.wrong_winners == 0 }
    pub fn render(&self) -> String {
        let mut s = format!("{:<20} {:>7} {:>13} {:>15} {:>8} {:>12}\n", "preset", "decided", "expected-VOID", "unexpected-VOID", "rejected", "wrong-winner");
        for (p, r) in &self.rows {
            s += &format!("{:<20} {:>7} {:>13} {:>15} {:>8} {:>12}\n", p, r.decided, r.expected_void, r.unexpected_void, r.rejected, r.wrong_winner);
        }
        s += &format!("cases {} | outcome mismatches {} | wrong winners {}\n", self.total, self.mismatches, self.wrong_winners);
        if self.wrong_winners > 0 { s += "WRONG WINNER: the resolver returned the opposite side of a known truth; the run FAILS\n"; }
        for d in &self.diffs { s += &format!("{}\n", d); }
        s
    }
}
pub fn load_cases(path: &str) -> Result<Vec<Value>, String> {
    let b = std::fs::read(path).map_err(|e| format!("{}: {}", path, e))?;
    let v: Value = serde_json::from_slice(&b).map_err(|e| format!("{}: {}", path, e))?;
    v.as_array().cloned().ok_or_else(|| format!("{}: not a JSON array", path))
}

enum Serve { Body(Vec<u8>, String), Err(String) }
struct Rule { url: Option<String>, contains: Option<String>, serve: Serve }
struct Replay { rules: Vec<Rule> }
impl HttpFetcher for Replay {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        for r in &self.rules {
            let hit = r.url.as_deref().is_some_and(|u| u == url) || r.contains.as_deref().is_some_and(|c| url.contains(c));
            if !hit { continue; }
            return match &r.serve {
                Serve::Err(e) => Err(e.clone()),
                Serve::Body(b, ct) => Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: ct.clone(), body: b.clone(), status_code: 200 }),
            };
        }
        Err(format!("no replay fixture for URL {}", url))
    }
}
struct AuditAgree;
impl ModelCaller for AuditAgree {
    fn call(&self, _m: &str, _msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) { (r#"{"audit":"agree"}"#.to_string(), None, None) }
}

fn read_fx(f: &str) -> Result<Vec<u8>, String> { std::fs::read(format!("{}/{}", DIR, f)).map_err(|e| format!("fixture {}: {}", f, e)) }
fn rules(fixtures: &Value) -> Result<Vec<Rule>, String> {
    let mut out = vec![];
    for f in fixtures.as_array().ok_or("fixtures must be an array")? {
        if let Some(dir) = f["manifest"].as_str() {
            let m: Value = serde_json::from_slice(&read_fx(&format!("{}/manifest.json", dir))?).map_err(|e| e.to_string())?;
            let pre: Vec<&str> = f["file_prefix"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default();
            for e in m.as_array().ok_or("manifest not an array")? {
                let file = e["file"].as_str().ok_or("manifest entry without file")?;
                if !pre.is_empty() && !pre.iter().any(|p| file.starts_with(p)) { continue; }
                let ct = e["content_type"].as_str().unwrap_or("application/json").to_string();
                out.push(Rule { url: Some(e["source_url"].as_str().ok_or("manifest entry without source_url")?.to_string()), contains: None, serve: Serve::Body(read_fx(&format!("{}/{}", dir, file))?, ct) });
            }
            continue;
        }
        let url = f["url"].as_str().map(String::from);
        let contains = f["url_contains"].as_str().map(String::from);
        if url.is_none() && contains.is_none() { return Err(format!("fixture needs url, url_contains or manifest: {}", f)); }
        let serve = if let Some(e) = f["error"].as_str() { Serve::Err(e.to_string()) } else {
            let ct = f["content_type"].as_str().unwrap_or("application/json").to_string();
            if let Some(file) = f["file"].as_str() { Serve::Body(read_fx(file)?, ct) }
            else if !f["body"].is_null() { Serve::Body(f["body"].to_string().into_bytes(), ct) }
            else { return Err(format!("fixture needs file, body or error: {}", f)); }
        };
        out.push(Rule { url, contains, serve });
    }
    Ok(out)
}

/// Replay one case: (outcome word, notes). Err = the case itself is malformed.
fn replay(c: &Value) -> Result<(String, Vec<String>), String> {
    let sheet = c.get("sheet").filter(|s| s.is_object()).ok_or("missing sheet")?;
    let now = praetorial_core::template::parse_iso(c["now"].as_str().ok_or("missing now")?).ok_or("bad now")?;
    let fx = Replay { rules: rules(c.get("fixtures").ok_or("missing fixtures")?)? };
    let raw = sheet.to_string();
    let mut job = json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 1, "checked_until": 0, "round": 0, "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw});
    // PT3: optional D-RESOLVE1 recovery state carried by the job (`first_unavailable` ISO time, `retry_count`), as the keeper supplies it
    if let Some(t) = c["first_unavailable"].as_str() {
        let s = praetorial_core::template::parse_iso(t).ok_or("bad first_unavailable")?;
        job["first_unavailable_ns"] = json!(s as u64 * 1_000_000_000);
    }
    if let Some(n) = c["retry_count"].as_u64() { job["retry_count"] = json!(n); }
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| build_submission_judged_at(&job, &AuditAgree, &fx, false, now)));
    // D-EARLYREQ1: a too-early request is flagged and the envelope emits NO signed outcome (PT2): report it as NO_OUTCOME, never as the VOID-shaped internal result
    match r { Ok((r, n, _)) => Ok((if early_request_reason().is_some() { "NO_OUTCOME".to_string() } else { r.outcome }, n)), Err(_) => Err("resolver panicked".into()) }
}

pub fn run_cases(cases: &[Value]) -> Report {
    let mut rep = Report { total: cases.len(), ..Default::default() };
    for (i, c) in cases.iter().enumerate() {
        let name = c["name"].as_str().map(String::from).unwrap_or_else(|| format!("#{}", i));
        let preset = c["preset"].as_str().unwrap_or("(unknown)").to_string();
        let row = rep.rows.entry(preset).or_default();
        let want = c["expect"]["outcome"].as_str();
        let (actual, notes) = match (want, replay(c)) {
            (None, _) => { rep.mismatches += 1; rep.diffs.push(format!("case {}: malformed: missing expect.outcome", name)); continue; }
            (_, Err(e)) => { rep.mismatches += 1; rep.diffs.push(format!("case {}: malformed: {}", name, e)); continue; }
            (Some(_), Ok(x)) => x,
        };
        let want = want.unwrap();
        let truth = c["truth"].as_str();
        let opposite = |t: &str| matches!((t, actual.as_str()), ("YES", "NO") | ("NO", "YES"));
        if truth.is_some_and(opposite) {
            row.wrong_winner += 1;
            rep.wrong_winners += 1;
            rep.diffs.push(format!("case {}: WRONG WINNER: known truth {}, resolver returned {} (notes: {:?})", name, truth.unwrap(), actual, notes));
            continue;
        }
        match actual.as_str() {
            "YES" | "NO" => row.decided += 1,
            "VOID" if want == "VOID" => row.expected_void += 1,
            "VOID" => row.unexpected_void += 1,
            _ => row.rejected += 1, // RETRY or no signed outcome
        }
        let mut bad = vec![];
        if actual != want { bad.push(format!("expected outcome {}, actual {}", want, actual)); }
        if let Some(nc) = c["expect"]["note_contains"].as_str() {
            if !notes.iter().any(|n| n.contains(nc)) { bad.push(format!("note_contains {:?} not in notes", nc)); }
        }
        if !bad.is_empty() {
            rep.mismatches += 1;
            rep.diffs.push(format!("case {}: {} (notes: {:?})", name, bad.join("; "), notes));
        }
    }
    rep
}
