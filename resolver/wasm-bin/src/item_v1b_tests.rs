//! V1b / D-VER2 RED tests: the resolver records the material verify-bet B4 needs to redo the judge checks offline:
//!  * per model answer: the full (bounded) answer text, the NEAR AI signature proof (signing address, signature, signed text,
//!    sha256 of the raw stream bytes the signature covers), and the sha256 of the string the verifier scored;
//!  * per source the judge saw: sha256 of the exact reader text (+ url/origin/party/curated facts the origin rules use);
//!  * per element: which answers fed the verdict and which corroboration rule applied.
//! The signed outcome / element_results_hash are untouched. `WRITE=1 cargo test v1b_fixture` regenerates the verifier fixture
//! (services/verifier/test/fixtures/v1b) from a test keypair + mocked NEAR AI responses: offline, $0.
use super::*;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

const FIXTURE_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../services/verifier/test/fixtures/v1b");
const SRC_A: &str = "NWS CLI report. YESTERDAY MAXIMUM 72 615 PM 78 1961 58 14 66 and the minimum was 58.";
const SRC_B: &str = "IEM copy of the same product. YESTERDAY MAXIMUM 72 615 PM 78 1961 58 14 66.";

fn answer_json(single_origin: bool) -> String {
    if single_origin {
        r#"{"answer": "met", "quote": "YESTERDAY MAXIMUM 72 615 PM 78 1961 58 14 66", "source_id": "S_A", "reason": "max is 72"}"#.to_string()
    } else {
        r#"{"answer": "met", "quote": "YESTERDAY MAXIMUM 72 615 PM 78 1961 58 14 66", "source_id": "S_A", "also": [{"source_id": "S_B", "quote": "YESTERDAY MAXIMUM 72 615 PM 78 1961 58 14 66"}], "reason": "max is 72 in both copies"}"#.to_string()
    }
}

fn job() -> Value {
    let terms = json!({
        "claim": "KNYC high on 2026-11-05 was at least 70F", "rule": "ALL", "sources": true, "clauses": ["AVAILABLE_V1"],
        "time": {"window_start": "2026-01-01T00:00:00Z", "window_end": "2026-12-31T23:59:59Z", "evidence_cutoff": "2027-01-01T00:00:00Z"},
        "elements": [{"id": "e1", "q": "was the max at least 70F"}],
        "sources_allowed": [{"id": "S_A", "publisher": "NWS weather.gov"}, {"id": "S_B", "publisher": "IEM mesonet"}],
        "custom_definitions": ["fallback: no fallback source applies to this test. early: early resolution not applicable to this test."],
        "models": ["test/model-a", "test/model-b"],
    })
    .to_string();
    json!({"contract": "escrow.testnet", "bet_id": 1, "envelope": {"terms_hash": praetorial_core::sha_hex(&terms)}, "terms": terms,
           "round": 0, "run_no": 1,
           "sources": [
             {"id": "S_A", "publisher": "NWS weather.gov", "url": "https://forecast.weather.gov/product.php?site=OKX", "published": "2026-06-01T00:00:00Z", "text": SRC_A},
             {"id": "S_B", "publisher": "IEM mesonet", "url": "https://mesonet.agron.iastate.edu/api/1/nwstext/x", "published": "2026-06-01T00:00:00Z", "text": SRC_B}]})
}

struct Bytes(Rc<RefCell<BTreeMap<String, (Vec<u8>, Vec<u8>)>>>, bool);
impl StreamPoster for Bytes {
    fn post_stream(&self, _u: &str, _h: &[(&str, &str)], body: &[u8], _l: &StreamLimits) -> Result<StreamResp, String> {
        let req: Value = serde_json::from_slice(body).unwrap();
        let model = req["model"].as_str().unwrap().to_string();
        let id = format!("chatcmpl-{}", model.replace('/', "-"));
        let content = answer_json(self.1);
        let sse = format!(
            "data: {{\"id\":\"{id}\",\"model\":\"{model}\",\"choices\":[{{\"delta\":{{\"content\":{c}}},\"finish_reason\":null}}]}}\n\ndata: {{\"id\":\"{id}\",\"model\":\"{model}\",\"choices\":[{{\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"total_tokens\":9}}}}\n\ndata: [DONE]\n\n",
            c = serde_json::to_string(&content).unwrap()
        )
        .into_bytes();
        self.0.borrow_mut().insert(id, (body.to_vec(), sse.clone()));
        Ok(StreamResp { status: 200, bytes: sse, stalled: false, first_byte_ms: Some(1), total_ms: 2, idle_hit: false, total_hit: false })
    }
}
struct Signer(Rc<RefCell<BTreeMap<String, (Vec<u8>, Vec<u8>)>>>);
fn test_key() -> ed25519_dalek::SigningKey { ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]) }
fn sha_b(b: &[u8]) -> String { praetorial_core::sha_hex(&String::from_utf8_lossy(b)) }
impl SigGetter for Signer {
    fn get(&self, url: &str, _h: &[(&str, &str)]) -> Result<(u16, String), String> {
        use ed25519_dalek::Signer as _;
        let id = url.split("/v1/signature/").nth(1).unwrap().split('?').next().unwrap().to_string();
        let (req, resp) = self.0.borrow().get(&id).cloned().unwrap();
        let text = format!("{}:{}", sha_b(&req), sha_b(&resp));
        let sig = test_key().sign(text.as_bytes());
        Ok((200, json!({"signing_address": bytes_hex(&test_key().verifying_key().to_bytes()), "signature": bytes_hex(&sig.to_bytes()), "text": text, "signing_algo": "ed25519"}).to_string()))
    }
}
fn ed_verify(addr: &str, sig: &str, msg: &str) -> bool { praetorial_core::ed25519_verify_hex(addr, sig, msg) }

type Store = Rc<RefCell<BTreeMap<String, (Vec<u8>, Vec<u8>)>>>;
fn run(single_origin: bool) -> (Value, Store) {
    run_mode(single_origin, false)
}
fn run_mode(single_origin: bool, real_http: bool) -> (Value, Store) {
    let store: Store = Rc::new(RefCell::new(BTreeMap::new()));
    let poster = Bytes(store.clone(), single_origin);
    let getter = Signer(store.clone());
    let caller = StreamJudgeCaller {
        api_base: "https://x".into(), api_key: "SECRETKEY123456789012345678".into(), poster: &poster, getter: &getter,
        sleep_ms: Box::new(|_| {}), now_ms: Box::new(|| 0), sha256_hex: Box::new(sha_b), verify: Box::new(ed_verify),
    };
    let key = test_key();
    struct K(ed25519_dalek::SigningKey);
    impl KeyBackend for K {
        fn public_key(&self, _p: &str) -> Result<Vec<u8>, String> { Ok(self.0.verifying_key().to_bytes().to_vec()) }
        fn sign(&self, _p: &str, m: &[u8]) -> Result<Vec<u8>, String> { use ed25519_dalek::Signer as _; Ok(self.0.sign(m).to_bytes().to_vec()) }
        fn predecessor(&self) -> Option<String> { None }
    }
    // RHTTP1: offline mode explicit so the recorded verifier fixture is the same bytes in every build (it was regenerated by
    // the default build; `envelope_output_at` reads the compile-time REAL_HTTP, so a real-http build produced different bytes).
    let out = envelope_output_at_with(&job(), &caller, &NullFetcher, &K(key), 1_800_000_000, real_http);
    (out, store)
}

#[test]
fn v1b_answers_carry_signature_proof_full_text_and_scored_string_hash() {
    let (out, store) = run(false);
    let diags = out["judge"]["run_diagnostics"].as_array().unwrap();
    assert_eq!(diags.len(), 2);
    for d in diags {
        let p = &d["signature_proof"];
        let (addr, sig, text) = (p["signing_address"].as_str().unwrap(), p["signature"].as_str().unwrap(), p["text"].as_str().unwrap());
        assert_eq!(p["signing_algo"], "ed25519");
        assert!(praetorial_core::ed25519_verify_hex(addr, sig, text), "recorded proof must verify offline");
        let rs = p["response_sha256"].as_str().unwrap();
        assert!(text.split(':').any(|x| x == rs), "signed text covers the recorded stream hash");
        let stream = store.borrow().values().map(|(_, r)| sha_b(r)).collect::<Vec<_>>();
        assert!(stream.contains(&rs.to_string()), "response_sha256 == sha256 of the raw stream bytes received");
        assert_eq!(d["content"].as_str().unwrap(), answer_json(false));
        assert_eq!(d["content_complete"], true);
        assert_eq!(d["raw_sha256"].as_str().unwrap(), praetorial_core::sha_hex(&answer_json(false)));
    }
}

#[test]
fn v1b_sources_carry_sha256_of_the_exact_reader_text_and_origin_facts() {
    let (out, _) = run(false);
    let srcs = out["judge"]["sources"].as_array().unwrap();
    assert_eq!(srcs.len(), 2);
    assert_eq!(srcs[0]["id"], "S_A");
    assert_eq!(srcs[0]["sha256"].as_str().unwrap(), praetorial_core::sha_hex(SRC_A));
    assert_eq!(srcs[1]["sha256"].as_str().unwrap(), praetorial_core::sha_hex(SRC_B));
    assert_eq!(srcs[0]["url"], "https://forecast.weather.gov/product.php?site=OKX");
    assert_eq!(srcs[0]["curated"], false);
    assert!(srcs[0].get("text").is_none(), "page bodies never go into the on-chain raw");
}

#[test]
fn v1b_element_evidence_names_the_answers_and_the_corroboration_rule() {
    let (out, _) = run(false);
    let ee = out["judge"]["element_evidence"].as_array().unwrap();
    assert_eq!(ee.len(), 1);
    assert_eq!(ee[0]["id"], "e1");
    assert_eq!(ee[0]["rule"], "D-ORIGIN1");
    assert_eq!(ee[0]["answers"][0].as_str().unwrap(), praetorial_core::sha_hex(&answer_json(false)));
}

#[test]
fn v1b_signed_outcome_and_element_results_hash_unchanged_and_elements_untouched() {
    let (out, _) = run(false);
    assert_eq!(out["result"]["outcome"], "YES");
    assert_eq!(out["judge"]["elements"], json!([{"id": "e1", "verdict": "met"}]));
    let h = praetorial_core::sha_hex(&canonical_json(&json!([{"id": "e1", "verdict": "met"}])));
    assert_eq!(out["result"]["element_results_hash"].as_str().unwrap(), h);
}

#[test]
fn v1b_raw_resolution_stays_well_under_the_size_budget() {
    // contracts/escrow stores last_resolution_raw as an uncapped String (no length check in on_resolution); the practical
    // bound is OutLayer's return value + NEAR storage cost, so the resolver keeps its own budget.
    let (out, _) = run(false);
    let n = out.to_string().len();
    assert!(n < 16 * 1024, "raw resolution is {} bytes; budget 16 KiB", n);
}

#[test]
fn v1b_overlong_answer_text_is_bounded_and_flagged_incomplete() {
    let long = ModelReply { content: "x".repeat(10_000), ..Default::default() };
    let (text, complete) = bounded_answer_text(&long.content);
    assert!(!complete && text.len() <= 4096);
    let (t2, c2) = bounded_answer_text("short");
    assert!(c2 && t2 == "short");
}

#[test]
fn v1b_fixture() {
    let (out, store) = run(false);
    let (single, _) = run(true);
    let terms = job()["terms"].as_str().unwrap().to_string();
    let (_, store_single) = run(true);
    let responses: BTreeMap<String, String> = store.borrow().values().chain(store_single.borrow().values()).map(|(_, r)| (sha_b(r), String::from_utf8(r.clone()).unwrap())).collect();
    let evidence = json!({"sources": {"S_A": SRC_A, "S_B": SRC_B}, "responses": responses});
    let files = [
        ("raw_resolution.txt", serde_json::to_string_pretty(&out).unwrap()),
        ("terms.json", terms),
        ("judge_evidence.json", serde_json::to_string_pretty(&evidence).unwrap()),
        ("raw_resolution_single_origin.txt", serde_json::to_string_pretty(&single).unwrap()),
    ];
    for (name, body) in files {
        let p = format!("{}/{}", FIXTURE_DIR, name);
        if std::env::var("WRITE").is_ok() {
            std::fs::create_dir_all(FIXTURE_DIR).unwrap();
            std::fs::write(&p, &body).unwrap();
        } else {
            assert_eq!(std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {} (run WRITE=1 cargo test v1b_fixture)", p, e)), body, "{} drifted from the current resolver output", name);
        }
    }
}

#[test]
fn v1b_real_http_mode_records_signed_proofs_for_the_pinned_judges() {
    // RHTTP1: the production path records the same verify-bet material, for the pinned pair (D-JUDGE6), never the term-named models.
    let (out, _) = run_mode(false, true);
    assert_eq!(out["result"]["outcome"], json!("YES"), "{}", out);
    assert_eq!(out["judge"]["models_requested"], json!([PRIMARY_JUDGE_MODEL, SECOND_JUDGE_MODEL]), "{}", out);
    assert!(out["notes"].as_array().unwrap().iter().any(|n| n == "D-JUDGE6: term-sheet models ignored"), "{}", out);
    let diags = out["judge"]["run_diagnostics"].as_array().unwrap();
    assert_eq!(diags.len(), 2);
    for d in diags {
        let p = &d["signature_proof"];
        assert_eq!(d["signature_verified"], json!(true), "{}", d);
        assert!(ed_verify(p["signing_address"].as_str().unwrap(), p["signature"].as_str().unwrap(), p["text"].as_str().unwrap()), "{}", d);
    }
    assert!(out["signing"]["signature_hex"].is_string(), "{}", out);
}
