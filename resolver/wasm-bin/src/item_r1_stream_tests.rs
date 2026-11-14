//! Spike R1: streamed judge-ping (`stream: true`, SSE) + signature fetch. Written before the code (RED first).
//! Signs nothing: the only signature handled is NEAR AI's own, verified, never produced.
use super::*;
use std::cell::RefCell;

const KEY: &str = "sk-test-0123456789abcdefghijklmnopqrstuvwxyz";
const ID: &str = "chatcmpl-abc";

fn chunk(delta: &str, fr: Option<&str>) -> String {
    let fr = fr.map(|f| format!("\"{}\"", f)).unwrap_or("null".into());
    format!("data: {{\"id\":\"{ID}\",\"object\":\"chat.completion.chunk\",\"model\":\"m/x\",\"choices\":[{{\"index\":0,\"delta\":{delta},\"finish_reason\":{fr}}}],\"usage\":null}}\n\n")
}
fn sse() -> String {
    let mut s = String::new();
    s += &chunk(r#"{"role":"assistant","content":""}"#, None);
    s += &chunk(r#"{"reasoning_content":"thinking..."}"#, None);
    s += &chunk(r#"{"content":"{\"answer\":"}"#, None);
    s += &chunk(r#"{"content":"\"insufficient\"}"}"#, None);
    s += &chunk("{}", Some("stop"));
    s += &format!("data: {{\"id\":\"{ID}\",\"choices\":[],\"usage\":{{\"prompt_tokens\":10,\"completion_tokens\":7}}}}\n\n");
    s += "data: [DONE]\n\n";
    s
}

struct FakePoster { reply: Result<(u16, Vec<u8>), String>, seen: RefCell<Vec<Vec<u8>>> }
impl ChatPoster for FakePoster {
    fn post(&self, _u: &str, _h: &[(&str, &str)], body: &[u8]) -> Result<(u16, Vec<u8>), String> {
        self.seen.borrow_mut().push(body.to_vec());
        self.reply.clone()
    }
}
fn poster(body: &str) -> FakePoster { FakePoster { reply: Ok((200, body.as_bytes().to_vec())), seen: RefCell::new(vec![]) } }

/// Signature endpoint fake: answers the scripted replies in order, then repeats the last one.
struct FakeGet { replies: Vec<Result<(u16, String), String>>, urls: RefCell<Vec<String>> }
impl SigGetter for FakeGet {
    fn get(&self, url: &str, _h: &[(&str, &str)]) -> Result<(u16, String), String> {
        let n = self.urls.borrow().len();
        self.urls.borrow_mut().push(url.to_string());
        self.replies[n.min(self.replies.len() - 1)].clone()
    }
}
fn sig_ok() -> Result<(u16, String), String> {
    Ok((200, r#"{"text":"REQHASH:RESPHASH","signature":"aa","signing_address":"bb","signing_algo":"ed25519"}"#.into()))
}
fn nf() -> Result<(u16, String), String> { Ok((404, r#"{"error":"not found"}"#.into())) }

/// Clock advancing 1000 ms per call; sleeper advances an independent counter.
fn clock() -> impl Fn() -> u128 { let t = RefCell::new(0u128); move || { *t.borrow_mut() += 1000; *t.borrow() } }

fn run(p: &FakePoster, g: &FakeGet, verify: bool, sleeps: &RefCell<Vec<u64>>, job: Value) -> Value {
    let hash = |b: &[u8]| if b == sse().as_bytes() { "RESPHASH".to_string() } else { format!("len{}", b.len()) };
    let ver = move |_a: &str, _s: &str, _t: &str| verify;
    judge_ping_stream(&job, "https://cloud-api.near.ai", Some(KEY), p, g, &|ms| sleeps.borrow_mut().push(ms), &clock(), &hash, &ver)
}

#[test]
fn r1_parse_sse_assembles_content_id_finish_usage_and_ignores_reasoning() {
    let r = parse_sse_chat(&sse());
    assert_eq!(r.content, r#"{"answer":"insufficient"}"#);
    assert_eq!(r.id.as_deref(), Some(ID));
    assert_eq!(r.model.as_deref(), Some("m/x"));
    assert_eq!(r.finish_reason.as_deref(), Some("stop"));
    assert_eq!(r.chunks, 6);
    assert!(r.done);
    assert_eq!(r.usage.as_ref().unwrap()["completion_tokens"], json!(7));
    assert_eq!(r.reasoning_chars, "thinking...".len());
}

#[test]
fn r1_parse_sse_tolerates_crlf_comments_garbage_and_missing_done() {
    let s = sse().replace("\n\n", "\r\n\r\n").replace("data: [DONE]\r\n\r\n", ": keep-alive\r\n\r\ndata: {not json\r\n\r\n");
    let r = parse_sse_chat(&s);
    assert_eq!(r.content, r#"{"answer":"insufficient"}"#);
    assert!(!r.done, "no [DONE] seen");
}

#[test]
fn r1_parse_sse_truncated_stream_reports_length_or_none() {
    let s = chunk(r#"{"content":"abc"}"#, None); // cut off: no finish chunk
    let r = parse_sse_chat(&s);
    assert_eq!(r.content, "abc");
    assert_eq!(r.finish_reason, None);
    assert!(!r.done);
}

#[test]
fn r1_stream_sends_job_body_with_stream_true_and_include_usage() {
    let p = poster(&sse());
    let g = FakeGet { replies: vec![sig_ok()], urls: RefCell::new(vec![]) };
    let s = RefCell::new(vec![]);
    let job = json!({"mode":"judge-ping","stream":true,"body":{"model":"m/x","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}});
    run(&p, &g, true, &s, job);
    let sent: Value = serde_json::from_slice(&p.seen.borrow()[0]).unwrap();
    assert_eq!(sent["stream"], json!(true));
    assert_eq!(sent["stream_options"]["include_usage"], json!(true));
    assert_eq!(sent["max_tokens"], json!(5));
    assert_eq!(p.seen.borrow().len(), 1, "exactly one chat call");
}

#[test]
fn r1_stream_success_reports_content_finish_bytes_and_verified_signature() {
    let p = poster(&sse());
    let g = FakeGet { replies: vec![sig_ok()], urls: RefCell::new(vec![]) };
    let s = RefCell::new(vec![]);
    let out = run(&p, &g, true, &s, json!({"mode":"judge-ping","stream":true,"model":"m/x"}));
    assert_eq!(out["ok"], json!(true));
    assert_eq!(out["stream"], json!(true));
    assert_eq!(out["http_status"], json!(200));
    assert_eq!(out["finish_reason"], json!("stop"));
    assert_eq!(out["content_len"], json!(r#"{"answer":"insufficient"}"#.len()));
    assert_eq!(out["content_is_json"], json!(true));
    assert_eq!(out["response_bytes"], json!(sse().len()));
    assert_eq!(out["done_marker"], json!(true));
    assert_eq!(out["completion_id"], json!(ID));
    assert_eq!(out["sig_verified"], json!(true));
    assert_eq!(out["sig_attempts"], json!(1));
    assert_eq!(out["sig_resp_hash_matches"], json!(true), "signed text carries sha256 of the raw SSE bytes");
    assert_eq!(out["error"], Value::Null);
    let url = &g.urls.borrow()[0];
    assert!(url.starts_with("https://cloud-api.near.ai/v1/signature/chatcmpl-abc?"), "{}", url);
    assert!(url.contains("signing_algo=ed25519") && url.contains("model=m/x"), "{}", url);
}

#[test]
fn r1_stream_signature_retries_on_404_then_succeeds_within_10s() {
    let p = poster(&sse());
    let g = FakeGet { replies: vec![nf(), nf(), sig_ok()], urls: RefCell::new(vec![]) };
    let s = RefCell::new(vec![]);
    let out = run(&p, &g, true, &s, json!({"mode":"judge-ping","stream":true}));
    assert_eq!(out["sig_verified"], json!(true));
    assert_eq!(out["sig_attempts"], json!(3));
    assert_eq!(s.borrow().len(), 2, "slept between attempts only");
    assert!(s.borrow().iter().sum::<u64>() <= 10_000);
}

#[test]
fn r1_stream_signature_gives_up_after_10s_and_reports_not_verified() {
    let p = poster(&sse());
    let g = FakeGet { replies: vec![nf()], urls: RefCell::new(vec![]) };
    let s = RefCell::new(vec![]);
    let out = run(&p, &g, true, &s, json!({"mode":"judge-ping","stream":true}));
    assert_eq!(out["sig_verified"], json!(false));
    assert!(out["sig_attempts"].as_u64().unwrap() >= 2 && out["sig_attempts"].as_u64().unwrap() <= 12);
    assert!(s.borrow().iter().sum::<u64>() <= 10_000, "retry budget ~10 s");
    assert!(out["sig_error"].as_str().unwrap().contains("404"), "{}", out);
    assert_eq!(out["ok"], json!(true), "the answer itself still arrived");
}

#[test]
fn r1_stream_bad_signature_is_not_verified_even_if_present() {
    let p = poster(&sse());
    let g = FakeGet { replies: vec![sig_ok()], urls: RefCell::new(vec![]) };
    let s = RefCell::new(vec![]);
    let out = run(&p, &g, false, &s, json!({"mode":"judge-ping","stream":true}));
    assert_eq!(out["sig_verified"], json!(false));
    assert_eq!(g.urls.borrow().len(), 1, "a present-but-invalid signature is not retried");
}

#[test]
fn r1_stream_resp_hash_mismatch_is_reported_and_blocks_verified() {
    let p = poster(&sse());
    let g = FakeGet { replies: vec![Ok((200, r#"{"text":"REQHASH:OTHER","signature":"aa","signing_address":"bb"}"#.into()))], urls: RefCell::new(vec![]) };
    let s = RefCell::new(vec![]);
    let out = run(&p, &g, true, &s, json!({"mode":"judge-ping","stream":true}));
    assert_eq!(out["sig_resp_hash_matches"], json!(false));
    assert_eq!(out["sig_verified"], json!(false), "signature over bytes we did not receive is not a verification");
}

#[test]
fn r1_stream_transport_error_is_reported_and_no_signature_fetch_happens() {
    let p = FakePoster { reply: Err(format!("request failed: ConnectionReadTimeout {}", KEY)), seen: RefCell::new(vec![]) };
    let g = FakeGet { replies: vec![sig_ok()], urls: RefCell::new(vec![]) };
    let s = RefCell::new(vec![]);
    let out = run(&p, &g, true, &s, json!({"mode":"judge-ping","stream":true}));
    assert_eq!(out["ok"], json!(false));
    assert!(!out["error"].as_str().unwrap().contains(KEY));
    assert_eq!(g.urls.borrow().len(), 0);
}

#[test]
fn r1_stream_non_2xx_is_not_ok_and_402_is_surfaced_with_status() {
    let p = FakePoster { reply: Ok((402, br#"{"error":"insufficient credits"}"#.to_vec())), seen: RefCell::new(vec![]) };
    let g = FakeGet { replies: vec![sig_ok()], urls: RefCell::new(vec![]) };
    let s = RefCell::new(vec![]);
    let out = run(&p, &g, true, &s, json!({"mode":"judge-ping","stream":true}));
    assert_eq!(out["ok"], json!(false));
    assert_eq!(out["http_status"], json!(402));
    assert!(out["error"].as_str().unwrap().contains("402"));
    assert_eq!(g.urls.borrow().len(), 0);
}

#[test]
fn r1_stream_length_finish_is_ok_false_content_not_complete() {
    let s = chunk(r#"{"content":"{\"ans"}"#, None) + &chunk("{}", Some("length")) + "data: [DONE]\n\n";
    let p = poster(&s);
    let g = FakeGet { replies: vec![sig_ok()], urls: RefCell::new(vec![]) };
    let sl = RefCell::new(vec![]);
    let out = run(&p, &g, true, &sl, json!({"mode":"judge-ping","stream":true}));
    assert_eq!(out["finish_reason"], json!("length"));
    assert_eq!(out["complete"], json!(false), "length / non-JSON content is not a complete answer");
}

#[test]
fn r1_stream_output_signs_nothing_and_never_echoes_the_key() {
    let p = poster(&sse());
    let g = FakeGet { replies: vec![sig_ok()], urls: RefCell::new(vec![]) };
    let s = RefCell::new(vec![]);
    let out = run(&p, &g, true, &s, json!({"mode":"judge-ping","stream":true}));
    assert!(out.get("signing").is_none() && out.get("signature").is_none() && out.get("signature_hex").is_none(), "{}", out);
    assert!(!out.to_string().contains(KEY));
}

#[test]
fn r1_stream_missing_key_makes_no_call() {
    let p = poster(&sse());
    let g = FakeGet { replies: vec![sig_ok()], urls: RefCell::new(vec![]) };
    let hash = |_: &[u8]| String::new();
    let ver = |_: &str, _: &str, _: &str| true;
    let out = judge_ping_stream(&json!({"mode":"judge-ping","stream":true}), "https://x", None, &p, &g, &|_| {}, &clock(), &hash, &ver);
    assert_eq!(p.seen.borrow().len(), 0);
    assert_eq!(out["error"], json!("NEAR_AI_API_KEY not set"));
}

#[test]
fn r1_stream_dispatch_is_in_main_before_signing_paths_and_only_when_stream_true() {
    let src = include_str!("main.rs");
    let body = &src[src.find("fn main()").unwrap()..];
    let st = body.find("judge_ping_stream(").expect("main dispatches judge_ping_stream");
    assert!(st < body.find("\"report-pubkey\"").unwrap() && st < body.find("job.get(\"envelope\")").unwrap());
    assert!(body.contains("\"stream\""), "gated on job.stream");
}

#[cfg(any(feature = "local-signer", feature = "real-http"))]
#[test]
fn r1_real_ed25519_verifier_accepts_a_genuine_signature_over_streamed_hash_text() {
    use ed25519_dalek::{Signer, SigningKey};
    let sk = SigningKey::from_bytes(&[3u8; 32]);
    let pk = hex::encode(sk.verifying_key().to_bytes());
    let text = "req:resp";
    let sig = hex::encode(sk.sign(text.as_bytes()).to_bytes());
    assert!(ed25519_verify_text(&pk, &sig, text));
    assert!(!ed25519_verify_text(&pk, &sig, "req:resp2"));
}
