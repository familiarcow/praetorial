# FRZ2SEC1 live proof (testnet, frz2 escrow praetorial-frz2-2611091914.praetorial-dev-1101.testnet)
Secret bound: profile `praetorial-resolver`, owner `praetorial-dev-1101.testnet` (outlayer_config.secrets_account_id; OUTLAYER_HOME=~/.outlayer),
wasm hash `6517a422f55639d5d452ba2abcea93cc261c33729025be2afd5efcfa42d3b1c3` (== `resolver_keys()[2]` == apps/web/lib/release.json, all 64 chars), via the frz2 escrow.
Bet 26 (iana.org mention check, past window, 1 USDC-style mock stake): request_resolution tx `3qa7gDkBzUb1XKYXH8x5KTQAPx1VfaD3gjiDbdcQCsiC`;
`bet26_last_resolution_raw.json`: judge_backend `near-ai`, http_status [200, 200] (DeepSeek-V4.1-Flash-1017, glm-5.3-flash). Outcome in that raw was VOID
(not evidence about the binding; the point is the backend). `prove_live.mjs` opens/takes; `resume_live.mjs` tops up keeper credit and requests resolution.
Bet 26 is left in Resolving (no submit/finalize needed for this item).
