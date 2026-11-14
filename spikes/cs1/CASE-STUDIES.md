# CS1 case studies (testnet)

Generated 2026-11-12 05:54 UTC by `spikes/cs1/casestudies.mts` from on-chain state.
Escrow `praetorial-frz3-2611100414.praetorial-dev-1101.testnet`; site https://praetorial-web-testnet.familiarcow.workers.dev. Every tx links to nearblocks testnet. People are the demo accounts' @usernames.
Bet pages: the deployed testnet site still runs the pre-K0 bet page, so the screenshots are the K0 kit render of the same on-chain data (`spikes/cs1/render.tsx`).

## BTC closes at or above $74,500 at 21:00 UTC

> @alice_demo bet 25 USDC that Bitcoin would close at or above $74,500 at 21:00 UTC; @bob_demo took NO. The AI read the 21:00 one-minute close on Coinbase, Bitstamp and Kraken (median $74,590.60), ruled YES, nobody challenged within the hour, and @alice_demo was paid 49.00 USDC.

- Bet [#50](https://praetorial-web-testnet.familiarcow.workers.dev/bet/50) · @alice_demo (YES) vs @bob_demo · 25.00 USDC each · decided by the AI judge
- Status now: **Settled**, outcome **YES**; paid AI runs used 1/3; challenge bonds 0
- Last AI result: **YES** (run 4)
- The AI's reasoning (resolver notes, verbatim):
  - 1a: Coinbase close of the minute ending T = 74604.19
  - 1a: Bitstamp close of the minute ending T = 74569.84
  - 1a: Kraken close of the minute ending T = 74590.6
  - decision: YES (code-decided 1a: median close of 3 venues = 74590.6 >= 74500 true)
  - 17c5 audit agrees with the code outcome YES
- The judges' answers (verbatim):
  - deepseek-ai/DeepSeek-V4.1-Flash-1017 (audit of the code's decision): **agree**

| step | tx |
|---|---|
| open (@alice_demo) | [7tprmjHVWz…](https://testnet.nearblocks.io/txns/7tprmjHVWzPZRApvMUFTDG71459dTgxtjKZHYKpkteWf) |
| take (@bob_demo) | [BTFy2kBnmz…](https://testnet.nearblocks.io/txns/BTFy2kBnmzF4ZQH5kbvkYfyUzruruWG4acjz7c1UATXb) |
| request_resolution (keeper) 2026-11-11 22:26 | [AieLw4TjRk…](https://testnet.nearblocks.io/txns/AieLw4TjRkWcJbvkxojKvFWAgpyB3UrPWD4AyjDdSF5s) |
| request_resolution (keeper) 2026-11-11 22:54 | [5ckULMFc4L…](https://testnet.nearblocks.io/txns/5ckULMFc4L67qjJDE2LUdqfqLZAbDYw8zSQe5rtVNihe) |
| submit_outcome (keeper) 2026-11-11 23:04 | [J5uB9nagmW…](https://testnet.nearblocks.io/txns/J5uB9nagmWNQhbMM7GBxvbuJj26KX2UKCvHqRaRV64C6) |
| finalize (keeper) 2026-11-12 00:31 | [GK4cNFxT55…](https://testnet.nearblocks.io/txns/GK4cNFxT5588j3UK3dsgd5Hs2GAcsWHWMBkQcQJHWUUc) |

Screenshots: [a-btc-1-taken-1280.png](shots/a-btc-1-taken-1280.png) · [a-btc-1-taken-375.png](shots/a-btc-1-taken-375.png) · [a-btc-2-ruled-1280.png](shots/a-btc-2-ruled-1280.png) · [a-btc-2-ruled-375.png](shots/a-btc-2-ruled-375.png) · [a-btc-3-settled-1280.png](shots/a-btc-3-settled-1280.png) · [a-btc-3-settled-375.png](shots/a-btc-3-settled-375.png)

## NY Rangers beat the Calgary Flames (NHL, 2026-11-11)

> @bob_demo bet 3 NEAR that the New York Rangers would beat the Calgary Flames; @carol_demo took the Flames. Asked before the game, the AI answered RETRY ("too early: earliest resolve is scheduled start + 4h") and set its own next check at 04:30 UTC. The keeper asked again then; the AI read the NHL's own game feed and ESPN (final: Rangers 3, Flames 1) and ruled YES. Nobody challenged, and @bob_demo was paid 5.72826 NEAR.

- Bet [#51](https://praetorial-web-testnet.familiarcow.workers.dev/bet/51) · @bob_demo (YES) vs @carol_demo · 3 NEAR each · decided by the AI judge
- Status now: **Settled**, outcome **YES**; paid AI runs used 2/3; challenge bonds 0
- Last AI result: **YES** (run 2)
- The AI's reasoning (resolver notes, verbatim):
  - source fetched: S_LEAGUE
  - source fetched: S_ESPN
  - final: NYR 3 - CGY 1; winner NYR
  - 17c5 audit disagreed once, agreed on the re-run: code outcome YES stands
- The judges' answers (verbatim):
  - deepseek-ai/DeepSeek-V4.1-Flash-1017 (audit of the code's decision): **flag**
  - deepseek-ai/DeepSeek-V4.1-Flash-1017 (audit of the code's decision): **agree**

| step | tx |
|---|---|
| open (@bob_demo) | [5eAKRi31QS…](https://testnet.nearblocks.io/txns/5eAKRi31QSBNnTT9UNpgDfekGYN6CDNJxXA3jJaQUmWh) |
| take (@carol_demo) | [4fqyezhrBF…](https://testnet.nearblocks.io/txns/4fqyezhrBFWyafRuKrsqQL4x9wLztUwghQ6XcahEGwcX) |
| request_resolution (keeper) 2026-11-12 04:37 | [Hx4j44XKf5…](https://testnet.nearblocks.io/txns/Hx4j44XKf53y3cqGvduoKBFFJe9VWYj7jz7ED8reHzxW) |
| submit_outcome (keeper) 2026-11-12 04:45 | [7aNpEkKGxN…](https://testnet.nearblocks.io/txns/7aNpEkKGxNENeZiTvVkZnxwp5djUXAKVenQuhcb8S43x) |
| finalize (keeper) 2026-11-12 05:52 | [AWuw15pMes…](https://testnet.nearblocks.io/txns/AWuw15pMesnizXokiEdTwejtESBmJmaNhyeFhymJgLR) |

Screenshots: [b-nhl-1-taken-1280.png](shots/b-nhl-1-taken-1280.png) · [b-nhl-1-taken-375.png](shots/b-nhl-1-taken-375.png) · [b-nhl-2-ruled-1280.png](shots/b-nhl-2-ruled-1280.png) · [b-nhl-2-ruled-375.png](shots/b-nhl-2-ruled-375.png) · [b-nhl-3-settled-1280.png](shots/b-nhl-3-settled-1280.png) · [b-nhl-3-settled-375.png](shots/b-nhl-3-settled-375.png)

## NOAA's planetary Kp index for 21:00-24:00 UTC on 2026-11-11 is 2 or higher

> @dan_demo bet 15 USDC that NOAA's planetary Kp index for 21:00-24:00 UTC would be 2 or higher; @alice_demo took NO. Two AI models read NOAA's published row (Kp 1.33) and GFZ Potsdam's (1.0), ruled NO, and @alice_demo was paid 29.00 USDC.

- Bet [#54](https://praetorial-web-testnet.familiarcow.workers.dev/bet/54) · @dan_demo (YES) vs @alice_demo · 15.00 USDC each · decided by the AI judge
- Status now: **Settled**, outcome **NO**; paid AI runs used 1/3; challenge bonds 0
- Last AI result: **NO** (run 1)
- The AI's reasoning (resolver notes, verbatim):
  - source fetched: S1 (https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json)
  - source fetched: S2 (https://kp.gfz.de/app/json/?start=2026-11-11T21:00:00Z&end=2026-11-11T21:00:00Z&index=Kp)
  - decision: an element is not proven (burden on YES); other elements irrelevant
- The judges' answers (verbatim):
  - deepseek-ai/DeepSeek-V4.1-Flash-1017: **not_met**: NOAA SWPC's row for time_tag 2026-11-11T21:00:00 shows Kp 1.33, which is below the 2.00 threshold, and GFZ Potsdam independently shows 1.0 for the same interval. (quote: `{"time_tag":"2026-11-11T21:00:00","Kp":1.33,"a_running":5,"station_count":8}`)
  - z-ai/glm-5.3-flash: **not_met**: NOAA SWPC's row for time_tag 2026-11-11T21:00:00 shows Kp 1.33, which is below the 2.00 threshold (GFZ corroborates with 1.0). (quote: `{"time_tag":"2026-11-11T21:00:00","Kp":1.33,"a_running":5,"station_count":8}`)

| step | tx |
|---|---|
| open (@dan_demo) | [BYiUTbeTrB…](https://testnet.nearblocks.io/txns/BYiUTbeTrB3UsMcvD35s8mCbFEikLQQcnfy89jZUGdmk) |
| take (@alice_demo) | [4m3pjFNWWa…](https://testnet.nearblocks.io/txns/4m3pjFNWWa4btqNbTg3yy5PH41ojg57ut9UPiPVHm1jZ) |
| request_resolution (keeper) 2026-11-12 00:32 | [9wtoUgtdti…](https://testnet.nearblocks.io/txns/9wtoUgtdtikT2ryHPyJJyRmAArqbPgvmbuoLikb7fY65) |
| submit_outcome (keeper) 2026-11-12 00:41 | [475L2LnnHz…](https://testnet.nearblocks.io/txns/475L2LnnHzJhhtmWUJr2Lt1gxKt727tD5rVCvhBHTcX8) |
| finalize (keeper) 2026-11-12 01:47 | [J9nZnYBeiv…](https://testnet.nearblocks.io/txns/J9nZnYBeivSPHXQZAZwDAUu78xRgGkrx2fYJPnSwJ5sN) |

Screenshots: [c2-kp-2-settled-1280.png](shots/c2-kp-2-settled-1280.png) · [c2-kp-2-settled-375.png](shots/c2-kp-2-settled-375.png)

## Central Park's official high on 2026-11-11 is 63°F or warmer (NWS)

> @dan_demo bet 15 USDC that Central Park's official high on 11 Nov would be 63°F or warmer; @alice_demo took NO. The keeper asked too early (at the start of the climate day: the bug CS1 fixed in the keeper), the AI correctly answered RETRY, and the chain will not accept a new request before 12 Nov 19:48 UTC. This is the honest result: the bet is still waiting, with no money at risk.

- Bet [#52](https://praetorial-web-testnet.familiarcow.workers.dev/bet/52) · @dan_demo (YES) vs @alice_demo · 15.00 USDC each · decided by the AI judge
- Status now: **Taken**; paid AI runs used 1/3; challenge bonds 0
- Last AI result: **RETRY** (run 1)
- The AI's reasoning (resolver notes, verbatim):
  - S_NWS: no CLI product issued after the climate day 2026-11-11 (2026-11-12T05:00:00Z) yet
  - source fetched: S_IEM
  - copies: NWS CLI Absent, IEM Absent
  - RETRY (D-RESOLVE1): need both copies; NWS CLI absent, IEM absent

| step | tx |
|---|---|
| open (@dan_demo) | [6BxENHJqso…](https://testnet.nearblocks.io/txns/6BxENHJqsoSpepnfTHhiXGJFm6LdSoTi5iEF9BnH64t7) |
| take (@alice_demo) | [6qSPnnYt71…](https://testnet.nearblocks.io/txns/6qSPnnYt71UcQXNPF5eEuvZYsVJ7hGpyP1musJgdeoWU) |

Screenshots: [c-nws-1-taken-1280.png](shots/c-nws-1-taken-1280.png) · [c-nws-1-taken-375.png](shots/c-nws-1-taken-375.png)

## Knicks beat the Cavaliers tonight (@kim_ref decides)

> @alice_demo bet 10 USDC that the Knicks would beat the Cavaliers tonight, with @kim_ref as referee; @dan_demo took NO. Cleveland won 115-107 (ESPN final), @kim_ref ruled NO, the escrow paid out at once, and @dan_demo was paid 19.00 USDC.

- Bet [#53](https://praetorial-web-testnet.familiarcow.workers.dev/bet/53) · @alice_demo (YES) vs @dan_demo · 10.00 USDC each · decided by @kim_ref (referee)
- Status now: **Settled**, outcome **NO**; paid AI runs used 0/3; challenge bonds 0

| step | tx |
|---|---|
| open (@alice_demo) | [JEJkDC6AMp…](https://testnet.nearblocks.io/txns/JEJkDC6AMp62doWy3yvt5qRenVjw2dPCD34Y7PkAusNR) |
| take (@dan_demo) | [CvDgmjPU6N…](https://testnet.nearblocks.io/txns/CvDgmjPU6NMhBjMTP5qtGAUk3bJUviiLbVSHvibak2jM) |
| referee_rule NO (@kim_ref) | [DurcUMBCHf…](https://testnet.nearblocks.io/txns/DurcUMBCHfeGBH3X2duvEDwz8q4dcXbqeEtCvy3DDATQ) |

Screenshots: [d-referee-1-taken-1280.png](shots/d-referee-1-taken-1280.png) · [d-referee-1-taken-375.png](shots/d-referee-1-taken-375.png) · [d-referee-2-settled-1280.png](shots/d-referee-2-settled-1280.png) · [d-referee-2-settled-375.png](shots/d-referee-2-settled-375.png)

## BTC closes at or above $74,400 at 20:30 UTC (challenged)

> @carol_demo bet 20 USDC that Bitcoin would close at or above $74,400 at 20:30 UTC; @dan_demo took NO. The AI ruled YES (median close $74,453.48). @dan_demo challenged with a 5.005 USDC bond and asked for the second look; the AI ruled YES again. @carol_demo was paid 39.00 USDC plus @dan_demo's bond minus the second look's compute cost.

- Bet [#49](https://praetorial-web-testnet.familiarcow.workers.dev/bet/49) · @carol_demo (YES) vs @dan_demo · 20.00 USDC each · decided by the AI judge
- Status now: **Settled**, outcome **YES**; paid AI runs used 2/3; challenge bonds 0
- Last AI result: **YES** (run 10)
- The AI's reasoning (resolver notes, verbatim):
  - 1a: Coinbase close of the minute ending T = 74448.2
  - 1a: Bitstamp close of the minute ending T = 74453.48
  - 1a: Kraken close of the minute ending T = 74454.2
  - decision: YES (code-decided 1a: median close of 3 venues = 74453.48 >= 74400 true)
  - 17c5 audit agrees with the code outcome YES
- The judges' answers (verbatim):
  - deepseek-ai/DeepSeek-V4.1-Flash-1017 (audit of the code's decision): **agree**

| step | tx |
|---|---|
| open (@carol_demo) | [3FtMzC9DoX…](https://testnet.nearblocks.io/txns/3FtMzC9DoXPPGR8rbPLwLDMZAXy19Fgg5FYqL6G3qbDk) |
| take (@dan_demo) | [7efBWmGaEk…](https://testnet.nearblocks.io/txns/7efBWmGaEkYfh5MNgmpETubm7th2cZbmckAV4X6L6N3P) |
| challenge round 1 (bond 5.005 USDC) (@dan_demo) | [4N3EanAwrJ…](https://testnet.nearblocks.io/txns/4N3EanAwrJ4yStku1fwovW1UeVC5aTfyHnuHyGVHjwKW) |
| Request the result now: request_resolution round 1 (0.02 NEAR) (@dan_demo) | [9SbiLsizpB…](https://testnet.nearblocks.io/txns/9SbiLsizpBHSGnnragbY5Z8porbzpnZtWggaYfKPLG6j) |
| request_resolution (keeper) 2026-11-11 22:35 | [G46nXFbipC…](https://testnet.nearblocks.io/txns/G46nXFbipCyvY1dkkKNsUn4s8pJX8ZWjg5Wo5RiRUA39) |
| request_resolution (keeper) 2026-11-11 22:44 | [HzwRD7YhJJ…](https://testnet.nearblocks.io/txns/HzwRD7YhJJdckHe99kdTAtmhCjea56ZtwNNLwtG2pHcz) |
| submit_outcome (keeper) 2026-11-11 22:54 | [BEZLGN6Xi7…](https://testnet.nearblocks.io/txns/BEZLGN6Xi76fCiYyKNQrv3izZpFJYeV3v7e8NmW1jo3J) |
| finalize (keeper) — **failed** 2026-11-12 00:01 | [7bCmfPymqT…](https://testnet.nearblocks.io/txns/7bCmfPymqTzkuuzs4ddTb6YRui2SEiasusNSXejctRw) |
| finalize (keeper) — **failed** 2026-11-12 00:11 | [fJ7LNwZAHH…](https://testnet.nearblocks.io/txns/fJ7LNwZAHHydz61wee2B66GSQdCTgPv3hPEWPm8PdBS) |
| finalize (keeper) — **failed** 2026-11-12 00:21 | [FEWawn7qeG…](https://testnet.nearblocks.io/txns/FEWawn7qeGn3583zoHtxpW9z7Q7MkvP7XWRnLWNaFqP2) |
| finalize (keeper) — **failed** 2026-11-12 00:30 | [9f3P45RCVK…](https://testnet.nearblocks.io/txns/9f3P45RCVK6Df6wnhe4992ZNSQHBM4pkCv37hhT51fdq) |
| finalize (keeper) — **failed** 2026-11-12 00:40 | [96Lyg7qAJq…](https://testnet.nearblocks.io/txns/96Lyg7qAJqG2HQZU3BDqX5gyhWdV8eb7yUGd2No86TpZ) |
| finalize (keeper) — **failed** 2026-11-12 00:49 | [83MzTgWDHD…](https://testnet.nearblocks.io/txns/83MzTgWDHDfeKYbuUghZ26UEXDmg6fCFwrTd1ZU6fhC2) |
| finalize (keeper) — **failed** 2026-11-12 00:59 | [AoroPXs2aN…](https://testnet.nearblocks.io/txns/AoroPXs2aNggLg17ASab8jmUu3xyPNKfS9JVZk1k2i7s) |
| submit_outcome (keeper) 2026-11-12 01:08 | [AXvXrG32Nx…](https://testnet.nearblocks.io/txns/AXvXrG32NxybxRhrxCWBBVCipWG99PhvDsN8t5WqvJ7m) |
| finalize (keeper) 2026-11-12 02:13 | [3hJouvbQA5…](https://testnet.nearblocks.io/txns/3hJouvbQA5vQQGxX1FazaNUgRmxS3CbyGpv63CXJynaK) |

Screenshots: [e-challenge-1-taken-1280.png](shots/e-challenge-1-taken-1280.png) · [e-challenge-1-taken-375.png](shots/e-challenge-1-taken-375.png) · [e-challenge-2-ruled-1280.png](shots/e-challenge-2-ruled-1280.png) · [e-challenge-2-ruled-375.png](shots/e-challenge-2-ruled-375.png) · [e-challenge-3-challenged-1280.png](shots/e-challenge-3-challenged-1280.png) · [e-challenge-3-challenged-375.png](shots/e-challenge-3-challenged-375.png) · [e-challenge-4-settled-1280.png](shots/e-challenge-4-settled-1280.png) · [e-challenge-4-settled-375.png](shots/e-challenge-4-settled-375.png)

