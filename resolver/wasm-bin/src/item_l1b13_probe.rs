//! L1b13 live probe (dev tool, not a unit test of behaviour): runs the REAL judge path (same prompts, models,
//! params, StreamJudgeCaller + verified_stream_call) natively, with curl as the transport, against real NEAR AI and
//! the live public candle endpoints. Runs only when L1B13_LIVE=1 and NEAR_AI_API_KEY are set; prints per-stage timing
//! to stderr (never the key).
use super::*;
use serde_json::json;
use std::cell::RefCell;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Instant;

struct CurlFetcher(Instant);
impl HttpFetcher for CurlFetcher {
    fn fetch(&self, url: &str) -> Result<RawFetchResponse, String> { self.fetch_timeout(url, 15_000) }
    fn fetch_timeout(&self, url: &str, timeout_ms: u64) -> Result<RawFetchResponse, String> {
        let t = Instant::now();
        let o = Command::new("curl").args(["-sS", "-m", &(timeout_ms / 1000).max(1).to_string(), "-w", "\n%{http_code}", url]).output().map_err(|e| e.to_string())?;
        let mut b = o.stdout; let i = b.iter().rposition(|c| *c == b'\n').unwrap_or(0);
        let code: u16 = String::from_utf8_lossy(&b[i + 1..]).trim().parse().unwrap_or(0); b.truncate(i);
        eprintln!("[probe +{:>6}ms] fetch {} -> {} ({} B) in {} ms", self.0.elapsed().as_millis(), url.split('?').next().unwrap(), code, b.len(), t.elapsed().as_millis());
        if code == 0 { return Err(format!("transport error: curl {}", String::from_utf8_lossy(&o.stderr))); }
        Ok(RawFetchResponse { final_url: url.into(), redirect_chain: vec![], content_type: "application/json".into(), body: b, status_code: code })
    }
}
struct CurlStream { rx: mpsc::Receiver<Option<Vec<u8>>>, _child: std::process::Child }
impl ByteStream for CurlStream {
    fn next_chunk(&mut self, wait_ms: u64) -> Chunk {
        match self.rx.recv_timeout(std::time::Duration::from_millis(wait_ms)) {
            Ok(Some(d)) => Chunk::Data(d), Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => Chunk::Closed, Err(mpsc::RecvTimeoutError::Timeout) => Chunk::Idle,
        }
    }
}
struct CurlPoster(Instant);
impl StreamPoster for CurlPoster {
    fn post_stream(&self, url: &str, headers: &[(&str, &str)], body: &[u8], limits: &StreamLimits) -> Result<StreamResp, String> {
        let t0 = Instant::now();
        let mut c = Command::new("curl");
        c.args(["-sN", "-X", "POST", url, "--data-binary", "@-"]);
        for (k, v) in headers { c.args(["-H", &format!("{}: {}", k, v)]); }
        let mut child = c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
        use std::io::Write;
        child.stdin.take().unwrap().write_all(body).map_err(|e| e.to_string())?;
        let mut out = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        let gaps = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(u128, usize)>::new()));
        let g2 = gaps.clone();
        std::thread::spawn(move || { let mut buf = [0u8; 8192]; loop { match out.read(&mut buf) { Ok(0) | Err(_) => { let _ = tx.send(None); break } Ok(n) => { g2.lock().unwrap().push((t0.elapsed().as_millis(), n)); if tx.send(Some(buf[..n].to_vec())).is_err() { break } } } } });
        let mut s = CurlStream { rx, _child: child };
        let r = drain_stream_since(&mut s, limits, &|| t0.elapsed().as_millis(), 200, 0);
        let g = gaps.lock().unwrap();
        let maxgap = g.windows(2).map(|w| w[1].0 - w[0].0).max().unwrap_or(0);
        let _ = s._child.kill();
        match &r { Ok(x) => eprintln!("[probe +{:>6}ms] model stream: {} chunks, first_byte={:?} ms total={} ms max_idle_gap={} ms stalled={} idle_hit={} bytes={}", self.0.elapsed().as_millis(), g.len(), x.first_byte_ms, x.total_ms, maxgap, x.stalled, x.idle_hit, x.bytes.len()),
            Err(e) => eprintln!("[probe] stream err {}", e) }
        r
    }
}
struct CurlGetter;
impl SigGetter for CurlGetter {
    fn get(&self, url: &str, headers: &[(&str, &str)]) -> Result<(u16, String), String> {
        let mut c = Command::new("curl"); c.args(["-sS", "-m", "15", "-w", "\n%{http_code}", url]);
        for (k, v) in headers { c.args(["-H", &format!("{}: {}", k, v)]); }
        let o = c.output().map_err(|e| e.to_string())?; let s = String::from_utf8_lossy(&o.stdout).to_string();
        let i = s.rfind('\n').unwrap_or(0); Ok((s[i + 1..].trim().parse().unwrap_or(0), s[..i].to_string()))
    }
}
struct Timed<'a> { inner: &'a dyn ModelCaller, t: Instant, calls: RefCell<Vec<(String, u128)>> }
impl ModelCaller for Timed<'_> {
    fn backend(&self) -> (String, Option<String>) { self.inner.backend() }
    fn call(&self, m: &str, msgs: &[(String, String)]) -> (String, Option<String>, Option<String>) { let r = self.call_full(m, msgs); (r.content, r.chat_id, r.model_echoed) }
    fn call_full(&self, m: &str, msgs: &[(String, String)]) -> ModelReply {
        let s = Instant::now();
        eprintln!("[probe +{:>6}ms] model call START {} (prompt {} chars)", self.t.elapsed().as_millis(), m, msgs.iter().map(|x| x.1.len()).sum::<usize>());
        let r = self.inner.call_full(m, msgs);
        eprintln!("[probe +{:>6}ms] model call END {} in {} ms: finish={:?} sig_ok={:?} err={:?} content_len={}", self.t.elapsed().as_millis(), m, s.elapsed().as_millis(), r.finish_reason, r.signature_verified, r.transport_error, r.content.len());
        self.calls.borrow_mut().push((m.to_string(), s.elapsed().as_millis()));
        r
    }
}
#[test]
fn l1b13_live_probe() {
    if std::env::var("L1B13_LIVE").is_err() { return; }
    let sheet = std::env::var("L1B13_SHEET").unwrap_or_else(|_| "live2/terms_jason_bitstamp_only_no.json".into());
    let key = std::env::var("NEAR_AI_API_KEY").expect("NEAR_AI_API_KEY");
    let raw = String::from_utf8(std::fs::read(format!("{}/{}", super::item_l1a_tests::L1, sheet)).unwrap()).unwrap();
    let raw = serde_json::from_str::<Value>(&raw).unwrap().to_string();
    let now: i64 = std::env::var("L1B13_NOW").ok().and_then(|s| s.parse().ok()).unwrap_or(1794065826);
    let job = json!({"contract": "escrow.testnet", "bet_id": 17, "run_no": 1, "checked_until": 0, "round": 0, "envelope": {"terms_hash": praetorial_core::sha_hex(&raw)}, "terms": raw});
    let t = Instant::now();
    let poster = CurlPoster(t); let getter = CurlGetter;
    let c = StreamJudgeCaller { api_base: "https://cloud-api.near.ai".into(), api_key: key, poster: &poster, getter: &getter,
        sleep_ms: Box::new(|ms| std::thread::sleep(std::time::Duration::from_millis(ms))), now_ms: Box::new(move || t.elapsed().as_millis()),
        sha256_hex: Box::new(|b| praetorial_core::sha_hex(&String::from_utf8_lossy(b))), verify: Box::new(|_, _, _| true) };
    let timed = Timed { inner: &c, t, calls: RefCell::new(vec![]) };
    budget::install(Box::new(SystemClock));
    let f = CurlFetcher(t);
    let (r, notes, _) = build_submission_judged_at(&job, &timed, &f, true, now);
    eprintln!("[probe] TOTAL {} ms outcome={} model_calls={:?}", t.elapsed().as_millis(), r.outcome, timed.calls.borrow());
    for n in notes.iter().filter(|n| n.contains("budget") || n.contains("D-BUDGET") || n.contains("judge")) { eprintln!("[probe] note: {}", &n.chars().take(300).collect::<String>()); }
}
