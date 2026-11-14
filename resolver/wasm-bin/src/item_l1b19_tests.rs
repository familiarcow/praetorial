//! L1b19 (D-JUDGETIME1b, D-RESOLVE8): the live4 Jason one-venue NO sheet, replayed with Kraken (the FALLBACK venue) returning no
//! candles in the window (its public OHLC keeps ~12 h). The sheet's fallback clause only substitutes Kraken when a PRIMARY
//! (Coinbase/Bitstamp) is unavailable; both primaries have complete gap-free coverage, so Kraken cannot change the answer and the
//! gate fully decides -> short audit path, not the full two-model judge.
use super::*;
use serde_json::json;
use std::cell::RefCell;

const L1: &str = super::item_l1a_tests::L1;
const NOW: i64 = 1794063600;

struct FxNoKraken;
impl HttpFetcher for FxNoKraken {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
        let body: Vec<u8> = if url.contains("coinbase") {
            let mut all: Vec<Value> = Vec::new();
            for i in 0..3 {
                let v: Value = serde_json::from_slice(&std::fs::read(format!("{}/fixtures/cb_BTC_1m_p{}.json", L1, i)).unwrap()).unwrap();
                all.extend(v.as_array().unwrap().iter().cloned());
            }
            serde_json::to_vec(&all).unwrap()
        } else if url.contains("bitstamp") {
            std::fs::read(format!("{}/fixtures/bs_BTC_1m.json", L1)).unwrap()
        } else if url.contains("kraken") {
            br#"{"error":[],"result":{"XXBTZUSD":[],"last":1794063000}}"#.to_vec()
        } else {
            return Err("no recorded fixture".into());
        };
        Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: "application/json".into(), body, status_code: 200 })
    }
}
struct Rec { reply: &'static str, seen: RefCell<Vec<Vec<(String, String)>>> }
impl ModelCaller for Rec {
    fn call(&self, _m: &str, msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) {
        self.seen.borrow_mut().push(msgs.to_vec());
        (self.reply.to_string(), None, None)
    }
}
fn live4_jason() -> Value {
    let p = format!("{}/live4/terms_jason_bitstamp_only_no.json", L1);
    serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap()
}
fn run(c: &Rec) -> (String, Vec<String>) {
    let raw = live4_jason().to_string();
    let job = json!({"contract": "escrow.testnet", "bet_id": 2, "run_no": 1, "checked_until": 0, "round": 0, "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw});
    let (r, notes, _) = build_submission_judged_at(&job, c, &FxNoKraken, false, NOW);
    (r.outcome, notes)
}
fn text(m: &[(String, String)]) -> String { m.iter().map(|(_, c)| c.as_str()).collect::<Vec<_>>().join("\n") }

#[test]
fn live4_one_venue_no_with_kraken_empty_takes_the_audit_path_one_call() {
    let c = Rec { reply: r#"{"audit":"agree"}"#, seen: RefCell::new(vec![]) };
    let (out, notes) = run(&c);
    let seen = c.seen.borrow();
    assert!(notes.iter().any(|n| n.contains("INCOMPLETE for S_KR")), "fixture must reproduce Kraken excluded: {:?}", notes);
    assert!(!seen.is_empty());
    for m in seen.iter() {
        let t = text(m);
        assert!(t.contains("<proposal>") && t.contains("auditor") && !t.contains("</rules>"), "audit prompt expected, got {} bytes", t.len());
    }
    assert_eq!(seen.len(), 1, "one audit call");
    assert_eq!(out, "NO", "{:?}", notes);
}

#[test]
fn live4_kraken_empty_but_a_primary_incomplete_is_not_audit_decided() {
    // Safety: if a PRIMARY is unavailable the fallback matters, so Kraken missing too must NOT take the audit path.
    struct FxCbDown;
    impl HttpFetcher for FxCbDown {
        fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> {
            if url.contains("coinbase") { return Err("down".into()); }
            FxNoKraken.fetch(url)
        }
    }
    let c = Rec { reply: r#"{"answer":"not_met","quote":"x","source_id":"S_BS","reason":"r"}"#, seen: RefCell::new(vec![]) };
    let raw = live4_jason().to_string();
    let job = json!({"contract": "escrow.testnet", "bet_id": 2, "run_no": 1, "checked_until": 0, "round": 0, "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw});
    let (r, notes, _) = build_submission_judged_at(&job, &c, &FxCbDown, false, NOW);
    assert_eq!(r.outcome, "VOID", "{:?}", notes);
    assert!(c.seen.borrow().iter().all(|m| !text(m).contains("<proposal>")));
}
