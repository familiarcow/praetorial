//! WX1 (D-WX1): the NWS CLI appends `R` to a record maximum (`MAXIMUM         88R 12:39 PM  88    2016`). Replay of the REAL
//! recorded KIAH 2026-11-03 product + IAH list + IEM rows (fixtures/wx1, see its README): the code must read 88, not RETRY.
use super::*;
use serde_json::json;
use std::cell::RefCell;

const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/wx1");
const LIST: &str = "https://api.weather.gov/products/types/CLI/locations/IAH";
const PROD: &str = "https://api.weather.gov/products/61a52f4b-bee7-4ed2-8ebd-99b9ea19ca75";
const IEM: &str = "https://mesonet.agron.iastate.edu/json/cli.py?station=KIAH&year=2026";

struct Fx;
impl HttpFetcher for Fx {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        let (f, ct) = match url {
            LIST => ("nws_cli_IAH_list_20261108.json", "application/ld+json"),
            PROD => ("nws_cli_KIAH_20261103_product.json", "application/ld+json"),
            IEM => ("iem_cli_KIAH_2026_trimmed.json", "application/json"),
            u => return Err(format!("no recorded fixture for URL {}", u)),
        };
        let body = std::fs::read(format!("{}/{}", DIR, f)).unwrap();
        Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: ct.into(), body, status_code: 200 })
    }
}
struct Rec(RefCell<Vec<String>>);
impl ModelCaller for Rec {
    fn call(&self, _m: &str, msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        self.0.borrow_mut().push(msgs.iter().map(|(_, c)| c.as_str()).collect::<Vec<_>>().join("\n"));
        (r#"{"audit":"agree"}"#.to_string(), None, None)
    }
}
fn run(op: &str, x: i64, j: &Rec) -> (String, Vec<String>) {
    let sh = json!({"template": {"id": "nws_daily_high", "version": 1}, "fields": {"station": "KIAH", "date": "2026-11-03", "op": op, "x_f": x}});
    let raw = sh.to_string();
    let job = json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 1, "checked_until": 0, "round": 0, "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw});
    let now = praetorial_core::template::parse_iso("2026-11-08T12:00:00Z").unwrap();
    let (r, n, _) = build_submission_judged_at(&job, j, &Fx, false, now);
    (r.outcome, n)
}

#[test]
fn kiah_20261103_record_high_88r_decides_from_88() {
    for (op, x, want) in [(">=", 85, "YES"), ("<=", 87, "NO"), (">=", 89, "NO")] {
        let (o, n) = run(op, x, &Rec(RefCell::new(vec![])));
        assert_eq!(o, want, "{} {}: {:?}", op, x, n);
        assert!(n.iter().any(|s| s.contains("NWS CLI Val(88)")), "{:?}", n);
    }
}
#[test]
fn audit_sees_88_not_88r_as_the_code_value() {
    let j = Rec(RefCell::new(vec![]));
    let (o, _) = run(">=", 85, &j);
    assert_eq!(o, "YES");
    let p = j.0.borrow();
    assert_eq!(p.len(), 1, "one audit call");
    assert!(p[0].contains(r#""nws_max":88"#) && p[0].contains(r#""iem_high":88"#), "{}", p[0]);
    assert!(!p[0].contains("88R"), "{}", p[0]);
}
