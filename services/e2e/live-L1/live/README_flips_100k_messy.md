# L1b live testnet: flips_100k_messy (bet 3)
Escrow `praetorial-l1b-11071028.praetorial-dev-1101.testnet` (testnet), escrow wasm sha256 `812837958ab87ecdef80fe1d78f2e27adff465b18eff24ae9a150b766908df74` (stripped build of main 70bc98d, `CARGO_PROFILE_RELEASE_STRIP=symbols`, 514 KB), resolver wasm sha256 `f6c24165f2ca9c24555d9edaa90aa2fd1ef26ad52035780895f5c502a52bdd17` (reproducible build of bd6b21e, uploaded to FastFS by `outlayer upload`, hash re-verified by verifier E3). D-KEY2 report-pubkey + sourcecheck as in R3e. Assets: intents-mock USDC (testnet mock, 10 USDC each side). settlement_period 3600s (contract minimum 1h) so finalize is not possible until 1h after submit_outcome; the 50-minute run limit ended before that.

**Status: PARTIAL, not DONE** (proposed on chain, settlement window open until 2026-11-07T16:42Z; finalize pending, run `sh resume_finalize.sh`). Verifier pre-finalize: `verify_pre_finalize_bet3.txt` (7 PASS / 0 FAIL / 3 SKIP: E4, B4 partial, B5 needs finalize).

- Claim: BTC flips 100k
- Window: 2026-11-07T04:20:00Z .. 2026-11-07T14:20:00Z (past window); L1a expectation: **VOID** (messy phrasing, expected VOID).
- Sources (resolver-fetched): 
- S_CB Coinbase BTC-USD: `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=2026-11-07T04:20:00Z&end=2026-11-07T08:29:59Z` sha256 `915bff5b13d72e4c32547632c9530fdcb54f9f4f53200279a543108b69c8f849`
- S_BS Bitstamp btcusd: `https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=60&limit=600&start=1794025200&end=1794061199` sha256 `0603ccf84426ab1b43085c4cf65355a8851db90dc04c6f96008bd10f011026f9`
- S_KR Kraken XBT/USD: `https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1&since=1794025199` sha256 `2f3b607905404b62b704691d1f8058b91245a2c4bb603afd6ec85aba981c3a69`
- Judges (2 NEAR AI models, judge_backend `near-ai`, element verdict `not_proven`):
- `deepseek-ai/DeepSeek-V4.1-Flash-1017` HTTP 200: `{"answer": "not_met", "quote": "1794042000,76152.43", "source_id": "S_CB", "also": [{"source_id": "S_BS", "quote": "1794042000,76143.75"}, {"source_id": "S_KR", "quote": "1794042000,76146.9"}], "reason": "The complete 1-minute candle highs across all three venues in the window peak around 76,152 USD, far below 100,000, so BTC did not flip 100k."}`
- `z-ai/glm-5.3-flash` HTTP 200: `{"answer": "not_met", "quote": "1794042000,76152.43", "source_id": "S_CB", "also": [{"source_id": "S_BS", "quote": "1794042000,76143.75"}, {"source_id": "S_KR", "quote": "1794042000,76146.9"}], "reason": "Across the complete window all three venues' 1-minute candle highs peak around 76,152 USD (Coinbase 76152.43, Bitstamp 76143.75, Kraken 76146.9), far below 100,000, so BTC never flipped 100k."}`
- Signed outcome: **NO** (run_no 1, terms_hash `1fe0fffc0c9a969a44f67b2d3a453fed37b90d67a0fd1dbe980c08b39a81bb20`); bet status after submit_outcome: Proposed NO.
- Stakes: maker 10 USDC (mock) vs taker 10 USDC; payouts: pending finalize (winner gets 20 USDC minus fee).
- Txs: sourcecheck `GNjXz26pGAoCpu7NJ5K6i4qvg1bdXYdEG8AA8yRLAmb6`, open `5VpkBp8LyD2Ef5RWXUuvduT1L2GAbHFSTSrvwuSMaeiY`, take `DDPUqQjG2kjhf8nq5Gma1xRztQ3Luk4LQ6WDkPcrebf9`, request_resolution `C1yzpZyXVVLpjktTxgJkQwsf4WHosFqimkpEdfj6rR2m`, submit_outcome `D14ziS5ZK8V7An7Wxs1n1RoVpNF5Pvcb7KzLjFPZbSZ2`, finalize: pending.
- Files: `terms_flips_100k_messy.json`, `sourcecheck_flips_100k_messy.log`, `results_flips_100k_messy.json` (incl. raw resolution), `verify_pre_finalize_bet3.txt`.

**DISCREPANCY vs L1a expectation:** L1a expected VOID (recorded judge `insufficient`). Both live models answered a decisive `not_met` (all venue highs ~76,150 << 100,000), so the resolver signed **NO**, not VOID. The pipeline has no ambiguity gate for vague wording (`flips`), the AI picks one reading. Economic result is plausible (BTC did not reach 100k), but this example does not demonstrate VOID-on-messy-phrasing. See the top-level README.
