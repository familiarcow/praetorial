# L1a: crypto-price example set, offline replay through the CURRENT resolver (f298d82)

27 examples, 27 PASS, 0 RED. Recorded fixtures only (fixtures/manifest.json: url, fetch time, sha256). No network, no NEAR AI.
Test: `resolver/wasm-bin/src/item_l1a_tests.rs` (`cargo test l1a` in resolver/wasm-bin); regenerate with `python3 -I gen_examples.py`.
Paths: **code** = typed template decided by code (judge only audits); **AI** = custom/Jason-form sheet, judge reply is a RECORDED hand-written constant (so these test the resolver's gates and verbatim-quote check, not a model); **builder-reject** = materialize/open/relative-date checks refuse the sheet.

| id | phrasing | expected | actual | path | result |
|---|---|---|---|---|---|
| jason_same_bucket_yes **[L1b]** | Jason form: BTC 1-min high reaches $75948 on BOTH Coinbase and Bitstamp within the same 5- | YES | YES | AI | PASS |
| jason_bitstamp_only_no **[L1b]** | Jason form, level touched on Bitstamp only (past window) | NO | NO | AI | PASS |
| jason_coinbase_only_no | Jason form, level touched on Coinbase only (past window) | NO | NO | AI | PASS |
| jason_both_venues_different_buckets_no | Jason form, level touched on both venues but in different 5-minute buckets | NO | NO | AI | PASS |
| jason_coinbase_gap_kraken_fallback_yes (SYNTH) | Jason form with 12 Coinbase minutes missing (SYNTHETIC deletion) -> Coinbase excluded (D-R | YES | YES | AI | PASS |
| jason_coinbase_small_gap_yes (SYNTH) | Jason form with 2 Coinbase minutes missing (SYNTHETIC deletion, within the D-RESOLVE8 tole | YES | YES | AI | PASS |
| close_above_yes **[L1b]** | BTC closes above $75828 at 2026-11-07T14:00:00Z | YES | YES | code | PASS |
| close_above_no | BTC above $75848 at 2026-11-07T14:00:00Z | NO | NO | code | PASS |
| close_below_yes | BTC below $75848 at 2026-11-07T14:00:00Z | YES | YES | code | PASS |
| close_below_no | BTC below $75828 at 2026-11-07T14:00:00Z | NO | NO | code | PASS |
| touch_above_yes | BTC touches $76146 before 2026-11-07T14:20:00Z | YES | YES | code | PASS |
| touch_above_no | BTC hits $76153 before 2026-11-07T14:20:00Z | NO | NO | code | PASS |
| touch_above_one_venue_void | BTC touches $76147 before 2026-11-07T14:20:00Z (only one venue reached it) | VOID | VOID | code | PASS |
| touch_below_yes | BTC drops to $75729 before 2026-11-07T14:20:00Z | YES | YES | code | PASS |
| touch_below_no | BTC falls to $75710 before 2026-11-07T14:20:00Z | NO | NO | code | PASS |
| pct_move_day_builder | BTC up more than 5% on 2026-11-07 (open->close) | REJECT:TPL_UNKNOWN_ID | REJECT:TPL_UNKNOWN_ID | builder-reject | PASS |
| eth_close_builder | ETH closes above $2,000 at 2026-11-07T20:00 UTC | REJECT:TPL_UNKNOWN_FIELD | REJECT:TPL_UNKNOWN_FIELD | builder-reject | PASS |
| sol_touch_builder | SOL touches $150 before 2026-11-07 | REJECT:TPL_UNKNOWN_FIELD | REJECT:TPL_UNKNOWN_FIELD | builder-reject | PASS |
| eth_and_sol_builder | ETH and SOL both above their level at 2026-11-07T20:00 UTC | REJECT:TPL_UNKNOWN_FIELD | REJECT:TPL_UNKNOWN_FIELD | builder-reject | PASS |
| no_timezone_builder | BTC above $76,000 at 5pm tomorrow (no timezone) | REJECT:TPL_T_UTC_NOT_MINUTE | REJECT:TPL_T_UTC_NOT_MINUTE | builder-reject | PASS |
| amount_100k_builder | BTC above 100k at 2026-11-08T17:00:00Z | REJECT:TPL_X_USD_NOT_WHOLE | REJECT:TPL_X_USD_NOT_WHOLE | builder-reject | PASS |
| friday_custom | BTC will be above $76,000 on Friday | REJECT:CUSTOM_RELATIVE_DATE | REJECT:CUSTOM_RELATIVE_DATE | builder-reject | PASS |
| flips_100k_messy **[L1b]** | BTC flips 100k | VOID | VOID | AI | PASS |
| range_all_session_stays_within_void | BTC stays between $75661 and $76203 for the whole session | VOID | VOID | AI | PASS |
| range_breakout_no | BTC stays below $76123 for the whole session | NO | NO | AI | PASS |
| pct_up_day_custom_void | BTC up more than 5% on 2026-11-07 (open->close), custom sheet | VOID | VOID | AI | PASS |
| probe_adversarial_judge_met_one_venue **[L1b]** | Jason form, level touched on Bitstamp only, but the (recorded, adversarial) judge answers  | VOID | VOID | AI | PASS |

## L1b candidates (live testnet run)
- `jason_same_bucket_yes`: Jason past-window YES
- `jason_bitstamp_only_no`: Jason one-venue NO
- `close_above_yes`: close-at-T
- `flips_100k_messy`: messy phrasing must VOID
- `probe_adversarial_judge_met_one_venue`: Jason one-venue NO

## Finding (not in the merged set): custom Jason-form YES rests entirely on the judge
See FINDING.md. Probe `probe_adversarial_judge_met_one_venue` (side branch `feat/l1a-red-adversarial-judge`, RED): a judge reply `met` citing only the Bitstamp row for a level Coinbase never reached makes the resolver sign YES. Typed templates are not affected (code decides).
