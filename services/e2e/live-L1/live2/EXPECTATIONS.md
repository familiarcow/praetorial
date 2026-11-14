# Expectations written BEFORE resolving (2026-11-07 ~17:36Z)

Market facts (live 1-minute candles 2026-11-07 00:00Z..17:30Z, Coinbase BTC-USD + Bitstamp btcusd):
- Coinbase max 1m high 76152.43 (09:00Z), max 1m close 76135.69 (09:00Z).
- Bitstamp max 1m high 76143.75 (09:00Z), max 1m close 76130.98 (09:00Z).

Bet B (btc_breaks_76140_messy, "BTC breaks 76,140 today"):
- Reading 1 (touch / wick: any candle HIGH >= 76140): both venues qualify at 09:00Z -> YES.
- Reading 2 (break = a candle CLOSE above 76140): no candle on either venue closes above 76140 (max closes 76135.69 / 76130.98) -> NO.
- The sheet does not define wick vs close. Both readings are reasonable, same market data, different answer -> EXPECTED VOID (D-L1MESSY1 reading-disagreement).

Bet A (jason_bitstamp_only_no): sheet requires BOTH Coinbase and Bitstamp highs >= 75951 in the same 5-min window before 06:00Z; window 04:00-06:00Z. Expected Proposed NO (the L1b result's expectation). D-RESOLVE4a / D-BUDGET1 only matter if OutLayer returns no output again.

Bet C (close_above, typed btc_close_at_t, op '>', x=70000, T = open+~66min): BTC ~75.7k >> 70k -> expected YES at T. Open-time sourcecheck must now pass (D-SRCCHK2).
