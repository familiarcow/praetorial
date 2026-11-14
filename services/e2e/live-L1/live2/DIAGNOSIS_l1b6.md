# L1b6 diagnosis: no resolver output ~120 s on the Jason one-venue NO sheet

Status: slowness NOT reproduced natively; root cause NOT confirmed. A real unbounded-wait gap was found and closed
(source fetch had no deadline/budget). Do not read this as "the 120 s is fixed" until L1b7 shows the new stderr lines live.

## Native timing (raw: diag_l1b6_native_timing.log, probe source: diag_l1b6_probe.rs.txt)
Exact job input (`terms_jason_bitstamp_only_no.json`, envelope job shape), `build_submission_judged_at`, REAL public
Coinbase/Bitstamp/Kraken candle endpoints via curl (no keys), canned judge (no NEAR AI), 2026-11-07 ~15:05Z:

| stage | wall |
|---|---|
| Coinbase fetch (1 page, 7 KB) | 101-170 ms |
| Bitstamp fetch (1 page, 16 KB) | 530-625 ms |
| Kraken fetch (1 page, 57 KB) | 227-285 ms |
| judge (canned) | 0 ms |
| total | ~1.0 s |

Single page per venue (120 one-minute candles), so no pagination loop exists for this sheet (`price_pages` is bounded to
<= 3 pages/venue). Kraken `since=` returns only the latest 720 candles, so a window older than ~12 h is "no candles in
window" -> venue EXCLUDED/COULDNT_CHECK (an error path, fast, not a hang). Gate path (`price_condition_gate`) already
covered by `l1b2_live_one_venue_no_sheet_yields_outcome`. So fetch/gate/pagination are not slow on a healthy network.

## What the code does that CAN stall to ~120 s (read, not reproduced)
1. `real_fetch::WasiFetcher` (source GETs) used `wasi_http_client` `send()` + `body()`: no first-byte, between-bytes or
   total deadline (only connect timeout is even settable in that crate). A source that accepts the connection and never
   answers (or trickles) blocks until the host's own default or the platform kill. No total fetch budget either.
2. Model calls (not touched here): `STREAM_IDLE_TIMEOUT_MS`=60 s x `STREAM_MAX_ATTEMPTS`=2 = 120 s for ONE stalled call,
   +~3 s of overhead ~= the observed 120-123 s. The D-BUDGET1 budget only guards the rerun, not a stalled first call, and
   the second model is still called after a stalled first one. Bet 2 (messy, same wasm) had two 6.8/7.4 s calls, so calls
   are not slow in general; a stall specific to this prompt/NO verdict is a hypothesis, unconfirmed.
Either could explain "4/4 no output ~120 s"; only a live run with timing can tell. We cannot call NEAR AI here.

## Fix (this item)
- Per-request deadline <= 15 s and one shared source-fetch budget of 45 s (inside D-BUDGET1's 120 s). `fetch_json` asks
  `budget::fetch_timeout_ms()` (min(15 s, budget left); Err once spent), passes it to the new `HttpFetcher::fetch_timeout`;
  `WasiFetcher::fetch_timeout` is a bounded GET (host connect/first-byte/between-bytes options + poll timers on headers and
  body, shared across redirect hops).
- A source that times out or is refused is unavailable: venue EXCLUDED with COULDNT_CHECK; under the sheet's fallback rule
  fewer than two venues -> VOID; never NO, never YES (tests `one_hanging_source...`, `all_sources_hanging...`).
- Stage timing for the next live run: `L1b6 fetch host=<h> ms=<n> ok|err` on stderr per source request
  (`budget::fetch_log()` in tests). Model-call timing was already `D-BUDGET1: calls_ms=[..]`.

## Limits / next
- `WasiFetcher::fetch_timeout` compiles for wasm32-wasip2 (real-http,outlayer-sign) but is not exercised under a wasm host
  here (no wasmtime installed); native tests use a fake fetcher honouring the deadline. L1b7 live run is the proof.
- If L1b7 shows source fetches fast but total still ~120 s, the stalled model call (item 2) is next: cap the stream
  idle/total by the remaining budget and skip the second model call when the first consumed the budget. That touches
  judge/stream settings, so it was left out of scope (design question in the report).
