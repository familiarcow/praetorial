# Lane B corpus report (cases/lane_b.jsonl)

Built by `build/build_lane_b.py` (all network via fetchlib; rerun reproduces from fixtures/). 76 cases = 70 real + 6 planted-bug copies (`__bug`, 8.6%).
Reader (code under test) = `jget` + `read_case`; truth functions (`espn_result`, `nhl_result`, `mlb_result`, `iem_cli*`, `coinbase_close`, `fred_series`, EMSC) never call the reader and never read the outcome field under test.

## Counts (70 real)
| type | met | not_met | insufficient |
|---|---|---|---|
| kalshi (27) | 10 | 13 | 4 |
| polymarket (20) | 10 | 7 | 3 |
| gov_json (23) | 8 | 10 | 5 |
Total expected: met 28, not_met 30, insufficient 12. Reader proposal == expected for all 70 real cases (0 `code_wrong`); the 6 bug copies have a wrong proposal by construction (4 flipped decisions produced by running the reader with a mutated spec: reversed operator or other outcome label; 2 "missing/unsettled treated as not_met").

Tags: string_numeric 13 (BLS/Treasury/Kalshi decimal strings), json_in_string 20 (Polymarket outcomePrices/outcomes), near_threshold 13, exact_tie 6, lexicographic_trap 2 (string "336.940" vs 99.5), wrong_path 7, unsettled/unresolved 6, trailing_zero 1, sdmx_nested_path 1.

## Truth per group
- Kalshi games (7: NBA 2, NHL 2, NFL 1, MLB 2): ESPN scoreboard final score (+ NHL api-web / MLB statsapi as second publisher for NHL/MLB) mapped to the YES team. NBA/NFL are ESPN only (cdn.nba.com 403; no second free API found).
- Kalshi weather (8 + 2 expiration_value cases): NWS CLI daily max via IEM cli.py JSON, cross-checked against the raw CLI text product (MAXIMUM line) -- both must agree; applied to the market's strike definition (strike_type/floor/cap), not its result. Same upstream (NWS) so "independent" = different parse path and different publisher (IEM) from Kalshi. Kalshi rules text says "The Weather Company"; every one of the 8 Kalshi expiration_values matched NWS CLI.
- Kalshi BTC (3): Coinbase BTC-USD 1m candle at 20:59Z vs strike, only when >=150 USD away.
- Kalshi CPI (3): month-over-month % of SA CPI-U from FRED CPIAUCSL and BLS API CUSR0000SA0, both must agree (rounded to 0.1); one is an exact tie (0.6 vs "greater than 0.6" -> NO).
- Polymarket NHL/NFL (11): ESPN + NHL api-web (NFL ESPN only).
- Polymarket BTC/ETH above-X-at-7am-ET (6): Coinbase 1m candle at 12:00Z, thresholds >=0.4% from price (Polymarket uses Binance).
- gov_json: BLS v1 values vs FRED redistribution (7 numeric + 3 wrong-path); Treasury debt_to_penny vs FRED GFDEBTN (same upstream agency, separate publisher path); USGS magnitude vs EMSC catalog (3, same answer on both); World Bank US population vs FRED POP (BEA/Census); Frankfurter (ECB) and ECB SDMX vs Fed H.10 (FRED DEXUSEU); Open-Meteo archive grid vs NWS CLI station max (threshold 4 F away).
- insufficient: unsettled Kalshi (3: status active and close_time after fetch time), unresolved Polymarket (2: closed=false, endDate future), wrong/missing path (Kalshi market.outcome, Polymarket outcomePrice, BLS val, BLS index 99, BLS nonexistent series, USGS properties.magnitude), World Bank 2026 (body `[meta, null]`). Truth = the recorded record's own status/close fields or key inspection, stated in `truth_evidence`.

## Dropped
0 dropped by the build (`build/lane_b_dropped.json` empty): every kept candidate had an independent confirmation. Candidates never built for lack of a truth source: Polymarket/Kalshi "Manila/Karachi highest temperature", tornado-risk, S&P (KXINXU), Polymarket soccer (Thai league; ESPN lacks it), Census API (needs key), SEC data API (403), NWS live observations (no past-state independent record).

## Notes / caveats
- BLS API v1 ignores startyear/endyear and always returns the last 3 years; a 2020 trap case was replaced by CPI vs 99.5 (lexicographic). BLS 2025-M10 value is "-" (shutdown gap); not used.
- Kalshi/Polymarket single-record URLs: `/markets/<ticker>` (path `market.*`) and `?slug=<slug>&closed=true` (list, path `0.*`). Polymarket slug lookups for closed markets require `closed=true`.
- Latest-period gov values (e.g. UNRATE 2026-10, AHE 2026-10) are first prints as of 2026-11-06 and may be revised; cases pin year/period via gates.
- Gate rule used for Kalshi: status in {finalized, settled}; Polymarket: closed true AND umaResolutionStatus resolved AND prices a clean 0/1 vector.
- No fetch failures needing browser UA; all `fetch_labels` are polite-UA, no cookies. Bug copies share facts with their originals; `bettor_spec` field documents URL/path/gates/operator per case.
