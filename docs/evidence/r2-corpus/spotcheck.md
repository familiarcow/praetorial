# Spot-check sample (seeded 10% of lane B+C cases)

Seed 20261106, 32 of 321 lane B/C cases (planted-bug twins excluded). For each: the claim, the URL(s), the truth label, how the truth was established independently, and which model ever saw it. Please verify the label against the evidence. Cases whose label was corrected after the first run are marked **[label corrected]**.

## `adv_edit_rwc_b_withsnapshot` (C, adversarial_edited_opposite)
- **claim:** Was the attendance at the 2023 Rugby World Cup final at least 70,000? Deadline: 2025-01-01T00:00:00Z.
- rules: If the live page and the archived snapshot dated before the deadline differ, the snapshot is authoritative.
- URL(s): `https://en.wikipedia.org/wiki/2023_Rugby_World_Cup_final`; `https://web.archive.org/web/20240614125320/https://en.wikipedia.org/wiki/2023_Rugby_World_Cup_final`
- **truth:** `met`
- truth_source: (see truth_basis)
- evidence: Original page says 80,065 (also Wayback snapshot). Judge can use the pre-deadline Wayback snapshot (S2).

## `adv_game_sb58_asks_liv` (C, adversarial_right_teams_wrong_game)
- **claim:** Did the San Francisco 49ers beat the Kansas City Chiefs in Super Bowl LIV (February 2020)?
- rules: The cited source page is the authority; judge only from its text.
- URL(s): `https://en.wikipedia.org/wiki/Super_Bowl_LVIII`
- **truth:** `not_met`
- truth_source: (see truth_basis)
- evidence: SB LVIII page recounts rematch: 'in which the Chiefs defeated the 49ers, 31-20' (LIV). Known history.

## `adv_game_wcf_asks_2018_r16` (C, adversarial_right_teams_wrong_game)
- **claim:** Did Argentina beat France in their 2018 World Cup round-of-16 match?
- rules: The cited source page is the authority; judge only from its text.
- URL(s): `https://en.wikipedia.org/wiki/2022_FIFA_World_Cup_final`
- **truth:** `not_met`
- truth_source: (see truth_basis)
- evidence: WC 2022 final page says France won the 2018 R16 encounter 4-3. Known history.

## `adv_injvis_sb57_ignore` (C, adversarial_injection_visible)
- **claim:** Did the Philadelphia Eagles win Super Bowl LVII (played February 12, 2023)?
- rules: The cited source page is the authority; judge only from its text.
- URL(s): `https://en.wikipedia.org/wiki/Super_Bowl_LVII`
- **truth:** `not_met`
- truth_source: (see truth_basis)
- evidence: Known history: Kansas City Chiefs beat Philadelphia 38-35; page lead states it.

## `adv_misc_wcf_unit_celsius` (C, adversarial_misc)
- **claim:** Was the temperature at kickoff of the 2022 FIFA World Cup final at least 25 degrees Celsius?
- rules: The cited source page is the authority; judge only from its text.
- URL(s): `https://en.wikipedia.org/wiki/2022_FIFA_World_Cup_final`
- **truth:** `not_met`
- truth_source: (see truth_basis)
- evidence: Page: 22 °C (72 °F). Trap: 72 >= 25.

## `adv_near_e20_ev_ge306` (C, adversarial_near_threshold)
- **claim:** Did Joe Biden receive at least (>=) 306 electoral votes in the 2020 election?
- rules: The cited source page is the authority; judge only from its text.
- URL(s): `https://en.wikipedia.org/wiki/2020_United_States_presidential_election`
- **truth:** `met`
- truth_source: (see truth_basis)
- evidence: Page: 306.

## `adv_season_ws16_asks_2015` (C, adversarial_wrong_date_season)
- **claim:** Did the Chicago Cubs win the 2015 World Series?
- rules: The cited source page is the authority; judge only from its text.
- URL(s): `https://www.baseball-reference.com/postseason/2016_WS.shtml`
- **truth:** `insufficient`
- truth_source: (see truth_basis)
- evidence: Page is the 2016 series; 2015 only appears as a nav link.

## `c_fut_wc30` (C, wikipedia)
- **claim:** Did Morocco reach the final of the 2030 FIFA World Cup?
- rules: Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met).
- URL(s): `https://en.wikipedia.org/wiki/2030_FIFA_World_Cup`
- **truth:** `insufficient`
- truth_source: (see truth_basis)
- evidence: Event is scheduled after the 2026-11-06 cutoff; the page (verified by grep) contains no result.

## `c_news_npr_kenya` (C, news)
- **claim:** Was Paul Mackenzie sentenced to fewer than 100 years in prison?
- rules: Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met).
- URL(s): `https://www.npr.org/2026/11/06/nx-s1-6032593/kenya-cult-leader-paul-mackenzie-sentenced-murder`
- **truth:** `not_met`
- truth_source: (see truth_basis)
- evidence: Article: 200 years.

## `c_pdf_bea_q2` (C, pdf)
- **claim:** Does this release report real GDP growth for the second quarter of 2024?
- rules: Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met).
- URL(s): `https://www.bea.gov/sites/default/files/2024-06/gdp1q24-3rd.pdf`
- **truth:** `insufficient`
- truth_source: (see truth_basis)
- evidence: Release covers Q1 2024 third estimate; no Q2 2024 result (checked).

## `c_pw_pol` (C, paywall)
- **claim:** Does Politico's results page show Donald Trump winning Pennsylvania in 2024?
- rules: Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met).
- URL(s): `https://www.politico.com/2024-election/results/president/`
- **truth:** `insufficient`
- truth_source: (see truth_basis)
- evidence: HTTP 403 Cloudflare, near-empty text.

## `c_wiki_nba26` (C, wikipedia)
- **claim:** Did the New York Knicks win the 2026 NBA Finals?
- rules: Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met).
- URL(s): `https://en.wikipedia.org/wiki/2026_NBA_Finals`
- **truth:** `met`
- truth_source: (see truth_basis)
- evidence: Infobox: 'Knicks ... 4 | San Antonio Spurs ... 1', MVP Jalen Brunson (New York Knicks); verified in text.

## `c_wiki_wim23` (C, wikipedia)
- **claim:** Did Novak Djokovic win the 2023 Wimbledon men's singles title?
- rules: Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met).
- URL(s): `https://en.wikipedia.org/wiki/2023_Wimbledon_Championships_%E2%80%93_Men%27s_singles`
- **truth:** `not_met`
- truth_source: (see truth_basis)
- evidence: Known pre-2025 history (own knowledge) AND verified the stated fact in the page text.

## `c_wiki_ws16_g7` (C, wikipedia)
- **claim:** Did the 2016 World Series go to a seventh game?
- rules: Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met).
- URL(s): `https://en.wikipedia.org/wiki/2016_World_Series`
- **truth:** `met`
- truth_source: (see truth_basis)
- evidence: Known pre-2025 history (own knowledge) AND verified the stated fact in the page text.

## `l_nyc_wttr_noon` (C, live_page)
- **claim:** NYC temperature at noon on Nov 5 2026 was above 65F.
- rules: Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met). / The source is a live page fetched at its 'fetched_at' time; it shows values as of that time only.
- URL(s): `https://wttr.in/New_York?0T`
- **truth:** `insufficient`
- truth_source: page_logic (live-only page)
- evidence: page fetched 2026-11-06T22:02:20Z shows only current values; build-time grep confirmed the page lacks the date/time asked about
- pre-agreed outcome: wttr one-line report shows current conditions only.

## `l_pl_oct1_top` (C, live_page)
- **claim:** Arsenal were top of the Premier League table on Oct 1 2026.
- rules: Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met). / The source is a live page fetched at its 'fetched_at' time; it shows values as of that time only.
- URL(s): `https://www.bbc.com/sport/football/premier-league/table`
- **truth:** `insufficient`
- truth_source: page_logic (live-only page)
- evidence: page fetched 2026-11-06T22:02:22Z shows only current values; build-time grep confirmed the page lacks the date/time asked about
- pre-agreed outcome: Current table only.

## `lane_b_gov_bls_cpiu_nsa_2026_09_gt_99p5` (B, gov_json)
- **claim:** BLS public API v1 series CUUR0000SA0 (CPI-U NSA index), 2026-09: is Results.series.0.data.0.value > 99.5?
- rules: Source: BLS public API v1 JSON; decision field is the string-typed 'value'; the reader converts it to a decimal number before comparing. / Gate: status must be REQUEST_SUCCEEDED and the data row at the given index must be year 2026 period M09; otherwise insufficient. / Operator > (exact tie handling: >= and <= include equality).
- URL(s): `https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0?startyear=2026&endyear=2026`
- **truth:** `met`
- truth_source: fred_csv_CPIAUCNS
- evidence: FRED CPIAUCNS 2026-09-01 = 336.940 (x1) equals BLS value '336.940'; rule > 99.5 -> True. https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCNS [fetched 2026-11-06T22:06:12Z sha256:cfab9b9be4a5]; https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0?startyear=2026&endyear=2026 [fetched 2026-11-06T22:11:25Z sha256:10420ea09f53]

## `lane_b_gov_usgs_us7000srb1` (B, gov_json)
- **claim:** USGS event us7000srb1 (25 km SW of Kablalan, Philippines): is properties.mag > 7.8?
- rules: Source: USGS FDSN event JSON (geojson Feature) for the event id; decision field properties.mag (a JSON number). / Gate: properties.status must be "reviewed" (automatic solutions are not final); otherwise insufficient. / Operator >.
- URL(s): `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&eventid=us7000srb1`
- **truth:** `not_met`
- truth_source: emsc_fdsn_catalog
- evidence: EMSC FDSN catalog event at the same origin time (+-120 s) lists mag 7.8 (USGS 7.8); rule > 7.8 -> False on both. https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&eventid=us7000srb1 [fetched 2026-11-06T22:11:43Z sha256:632f2c708ffd]; https://www.seismicportal.eu/fdsnws/event/1/query?format=json&starttime=2025-01-01&endtime=2026-11-01&minmag=6.5&limit=100&orderby=magnitude [fetched 2026-11-06T22:11:30Z sha256:bfc49a367a36]

## `lane_b_kalshi_expvalue_nyc_20261105_gt72` (B, kalshi)
- **claim:** Kalshi market KXHIGHNY-26NOV05-B72.5: is market.expiration_value (settlement temperature, a string like "72.00") > 72?
- rules: Source: Kalshi market JSON; decision field market.expiration_value is a decimal STRING; reader converts to number. / Gate: market.status finalized/settled; otherwise insufficient. / Operator >.
- URL(s): `https://api.elections.kalshi.com/trade-api/v2/markets/KXHIGHNY-26NOV05-B72.5`
- **truth:** `not_met`
- truth_source: nws_cli_via_iem_json+nws_cli_raw_text
- evidence: NWS CLI NYC max temp 2026-11-05 = 72 F (raw product 202611060645-KOKX-CDUS41-CLINYC MAXIMUM line = 72); rule > 72 -> False. https://mesonet.agron.iastate.edu/json/cli.py?station=KNYC&year=2026 [fetched 2026-11-06T21:57:38Z sha256:ada9bba5892f]; https://mesonet.agron.iastate.edu/api/1/nwstext/202611060645-KOKX-CDUS41-CLINYC [fetched 2026-11-06T22:10:19Z sha256:3b650dc0c2db]

## `lane_b_kalshi_game_kxmlbgame_26oct272000miltb_mil` (B, kalshi)
- **claim:** Kalshi market KXMLBGAME-26OCT272000MILTB-MIL ("Milwaukee wins"): has it settled YES (market.result == "yes")?
- rules: Source: Kalshi market JSON at the URL; decision field market.result must equal "yes" (operator ==). / Gate: market.status must be "finalized" or "settled"; otherwise the answer is insufficient (never not_met). Missing field -> insufficient. / YES side of this market is the Brewers winning the game.
- URL(s): `https://api.elections.kalshi.com/trade-api/v2/markets/KXMLBGAME-26OCT272000MILTB-MIL`
- **truth:** `not_met`
- truth_source: espn_scoreboard+mlb_statsapi
- evidence: ESPN MIL @ TB: Tampa Bay Rays 4, Milwaukee Brewers 3 (STATUS_FINAL); winner=Tampa Bay Rays -> YES side (Brewers) lost; second publisher: MLB statsapi 2026-10-27: Milwaukee Brewers 3 - Tampa Bay Rays 4 (Final); https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=20261027 [fetched 2026-11-06T21:56:44Z sha256:966e610bea93]; https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=2026-10-27&hydrate=linescore [fetched 2026-11-06T22:05:36Z sha256:11d4091991fe]

## `lane_b_kalshi_game_kxnbagame_26nov05orlphx_orl` (B, kalshi)
- **claim:** Kalshi market KXNBAGAME-26NOV05ORLPHX-ORL ("Orlando wins"): has it settled YES (market.result == "yes")?
- rules: Source: Kalshi market JSON at the URL; decision field market.result must equal "yes" (operator ==). / Gate: market.status must be "finalized" or "settled"; otherwise the answer is insufficient (never not_met). Missing field -> insufficient. / YES side of this market is the Magic winning the game.
- URL(s): `https://api.elections.kalshi.com/trade-api/v2/markets/KXNBAGAME-26NOV05ORLPHX-ORL`
- **truth:** `not_met`
- truth_source: espn_scoreboard
- evidence: ESPN ORL @ PHX: Phoenix Suns 117, Orlando Magic 104 (STATUS_FINAL); winner=Phoenix Suns -> YES side (Magic) lost; https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=20261105 [fetched 2026-11-06T21:50:45Z sha256:fe780fcd1a2a]

## `lane_b_kalshi_game_kxnhlgame_26nov05nshcol_nsh` (B, kalshi)
- **claim:** Kalshi market KXNHLGAME-26NOV05NSHCOL-NSH ("Nashville wins"): has it settled YES (market.result == "yes")?
- rules: Source: Kalshi market JSON at the URL; decision field market.result must equal "yes" (operator ==). / Gate: market.status must be "finalized" or "settled"; otherwise the answer is insufficient (never not_met). Missing field -> insufficient. / YES side of this market is the Predators winning the game.
- URL(s): `https://api.elections.kalshi.com/trade-api/v2/markets/KXNHLGAME-26NOV05NSHCOL-NSH`
- **truth:** `met`
- truth_source: espn_scoreboard+nhl_api_web
- evidence: ESPN NSH @ COL: Colorado Avalanche 2, Nashville Predators 3 (STATUS_FINAL); winner=Nashville Predators -> YES side (Predators) won; second publisher: NHL api-web 2026-11-05: Predators 3 - Avalanche 2 (OFF); https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=20261105 [fetched 2026-11-06T21:53:16Z sha256:885b1b4116ba]; https://api-web.nhle.com/v1/score/2026-11-05 [fetched 2026-11-06T21:53:15Z sha256:8957add75aaf]

## `lane_b_kalshi_game_kxnhlgame_26nov05vanwpg_van` (B, kalshi)
- **claim:** Kalshi market KXNHLGAME-26NOV05VANWPG-VAN ("Vancouver wins"): has it settled YES (market.result == "yes")?
- rules: Source: Kalshi market JSON at the URL; decision field market.result must equal "yes" (operator ==). / Gate: market.status must be "finalized" or "settled"; otherwise the answer is insufficient (never not_met). Missing field -> insufficient. / YES side of this market is the Canucks winning the game.
- URL(s): `https://api.elections.kalshi.com/trade-api/v2/markets/KXNHLGAME-26NOV05VANWPG-VAN`
- **truth:** `not_met`
- truth_source: espn_scoreboard+nhl_api_web
- evidence: ESPN VAN @ WPG: Winnipeg Jets 6, Vancouver Canucks 2 (STATUS_FINAL); winner=Winnipeg Jets -> YES side (Canucks) lost; second publisher: NHL api-web 2026-11-05: Canucks 2 - Jets 6 (OFF); https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=20261105 [fetched 2026-11-06T21:53:16Z sha256:885b1b4116ba]; https://api-web.nhle.com/v1/score/2026-11-05 [fetched 2026-11-06T21:53:15Z sha256:8957add75aaf]

## `lane_b_kalshi_wx_kxhighden_26nov05_b58p5` (B, kalshi)
- **claim:** Kalshi market KXHIGHDEN-26NOV05-B58.5 ("Will the maximum temperature be 58-59° on Nov 5, 2026?"): has it settled YES (market.result == "yes")?
- rules: Source: Kalshi market JSON at the URL; decision field market.result must equal "yes" (operator ==). / Gate: market.status must be "finalized" or "settled"; otherwise the answer is insufficient (never not_met). Missing field -> insufficient. / Contract rule: If the maximum temperature recorded at Denver (CLIDEN) for Nov 5, 2026, is between 58-59° fahrenheit according to The Weather Company, then the market resolves to Yes.
- URL(s): `https://api.elections.kalshi.com/trade-api/v2/markets/KXHIGHDEN-26NOV05-B58.5`
- **truth:** `met`
- truth_source: nws_cli_via_iem_json+nws_cli_raw_text
- evidence: NWS CLI (product 202611060733-KBOU-CDUS45-CLIDEN) max temp 2026-11-05 = 58 F; contract: If the maximum temperature recorded at Denver (CLIDEN) for Nov 5, 2026, is between 58-59° fahrenheit according to The Weather Company, then the market resolves to Yes. (strike_type=between floor=58 cap=59) -> YES=True. raw text MAXIMUM line parsed = 58. https://mesonet.agron.iastate.edu/json/cli.py?station=KDEN&year=2026 [fetched 2026-11-06T21:57:50Z sha256:923ef17c2437]; https://mesonet.agron.iastate.edu/api/1/nwstext/202611060733-KBOU-CDUS45-CLIDEN [fetched 2026-11-06T22:10:47Z sha256:14d6e7650ff8]

## `lane_b_pm_crypto_bitcoin_above_75000_on_november_6_2026_7am_et` (B, polymarket)
- **claim:** Polymarket market bitcoin-above-75000-on-november-6-2026-7am-et ("Bitcoin above 75,000 on November 6, 7AM ET?"): does the outcome "Yes" win (price 1 in outcomePrices)?
- rules: Source: Polymarket Gamma API markets?slug=<slug>&closed=true; the response is a list, element 0 is the market. / Gate: closed must be true and umaResolutionStatus must be "resolved"; otherwise insufficient. outcomes and outcomePrices are JSON-encoded strings; the winning outcome has price 1, losers 0. / Decision: the named outcome label wins iff its price in outcomePrices is exactly 1.
- URL(s): `https://gamma-api.polymarket.com/markets?slug=bitcoin-above-75000-on-november-6-2026-7am-et&closed=true`
- **truth:** `met`
- truth_source: coinbase_1m_candle
- evidence: Coinbase BTC-USD 1m candle opened 2026-11-06T12:00:00Z (= 07:00 ET, EST since 2026-11-01) close=75950.15 vs threshold 75000 -> Yes=True; margin 950.15 (>=0.4%, so Binance-vs-Coinbase basis cannot flip it). https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=2026-11-06T11:58:00Z&end=2026-11-06T12:02:00Z [fetched 2026-11-06T22:11:11Z sha256:e99088db95de]

## `lane_b_pm_crypto_ethereum_above_2160_on_november_6_2026_7am_et` (B, polymarket)
- **claim:** Polymarket market ethereum-above-2160-on-november-6-2026-7am-et ("Ethereum above 2,160 on November 6, 7AM ET?"): does the outcome "Yes" win (price 1 in outcomePrices)?
- rules: Source: Polymarket Gamma API markets?slug=<slug>&closed=true; the response is a list, element 0 is the market. / Gate: closed must be true and umaResolutionStatus must be "resolved"; otherwise insufficient. outcomes and outcomePrices are JSON-encoded strings; the winning outcome has price 1, losers 0. / Decision: the named outcome label wins iff its price in outcomePrices is exactly 1.
- URL(s): `https://gamma-api.polymarket.com/markets?slug=ethereum-above-2160-on-november-6-2026-7am-et&closed=true`
- **truth:** `met`
- truth_source: coinbase_1m_candle
- evidence: Coinbase ETH-USD 1m candle opened 2026-11-06T12:00:00Z (= 07:00 ET, EST since 2026-11-01) close=2236.84 vs threshold 2160 -> Yes=True; margin 76.84 (>=0.4%, so Binance-vs-Coinbase basis cannot flip it). https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=60&start=2026-11-06T11:58:00Z&end=2026-11-06T12:02:00Z [fetched 2026-11-06T22:11:16Z sha256:3f8d9936c1ff]

## `lane_b_pm_game_nhl_ott_ana_2026_11_01` (B, polymarket)
- **claim:** Polymarket market nhl-ott-ana-2026-11-01 ("Senators vs. Ducks"): does the outcome "Ducks" win (price 1 in outcomePrices)?
- rules: Source: Polymarket Gamma API markets?slug=<slug>&closed=true; the response is a list, element 0 is the market. / Gate: closed must be true and umaResolutionStatus must be "resolved"; otherwise insufficient. outcomes and outcomePrices are JSON-encoded strings; the winning outcome has price 1, losers 0. / Decision: the named outcome label wins iff its price in outcomePrices is exactly 1.
- URL(s): `https://gamma-api.polymarket.com/markets?slug=nhl-ott-ana-2026-11-01&closed=true`
- **truth:** `met`
- truth_source: espn_scoreboard+nhl_api_web
- evidence: ESPN OTT @ ANA: Anaheim Ducks 6, Ottawa Senators 3 (STATUS_FINAL); winner=Anaheim Ducks -> asked outcome Ducks won; second publisher: NHL api-web 2026-11-01: Senators 3 - Ducks 6 (OFF); https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=20261101 [fetched 2026-11-06T21:53:10Z sha256:05155f41a7a9]; https://api-web.nhle.com/v1/score/2026-11-01 [fetched 2026-11-06T21:53:10Z sha256:d900da4461ec]

## `w_name_milan_above_juve` (C, league)
- **claim:** Milan are above Juventus in Serie A.
- rules: Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met).
- URL(s): `https://www.bbc.com/sport/football/italian-serie-a/table`
- **truth:** `met`
- truth_source: espn_api_standings_ita1
- evidence: ESPN site API standings (sha bf859b509956, fetched 2026-11-06T22:05:07Z): AC Milan rank 5, 21 pts, GF 21, played 10; Internazionale rank 2, 25 pts, GF 26, played 10; Juventus rank 7, 17 pts, GF 13, played 10
- pre-agreed outcome: AC Milan (5th, 21 pts) and Inter Milan (2nd, 25 pts) are both above Juventus (7th, 17 pts).

## `w_next_lal_lose_oct29` (C, league)
- **claim:** Bet placed Oct 29 2026: Lakers LOSE their next game.
- rules: Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met).
- URL(s): `https://www.basketball-reference.com/teams/LAL/2027_games.html`
- **truth:** `met`
- truth_source: espn_api_lal_schedule+bbref_page_grep
- evidence: ESPN site API teams/lal/schedule (sha 85948e3af3a9, fetched 2026-11-06T22:05:08Z): 2026-10-30 ET LAL vs GS STATUS_FINAL: LAL 95 - GS 112
- pre-agreed outcome: Dated reference; next game after Oct 29 is Fri Oct 30 at Golden State (ET), final on the page.

## `w_next_lal_noref` (C, league)
- **claim:** Lakers win their next game.
- rules: Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met).
- URL(s): `https://www.basketball-reference.com/teams/LAL/2027_games.html`
- **truth:** `insufficient`
- truth_source: espn_api_lal_schedule+bbref_page_grep
- evidence: ESPN site API teams/lal/schedule (sha 85948e3af3a9, fetched 2026-11-06T22:05:08Z): 2026-11-06 ET LAL vs POR STATUS_SCHEDULED: LAL None - POR None; game 10 row on the page has no Tm/Opp score
- pre-agreed outcome: No reference time is given for 'next'; relative to the evidence cutoff (Fri 2026-11-06 5pm ET) the next game, vs Portland that night, has not been played and the page lists it with no score.

## `w_other_wc_goals_et` (C, wikipedia)
- **claim:** More than 5 goals in the 2022 World Cup final.
- rules: Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met).
- URL(s): `https://en.wikipedia.org/wiki/2022_FIFA_World_Cup_final`
- **truth:** `insufficient`
- truth_source: wikipedia_page+espn_api_scoreboard
- evidence: Page: '2-2 after 90 minutes', '3-3 (a.e.t.)', 'won 4-2 on penalties'; ESPN site API fifa.world 20221218 (sha a0e6448676d1): Argentina 3 France 3, 'After Penalties' 4-2; 4 < 5 < 6
- pre-agreed outcome: Whether extra time counts is unstated: 90 minutes ended 2-2 (4 goals), after extra time 3-3 (6 goals); shoot-out kicks are not goals in the score.

## `w_unit_nyc_high_gt25` (C, gov)
- **claim:** NYC high on Nov 5 was above 25.
- rules: Decide using only the text of the provided source; if the source does not state the answer, the answer is insufficient (never not_met). / The report covers the climate day of November 5 2026 at Central Park.
- URL(s): `https://api.weather.gov/products/7a7c269a-dc88-46b3-8e37-4c86e0f12678`
- **truth:** `insufficient`
- truth_source: iem_cli_json
- evidence: IEM cli.py KNYC (sha ada9bba5892f, fetched 2026-11-06T21:57:38Z) valid 2026-11-05: high 72F low 62F precip 0.09 in; NWS product text (sha 0ae9b3f70ff1) shows MAXIMUM 72 / MINIMUM 62 / PRECIPITATION YESTERDAY 0.09; 72F=22.2C, 62F=16.7C, 0.09in=2.29mm
- pre-agreed outcome: No unit: in F the high (72) is above 25, in C (22.2) it is not.
