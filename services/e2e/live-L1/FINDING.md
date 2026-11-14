# L1a finding: Jason-form (custom) YES is decided by the judge alone; code does not verify "both venues"

Probe (side branch `feat/l1a-red-adversarial-judge`, test RED): sheet = `jason_bitstamp_only_no` (level reached on Bitstamp only; Coinbase max is 1.0 below it). Recorded judge reply
`{"answer":"met","source_id":"S_BS","quote":"1794029880,75952.18"}` (a real Bitstamp row, nothing from Coinbase). Resolver result: **YES**; expected NO (or VOID).
Why: at 1m granularity the D-RESOLVE6b coarse gate does not apply; `verify` only checks the quote is verbatim in the cited source, and the custom path takes the judge's `met` as the element verdict. The resolver holds all three candle sets and could check "high >= X on both venues in one 5-min bucket" itself, but does not.
Severity: MEDIUM, conditional on judge error (needs a model to answer met on one venue's evidence). Scope: legacy custom/Jason form only; typed btc_close_at_t / btc_touch are decided by code and unaffected. Jason form is out of the MVP scope (Design: coincidence rules excluded).
Options for a new queue item: (A) code gate for custom price sheets: when the sheet's claim pins a threshold + venues, require the code-computed condition before signing YES (recommended if Jason form stays in the demo); (B) accept as AI-judge risk and retire the Jason form from the mainnet demo; (C) require `also` corroboration from every named venue for YES on price sheets.
- 2026-11-07 FIXED by a7e4bd2 (D-L1GATE1/1a): judge/code disagreement => VOID
